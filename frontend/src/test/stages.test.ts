import { describe, it, expect } from 'vitest'
import {
  cardSubColumnIndex, currentStopIndex, gatesOpen, getTrackStates, isDimensionField, isGatedStage, leftWithGatesOpenWarning,
  movementGateNote, moveStops, splitCellBySubColumn, stageSubColumns, subColumnCounts, subColumnNeighbors, trackStateLabel,
} from '../utils/stages'
import { applyStageRemap } from '../hooks/useBoard'
import { subColumnChoices } from '../utils/cardActions'
import { buildFieldRows, describeMovement, getCardTrackStates, pinnedNote } from '../utils/cardPeek'
import type { Card, CardMovement, Column, CustomFieldDefinition, Swimlane } from '../types'

const sub = (id: number, position: number, name: string) => ({ id, uid: `s${id}`, position, name })
const col = (over: Partial<Column> = {}): Column => ({
  id: 1, uid: 'c1', name: 'Discovery', position: 1, color: '#000', wip_limit: null, weight_limit: null,
  allow_card_creation: true, is_done: false, policy: null, sub_columns: [], tracks: [], ...over,
})
const gated = col({ sub_columns: [sub(12, 1, 'Ready'), sub(11, 0, 'Doing')] })
const card = (over: Partial<Card> = {}) => ({ id: 1, column: 1, position: 0, gates_passed: 0, custom_field_values: [], version: 1, ...over }) as unknown as Card

