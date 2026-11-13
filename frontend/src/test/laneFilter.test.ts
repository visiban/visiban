import { describe, it, expect } from 'vitest'
import {
  evalChain,
  isRuleComplete,
  matchRule,
  normalizeDate,
  normalizeNumber,
  opsForFieldType,
  runsOf,
  textChain,
  type FieldRule,
} from '../utils/fieldRules'
import {
  compileLaneFilter,
  isLaneFilterActive,
  laneFilterChipItems,
  laneFilterFields,
  laneIdsHiddenByFilter,
  laneRuleCount,
  nextLaneItemId,
  parseLaneFilterParam,
  pruneLaneFilter,
  removeLaneItem,
  sanitizeLaneFilter,
  serializeLaneFilterParam,
  summarizeLaneFilter,
  type LaneFilter,
  type LaneRule,
} from '../utils/laneFilter'

// #2205 — the generic evaluator and the lane-filter layer on top of it.

const field = (id: number, name: string, field_type: string, extra: Record<string, unknown> = {}) => ({
  id, name, field_type: field_type as 'dropdown', is_admin_only: false, position: id, ...extra,
})
const AE = field(1, 'AE', 'dropdown')
const CD = field(2, 'Client Director', 'dropdown')
const DEAL = field(3, 'Deal value', 'number')
const RENEW = field(4, 'Renewal', 'date')
const SECRET = field(5, 'Margin', 'number', { is_admin_only: true })
const NOTES = field(6, 'Notes', 'text')
const FIELDS = [AE, CD, DEAL, RENEW]

const rule = (id: number, f: number | null, op: LaneRule['op'], extra: Partial<LaneRule> = {}): LaneRule => ({
  kind: 'rule', id, join: 'and', field: f, op, ...extra,
})
const lane = (vals: Record<number, string>, id = 1) => ({
  id, custom_field_values: Object.entries(vals).map(([k, v]) => ({ field_definition: Number(k), value: v })),
})
const fmt = (_f: unknown, raw: string) => raw

