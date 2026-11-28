import { describe, expect, it } from 'vitest'
import type { Card, Column, CustomFieldDefinition, Swimlane, SwimlaneCustomFieldDefinition } from '../types'
import {
  laneSortAccessibleName,
  laneSortBandValue,
  laneSortOptions,
  laneSortRuleText,
  laneSortSummary,
  newLaneSort,
  parseLaneSortParams,
  sortLanes,
  writeLaneSortParams,
  type LaneSort,
  type LaneSortContext,
} from '../utils/laneSort'

// #2698 — the lane sort comparator, URL state and summary text.

const lane = (id: number, name: string, extra: Partial<Swimlane> = {}): Swimlane =>
  ({ id, name, position: id, custom_field_values: [], wip_limit: null, limit_column_ids: null, effective_health_status: null, ...extra }) as Swimlane
const val = (field: number, value: string) => ({ field_definition: field, value })
const laneField = (id: number, name: string, field_type: string, extra: Partial<SwimlaneCustomFieldDefinition> = {}) =>
  ({ id, name, field_type, choices: [], is_admin_only: false, ...extra }) as SwimlaneCustomFieldDefinition
const cardField = (id: number, name: string, field_type = 'number') => ({ id, name, field_type }) as CustomFieldDefinition
const card = (id: number, swimlane: number, extra: Partial<Card> = {}) =>
  ({ id, swimlane, column: 1, archived_at: null, weight: 0, custom_field_values: [], ...extra }) as Card
const columns = [{ id: 1, is_done: false }, { id: 2, is_done: true }] as Column[]
const ctx = (cards: Card[] = [], shown: Set<number> | null = null): LaneSortContext => ({ cards, columns, shownCardIds: shown })

const fields = [
  laneField(10, 'Tier', 'text'),
  laneField(11, 'Seats', 'number'),
  laneField(12, 'Renewal', 'date'),
  laneField(13, 'Priority', 'dropdown', { choices: ['Critical', 'High', 'Low'] }),
  laneField(14, 'Regions', 'multi_select', { choices: ['EMEA', 'APAC', 'AMER'] }),
  laneField(15, 'Strategic', 'checkbox'),
  laneField(16, 'Secret', 'text', { is_admin_only: true }),
]
const options = laneSortOptions(fields, [cardField(30, 'Points'), cardField(31, 'Notes', 'text')], true)
const names = (ls: Swimlane[]) => ls.map((l) => l.name)
const by = (key: string, extra: Partial<LaneSort> = {}): LaneSort => ({ ...newLaneSort(key), ...extra })

describe('laneSortOptions (#2698)', () => {
  it('groups Lane, Custom fields and Computed, with Sum only for number card fields', () => {
    expect(options.map((o) => `${o.group}:${o.label}`)).toEqual([
      'Lane:Name', 'Lane:Health',
      'Custom fields:Tier', 'Custom fields:Seats', 'Custom fields:Renewal', 'Custom fields:Priority', 'Custom fields:Regions', 'Custom fields:Strategic', 'Custom fields:Secret',
      'Computed:Card count', 'Computed:WIP usage', 'Computed:Sum of Points',
    ])
  })
  it('leaves out an admin-only field for a member', () => {
    expect(laneSortOptions(fields, [], false).some((o) => o.label === 'Secret')).toBe(false)
  })
  it('labels directions by type', () => {
    const dirs = Object.fromEntries(options.map((o) => [o.label, o.directions]))
    expect(dirs.Name).toEqual(['A → Z', 'Z → A'])
    expect(dirs.Seats).toEqual(['Highest first', 'Lowest first'])
    expect(dirs.Renewal).toEqual(['Newest first', 'Oldest first'])
    expect(dirs.Priority).toEqual(['Critical → Low', 'Low → Critical'])
    expect(dirs.Regions).toEqual(['Option order', 'Reverse option order'])
    expect(dirs.Strategic).toEqual(['Checked first', 'Unchecked first'])
    expect(dirs.Health).toEqual(['Off track → On track', 'On track → Off track'])
    expect(dirs['Card count']).toEqual(['Most first', 'Fewest first'])
    expect(dirs['WIP usage']).toEqual(['Fullest first', 'Emptiest first'])
    expect(dirs['Sum of Points']).toEqual(['Highest first', 'Lowest first'])
  })
})

