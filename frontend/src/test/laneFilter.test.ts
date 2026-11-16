import { describe, it, expect } from 'vitest'
import * as L from '../utils/laneFilter'
import {
  evalChain,
  isRuleComplete,
  matchRule,
  normalizeDate,
  normalizeNumber,
  normalizeText,
  opsForFieldType,
  ruleText,
  runsOf,
  textChain,
  type FieldRule,
} from '../utils/fieldRules'
import {
  compileLaneFilter,
  isLaneFilterActive,
  LANE_BUILTIN_FIELDS,
  laneFilterAvailable,
  laneFilterChipItems,
  laneFilterFields,
  laneIdsHiddenByFilter,
  laneRuleCount,
  laneTextValueChoices,
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
const SIGNED = field(7, 'Signed', 'checkbox')
const SITE = field(8, 'Site', 'url')
const OWNER = field(9, 'Owner', 'text', { is_admin_only: true })
const FIELDS = [AE, CD, DEAL, RENEW]
const TEXT_FIELDS = [AE, NOTES, SITE]

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

describe('fieldRules — text and url (#2226)', () => {
  const tr = (op: FieldRule['op'], value?: string): FieldRule => ({ field: 6, op, value })

  it('offers is / is not / contains / does not contain / matches wildcard on text and url fields', () => {
    expect(opsForFieldType('text')).toEqual(['is', 'is_not', 'contains', 'not_contains', 'wildcard'])
    expect(opsForFieldType('url')).toEqual(['is', 'is_not', 'contains', 'not_contains', 'wildcard'])
    expect(normalizeText('  Ethan Ross ')).toBe('ethan ross')
    expect(normalizeText('   ')).toBeNull()
    expect(normalizeText(undefined)).toBeNull()
  })

  it('treats a blank or whitespace-only operand as incomplete', () => {
    expect(isRuleComplete(tr('contains', ''), 'text')).toBe(false)
    expect(isRuleComplete(tr('contains', '   '), 'text')).toBe(false)
    expect(isRuleComplete(tr('contains'), 'url')).toBe(false)
    expect(isRuleComplete(tr('contains', 'ross'), 'text')).toBe(true)
    expect(isRuleComplete(tr('is', 'Ethan Ross'), 'url')).toBe(true)
    expect(isRuleComplete(tr('between', 'x'), 'text')).toBe(false)
    // `contains` is not a dropdown operator.
    expect(isRuleComplete({ field: 1, op: 'contains', value: 'a' }, 'dropdown')).toBe(false)
  })

  it('matches trimmed and case-insensitively', () => {
    expect(matchRule(tr('is', 'Ethan Ross'), 'text', ' ethan ROSS ')).toBe(true)
    expect(matchRule(tr('is', ' ethan ross'), 'text', 'Ethan Ross')).toBe(true)
    expect(matchRule(tr('is', 'Ethan Ross'), 'text', 'Ethan Rossi')).toBe(false)
    expect(matchRule(tr('is_not', 'Ethan Ross'), 'text', 'ETHAN ROSS')).toBe(false)
    expect(matchRule(tr('is_not', 'Ethan Ross'), 'text', 'Olivia Grant')).toBe(true)
    expect(matchRule(tr('contains', 'ROSS '), 'text', 'Ethan Ross')).toBe(true)
    expect(matchRule(tr('contains', 'grant'), 'url', 'https://Grant.example')).toBe(true)
    expect(matchRule(tr('contains', 'ross'), 'text', 'Olivia Grant')).toBe(false)
  })

  it('not_contains is the inverse of contains; wildcard matches any part of the value (#2227)', () => {
    const nc = (v: string, raw: string | undefined) => matchRule(tr('not_contains', v), 'text', raw)
    const wc = (v: string, raw: string | undefined) => matchRule(tr('wildcard', v), 'text', raw)
    expect(nc('ross', 'Ethan Ross')).toBe(false)
    expect(nc(' ROSS ', 'Olivia Grant')).toBe(true)
    // contains stays literal: * and ? are ordinary characters there.
    expect(matchRule(tr('contains', 'e*ross'), 'text', 'Ethan Ross')).toBe(false)
    expect(matchRule(tr('contains', 'e*ross'), 'text', 'the E*Ross')).toBe(true)
    expect(nc('e*ross', 'Ethan Ross')).toBe(true)
    // Empty-value rule: no value passes not_contains, fails wildcard.
    for (const raw of [undefined, '', '   ']) {
      expect(nc('ross', raw)).toBe(true)
      expect(wc('*', raw)).toBe(false)
    }
    // Every documented example row.
    const rows: [string, string[], string[]][] = [
      ['e*ross', ['Ethan Ross', 'Eve Gross'], ['Ross Ethan']],
      ['j?n', ['Jan', 'Jon', 'Jan Smith'], ['Jean', 'Jn']],
      ['ethan', ['Ethan Ross', 'Seth Ethan'], ['Eth']],
      ['Ethan*', ['Ethan Ross', 'Seth Ethan'], ['Eth']],
      ['a*c', ['abc', 'xxabbcxx'], ['cba']],
      ['*', ['x'], []],
    ]
    for (const [pat, yes, no] of rows) {
      for (const v of yes) expect(wc(pat, v), `${pat} ~ ${v}`).toBe(true)
      for (const v of no) expect(wc(pat, v), `${pat} !~ ${v}`).toBe(false)
    }
    // Blank operands are incomplete for both new operators.
    for (const op of ['not_contains', 'wildcard'] as const) {
      expect(isRuleComplete(tr(op, '  '), 'text')).toBe(false)
      expect(isRuleComplete(tr(op, 'x'), 'url')).toBe(true)
      expect(isRuleComplete({ field: 1, op, value: 'a' }, 'dropdown')).toBe(false)
    }
    expect(ruleText(tr('not_contains', ' ross '), 'text', 'AE', (raw) => raw)).toBe('AE does not contain ross')
    expect(ruleText(tr('wildcard', 'e*ross'), 'text', 'AE', (raw) => raw)).toBe('AE matches wildcard e*ross')
  })

  it('applies the empty-value rule: no value fails is and contains, passes is not', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(matchRule(tr('is', 'Ethan Ross'), 'text', raw)).toBe(false)
      expect(matchRule(tr('contains', 'ross'), 'text', raw)).toBe(false)
      expect(matchRule(tr('is_not', 'Ethan Ross'), 'text', raw)).toBe(true)
    }
  })

  it('reads as plain language', () => {
    const id = (raw: string) => raw
    expect(ruleText(tr('is', 'Ethan Ross'), 'text', 'AE', id)).toBe('AE is Ethan Ross')
    expect(ruleText(tr('is_not', 'Ethan Ross'), 'text', 'AE', id)).toBe('AE is not Ethan Ross')
    expect(ruleText(tr('contains', ' ross '), 'url', 'AE', id)).toBe('AE contains ross')
  })
})