describe('stage structure (#1102)', () => {
  it('treats a column with 0 or 1 sub-columns as plain and sorts sub-columns by position', () => {
    expect(stageSubColumns(col())).toEqual([])
    expect(stageSubColumns(col({ sub_columns: [sub(1, 0, 'Only')] }))).toEqual([])
    expect(stageSubColumns(undefined)).toEqual([])
    expect(stageSubColumns(gated).map((s) => s.name)).toEqual(['Doing', 'Ready'])
    expect(isGatedStage(gated)).toBe(true)
    expect(isGatedStage(col())).toBe(false)
  })

  it('clamps a stale gates_passed into range and reads 0 on a plain column', () => {
    expect(cardSubColumnIndex(card({ gates_passed: 5 }), gated)).toBe(1)
    expect(cardSubColumnIndex(card({ gates_passed: -1 }), gated)).toBe(0)
    expect(cardSubColumnIndex(card({ gates_passed: undefined }), gated)).toBe(0)
    expect(cardSubColumnIndex(card({ gates_passed: 3 }), col())).toBe(0)
  })

  it('splits a cell per sub-column, each in position order', () => {
    const cards = [card({ id: 1, gates_passed: 1, position: 2 }), card({ id: 2, gates_passed: 0, position: 1 }), card({ id: 3, gates_passed: 1, position: 0 })]
    expect(splitCellBySubColumn(cards, gated).map((l) => l.map((c) => c.id))).toEqual([[2], [3, 1]])
    expect(splitCellBySubColumn(cards, col()).map((l) => l.map((c) => c.id))).toEqual([[3, 2, 1]])
  })

  it('counts open gates and warns only when leaving the stage early', () => {
    expect(gatesOpen(card({ gates_passed: 0 }), gated)).toBe(1)
    expect(gatesOpen(card({ gates_passed: 1 }), gated)).toBe(0)
    expect(gatesOpen(card(), col())).toBe(0)
    expect(leftWithGatesOpenWarning(card({ gates_passed: 0 }), gated, 2)).toBe('Left Discovery in Doing, before Ready')
    const three = col({ sub_columns: [sub(1, 0, 'A'), sub(2, 1, 'B'), sub(3, 2, 'C')] })
    expect(leftWithGatesOpenWarning(card({ gates_passed: 0 }), three, 2)).toBe('Left Discovery in A, before C')
    expect(leftWithGatesOpenWarning(card({ gates_passed: 1 }), gated, 2)).toBeNull()
    expect(leftWithGatesOpenWarning(card({ gates_passed: 0 }), gated, 1)).toBeNull()
    expect(leftWithGatesOpenWarning(card({ gates_passed: 0 }), undefined, 2)).toBeNull()
  })

  it('lists keyboard stops with sub-columns between columns (#2327)', () => {
    const cols = [col({ id: 2, name: 'Won', position: 2 }), gated, col({ id: 0, name: 'Lead', position: 0 })]
    const stops = moveStops(cols)
    expect(stops.map((s) => s.label)).toEqual(['Lead', 'Discovery: Doing', 'Discovery: Ready', 'Won'])
    expect(currentStopIndex(card({ column: 1, gates_passed: 1 }), cols)).toBe(2)
    expect(currentStopIndex(card({ column: 0 }), cols)).toBe(0)
    expect(currentStopIndex(card({ column: 99 }), cols)).toBe(-1)
  })

  it('names the neighboring sub-columns and builds the Move to… steps', () => {
    expect(subColumnNeighbors(card({ gates_passed: 0 }), [gated])).toEqual({ previous: null, next: 'Ready' })
    expect(subColumnNeighbors(card({ gates_passed: 1 }), [gated])).toEqual({ previous: 'Doing', next: null })
    expect(subColumnNeighbors(card(), [col()])).toBeNull()
    expect(subColumnChoices(null)).toEqual([])
    expect(subColumnChoices({ previous: 'Doing', next: 'Ready' }).map((c) => [c.label, c.value])).toEqual([
      ['Move back to Doing', 'sub-previous'], ['Move on to Ready', 'sub-next'],
    ])
  })

  it('counts per sub-column with the last sub-column waiting', () => {
    const cards = [card({ gates_passed: 0 }), card({ gates_passed: 1 }), card({ gates_passed: 1 }), card({ column: 2 })]
    expect(subColumnCounts(gated, cards)).toEqual([
      { name: 'Doing', count: 1, state: 'working' },
      { name: 'Ready', count: 2, state: 'waiting' },
    ])
    expect(subColumnCounts(col(), cards)).toEqual([])
  })

  it('notes gate positions on a history move row', () => {
    expect(movementGateNote({ from_gates_open: 2, to_gates_passed: 1 })).toBe('left 2 sub-columns early, entered at sub-column 2')
    expect(movementGateNote({ from_gates_open: 1 })).toBe('left 1 sub-column early')
    expect(movementGateNote({ to_gates_passed: 2 })).toBe('entered at sub-column 3')
    expect(movementGateNote({ from_gates_open: null, to_gates_passed: null })).toBeNull()
  })
})