describe('fieldRules', () => {
  it('normalizes numbers and dates, rejecting junk as no value', () => {
    expect(normalizeNumber(' 50000 ')).toBe(50000)
    expect(normalizeNumber('1e3')).toBe(1000)
    expect(normalizeNumber('')).toBeNull()
    expect(normalizeNumber('abc')).toBeNull()
    expect(normalizeNumber('Infinity')).toBeNull()
    expect(normalizeNumber(undefined)).toBeNull()
    expect(normalizeDate('2026-03-05')).toBe('2026-03-05')
    expect(normalizeDate('2026-03-05T10:00:00Z')).toBe('2026-03-05')
    expect(normalizeDate('2026-02-30')).toBeNull()
    expect(normalizeDate('03/05/2026')).toBeNull()
    expect(normalizeDate(null)).toBeNull()
  })

  it('offers is/is not for dropdowns and between for number and date', () => {
    expect(opsForFieldType('dropdown')).toEqual(['is', 'is_not'])
    expect(opsForFieldType('number')).toEqual(['between'])
    expect(opsForFieldType('date')).toEqual(['between'])
  })

  it('treats rules without a field, value, bound, or with a mismatched op as incomplete', () => {
    const r = (x: Partial<FieldRule>): FieldRule => ({ field: 1, op: 'is', ...x })
    expect(isRuleComplete(r({ field: null, value: 'a' }), 'dropdown')).toBe(false)
    expect(isRuleComplete(r({ value: '' }), 'dropdown')).toBe(false)
    expect(isRuleComplete(r({ value: 'a' }), 'dropdown')).toBe(true)
    expect(isRuleComplete(r({ value: 'a' }), null)).toBe(false)
    expect(isRuleComplete(r({ op: 'between', min: '1' }), 'dropdown')).toBe(false)
    expect(isRuleComplete(r({ op: 'between' }), 'number')).toBe(false)
    expect(isRuleComplete(r({ op: 'between', min: 'x' }), 'number')).toBe(false)
    expect(isRuleComplete(r({ op: 'between', max: '10' }), 'number')).toBe(true)
    expect(isRuleComplete(r({ op: 'between', min: '2026-01-01' }), 'date')).toBe(true)
  })

  it('applies the empty-value rule: no value fails is and between, passes is_not', () => {
    expect(matchRule({ field: 1, op: 'is', value: 'a' }, 'dropdown', undefined)).toBe(false)
    expect(matchRule({ field: 1, op: 'is_not', value: 'a' }, 'dropdown', undefined)).toBe(true)
    expect(matchRule({ field: 1, op: 'is_not', value: 'a' }, 'dropdown', '')).toBe(true)
    expect(matchRule({ field: 1, op: 'is_not', value: 'a' }, 'dropdown', 'a')).toBe(false)
    expect(matchRule({ field: 1, op: 'between', min: '1' }, 'number', undefined)).toBe(false)
    expect(matchRule({ field: 1, op: 'between', min: '1' }, 'number', 'n/a')).toBe(false)
    expect(matchRule({ field: 1, op: 'between', min: '2026-01-01' }, 'date', 'soon')).toBe(false)
  })

  it('compares numbers numerically and dates chronologically, bounds inclusive', () => {
    const range = { field: 1, op: 'between' as const, min: '9', max: '100' }
    expect(matchRule(range, 'number', '10')).toBe(true) // lexicographic would say "10" < "9"
    expect(matchRule(range, 'number', '9')).toBe(true)
    expect(matchRule(range, 'number', '100')).toBe(true)
    expect(matchRule(range, 'number', '100.5')).toBe(false)
    expect(matchRule({ field: 1, op: 'between', max: '2026-06-30' }, 'date', '2026-06-30')).toBe(true)
    expect(matchRule({ field: 1, op: 'between', max: '2026-06-30' }, 'date', '2026-07-01')).toBe(false)
  })

  it('binds And tighter than Or', () => {
    const e = (join: 'and' | 'or', v: boolean) => ({ join, v })
    // true or false and false  =>  true or (false and false)  =>  true
    expect(evalChain([e('and', true), e('or', false), e('and', false)], (x) => x.v)).toBe(true)
    // false and true or false  =>  (false and true) or false  =>  false
    expect(evalChain([e('and', false), e('and', true), e('or', false)], (x) => x.v)).toBe(false)
    expect(evalChain([], () => false)).toBe(true)
    expect(runsOf([e('or', true), e('and', true)])).toHaveLength(1)
  })

  it('parenthesizes And-runs only when an Or is present', () => {
    expect(textChain([{ join: 'and', text: 'A' }, { join: 'and', text: 'B' }])).toBe('A and B')
    expect(textChain([{ join: 'and', text: 'A' }, { join: 'and', text: 'B' }, { join: 'or', text: 'C' }])).toBe('(A and B) or C')
  })
})

