import { describe, it, expect } from 'vitest'
import { applyValueHit, matchRange, parseShorthand, searchFields, type SearchContext } from '../utils/filterFieldSearch'
import { EMPTY_FILTER } from '../components/Board/FilterBar'
import { laneFilterFields } from '../utils/laneFilter'
import { resolveLaneTiers } from '../utils/laneBand'

const cardFields = [
  { id: 1, name: 'Region', field_type: 'dropdown', choices: ['EMEA', 'APAC'] },
  { id: 2, name: 'Budget', field_type: 'number' },
  { id: 3, name: 'Go live', field_type: 'date' },
  { id: 4, name: 'Notes', field_type: 'text' },
  { id: 5, name: 'Spec', field_type: 'url' },
  { id: 6, name: 'Approved', field_type: 'checkbox' },
  { id: 7, name: 'Platforms', field_type: 'multi_select', choices: ['iOS', 'Web', 'Android'] },
]
const cv = (field_definition: number, value: string) => ({ field_definition, value })
const cards = [
  { custom_field_values: [cv(1, 'EMEA'), cv(2, '1200'), cv(3, '2026-11-20'), cv(4, 'Ship the beta'), cv(5, 'https://x.test/spec'), cv(6, 'true'), cv(7, '["iOS","Web"]')] },
  { custom_field_values: [cv(1, 'EMEA'), cv(7, '["Web"]')] },
  { custom_field_values: [] },
  { custom_field_values: [cv(1, 'APAC'), cv(4, 'Beta feedback')] },
]
const laneDefs = [
  { id: 50, uid: 'a', name: 'Tier', field_type: 'dropdown', choices: ['gold', 'silver'], is_admin_only: false, position: 0, band_visibility: 'hidden' },
  { id: 51, uid: 'b', name: 'Secret code', field_type: 'text', choices: [], is_admin_only: true, position: 1, band_visibility: 'band' },
  { id: 52, uid: 'c', name: 'Stack', field_type: 'multi_select', choices: ['go', 'rust'], is_admin_only: false, position: 2, band_visibility: 'details' },
  { id: 53, uid: 'd', name: 'Seats', field_type: 'number', choices: [], is_admin_only: false, position: 3, band_visibility: 'details' },
  { id: 54, uid: 'e', name: 'Active', field_type: 'checkbox', choices: [], is_admin_only: false, position: 4, band_visibility: 'details' },
]
const lanes = [
  { name: 'Acme', contact_email: 'boss@acme.test', custom_field_values: [cv(50, 'gold'), cv(51, 'hunter2'), cv(52, '["go","rust"]'), cv(53, '40'), cv(54, 'true')] },
  { name: 'Bolt', contact_email: '', custom_field_values: [cv(50, 'silver'), cv(51, 'swordfish')] },
]

function ctx(over: Partial<SearchContext> & { isAdmin?: boolean } = {}): SearchContext {
  const isAdmin = over.isAdmin
  return {
    cardFields,
    laneFields: laneFilterFields(laneDefs as never, isAdmin),
    cards: cards as never,
    lanes: lanes as never,
    isAdmin,
    tiers: resolveLaneTiers(laneDefs as never, 6),
    ...over,
  }
}

describe('matchRange / parseShorthand', () => {
  it('matches case-insensitively and rejects an empty needle', () => {
    expect(matchRange('Region', 'REG')).toEqual([0, 3])
    expect(matchRange('Region', ' ')).toBeNull()
    expect(matchRange('Region', 'zz')).toBeNull()
  })
  it('splits field:value and ignores a leading colon', () => {
    expect(parseShorthand('tier:gold')).toEqual({ field: 'tier', value: 'gold' })
    expect(parseShorthand('tier:')).toEqual({ field: 'tier', value: '' })
    expect(parseShorthand(':gold')).toBeNull()
    expect(parseShorthand('plain')).toBeNull()
  })
})