describe('track states (#1920/#1921)', () => {
  const tech = { id: 41, name: 'Technical', field_type: 'dropdown', is_dimension: true, position: 0, show_on_card: false,
    choice_resolutions: { Done: 'satisfied', 'Not applicable': 'not_applicable', Maybe: 'open' } } as unknown as CustomFieldDefinition
  const biz = { ...tech, id: 42, name: 'Business' } as CustomFieldDefinition
  const stage = col({ tracks: [{ id: 2, field_id: 42, field_uid: 'f42', name: 'Business', position: 1 }, { id: 1, field_id: 41, field_uid: 'f41', name: 'Technical', position: 0 }] })
  const lane = { not_applicable_field_ids: [] } as unknown as Swimlane
  const values = (v41: string, v42 = '') => card({ custom_field_values: [{ field_definition: 41, value: v41 }, { field_definition: 42, value: v42 }] as Card['custom_field_values'] })

  it('resolves done, open and not applicable in track order; unset and unmapped are open', () => {
    expect(getTrackStates(values('Done'), stage, lane, [tech, biz]).map((t) => [t.name, t.state])).toEqual([['Technical', 'done'], ['Business', 'open']])
    expect(getTrackStates(values('Not applicable', 'Maybe'), stage, lane, [tech, biz]).map((t) => t.state)).toEqual(['not_applicable', 'open'])
    expect(getTrackStates(values('Unknown'), stage, lane, [tech, biz])[0].state).toBe('open')
    expect(getTrackStates(values('Done'), stage, lane, undefined)[0].state).toBe('open')
  })

  it('lets a lane mark override the card value', () => {
    const na = { not_applicable_field_ids: [41] } as unknown as Swimlane
    const [t] = getTrackStates(values('Done'), stage, na, [tech, biz])
    expect(t).toEqual({ id: 41, name: 'Technical', state: 'not_applicable', fromLane: true })
  })

  it('shows a renamed field on every stage it is a track on (the column copy is stale)', () => {
    // custom_field.updated replaces only the definitions, so each stage's
    // `tracks[].name` still holds the old name until a reload.
    const renamed = { ...tech, name: 'Engineering' } as CustomFieldDefinition
    const other = col({ id: 2, tracks: [{ id: 9, field_id: 41, name: 'Technical', position: 0 }] as Column['tracks'] })
    for (const column of [stage, other]) {
      expect(getTrackStates(values('Done'), column, lane, [renamed, biz])[0].name).toBe('Engineering')
    }
    const na = { not_applicable_field_ids: [41] } as unknown as Swimlane
    expect(getTrackStates(values('Done'), other, na, [renamed])[0].name).toBe('Engineering')
  })

  it('returns nothing for a column without tracks', () => {
    expect(getTrackStates(values('Done'), col(), lane, [tech])).toEqual([])
    expect(getTrackStates(values('Done'), null, null, [tech])).toEqual([])
  })

  it('labels states in words and flags dimension fields', () => {
    expect(['done', 'open', 'not_applicable'].map((s) => trackStateLabel(s as 'done'))).toEqual(['done', 'open', 'not applicable'])
    expect(isDimensionField(tech)).toBe(true)
    expect(isDimensionField({ is_dimension: undefined })).toBe(false)
  })

  it('feeds the peek seam and keeps dimensions out of its field list and pinned count', () => {
    expect(getCardTrackStates(values('Done'), stage, lane, [tech, biz])).toEqual([
      { id: 41, name: 'Technical', state: 'done', fromLane: false }, { id: 42, name: 'Business', state: 'open', fromLane: false },
    ])
    const plain = { ...tech, id: 7, name: 'Region', is_dimension: false, show_on_card: true } as CustomFieldDefinition
    expect(buildFieldRows(values('Done'), [tech, plain]).map((r) => r.definition.id)).toEqual([7])
    expect(pinnedNote([tech, { ...biz, show_on_card: true } as CustomFieldDefinition, plain])).toBe('1 of 1 pinned to the card')
  })

  it('adds the gate note to a peek history line', () => {
    const m = { movement_type: 'move', from_column: 1, to_column: 2, from_column_name: 'Discovery', to_column_name: 'Won', from_swimlane: 1, to_swimlane: 1, from_gates_open: 1 } as unknown as CardMovement
    expect(describeMovement(m)).toBe('Discovery to Won, left 1 sub-column early')
  })
})

describe('applyStageRemap (#1102 column.updated remapped)', () => {
  it('applies newer remaps and keeps copies already at or past the version', () => {
    const cards = [card({ id: 1, gates_passed: 2, version: 3 }), card({ id: 2, gates_passed: 1, version: 9 }), card({ id: 3 })]
    const out = applyStageRemap(cards, [{ id: 1, gates_passed: 1, version: 4 }, { id: 2, gates_passed: 0, version: 9 }])
    expect(out[0]).toMatchObject({ gates_passed: 1, version: 4 })
    expect(out[1]).toBe(cards[1])
    expect(out[2]).toBe(cards[2])
  })

  it('returns the same array when nothing changes', () => {
    const cards = [card()]
    expect(applyStageRemap(cards, undefined)).toBe(cards)
    expect(applyStageRemap(cards, [])).toBe(cards)
    expect(applyStageRemap(cards, [{ id: 1, gates_passed: 0, version: 1 }])).toBe(cards)
  })
})