describe('laneFilter', () => {
  it('offers only dropdown/number/date fields, admin-only ones to admins only', () => {
    const defs = [SECRET, NOTES, DEAL, AE]
    expect(laneFilterFields(defs, false).map((f) => f.id)).toEqual([1, 3])
    expect(laneFilterFields(defs, true).map((f) => f.id)).toEqual([1, 3, 5])
  })

  it('evaluates top-level And/Or with a group, matching the Reads-as text', () => {
    const f: LaneFilter = {
      items: [
        rule(1, AE.id, 'is', { value: 'Priya' }),
        rule(2, DEAL.id, 'between', { min: '50000' }),
        { kind: 'group', id: 3, join: 'or', rules: [rule(4, CD.id, 'is', { value: 'Jo' }), rule(5, AE.id, 'is', { join: 'or', value: 'Sam' })] },
      ],
    }
    const test = compileLaneFilter(f, FIELDS)!
    expect(test(lane({ 1: 'Priya', 3: '60000' }))).toBe(true)
    expect(test(lane({ 1: 'Priya', 3: '100' }))).toBe(false)
    expect(test(lane({ 2: 'Jo' }))).toBe(true)
    expect(test(lane({ 1: 'Sam' }))).toBe(true)
    expect(test(lane({}))).toBe(false)
    expect(summarizeLaneFilter(f, FIELDS, fmt).readsAs).toBe(
      'Reads as: (AE is Priya and Deal value 50000 or more) or (Client Director is Jo or AE is Sam)',
    )
  })

  it('ignores incomplete rules and empty groups, so they never hide lanes', () => {
    const f: LaneFilter = { items: [rule(1, null, 'is'), rule(2, AE.id, 'is', { value: '' }), { kind: 'group', id: 3, join: 'and', rules: [rule(4, DEAL.id, 'between')] }] }
    expect(compileLaneFilter(f, FIELDS)).toBeNull()
    expect(laneIdsHiddenByFilter([lane({}, 1)], f, FIELDS).size).toBe(0)
    expect(summarizeLaneFilter(f, FIELDS, fmt)).toEqual({ readsAs: 'Reads as: all lanes shown · 3 incomplete filters ignored', completeCount: 0, incompleteCount: 3 })
    expect(summarizeLaneFilter({ items: [rule(1, AE.id, 'is', { value: 'a' }), rule(2, null, 'is')] }, FIELDS, fmt).readsAs).toBe(
      'Reads as: AE is a · 1 incomplete filter ignored',
    )
    expect(summarizeLaneFilter(undefined, FIELDS, fmt).readsAs).toBe('Reads as: all lanes shown')
  })

  it('reads ranges in plain language', () => {
    const text = (r: LaneRule) => laneFilterChipItems({ items: [r] }, FIELDS, fmt)[0].label
    expect(text(rule(1, DEAL.id, 'between', { min: '1', max: '5' }))).toBe('Deal value between 1 and 5')
    expect(text(rule(1, DEAL.id, 'between', { max: '5' }))).toBe('Deal value up to 5')
    expect(text(rule(1, RENEW.id, 'between', { min: '2026-01-01' }))).toBe('Renewal on or after 2026-01-01')
    expect(text(rule(1, RENEW.id, 'between', { max: '2026-01-01' }))).toBe('Renewal on or before 2026-01-01')
    expect(text(rule(1, AE.id, 'is_not', { value: 'Sam' }))).toBe('AE is not Sam')
  })

  it('chip items skip incomplete items and always parenthesize groups', () => {
    const f: LaneFilter = { items: [rule(1, null, 'is'), { kind: 'group', id: 2, join: 'or', rules: [rule(3, AE.id, 'is', { value: 'Jo' })] }] }
    expect(laneFilterChipItems(f, FIELDS, fmt)).toEqual([{ id: 2, join: 'or', label: '(AE is Jo)' }])
  })

  it('prunes rules on fields the viewer cannot rule on and blanks unparsable bounds', () => {
    const f: LaneFilter = {
      items: [
        rule(1, SECRET.id, 'between', { min: '1' }),
        rule(2, DEAL.id, 'between', { min: 'abc', max: '9' }),
        rule(3, AE.id, 'between', { min: '1' }),
        rule(4, null, 'is'),
        { kind: 'group', id: 5, join: 'or', rules: [rule(6, NOTES.id, 'is', { value: 'x' })] },
      ],
    }
    const pruned = pruneLaneFilter(f, laneFilterFields([AE, DEAL, SECRET, NOTES], false))!
    expect(pruned.items.map((i) => i.id)).toEqual([2, 4])
    expect(pruned.items[0]).toMatchObject({ min: '', max: '9' })
    const clean: LaneFilter = { items: [rule(1, AE.id, 'is', { value: 'a' })] }
    expect(pruneLaneFilter(clean, FIELDS)).toBe(clean)
    expect(pruneLaneFilter({ items: [rule(1, SECRET.id, 'between', { min: '1' })] }, FIELDS)).toBeUndefined()
    expect(pruneLaneFilter(undefined, FIELDS)).toBeUndefined()
  })

  it('round-trips through the compact URL form', () => {
    const f: LaneFilter = {
      items: [
        rule(1, AE.id, 'is', { value: 'Priya' }),
        rule(2, DEAL.id, 'between', { join: 'or', min: '5', max: '' }),
        { kind: 'group', id: 3, join: 'or', rules: [rule(4, CD.id, 'is_not', { value: 'Jo' }), rule(5, null, 'is', { join: 'or' })] },
      ],
    }
    const param = serializeLaneFilterParam(f)!
    expect(param.startsWith('1.')).toBe(true)
    const back = parseLaneFilterParam(param)!
    expect(laneFilterChipItems(back, FIELDS, fmt)).toEqual(laneFilterChipItems(f, FIELDS, fmt).map((c, i) => ({ ...c, id: back.items[i].id })))
    expect(back.items[2]).toMatchObject({ kind: 'group', join: 'or', rules: [{ op: 'is_not', value: 'Jo' }, { field: null, join: 'or' }] })
    expect(serializeLaneFilterParam(undefined)).toBeNull()
    expect(serializeLaneFilterParam({ items: [] })).toBeNull()
  })

  it('parses hostile or malformed params as no filter', () => {
    for (const p of [null, '', '2.[]', '1.', '1.{', '1.{}', '1.[]', `1.${'['.repeat(10)}`, `1.[${'0,'.repeat(20000)}0]`]) {
      expect(parseLaneFilterParam(p)).toBeUndefined()
    }
    expect(parseLaneFilterParam('1.[{"f":"7","o":"is"},{"f":7,"o":"contains"},{"f":7,"o":"is","v":"ok"}]')!.items).toHaveLength(1)
  })

  it('sanitizes stored state defensively and enforces the bounds', () => {
    expect(sanitizeLaneFilter(null)).toBeUndefined()
    expect(sanitizeLaneFilter({ items: 'x' })).toBeUndefined()
    const many = { items: Array.from({ length: 30 }, (_, i) => ({ kind: 'rule', id: i, join: 'and', field: 1, op: 'is', value: 'a' })) }
    expect(sanitizeLaneFilter(many)!.items).toHaveLength(20)
    const groups = { items: Array.from({ length: 3 }, (_, g) => ({ kind: 'group', id: 100 + g, join: 'and', rules: Array.from({ length: 20 }, (_, i) => ({ id: g * 20 + i, field: 1, op: 'is' })) })) }
    expect(laneRuleCount(sanitizeLaneFilter(groups))).toBe(50)
    const dupes = sanitizeLaneFilter({ items: [{ id: 1, field: 1, op: 'is' }, { id: 1, field: 1, op: 'is' }, { id: 'x', field: 1, op: 'is', value: 'a\u0000' }] })!
    expect(new Set(dupes.items.map((i) => i.id)).size).toBe(3)
    expect((dupes.items[2] as LaneRule).value).toBeUndefined()
    expect(sanitizeLaneFilter({ items: [{ kind: 'group', id: 1, rules: [] }, { kind: 'bogus', field: 1, op: 'is' }] })).toBeUndefined()
    expect(sanitizeLaneFilter({ items: [{ field: -1, op: 'is' }] })).toBeUndefined()
  })

  it('counts lane rules structurally for the filter badge and helpers', () => {
    expect(isLaneFilterActive(undefined)).toBe(false)
    expect(isLaneFilterActive({ items: [rule(1, null, 'is', { value: 'a' })] })).toBe(false)
    expect(isLaneFilterActive({ items: [{ kind: 'group', id: 1, join: 'and', rules: [rule(2, 1, 'between', { max: '3' })] }] })).toBe(true)
    const f: LaneFilter = { items: [rule(1, 1, 'is'), { kind: 'group', id: 4, join: 'and', rules: [rule(7, 1, 'is')] }] }
    expect(nextLaneItemId(f)).toBe(8)
    expect(nextLaneItemId(undefined)).toBe(1)
    expect(removeLaneItem(f, 1)!.items.map((i) => i.id)).toEqual([4])
    expect(removeLaneItem({ items: [rule(1, 1, 'is')] }, 1)).toBeUndefined()
  })
})