describe('sortLanes by field type (#2698)', () => {
  it('sorts text naturally, ignoring case and accents', () => {
    const ls = [lane(1, 'Team 10'), lane(2, 'team 2'), lane(3, 'Émile'), lane(4, 'alpha')]
    expect(names(sortLanes(ls, by('name'), options, ctx()).ordered)).toEqual(['alpha', 'Émile', 'team 2', 'Team 10'])
    expect(names(sortLanes(ls, by('name', { reverse: true }), options, ctx()).ordered)).toEqual(['Team 10', 'team 2', 'Émile', 'alpha'])
  })
  it('sorts numbers highest first, dates newest first', () => {
    const ls = [lane(1, 'A', { custom_field_values: [val(11, '5'), val(12, '2026-01-01')] }), lane(2, 'B', { custom_field_values: [val(11, '50'), val(12, '2026-06-01')] })]
    expect(names(sortLanes(ls, by('f:11'), options, ctx()).ordered)).toEqual(['B', 'A'])
    expect(names(sortLanes(ls, by('f:11', { reverse: true }), options, ctx()).ordered)).toEqual(['A', 'B'])
    expect(names(sortLanes(ls, by('f:12'), options, ctx()).ordered)).toEqual(['B', 'A'])
  })
  it('sorts single select in option order and multi-select by its first selected option', () => {
    const ls = [
      lane(1, 'A', { custom_field_values: [val(13, 'Low'), val(14, '["AMER"]')] }),
      lane(2, 'B', { custom_field_values: [val(13, 'Critical'), val(14, '["AMER","APAC"]')] }),
      lane(3, 'C', { custom_field_values: [val(13, 'High'), val(14, '["EMEA"]')] }),
    ]
    expect(names(sortLanes(ls, by('f:13'), options, ctx()).ordered)).toEqual(['B', 'C', 'A'])
    expect(names(sortLanes(ls, by('f:14'), options, ctx()).ordered)).toEqual(['C', 'B', 'A'])
  })
  it('sorts checkbox checked first and health worst first (no status = no value)', () => {
    const ls = [
      lane(1, 'A', { custom_field_values: [val(15, 'false')], effective_health_status: 'on_track' }),
      lane(2, 'B', { custom_field_values: [val(15, 'true')], effective_health_status: null }),
      lane(3, 'C', { effective_health_status: 'off_track' }),
    ]
    expect(names(sortLanes(ls, by('f:15'), options, ctx()).ordered)).toEqual(['B', 'A', 'C'])
    const health = sortLanes(ls, by('health'), options, ctx())
    expect(names(health.ordered)).toEqual(['C', 'A', 'B'])
    expect([...health.noValueIds]).toEqual([2])
  })
  it('counts shown cards for Card count and Sum while a card filter is on; zero cards is 0, not no value', () => {
    const ls = [lane(1, 'A'), lane(2, 'B'), lane(3, 'Empty')]
    const pts = (n: string) => ({ custom_field_values: [val(30, n)] })
    const cards = [card(1, 1, pts('1')), card(2, 1, pts('1')), card(3, 1, pts('1')), card(4, 2, pts('8')), card(5, 2)]
    expect(names(sortLanes(ls, by('card_count'), options, ctx(cards)).ordered)).toEqual(['A', 'B', 'Empty'])
    // With a filter showing only B's cards, B outranks A, matching what the band shows.
    const shown = new Set([4, 5])
    expect(names(sortLanes(ls, by('card_count'), options, ctx(cards, shown)).ordered)).toEqual(['B', 'A', 'Empty'])
    const sum = sortLanes(ls, by('sum:30'), options, ctx(cards))
    expect(names(sum.ordered)).toEqual(['B', 'A', 'Empty'])
    expect([...sum.noValueIds]).toEqual([3])
    const opt = options.find((o) => o.key === 'card_count')
    expect(laneSortBandValue(ls[0], opt, ctx(cards))).toBe('3 cards')
    expect(laneSortBandValue(ls[1], opt, ctx(cards, shown))).toBe('2 cards shown')
    expect(laneSortBandValue(ls[2], opt, ctx(cards))).toBe('0 cards')
    expect(laneSortBandValue(ls[0], options.find((o) => o.key === 'name'), ctx(cards))).toBeNull()
  })
  it('sorts WIP usage on the whole lane, no limit = no value', () => {
    const ls = [lane(1, 'Half', { wip_limit: 4 }), lane(2, 'Full', { wip_limit: 2 }), lane(3, 'None')]
    const cards = [card(1, 1), card(2, 1), card(3, 2), card(4, 2), card(5, 2, { column: 2 })]
    // A card filter does not change WIP usage.
    const r = sortLanes(ls, by('wip'), options, ctx(cards, new Set([1])))
    expect(names(r.ordered)).toEqual(['Full', 'Half', 'None'])
    expect([...r.noValueIds]).toEqual([3])
  })
})

