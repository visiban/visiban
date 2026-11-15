import { describe, it, expect } from 'vitest'
import type { Card, CardMovement, Column, CustomFieldDefinition } from '../types'
import { buildFieldRows, buildStatusStrip, computeTimeInColumns, describeMovement, getCardTrackStates, pinnedNote } from '../utils/cardPeek'

const col = (id: number, name: string, position: number): Column => ({
  id, uid: `c${id}`, name, position, color: '#000', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null,
})
const columns = [col(1, 'Prospect', 0), col(2, 'Qualified', 1), col(3, 'Discovery', 2)]
const card = { id: 9, column: 3, swimlane: 5, created_at: '2026-01-01T00:00:00Z', custom_field_values: [{ field_definition: 1, value: '52000' }, { field_definition: 2, value: '' }] } as unknown as Card

function mv(over: Partial<CardMovement>): CardMovement {
  return {
    id: 1, from_column: null, from_column_name: '', to_column: 1, to_column_name: 'Prospect', from_swimlane: null, to_swimlane: 5,
    to_swimlane_name: 'NA', moved_at: '2026-01-01T00:00:00Z', movement_type: 'move', ...over,
  } as unknown as CardMovement
}
const DAY = 86_400_000
const t0 = Date.parse('2026-01-01T00:00:00Z')

describe('buildStatusStrip', () => {
  it('returns previous, current and next by position', () => {
    const s = buildStatusStrip(card, [columns[2], columns[0], columns[1]])
    expect([s.previous?.name, s.current?.name, s.next]).toEqual(['Qualified', 'Discovery', null])
  })
  it('is empty when the column is unknown', () => {
    expect(buildStatusStrip({ ...card, column: 99 }, columns)).toEqual({ previous: null, current: null, next: null })
  })
})

describe('getCardTrackStates', () => {
  it('has no data source yet (#1920), so it returns none', () => {
    expect(getCardTrackStates(card)).toEqual([])
  })
})

describe('computeTimeInColumns', () => {
  it('sums a revisited column, floors days and marks the current one', () => {
    const moves = [
      mv({ id: 1, to_column: 1, to_column_name: 'Prospect', moved_at: new Date(t0).toISOString() }),
      mv({ id: 2, from_column: 1, from_column_name: 'Prospect', to_column: 2, to_column_name: 'Qualified', moved_at: new Date(t0 + 5 * DAY).toISOString() }),
      mv({ id: 3, from_column: 2, from_column_name: 'Qualified', to_column: 1, to_column_name: 'Prospect', moved_at: new Date(t0 + 14 * DAY).toISOString() }),
      mv({ id: 4, from_column: 1, from_column_name: 'Prospect', to_column: 3, to_column_name: 'Discovery', moved_at: new Date(t0 + 16 * DAY).toISOString() }),
      mv({ id: 5, movement_type: 'archived', moved_at: new Date(t0 + 17 * DAY).toISOString() }),
    ]
    const r = computeTimeInColumns(card, moves, columns, t0 + 55 * DAY)
    expect(r.map((d) => [d.name, d.days, d.current])).toEqual([['Prospect', 7, false], ['Qualified', 9, false], ['Discovery', 39, true]])
  })
  it('counts creation time in the origin when the log starts with a move', () => {
    const r = computeTimeInColumns(card, [mv({ from_column: 1, from_column_name: 'Prospect', to_column: 3, to_column_name: 'Discovery', moved_at: new Date(t0 + 3 * DAY).toISOString() })], columns, t0 + 4 * DAY)
    expect(r.map((d) => [d.name, d.days])).toEqual([['Prospect', 3], ['Discovery', 1]])
  })
  it('keeps a deleted column by its recorded name and returns [] with no moves', () => {
    const r = computeTimeInColumns(card, [mv({ to_column: null, to_column_name: 'Gone' })], columns, t0 + DAY)
    expect(r[0]).toMatchObject({ name: 'Gone', days: 1, current: false })
    expect(computeTimeInColumns(card, [], columns)).toEqual([])
  })
})

describe('fields', () => {
  const defs = [
    { id: 2, name: 'Due', position: 1, show_on_card: false },
    { id: 1, name: 'Deal value', position: 0, show_on_card: true },
    { id: 3, name: 'Seats', position: 2, show_on_card: false },
  ] as unknown as CustomFieldDefinition[]
  it('lists every field in order with null for empty or absent values', () => {
    expect(buildFieldRows(card, defs).map((r) => [r.definition.name, r.value])).toEqual([['Deal value', '52000'], ['Due', null], ['Seats', null]])
  })
  it('counts pinned fields', () => {
    expect(pinnedNote(defs)).toBe('1 of 3 pinned to the card')
  })
})

describe('describeMovement', () => {
  it('describes each movement kind', () => {
    expect(describeMovement(mv({}))).toBe('Created in Prospect')
    expect(describeMovement(mv({ to_column: null, to_column_name: '' }))).toBe('Created in a deleted column')
    expect(describeMovement(mv({ from_column: 1, from_column_name: 'Prospect', to_column: 2, to_column_name: 'Qualified' }))).toBe('Prospect to Qualified')
    expect(describeMovement(mv({ from_column: 1, from_column_name: 'Prospect', to_column: 1, to_column_name: 'Prospect', from_swimlane: 4, to_swimlane: 5, to_swimlane_name: 'APAC' }))).toBe('Moved to APAC')
    expect(describeMovement(mv({ movement_type: 'archived' }))).toBe('Archived')
    expect(describeMovement(mv({ movement_type: 'unarchived' }))).toBe('Restored')
  })
})
