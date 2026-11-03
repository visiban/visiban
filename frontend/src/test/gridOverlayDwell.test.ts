/**
 * The dwell overlay's arithmetic (#459): the browser's half of the *Flow metric
 * definitions* ADR. What counts as a visit is the server's (`column_entered_at`,
 * tested in backend/boards/tests/test_column_entered_at_459.py); this file covers
 * the median, the cell rules, and what the reading says.
 */
import { describe, it, expect } from 'vitest'
import { dwellOverlay, nearestRankMedian } from '../gridOverlays/builtin/dwell'
import { buildGridOverlayState } from '../gridOverlays/slot'
import { getGridOverlay, listGridOverlays } from '../gridOverlays/registry'
import { cellKey } from '../gridOverlays/types'
import type { GridOverlayContext } from '../gridOverlays/types'
import type { Card, Column, Swimlane } from '../types'

const NOW = Date.UTC(2026, 10, 3, 12)
const DAY = 86_400_000

function makeColumn(id: number, is_done = false): Column {
  return { id, uid: `col${id}`, name: `Col ${id}`, position: id, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done, policy: null }
}

function makeSwimlane(id: number): Swimlane {
  return { id, uid: `lane${id}`, name: `Lane ${id}`, contact_email: '', notes: '', position: id, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null }
}

let nextId = 1
function makeCard(column: number, swimlane: number, days: number | null | undefined): Card {
  const id = nextId++
  return {
    id, uid: `card${id}`, column, swimlane, title: `Card ${id}`, description: '',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: 0, created_by: null, created_at: '', updated_at: '', last_moved_at: null,
    column_entered_at: typeof days === 'number' ? new Date(NOW - days * DAY).toISOString() : days,
    attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
    version: 1, custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
  }
}

function ctx(cards: Card[], overrides: Partial<GridOverlayContext> = {}): GridOverlayContext {
  return { columns: [makeColumn(1), makeColumn(2)], swimlanes: [makeSwimlane(1), makeSwimlane(2)], cards, isFiltered: false, now: NOW, ...overrides }
}

const KEY = cellKey(1, 1)

describe('nearestRankMedian', () => {
  it.each([
    [[5], 5],
    [[1, 9], 1],
    [[1, 2, 9], 2],
    [[1, 2, 3, 100], 2],
    [[1, 2, 3, 4, 100], 3],
  ])('%j -> %s: a real card\'s value, the lower middle for an even count', (sorted, expected) => {
    expect(nearestRankMedian(sorted)).toBe(expected)
  })
})

describe('dwellOverlay', () => {
  it('registers under its persisted id, after the 1.2 overlays', () => {
    expect(getGridOverlay('dwell')).toBe(dwellOverlay)
    expect(listGridOverlays().map((o) => o.id)).toEqual(['none', 'card-count', 'dwell'])
  })

  it('reports the median in days, resisting an outlier as a mean would not', () => {
    const cells = dwellOverlay.compute(ctx([makeCard(1, 1, 2), makeCard(1, 1, 3), makeCard(1, 1, 300)]))
    expect(cells.get(KEY)).toEqual({ value: 3, label: 'median dwell 3.0 days' })
  })

  it('keeps cells apart: columns and swimlanes each have their own median', () => {
    const cells = dwellOverlay.compute(ctx([makeCard(1, 1, 2), makeCard(2, 1, 6), makeCard(1, 2, 9)]))
    expect(cells.get(cellKey(1, 1))!.value).toBe(2)
    expect(cells.get(cellKey(2, 1))!.value).toBe(6)
    expect(cells.get(cellKey(1, 2))!.value).toBe(9)
  })

  it('applies no sample-size floor: one card is a value', () => {
    expect(dwellOverlay.compute(ctx([makeCard(1, 1, 1.5)])).get(KEY)!.value).toBe(1.5)
  })

  it('leaves empty cells out', () => {
    expect(dwellOverlay.compute(ctx([])).size).toBe(0)
  })

  it('leaves a done column out, even if its cards still hold a time', () => {
    const cells = dwellOverlay.compute(ctx([makeCard(1, 1, 9)], { columns: [makeColumn(1, true)] }))
    expect(cells.size).toBe(0)
  })

  it.each([[null], [undefined], ['not a date']])('treats column_entered_at %s as unmeasured', (entered) => {
    const card = { ...makeCard(1, 1, 1), column_entered_at: entered as string | null | undefined }
    expect(dwellOverlay.compute(ctx([card])).size).toBe(0)
  })

  it('says so when a card in the cell could not be measured', () => {
    const cells = dwellOverlay.compute(ctx([makeCard(1, 1, 2), makeCard(1, 1, null)]))
    expect(cells.get(KEY)).toEqual({ value: 2, label: 'median dwell 2.0 days, 1 of 2 cards measured' })
  })

  it('says "matching cards" while a filter is active', () => {
    const one = dwellOverlay.compute(ctx([makeCard(1, 1, 2)], { isFiltered: true }))
    expect(one.get(KEY)!.label).toBe('median dwell 2.0 days across matching cards')
    const partial = dwellOverlay.compute(ctx([makeCard(1, 1, 2), makeCard(1, 1, null)], { isFiltered: true }))
    expect(partial.get(KEY)!.label).toBe('median dwell 2.0 days, 1 of 2 matching cards measured')
  })

  it('reads a time ahead of the clock as just arrived, not as a negative dwell', () => {
    const cells = dwellOverlay.compute(ctx([makeCard(1, 1, -0.001)]))
    expect(cells.get(KEY)!.value).toBe(0)
  })

  it('is pure: the same context gives the same values, whatever the wall clock says', () => {
    const cards = [makeCard(1, 1, 2)]
    expect(dwellOverlay.compute(ctx(cards))).toEqual(dwellOverlay.compute(ctx(cards)))
    expect(dwellOverlay.compute(ctx(cards, { now: NOW + DAY })).get(KEY)!.value).toBe(3)
  })

  it('does not reorder or mutate the cards it is given', () => {
    const cards = [makeCard(1, 1, 9), makeCard(1, 1, 1)]
    const copy = [...cards]
    dwellOverlay.compute(ctx(cards))
    expect(cards).toEqual(copy)
  })
})