describe('searchFields value hits per field type (#2437)', () => {
  const vals = (q: string, scope: 'all' | 'card' | 'lane' = 'card') => searchFields(q, scope, ctx({ isAdmin: true })).values

  it('empty query returns nothing', () => {
    expect(searchFields('  ', 'all', ctx())).toEqual({ names: [], values: [], titleQuery: null, shorthand: null })
  })
  it('dropdown: matches choices and counts cards', () => {
    expect(vals('emea')).toEqual([expect.objectContaining({ fieldName: 'Region', raw: 'EMEA', count: 2 })])
  })
  it('number: matches the stored text', () => {
    expect(vals('120')).toEqual([expect.objectContaining({ fieldName: 'Budget', raw: '1200', count: 1 })])
  })
  it('date: matches the formatted text and the stored ISO text', () => {
    const fmt = { format: (_s: string, _f: unknown, raw: string) => raw.split('-').reverse().join('/') }
    const hit = searchFields('20/11', 'card', ctx({ isAdmin: true, ...fmt } as never)).values
    expect(hit).toEqual([expect.objectContaining({ fieldName: 'Go live', raw: '2026-11-20' })])
    expect(vals('2026-11')).toEqual([expect.objectContaining({ fieldName: 'Go live', count: 1 })])
  })
  it('text: distinct values, with the card count', () => {
    expect(vals('beta').map((h) => h.raw).sort()).toEqual(['Beta feedback', 'Ship the beta'])
  })
  it('url: matches the stored link', () => {
    expect(vals('x.test')).toEqual([expect.objectContaining({ fieldName: 'Spec', count: 1 })])
  })
  it('checkbox: Yes and No, with a missing row counted as No (#1848)', () => {
    expect(vals('yes')).toEqual([expect.objectContaining({ fieldName: 'Approved', raw: 'true', label: 'Yes', count: 1 })])
    expect(vals('no').find((h) => h.fieldName === 'Approved')).toMatchObject({ raw: 'false', label: 'No', count: 3 })
  })
  it('multi-select: matches ENTRIES, never the JSON punctuation', () => {
    expect(vals('web')).toEqual([expect.objectContaining({ fieldName: 'Platforms', raw: 'Web', count: 2 })])
    expect(vals('["')).toEqual([])
    expect(vals('ios')).toEqual([expect.objectContaining({ raw: 'iOS', count: 1 })])
  })
  it('lane fields: dropdown, multi-select, number and checkbox count lanes', () => {
    const lane = (q: string) => searchFields(q, 'lane', ctx({ isAdmin: true })).values
    expect(lane('gold')).toEqual([expect.objectContaining({ fieldName: 'Tier', raw: 'gold', count: 1, scope: 'lane' })])
    expect(lane('rust')).toEqual([expect.objectContaining({ fieldName: 'Stack', raw: 'rust', count: 1 })])
    expect(lane('40')).toEqual([expect.objectContaining({ fieldName: 'Seats', raw: '40' })])
    expect(lane('yes')).toEqual([expect.objectContaining({ fieldName: 'Active', raw: 'true', count: 1 })])
  })
  it('built-in lane fields: lane name and health label', () => {
    const lane = searchFields('acme', 'lane', ctx({ isAdmin: true })).values
    expect(lane).toContainEqual(expect.objectContaining({ fieldName: 'Lane name', raw: 'Acme', count: 1 }))
  })
  it('caps value rows per field', () => {
    const many = { custom_field_values: [] as { field_definition: number; value: string }[] }
    const big = Array.from({ length: 20 }, (_, i) => ({ custom_field_values: [cv(4, `note ${i}`)] }))
    void many
    const r = searchFields('note', 'card', ctx({ cards: big as never }))
    expect(r.values.length).toBe(5)
  })
})