describe('laneFilter', () => {
  it('offers dropdown/number/date/text/url fields, admin-only ones to admins only', () => {
    const defs = [SECRET, NOTES, DEAL, AE, SIGNED, SITE, OWNER]
    // #2336 — the built-ins come first; Contact email to admins only.
    expect(laneFilterFields(defs, false).map((f) => f.id)).toEqual(['name', 1, 3, 6, 8])
    expect(laneFilterFields(defs, true).map((f) => f.id)).toEqual(['name', 'contact_email', 1, 3, 5, 6, 8, 9])
  })

  it('collects the lanes\' distinct text values, trimmed, case-folded and sorted', () => {
    const lanes: Parameters<typeof laneTextValueChoices>[0] = [
      lane({ 6: ' Olivia Grant ', 8: 'https://b.example' }, 1),
      lane({ 6: 'ethan ross' }, 2),
      lane({ 6: 'Ethan Ross', 1: 'Priya' }, 3),
      lane({ 6: '   ', 8: 'x'.repeat(501) }, 4),
      {},
    ]
    const choices = laneTextValueChoices(lanes, TEXT_FIELDS)
    expect(choices.get(6)).toEqual(['ethan ross', 'Olivia Grant'])
    expect(choices.get(8)).toEqual(['https://b.example'])
    // Dropdown fields keep their own choices; fields not offered are skipped.
    expect(choices.has(1)).toBe(false)
    expect(laneTextValueChoices(lanes, [AE]).size).toBe(0)
  })

  it('hides lanes by a text rule and keeps it through pruning', () => {
    const f: LaneFilter = {
      items: [rule(1, NOTES.id, 'contains', { value: 'ross' }), rule(2, SITE.id, 'is', { join: 'or', value: 'https://a.example' })],
    }
    expect(pruneLaneFilter(f, TEXT_FIELDS)).toBe(f)
    const hidden = laneIdsHiddenByFilter([lane({ 6: 'Ethan Ross' }, 1), lane({ 6: 'Olivia Grant' }, 2), lane({ 8: 'HTTPS://A.example ' }, 3), lane({}, 4)], f, TEXT_FIELDS)
    expect([...hidden]).toEqual([2, 4])
    expect(summarizeLaneFilter(f, TEXT_FIELDS, fmt).readsAs).toBe('Reads as: Notes contains ross or Site is https://a.example')
    // An empty contains input is ignored, never hiding anything.
    const empty: LaneFilter = { items: [rule(1, NOTES.id, 'contains', { value: '  ' })] }
    expect(compileLaneFilter(empty, TEXT_FIELDS)).toBeNull()
    expect(isLaneFilterActive(empty)).toBe(false)
    expect(isLaneFilterActive({ items: [rule(1, NOTES.id, 'contains', { value: 'r' })] })).toBe(true)
    // `between` is not a text operator, and `contains` is not a dropdown one.
    expect(pruneLaneFilter({ items: [rule(1, NOTES.id, 'between', { min: '1' }), rule(2, AE.id, 'contains', { value: 'a' })] }, TEXT_FIELDS)).toBeUndefined()
  })

  it('round-trips contains rules through the URL and stored state', () => {
    const f: LaneFilter = {
      items: [rule(1, NOTES.id, 'contains', { value: 'ross' }), rule(2, NOTES.id, 'contains', { value: '' }), rule(3, NOTES.id, 'is_not', { value: 'Ethan Ross' })],
    }
    const back = parseLaneFilterParam(serializeLaneFilterParam(f))!
    expect(back.items).toEqual(f.items)
    // Browser filter state and saved filters go through sanitizeLaneFilter as JSON.
    expect(sanitizeLaneFilter(JSON.parse(JSON.stringify(f)))).toEqual(f)
    // The server takes contains with a value string only, so the client never
    // carries range bounds on one and restores a missing value as "".
    expect(sanitizeLaneFilter({ items: [{ id: 1, field: 6, op: 'contains', min: '1', max: '2' }] })!.items[0]).toEqual(
      rule(1, 6, 'contains', { value: '' }),
    )
  })

  it('round-trips not_contains and wildcard rules and drops an unknown op alone (#2227)', () => {
    const f: LaneFilter = {
      items: [rule(1, NOTES.id, 'not_contains', { value: 'ross' }), rule(2, NOTES.id, 'wildcard', { value: 'e*' }), rule(3, NOTES.id, 'wildcard', { value: '' })],
    }
    expect(parseLaneFilterParam(serializeLaneFilterParam(f))!.items).toEqual(f.items)
    expect(sanitizeLaneFilter(JSON.parse(JSON.stringify(f)))).toEqual(f)
    expect(sanitizeLaneFilter({ items: [{ id: 1, field: 6, op: 'wildcard', min: '1' }, { id: 2, field: 6, op: 'regex', value: 'x' }] })!.items).toEqual([
      rule(1, 6, 'wildcard', { value: '' }),
    ])
    expect(isLaneFilterActive({ items: [rule(1, NOTES.id, 'wildcard', { value: ' ' })] })).toBe(false)
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
        { kind: 'group', id: 5, join: 'or', rules: [rule(6, SIGNED.id, 'is', { value: 'x' })] },
      ],
    }
    const pruned = pruneLaneFilter(f, laneFilterFields([AE, DEAL, SECRET, SIGNED], false))!
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
    // An op this client does not know (a newer client's) drops just that rule.
    expect(parseLaneFilterParam('1.[{"f":"7","o":"is"},{"f":7,"o":"starts_with"},{"f":7,"o":"is","v":"ok"}]')!.items).toHaveLength(1)
    expect(sanitizeLaneFilter({ items: [{ id: 1, field: 7, op: 'empty' }, { id: 2, field: 7, op: 'contains', value: 'a' }] })!.items).toEqual([
      rule(2, 7, 'contains', { value: 'a' }),
    ])
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

describe('laneFilter — built-in fields (#2336)', () => {
  const NAME_RULE = (id: number, op: LaneRule['op'], value: string, join: 'and' | 'or' = 'and'): LaneRule =>
    ({ kind: 'rule', id, join, field: 'name', op, value })
  const EMAIL_RULE = (id: number, op: LaneRule['op'], value: string, join: 'and' | 'or' = 'and'): LaneRule =>
    ({ kind: 'rule', id, join, field: 'contact_email', op, value })
  const NOTE = field(6, 'Account note', 'text')
  const lanes = [
    { id: 1, name: 'Acme Corp', contact_email: 'pat@acme.com', custom_field_values: [{ field_definition: 6, value: 'gold' }] },
    { id: 2, name: 'Globex', contact_email: '', custom_field_values: [] },
    { id: 3, name: 'acme labs', contact_email: 'sam@acme.co.uk', custom_field_values: [] },
    { id: 4, name: 'Initech', custom_field_values: [] },
  ]
  const adminFields = laneFilterFields([NOTE], true)
  const memberFields = laneFilterFields([NOTE], false)

  it('parses built-in keys and drops unknown strings; old-format rules parse as before', () => {
    const f = sanitizeLaneFilter({ items: [
      { kind: 'rule', id: 1, field: 'name', op: 'is', value: 'Acme Corp' },
      { kind: 'rule', id: 2, field: 'contact_email', op: 'contains', value: '@acme.com' },
      { kind: 'rule', id: 3, field: 'title', op: 'is', value: 'x' },
      { kind: 'rule', id: 4, field: 'Name', op: 'is', value: 'x' },
      { kind: 'group', id: 5, join: 'or', rules: [{ field: 'name', op: 'wildcard', value: 'acme*' }, { field: ['name'], op: 'is', value: 'x' }] },
      { kind: 'rule', id: 6, field: 6, op: 'is', value: 'gold' },
    ] })
    expect(f?.items.map((it) => (it.kind === 'rule' ? it.field : it.rules.map((r) => r.field)))).toEqual(['name', 'contact_email', ['name'], 6])
    const old = { items: [{ kind: 'rule', id: 1, join: 'and', field: 6, op: 'is', value: 'gold' }] }
    expect(sanitizeLaneFilter(old)).toEqual(old)
    expect(parseLaneFilterParam('1.[{"f":6,"o":"is","v":"gold"}]')).toEqual({ items: [{ kind: 'rule', id: 1, join: 'and', field: 6, op: 'is', value: 'gold' }] })
  })

  it('round-trips built-in rules through the compact URL form', () => {
    const f: LaneFilter = { items: [NAME_RULE(1, 'is', 'Acme Corp'), { kind: 'group', id: 2, join: 'or', rules: [EMAIL_RULE(3, 'wildcard', '*@acme.*'), { kind: 'rule', id: 4, join: 'and', field: 6, op: 'contains', value: 'go' }] }] }
    const param = serializeLaneFilterParam(f) as string
    expect(param).toContain('"f":"name"')
    expect(param).toContain('"f":"contact_email"')
    expect(serializeLaneFilterParam(parseLaneFilterParam(param))).toBe(param)
    expect(parseLaneFilterParam('1.[{"f":"title","o":"is","v":"x"}]')).toBeUndefined()
  })

  it('models the built-ins as synthetic text fields, with a suffix only on a name collision', () => {
    expect(LANE_BUILTIN_FIELDS.map((b) => b.key)).toEqual(['name', 'contact_email'])
    expect(adminFields.slice(0, 2)).toMatchObject([
      { id: 'name', name: 'Lane name', field_type: 'text', is_admin_only: false },
      { id: 'contact_email', name: 'Contact email', field_type: 'text', is_admin_only: true },
    ])
    const clash = laneFilterFields([field(7, ' lane NAME ', 'text'), field(8, 'Contact Email', 'text')], true)
    expect(clash.map((f) => f.name)).toEqual(['Lane name (built-in)', 'Contact email (built-in)', ' lane NAME ', 'Contact Email'])
    // A colliding admin-only field a member cannot see does not rename the built-in for them.
    const hidden = laneFilterFields([field(8, 'Lane name', 'text', { is_admin_only: true })], false)
    expect(hidden.map((f) => f.name)).toEqual(['Lane name'])
    const label = laneFilterChipItems({ items: [NAME_RULE(1, 'is', 'Acme Corp')] }, clash, (_f, raw) => raw)[0].label
    expect(label).toBe('Lane name (built-in) is Acme Corp')
  })

  it('drops stray min/max on built-in rules when parsing (server rejects them)', () => {
    for (const key of ['name', 'contact_email']) {
      const parsed = parseLaneFilterParam(`1.${JSON.stringify([{ f: key, o: 'is', v: 'x', a: '1', b: '2' }])}`)
      const r = parsed!.items[0] as LaneRule
      expect(r.field).toBe(key)
      expect(r.value).toBe('x')
      expect(r).not.toHaveProperty('min')
      expect(r).not.toHaveProperty('max')
    }
  })

  it('combines a built-in rule with a custom-field rule in Or and And groups', () => {
    const noteRule = (join: 'and' | 'or'): LaneRule => ({ kind: 'rule', id: 4, join, field: 6, op: 'contains', value: 'gold' })
    const orF: LaneFilter = { items: [{ kind: 'group', id: 1, join: 'and', rules: [NAME_RULE(2, 'is', 'Globex'), noteRule('or')] }] }
    expect([...laneIdsHiddenByFilter(lanes, orF, memberFields)].sort()).toEqual([3, 4])
    const andF: LaneFilter = { items: [{ kind: 'group', id: 1, join: 'and', rules: [NAME_RULE(2, 'wildcard', 'acme*'), noteRule('and')] }] }
    expect([...laneIdsHiddenByFilter(lanes, andF, memberFields)].sort()).toEqual([2, 3, 4])
  })

  it('matches Lane name case-insensitively', () => {
    const hidden = laneIdsHiddenByFilter(lanes, { items: [NAME_RULE(1, 'is', 'ACME CORP')] }, memberFields)
    expect([...hidden].sort()).toEqual([2, 3, 4])
    const wild = laneIdsHiddenByFilter(lanes, { items: [NAME_RULE(1, 'wildcard', 'acme*')] }, memberFields)
    expect([...wild].sort()).toEqual([2, 4])
  })

  it('an empty or missing contact email fails is/contains/wildcard and passes is not/does not contain', () => {
    const test = (op: LaneRule['op'], value: string) =>
      [2, 4].map((id) => compileLaneFilter({ items: [EMAIL_RULE(1, op, value)] }, adminFields)!(lanes.find((l) => l.id === id)!))
    expect(test('is', 'pat@acme.com')).toEqual([false, false])
    expect(test('contains', '@')).toEqual([false, false])
    expect(test('wildcard', '*')).toEqual([false, false])
    expect(test('is_not', 'pat@acme.com')).toEqual([true, true])
    expect(test('not_contains', '@acme.com')).toEqual([true, true])
  })

  it('matches the full stored address; wildcard is unanchored, so *@acme.com also hits a longer domain', () => {
    const hidden = (r: LaneRule) => [...laneIdsHiddenByFilter(lanes, { items: [r] }, adminFields)].sort()
    expect(hidden(EMAIL_RULE(1, 'wildcard', '*@acme.com'))).toEqual([2, 3, 4])
    expect(hidden(EMAIL_RULE(1, 'contains', '@acme.co'))).toEqual([2, 4])
    // Unanchored (#2227): "@acme.c" matches pat@acme.com and sam@acme.co.uk alike.
    expect(hidden(EMAIL_RULE(1, 'wildcard', '*@acme.c'))).toEqual([2, 4])
    const longer = [{ id: 9, name: 'X', contact_email: 'a@acme.com.evil.test', custom_field_values: [] }]
    expect([...laneIdsHiddenByFilter(longer, { items: [EMAIL_RULE(1, 'wildcard', '*@acme.com')] }, adminFields)]).toEqual([])
  })

  it('prunes a Contact email rule for a non-admin, which narrows an Or run', () => {
    const f: LaneFilter = { items: [{ kind: 'group', id: 1, join: 'and', rules: [NAME_RULE(2, 'is', 'Globex'), EMAIL_RULE(3, 'contains', '@acme.com', 'or')] }] }
    expect(pruneLaneFilter(f, adminFields)).toBe(f)
    const pruned = pruneLaneFilter(f, memberFields)
    expect(pruned).toEqual({ items: [{ kind: 'group', id: 1, join: 'and', rules: [NAME_RULE(2, 'is', 'Globex')] }] })
    // Admin: Globex or an acme.com contact (lanes 1 and 2); member: Globex only.
    expect([...laneIdsHiddenByFilter(lanes, f, adminFields)].sort()).toEqual([3, 4])
    expect([...laneIdsHiddenByFilter(lanes, pruned, memberFields)].sort()).toEqual([1, 3, 4])
    // The stored filter itself is left untouched.
    expect(f.items[0].kind === 'group' && f.items[0].rules).toHaveLength(2)
    expect(pruneLaneFilter({ items: [EMAIL_RULE(1, 'is', 'pat@acme.com')] }, memberFields)).toBeUndefined()
  })

  it('offers lane names to everyone and contact emails only with the Contact email field', () => {
    expect(laneTextValueChoices(lanes, adminFields).get('name')).toEqual(['Acme Corp', 'acme labs', 'Globex', 'Initech'])
    expect(laneTextValueChoices(lanes, adminFields).get('contact_email')).toEqual(['pat@acme.com', 'sam@acme.co.uk'])
    expect(laneTextValueChoices(lanes, memberFields).has('contact_email')).toBe(false)
  })

  it('labels chips and Reads as by the built-in name', () => {
    const f: LaneFilter = { items: [NAME_RULE(1, 'is', 'Acme Corp'), EMAIL_RULE(2, 'wildcard', '*@acme.*', 'or')] }
    expect(laneFilterChipItems(f, adminFields, (_f, raw) => raw).map((c) => c.label)).toEqual(['Lane name is Acme Corp', 'Contact email matches wildcard *@acme.*'])
    expect(summarizeLaneFilter(f, adminFields, (_f, raw) => raw).readsAs).toBe('Reads as: Lane name is Acme Corp or Contact email matches wildcard *@acme.*')
  })

  it('laneFilterAvailable: a custom field, two lanes, or a filter to clear', () => {
    expect(laneFilterAvailable(0, 1, undefined)).toBe(false)
    expect(laneFilterAvailable(0, 0, { items: [] })).toBe(false)
    expect(laneFilterAvailable(1, 0, undefined)).toBe(true)
    expect(laneFilterAvailable(0, 2, undefined)).toBe(true)
    expect(laneFilterAvailable(0, 1, { items: [NAME_RULE(1, 'is', '')] })).toBe(true)
  })
})

// #2214 — hideUnmatched is a setting on the lane filter, kept through every rules edit.
describe('hideUnmatched (#2214)', () => {
  const r1 = { kind: 'rule' as const, id: 1, join: 'and' as const, field: 'name' as const, op: 'is' as const, value: 'A' }
  it('withLaneItems keeps the flag, and collapses to undefined only with no items and the flag off', () => {
    expect(L.withLaneItems(undefined, [])).toBeUndefined()
    expect(L.withLaneItems({ items: [r1] }, [])).toBeUndefined()
    expect(L.withLaneItems({ items: [r1] }, [r1])).toEqual({ items: [r1] })
    expect(L.withLaneItems({ items: [r1], hideUnmatched: true }, [])).toEqual({ items: [], hideUnmatched: true })
  })
  it('withHideUnmatched turns the flag on and off, keeping the rules', () => {
    expect(L.withHideUnmatched(undefined, true)).toEqual({ items: [], hideUnmatched: true })
    expect(L.withHideUnmatched({ items: [], hideUnmatched: true }, false)).toBeUndefined()
    expect(L.withHideUnmatched({ items: [r1], hideUnmatched: true }, false)).toEqual({ items: [r1] })
  })
  it('sanitize keeps a strict true flag, even with no rules, and drops anything else', () => {
    expect(L.sanitizeLaneFilter({ items: [], hideUnmatched: true })).toEqual({ items: [], hideUnmatched: true })
    expect(L.sanitizeLaneFilter({ items: [r1], hideUnmatched: 'yes' })).toEqual({ items: [r1] })
    expect(L.sanitizeLaneFilter({ items: [], hideUnmatched: 1 })).toBeUndefined()
  })
  it('prune and removeLaneItem keep the flag when every rule goes', () => {
    const f = { items: [{ ...r1, field: 99 }], hideUnmatched: true }
    expect(L.pruneLaneFilter(f, [])).toEqual({ items: [], hideUnmatched: true })
    expect(L.removeLaneItem({ items: [r1], hideUnmatched: true }, 1)).toEqual({ items: [], hideUnmatched: true })
    expect(L.isLaneFilterActive({ items: [], hideUnmatched: true })).toBe(false)
  })
  it('the f_lanes URL form carries rules only (the flag has its own param)', () => {
    expect(L.serializeLaneFilterParam({ items: [], hideUnmatched: true })).toBeNull()
  })
})

// #2337 — rules on fields this viewer cannot use.
describe('countUnusableLaneRules (#2337)', () => {
  const defs = [{ id: 7, is_admin_only: true }, { id: 8, is_admin_only: false }]
  const rule = (id: number, field: L.LaneFieldKey | null) => ({ kind: 'rule' as const, id, join: 'and' as const, field, op: 'is' as const, value: 'x' })
  const f: L.LaneFilter = {
    items: [rule(1, 7), rule(2, 8), rule(3, 'contact_email'), rule(4, 'name'), rule(5, 404), rule(6, null),
      { kind: 'group', id: 9, join: 'or', rules: [rule(10, 7)] }],
  }
  it('counts admin-only custom fields and Contact email for a non-admin, inside groups too', () => {
    expect(L.countUnusableLaneRules(f, defs, false)).toBe(3)
  })
  it('is zero for an admin and for no filter; deleted fields are not counted', () => {
    expect(L.countUnusableLaneRules(f, defs, true)).toBe(0)
    expect(L.countUnusableLaneRules(undefined, defs, false)).toBe(0)
    expect(L.countUnusableLaneRules({ items: [rule(1, 404)] }, defs, false)).toBe(0)
  })
  it('ignoredRulesText is singular or plural, and Reads as appends it', () => {
    expect(L.ignoredRulesText(1)).toBe('1 filter ignored: you cannot use this field')
    expect(L.ignoredRulesText(2)).toBe('2 filters ignored: you cannot use these fields')
    expect(L.summarizeLaneFilter(undefined, [], (_f, v) => v, 2).readsAs).toBe('Reads as: all lanes shown · 2 filters ignored: you cannot use these fields')
  })
})
