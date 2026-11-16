import { describe, it, expect } from 'vitest'
import { laneRollup, resolveRollupField } from '../utils/laneRollup'
import type { Card, Column, CustomFieldDefinition } from '../types'

// #2275 — the swimlane band's number rollup ("$413k open").

function def(overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id: 7, uid: 'cfuid007', name: 'Amount', field_type: 'number', choices: [],
    position: 0, show_on_card: false, is_required: false, help_text: '',
    number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
    threshold_direction: '', threshold_warn: null, threshold_alert: null, threshold_warn_days: null, threshold_alert_days: null, created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const columns = [
  { id: 1, is_done: false },
  { id: 2, is_done: false },
  { id: 3, is_done: true },
] as Column[]

let nextId = 1
function card(swimlane: number, column: number, value: string | null, extra: Partial<Card> = {}): Card {
  return {
    id: nextId++, swimlane, column, archived_at: null,
    custom_field_values: value === null ? [] : [{ field_definition: 7, value }],
    ...extra,
  } as Card
}

describe('resolveRollupField', () => {
  const defs = [def(), def({ id: 8, name: 'Notes', field_type: 'text' })]

  it('returns the number field the board chose', () => {
    expect(resolveRollupField(7, defs)?.name).toBe('Amount')
  })

  it('is null when nothing is chosen', () => {
    expect(resolveRollupField(null, defs)).toBeNull()
    expect(resolveRollupField(undefined, defs)).toBeNull()
  })

  it('is null when the field is gone or no longer a number field', () => {
    expect(resolveRollupField(99, defs)).toBeNull()
    expect(resolveRollupField(8, defs)).toBeNull()
    expect(resolveRollupField(7, undefined)).toBeNull()
  })
})

describe('laneRollup', () => {
  it('is null without a number field', () => {
    expect(laneRollup(20, null, columns, [card(20, 1, '5')])).toBeNull()
    expect(laneRollup(20, def({ field_type: 'text' }), columns, [card(20, 1, '5')])).toBeNull()
  })

  it('sums the lane\'s cards not in a done column, skipping other lanes and archived cards', () => {
    const cards = [
      card(20, 1, '10'),
      card(20, 2, '5'),
      card(20, 3, '100'), // done column: not open
      card(21, 1, '1000'), // other lane
      card(20, 1, '7', { archived_at: '2026-01-01T00:00:00Z' }),
    ]
    const r = laneRollup(20, def(), columns, cards)!
    expect(r.total).toBe(15)
    expect(r.count).toBe(2)
    expect(r.text).toBe('15')
    expect(r.fieldName).toBe('Amount')
  })

  it('skips missing, blank and non-numeric values rather than hiding the total', () => {
    const cards = [card(20, 1, null), card(20, 1, ''), card(20, 1, '  '), card(20, 1, 'abc'), card(20, 1, '4')]
    expect(laneRollup(20, def(), columns, cards)).toMatchObject({ total: 4, count: 1 })
  })

  it('shows a zero total when the field is chosen but no open card has a value', () => {
    expect(laneRollup(20, def({ number_prefix: '$' }), columns, [card(20, 3, '9')])).toMatchObject({ total: 0, count: 0, text: '$0' })
  })

  it('formats with the field prefix, suffix and decimals', () => {
    const cards = [card(20, 1, '33'), card(20, 2, '380')]
    expect(laneRollup(20, def({ number_prefix: '$', number_suffix: 'k' }), columns, cards)!.text).toBe('$413k')
    expect(laneRollup(20, def({ number_decimals: 2 }), columns, cards)!.text).toBe('413.00')
  })

  it('does not drift on binary fractions', () => {
    const cards = [card(20, 1, '0.1'), card(20, 1, '0.2')]
    expect(laneRollup(20, def(), columns, cards)!.total).toBe(0.3)
  })

  it('handles negative values and a total of minus zero', () => {
    expect(laneRollup(20, def(), columns, [card(20, 1, '-2.5'), card(20, 1, '1')])!.total).toBe(-1.5)
    const zero = laneRollup(20, def(), columns, [card(20, 1, '-0.5'), card(20, 1, '0.5')])!
    expect(Object.is(zero.total, -0)).toBe(false)
    expect(zero.text).toBe('0')
  })

  it('accepts exponent notation', () => {
    expect(laneRollup(20, def(), columns, [card(20, 1, '1e3'), card(20, 1, '1')])!.total).toBe(1001)
  })

  it('reads a card with no custom_field_values array as no value', () => {
    const bare = { id: 999, swimlane: 20, column: 1, archived_at: null } as unknown as Card
    expect(laneRollup(20, def(), columns, [bare, card(20, 1, '2')])).toMatchObject({ total: 2, count: 1 })
  })
})