describe('name hits, scope, title row and shorthand', () => {
  it('names match case-insensitively in both scopes; scope narrows', () => {
    const all = searchFields('re', 'all', ctx({ isAdmin: true }))
    expect(all.names.map((h) => h.name)).toContain('Region')
    const lane = searchFields('tier', 'lane', ctx({ isAdmin: true }))
    expect(lane.names.map((h) => h.name)).toEqual(['Tier'])
    expect(searchFields('tier', 'card', ctx({ isAdmin: true })).names).toEqual([])
  })
  it('the Title-contains row is offered for all/card, never for lane scope', () => {
    expect(searchFields('abc', 'all', ctx()).titleQuery).toBe('abc')
    expect(searchFields('abc', 'card', ctx()).titleQuery).toBe('abc')
    expect(searchFields('abc', 'lane', ctx()).titleQuery).toBeNull()
  })
  it('field:value jumps to that field value only', () => {
    const r = searchFields('tier:gold', 'all', ctx({ isAdmin: true }))
    expect(r.names).toEqual([])
    expect(r.titleQuery).toBeNull()
    expect(r.shorthand).toEqual({ field: 'tier', value: 'gold' })
    expect(r.values).toEqual([expect.objectContaining({ fieldName: 'Tier', raw: 'gold' })])
  })
  it('field: with no value lists the field as a name hit; an unknown field falls back to plain text', () => {
    expect(searchFields('tier:', 'all', ctx({ isAdmin: true })).names.map((h) => h.name)).toEqual(['Tier'])
    const r = searchFields('nope:beta', 'all', ctx({ isAdmin: true }))
    expect(r.shorthand).toBeNull()
    expect(r.titleQuery).toBe('nope:beta')
  })
})

describe('hidden on band (#2439)', () => {
  it('a Hidden lane field is searchable by name and value and is labeled', () => {
    const r = searchFields('tier', 'lane', ctx({ isAdmin: true }))
    expect(r.names[0]).toMatchObject({ name: 'Tier', hiddenOnBand: true })
    expect(searchFields('gold', 'lane', ctx({ isAdmin: true })).values[0]).toMatchObject({ hiddenOnBand: true })
  })
  it('a Details or Band field is not labeled', () => {
    expect(searchFields('rust', 'lane', ctx({ isAdmin: true })).values[0].hiddenOnBand).toBe(false)
  })
})

describe('admin-only lane fields never leak (#1075)', () => {
  const leaks = (isAdmin: boolean | undefined, over: Partial<SearchContext> = {}) => {
    const out = [
      ...searchFields('secret', 'all', ctx({ isAdmin, ...over })).names.map((h) => h.name),
      ...searchFields('hunter2', 'all', ctx({ isAdmin, ...over })).values.map((h) => h.label),
      ...searchFields('swordfish', 'all', ctx({ isAdmin, ...over })).values.map((h) => h.label),
      ...searchFields('boss@acme', 'all', ctx({ isAdmin, ...over })).values.map((h) => h.label),
      ...searchFields('contact', 'all', ctx({ isAdmin, ...over })).names.map((h) => h.name),
      ...searchFields('secret code:hunter', 'all', ctx({ isAdmin, ...over })).values.map((h) => h.label),
    ]
    return out
  }
  it('an admin sees them', () => {
    expect(leaks(true)).toContain('Secret code')
    expect(leaks(true)).toContain('hunter2')
  })
  it('a non-admin sees neither names nor values', () => {
    expect(leaks(false)).toEqual([])
  })
  it('an absent role is a non-admin', () => {
    expect(leaks(undefined)).toEqual([])
  })
  it('even a caller that passes the raw, unfiltered lane fields cannot leak them', () => {
    expect(leaks(false, { laneFields: laneDefs as never })).toEqual([])
    expect(leaks(undefined, { laneFields: laneDefs as never })).toEqual([])
  })
})

