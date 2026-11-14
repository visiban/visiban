import { describe, it, expect } from 'vitest'
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

  it('not_contains is the inverse of contains; wildcard matches the whole value (#2227)', () => {
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
      ['Ethan*', ['Ethan Ross'], ['Seth Ethan']],
      ['*ross', ['Ethan Ross'], ['Rossi']],
      ['*ross*', ['Ethan Ross', 'Rossi'], ['Ethan R.']],
      ['e*ross', ['Ethan Ross'], ['Ross Ethan']],
      ['j?n', ['Jan', 'Jon'], ['Jean', 'Jan Smith']],
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
    expect(laneFilterFields(defs, false).map((f) => f.id)).toEqual([1, 3, 6, 8])
    expect(laneFilterFields(defs, true).map((f) => f.id)).toEqual([1, 3, 5, 6, 8, 9])
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
