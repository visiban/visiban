import { describe, it, expect } from 'vitest'
import { buildGridOverlayState } from '../gridOverlays/slot'
import {
  OVERLAY_ENCODINGS,
  OVERLAY_FLAT_LEVEL,
  OVERLAY_LEVELS,
  encodeOverlayLevel,
  formatOverlayValue,
  overlayLevel,
} from '../gridOverlays/scale'
import { getGridOverlay } from '../gridOverlays/registry'
import { cellKey } from '../gridOverlays/types'
import type { GridOverlay, GridOverlayContext } from '../gridOverlays/types'
import type { Card, Column, Swimlane } from '../types'

function makeColumn(id: number): Column {
  return { id, uid: `col${id}`, name: `Col ${id}`, position: id, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false }
}

function makeSwimlane(id: number): Swimlane {
  return { id, uid: `lane${id}`, name: `Lane ${id}`, contact_email: '', notes: '', position: id, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01' }
}

function makeCard(id: number, column: number, swimlane: number): Card {
  return {
    id, uid: `card${id}`, column, swimlane, title: `Card ${id}`, description: '',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: 0, created_by: { id: 1, username: 'u', display_name: 'U', avatar_url: '' },
    created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0,
    checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
    version: 1, custom_field_values: [], blocker_count: 0,
  }
}

/** Overlay that reports whatever values the test hands it, keyed col:lane. */
function fixedOverlay(values: Record<string, number>): GridOverlay {
  return {
    id: 'test-fixed',
    label: 'Fixed',
    description: 'Test overlay.',
    compute: () => new Map(Object.entries(values).map(([key, value]) => [key, { value, label: `${value} units` }])),
  }
}

function ctx(columnIds: number[], swimlaneIds: number[], cards: Card[] = [], isFiltered = false): GridOverlayContext {
  return { columns: columnIds.map(makeColumn), swimlanes: swimlaneIds.map(makeSwimlane), cards, isFiltered }
}

describe('overlay scale — dual encoding (#969)', () => {
  it('encodes severity twice: every visible level carries color AND a non-color channel', () => {
    for (let level = 1; level <= OVERLAY_LEVELS; level++) {
      const encoding = encodeOverlayLevel(level)
      expect(encoding.level).toBe(level)
      // Color channel.
      expect(encoding.tintClass).not.toBe('')
      // Non-color channel — the bottom bar's geometry.
      expect(encoding.barHeightClass).not.toBe('')
      expect(encoding.barToneClass).not.toBe('')
      // Third channel, rendered as the cell's value badge and the legend's a11y text.
      expect(encoding.levelLabel).toMatch(/level \d of \d/)
    }
  })

  it('gives every level a distinct bar height, not just a distinct hue', () => {
    const visible = OVERLAY_ENCODINGS.filter((e) => e.level > 0)
    expect(new Set(visible.map((e) => e.barHeightClass)).size).toBe(visible.length)
  })

  it('ramps on primary-emphasis and never on the info token the grid already uses', () => {
    for (const encoding of OVERLAY_ENCODINGS.filter((e) => e.level > 0)) {
      expect(encoding.tintClass).toMatch(/^bg-primary-emphasis\//)
      // bg-info/10, /15 and /20 are the active toggle, the filter-match pulse and the
      // drop-target indicator — all inside the board grid.
      expect(encoding.tintClass).not.toMatch(/bg-info/)
      // A magnitude ramp never borrows the success/warning/danger vocabulary.
      expect(encoding.tintClass).not.toMatch(/bg-(danger|warning|success)/)
    }
  })

  it('starts the ramp above the perceptibility floor', () => {
    expect(encodeOverlayLevel(1).tintClass).toBe('bg-primary-emphasis/10')
  })

  it('renders nothing at all at level 0', () => {
    const encoding = encodeOverlayLevel(0)
    expect(encoding).toEqual({ level: 0, tintClass: '', barHeightClass: '', barToneClass: '', levelLabel: 'no value' })
  })

  it('clamps an out-of-range level to level 0 instead of throwing', () => {
    expect(encodeOverlayLevel(99).level).toBe(0)
    expect(encodeOverlayLevel(-1).level).toBe(0)
  })

  it('buckets values relative to the busiest cell', () => {
    expect(overlayLevel(0, 8)).toBe(0)
    expect(overlayLevel(1, 8)).toBe(1)
    expect(overlayLevel(2, 8)).toBe(1)
    expect(overlayLevel(3, 8)).toBe(2)
    expect(overlayLevel(5, 8)).toBe(3)
    expect(overlayLevel(8, 8)).toBe(4)
    // The busiest cell is always top of scale, however small the board.
    expect(overlayLevel(1, 1)).toBe(4)
  })

  it('never returns a level for a non-positive value or a zero scale', () => {
    expect(overlayLevel(-3, 8)).toBe(0)
    expect(overlayLevel(4, 0)).toBe(0)
    expect(overlayLevel(Number.NaN, 8)).toBe(0)
  })

  it('formats values readably', () => {
    expect(formatOverlayValue(3)).toBe('3')
    expect(formatOverlayValue(2.25)).toBe('2.3')
  })
})

describe('buildGridOverlayState', () => {
  it('returns null for the None overlay so the default board path is untouched', () => {
    expect(buildGridOverlayState(getGridOverlay('none'), ctx([1], [1], [makeCard(1, 1, 1)]))).toBeNull()
    expect(buildGridOverlayState(null, ctx([1], [1]))).toBeNull()
    expect(buildGridOverlayState(undefined, ctx([1], [1]))).toBeNull()
  })

  it('scales the card-count overlay across the visible grid', () => {
    const cards = [
      makeCard(1, 1, 1), makeCard(2, 1, 1), makeCard(3, 1, 1), makeCard(4, 1, 1),
      makeCard(5, 2, 1),
    ]
    const state = buildGridOverlayState(getGridOverlay('card-count'), ctx([1, 2], [1], cards))!
    expect(state.overlayId).toBe('card-count')
    expect(state.label).toBe('Card count')
    expect(state.max).toBe(4)
    expect(state.isEmpty).toBe(false)
    expect(state.cells.get(cellKey(1, 1))!.encoding.level).toBe(4)
    expect(state.cells.get(cellKey(1, 1))!.label).toBe('4 cards')
    expect(state.cells.get(cellKey(2, 1))!.encoding.level).toBe(1)
    // A cell with no cards gets no entry — the slot leaves it visually untouched.
    expect(state.cells.has(cellKey(2, 99))).toBe(false)
  })

  it('summarizes each level with the range actually observed there', () => {
    const cards = [
      makeCard(1, 1, 1), makeCard(2, 1, 1), makeCard(3, 1, 1), makeCard(4, 1, 1),
      makeCard(5, 2, 1), makeCard(6, 2, 1), makeCard(7, 2, 1),
      makeCard(8, 3, 1),
    ]
    const state = buildGridOverlayState(getGridOverlay('card-count'), ctx([1, 2, 3], [1], cards))!
    expect(state.levels.map((l) => l.level)).toEqual([1, 2, 3, 4])
    expect(state.levels.map((l) => l.count)).toEqual([1, 0, 1, 1])
    // Level 1 holds the single-card cell, level 4 the four-card one.
    expect(state.levels[0]).toMatchObject({ count: 1, min: 1, max: 1 })
    expect(state.levels[1]).toMatchObject({ count: 0, min: 0, max: 0 })
    expect(state.levels[3]).toMatchObject({ count: 1, min: 4, max: 4 })
  })

  it('reports the empty state when the active overlay has nothing to show', () => {
    const state = buildGridOverlayState(getGridOverlay('card-count'), ctx([1, 2], [1, 2], []))!
    expect(state.isEmpty).toBe(true)
    expect(state.cells.size).toBe(0)
    expect(state.max).toBe(0)
  })

  it('ignores values for cells outside the visible grid, so a hidden column cannot wash out the scale', () => {
    // Column 9 is hidden (not in the context) but carries the largest value.
    const state = buildGridOverlayState(
      fixedOverlay({ [cellKey(1, 1)]: 2, [cellKey(9, 1)]: 100 }),
      ctx([1], [1]),
    )!
    expect(state.max).toBe(2)
    // Only one cell is visible, so there is no spread — flat, not "top of scale".
    expect(state.cells.get(cellKey(1, 1))!.encoding.level).toBe(OVERLAY_FLAT_LEVEL)
    expect(state.cells.has(cellKey(9, 1))).toBe(false)
  })

  it('drops non-positive and malformed values instead of tinting them', () => {
    const state = buildGridOverlayState(
      fixedOverlay({ [cellKey(1, 1)]: 0, [cellKey(2, 1)]: -5, [cellKey(3, 1)]: 6 }),
      ctx([1, 2, 3], [1]),
    )!
    expect(state.cells.size).toBe(1)
    expect(state.cells.has(cellKey(3, 1))).toBe(true)
  })

  it('draws a flat distribution at the quietest level instead of painting the board at level 4', () => {
    // Every populated cell holds exactly one card: true, but nothing stands out.
    const cards = [makeCard(1, 1, 1), makeCard(2, 2, 1), makeCard(3, 1, 2)]
    const state = buildGridOverlayState(getGridOverlay('card-count'), ctx([1, 2], [1, 2], cards))!
    expect(state.isFlat).toBe(true)
    expect(state.min).toBe(1)
    expect(state.max).toBe(1)
    for (const cell of state.cells.values()) {
      expect(cell.encoding.level).toBe(OVERLAY_FLAT_LEVEL)
    }
  })

  it('is not flat as soon as two cells differ', () => {
    const cards = [makeCard(1, 1, 1), makeCard(2, 1, 1), makeCard(3, 2, 1)]
    const state = buildGridOverlayState(getGridOverlay('card-count'), ctx([1, 2], [1], cards))!
    expect(state.isFlat).toBe(false)
    expect(state.min).toBe(1)
    expect(state.max).toBe(2)
    expect(state.cells.get(cellKey(1, 1))!.encoding.level).toBe(4)
    expect(state.cells.get(cellKey(2, 1))!.encoding.level).toBe(2)
  })

  it('carries the filtered flag through, so the legend can say what emptied it', () => {
    const unfiltered = buildGridOverlayState(getGridOverlay('card-count'), ctx([1], [1], []))!
    const filtered = buildGridOverlayState(getGridOverlay('card-count'), ctx([1], [1], [], true))!
    expect(unfiltered.isFiltered).toBe(false)
    expect(filtered.isFiltered).toBe(true)
  })

  it('reports isFlat false and min 0 on an empty board', () => {
    const state = buildGridOverlayState(getGridOverlay('card-count'), ctx([1], [1], []))!
    expect(state.isFlat).toBe(false)
    expect(state.min).toBe(0)
  })

  it('keeps per-cell object identity stable for memoized cells within one build', () => {
    const state = buildGridOverlayState(fixedOverlay({ [cellKey(1, 1)]: 3 }), ctx([1], [1]))!
    expect(state.cells.get(cellKey(1, 1))).toBe(state.cells.get(cellKey(1, 1)))
  })
})