describe('applyValueHit', () => {
  const hitFor = (q: string, scope: 'card' | 'lane') => searchFields(q, scope, ctx({ isAdmin: true })).values[0]
  it('card dropdown adds to existing values once', () => {
    const once = applyValueHit(EMPTY_FILTER, hitFor('emea', 'card'))
    expect(once.customFields[1]).toEqual({ kind: 'choice', values: ['EMEA'] })
    const apac = applyValueHit(once, hitFor('apac', 'card'))
    expect(apac.customFields[1]).toEqual({ kind: 'choice', values: ['EMEA', 'APAC'] })
    expect(applyValueHit(apac, hitFor('apac', 'card')).customFields[1]).toEqual({ kind: 'choice', values: ['EMEA', 'APAC'] })
  })
  it('card multi-select, checkbox, number, date and text', () => {
    expect(applyValueHit(EMPTY_FILTER, hitFor('ios', 'card')).customFields[7]).toEqual({ kind: 'multi_choice', values: ['iOS'] })
    expect(applyValueHit(EMPTY_FILTER, hitFor('yes', 'card')).customFields[6]).toEqual({ kind: 'choice', values: ['true'] })
    expect(applyValueHit(EMPTY_FILTER, hitFor('120', 'card')).customFields[2]).toEqual({ kind: 'number', equals: '1200' })
    expect(applyValueHit(EMPTY_FILTER, hitFor('2026-11', 'card')).customFields[3]).toEqual({ kind: 'date', equals: '2026-11-20' })
    expect(applyValueHit(EMPTY_FILTER, hitFor('ship', 'card')).customFields[4]).toEqual({ kind: 'text', query: 'Ship the beta' })
  })
  it('a lane value becomes an is rule, once; a number becomes a between rule', () => {
    const one = applyValueHit(EMPTY_FILTER, hitFor('gold', 'lane'))
    expect(one.laneFilter?.items).toEqual([expect.objectContaining({ kind: 'rule', field: 50, op: 'is', value: 'gold', join: 'and' })])
    expect(applyValueHit(one, hitFor('gold', 'lane'))).toBe(one)
    const num = applyValueHit(EMPTY_FILTER, hitFor('40', 'lane'))
    expect(num.laneFilter?.items[0]).toMatchObject({ field: 53, op: 'between', min: '40', max: '40' })
    const two = applyValueHit(one, hitFor('rust', 'lane'))
    expect(two.laneFilter?.items.map((i) => i.id)).toEqual([1, 2])
  })
})

describe('applyValueHit on a multi-select lane rule (#2659)', () => {
  const hit = (raw: string) => ({ kind: 'value', scope: 'lane', fieldId: 52, fieldName: 'Stack', fieldType: 'multi_select', raw, label: raw, count: 1, hiddenOnBand: false }) as never
  const withRule = (rule: object) => ({ ...EMPTY_FILTER, laneFilter: { items: [{ kind: 'rule', id: 1, join: 'and', field: 52, op: 'is', ...rule }] } }) as never

  it('picking a value the rule already holds is a no-op', () => {
    const f = withRule({ values: ['go', 'rust'] })
    expect(applyValueHit(f, hit('go'))).toBe(f)
  })
  it('picking a new value merges into the rule rather than adding an and-rule', () => {
    const next = applyValueHit(withRule({ values: ['go', 'rust'] }), hit('zig')) as unknown as { laneFilter: { items: Array<Record<string, unknown>> } }
    expect(next.laneFilter.items).toHaveLength(1)
    expect(next.laneFilter.items[0]).toMatchObject({ field: 52, op: 'is', values: ['go', 'rust', 'zig'] })
  })
  it('merged values follow the field choice order, not the pick order', () => {
    const h = (raw: string) => ({ ...(hit(raw) as object), choices: ['A', 'B', 'C'] }) as never
    const first = applyValueHit(EMPTY_FILTER, h('B'))
    const next = applyValueHit(first, h('A')) as unknown as { laneFilter: { items: Array<Record<string, unknown>> } }
    expect(next.laneFilter.items[0]).toMatchObject({ values: ['A', 'B'] })
  })
  it('searchFields carries the choice order on a choice-field hit', () => {
    expect(searchFields('go', 'lane', ctx({ isAdmin: true })).values.find((v) => v.fieldId === 52)?.choices).toEqual(['go', 'rust'])
  })
  it('a single-value rule becomes a values rule with two entries', () => {
    const next = applyValueHit(withRule({ value: 'go' }), hit('rust')) as unknown as { laneFilter: { items: Array<Record<string, unknown>> } }
    expect(next.laneFilter.items).toHaveLength(1)
    expect(next.laneFilter.items[0]).toMatchObject({ values: ['go', 'rust'], value: undefined })
  })
})