describe('sortLanes rules (#2698)', () => {
  const ls = [
    lane(1, 'One', { custom_field_values: [val(13, 'High')] }),
    lane(2, 'Two'),
    lane(3, 'Three', { custom_field_values: [val(13, 'High')] }),
    lane(4, 'Four', { custom_field_values: [val(13, 'Critical')] }),
    lane(5, 'Five'),
  ]
  it('keeps no-value lanes last in both directions, in board order', () => {
    expect(names(sortLanes(ls, by('f:13'), options, ctx()).ordered)).toEqual(['Four', 'One', 'Three', 'Two', 'Five'])
    expect(names(sortLanes(ls, by('f:13', { reverse: true }), options, ctx()).ordered)).toEqual(['One', 'Three', 'Four', 'Two', 'Five'])
  })
  it('puts no-value lanes first when asked, but below pins', () => {
    expect(names(sortLanes(ls, by('f:13', { emptyFirst: true, pins: [3] }), options, ctx()).ordered)).toEqual(['Three', 'Two', 'Five', 'Four', 'One'])
  })
  it('breaks ties with the tie-breaker in its default direction, then board order', () => {
    expect(names(sortLanes(ls, by('f:13', { then: 'name' }), options, ctx()).ordered)).toEqual(['Four', 'One', 'Three', 'Two', 'Five'])
    expect(names(sortLanes(ls, by('f:13', { then: 'name', reverse: true }), options, ctx()).ordered).slice(0, 2)).toEqual(['One', 'Three'])
    const t = [lane(1, 'B', { custom_field_values: [val(13, 'High')] }), lane(2, 'A', { custom_field_values: [val(13, 'High')] })]
    expect(names(sortLanes(t, by('f:13', { then: 'name' }), options, ctx()).ordered)).toEqual(['A', 'B'])
    expect(names(sortLanes(t, by('f:13'), options, ctx()).ordered)).toEqual(['B', 'A'])
  })
  it('keeps pinned lanes on top in board order, ignoring the sort', () => {
    expect(names(sortLanes(ls, by('f:13', { pins: [5, 2] }), options, ctx()).ordered)).toEqual(['Two', 'Five', 'Four', 'One', 'Three'])
  })
  it('reports a field no lane has a value for', () => {
    const r = sortLanes(ls, by('f:11'), options, ctx())
    expect(r.noValuesYet).toBe(true)
    expect(names(r.ordered)).toEqual(names(ls))
  })
  it('leaves the order alone for an unknown key and never mutates positions', () => {
    const before = ls.map((l) => l.position)
    expect(names(sortLanes(ls, by('f:999'), options, ctx()).ordered)).toEqual(names(ls))
    sortLanes(ls, by('name'), options, ctx())
    expect(ls.map((l) => l.position)).toEqual(before)
  })
})

describe('lane sort URL state (#2698)', () => {
  it('round-trips and never writes defaults', () => {
    expect(writeLaneSortParams(new URLSearchParams('view=board'), by('name')).toString()).toBe('view=board&lsort=name')
    const full = by('f:13', { reverse: true, then: 'name', emptyFirst: true, pins: [3, 1], keepSorted: false })
    const p = writeLaneSortParams(new URLSearchParams(), full)
    expect(parseLaneSortParams(p)).toEqual(full)
    expect(writeLaneSortParams(p, null).toString()).toBe('')
  })
  it('ignores unknown and malformed values', () => {
    expect(parseLaneSortParams(new URLSearchParams('lsort=drop table'))).toBeNull()
    expect(parseLaneSortParams(new URLSearchParams('lsort=name&lsort_dir=sideways&lsort_then=name&lsort_empty=x&lsort_pins=1,x,1,2'))).toEqual(
      { ...by('name'), pins: [1, 2] },
    )
  })
})

describe('lane sort summary and accessible name (#2698)', () => {
  it('reads Board order with no sort', () => {
    expect(laneSortSummary(null, options, 0)).toBe('Lanes: Board order')
    expect(laneSortAccessibleName(null, options, 0)).toBe('Lanes: Board order. Change lane order')
  })
  it('uses arrows, A→Z for text, and +N for the extra rules', () => {
    expect(laneSortSummary(by('f:13'), options, 0)).toBe('Lanes: Sorted by Priority ↓')
    expect(laneSortSummary(by('f:13', { reverse: true }), options, 0)).toBe('Lanes: Sorted by Priority ↑')
    expect(laneSortSummary(by('name'), options, 0)).toBe('Lanes: Sorted by Name A→Z')
    expect(laneSortSummary(by('f:13', { then: 'name' }), options, 1)).toBe('Lanes: Sorted by Priority ↓ +2')
    expect(laneSortSummary(by('f:13', { then: 'name', emptyFirst: true }), options, 3)).toBe('Lanes: Sorted by Priority ↓ +3')
    // Name always has a value, so "no value first" is not a rule there.
    expect(laneSortSummary(by('name', { emptyFirst: true }), options, 0)).toBe('Lanes: Sorted by Name A→Z')
  })
  it('spells the full rule, reading → as "to"', () => {
    const s = by('f:13', { then: 'name' })
    expect(laneSortRuleText(s, options, 1)).toBe('Priority, Critical → Low. Then Name, A → Z. 1 lane pinned. Lanes with no value last.')
    expect(laneSortAccessibleName(s, options, 1)).toBe(
      'Lanes: Sorted by Priority, Critical to Low. Then Name, A to Z. 1 lane pinned. Lanes with no value last. Change lane order',
    )
    expect(laneSortRuleText(by('card_count'), options, 2)).toBe('Card count, Most first. 2 lanes pinned.')
  })
})