describe('dwellOverlay legend note', () => {
  const note = (cards: Card[], overrides: Partial<GridOverlayContext> = {}) => dwellOverlay.note!(ctx(cards, overrides))

  it('is null when every visible card has a time', () => {
    expect(note([makeCard(1, 1, 2)])).toBeNull()
    expect(note([])).toBeNull()
  })

  it('counts cards left out, including a cell where none could be measured', () => {
    expect(note([makeCard(1, 1, 2), makeCard(1, 1, null)])).toBe('1 card with no recorded time in this column left out.')
    expect(note([makeCard(1, 1, 2), makeCard(2, 1, null), makeCard(2, 2, undefined)])).toBe('2 cards with no recorded time in this column left out.')
  })

  it('says "matching" under a filter', () => {
    expect(note([makeCard(1, 1, null)], { isFiltered: true })).toBe('1 matching card with no recorded time in this column left out.')
    expect(note([makeCard(1, 1, null), makeCard(2, 1, null)], { isFiltered: true })).toBe('2 matching cards with no recorded time in this column left out.')
  })

  it('does not count done columns, hidden columns or hidden swimlanes', () => {
    expect(note([makeCard(1, 1, null)], { columns: [makeColumn(1, true)] })).toBeNull()
    expect(note([makeCard(2, 1, null)], { columns: [makeColumn(1)] })).toBeNull()
    expect(note([makeCard(1, 2, null)], { swimlanes: [makeSwimlane(1)] })).toBeNull()
  })
})

describe('dwell through the slot', () => {
  const state = (cards: Card[], overrides: Partial<GridOverlayContext> = {}) =>
    buildGridOverlayState(dwellOverlay, ctx(cards, overrides))!

  it('gives the hottest cell the strongest tint, stepping by fixed days', () => {
    const s = state([makeCard(1, 1, 0.5), makeCard(2, 1, 2), makeCard(1, 2, 4), makeCard(2, 2, 12)])
    expect(s.cells.get(cellKey(1, 1))!.encoding.tintClass).toBe('')
    expect(s.cells.get(cellKey(2, 1))!.encoding.tintClass).toBe('bg-primary-emphasis/10')
    expect(s.cells.get(cellKey(1, 2))!.encoding.tintClass).toBe('bg-primary-emphasis/20')
    expect(s.cells.get(cellKey(2, 2))!.encoding.tintClass).toBe('bg-primary-emphasis/40')
  })

  it.each([
    [0.96, '1.0d', 1],
    [2.96, '3.0d', 2],
    [4.94, '4.9d', 2],
    [7.96, '8.0d', 4],
  ])('steps %s days by the number it shows: %s is level %s', (days, display, level) => {
    const cell = state([makeCard(1, 1, days)]).cells.get(KEY)!
    expect(cell.display).toBe(display)
    expect(cell.encoding.level).toBe(level)
  })

  it('hands the legend its note', () => {
    expect(state([makeCard(1, 1, 2), makeCard(1, 1, null)]).note).toMatch(/^1 card /)
    expect(state([makeCard(1, 1, 2)]).note).toBeNull()
  })

  it('formats the badge in days', () => {
    expect(state([makeCard(1, 1, 4)]).cells.get(KEY)!.display).toBe('4.0d')
  })

  it('leaves done and empty cells without a state, so they render untouched', () => {
    const s = state([makeCard(2, 1, 4)], { columns: [makeColumn(1), makeColumn(2, true)] })
    expect(s.cells.size).toBe(0)
    expect(s.isEmpty).toBe(true)
  })

  it('leaves a card in a hidden column out of the board', () => {
    const s = state([makeCard(2, 1, 40)], { columns: [makeColumn(1)] })
    expect(s.max).toBe(0)
    expect(s.isEmpty).toBe(true)
  })

  it('reports the filtered empty state', () => {
    const s = state([], { isFiltered: true })
    expect(s.isEmpty).toBe(true)
    expect(s.isFiltered).toBe(true)
  })
})
