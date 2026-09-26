import { describe, it, expect } from 'vitest'
import {
  NONE_OVERLAY_ID,
  getGridOverlay,
  listGridOverlays,
  registerGridOverlay,
  resolveGridOverlayId,
} from '../gridOverlays/registry'
import { cellKey } from '../gridOverlays/types'
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

describe('grid overlay registry', () => {
  it('ships exactly two overlays in 1.2, with None first', () => {
    const ids = listGridOverlays().map((o) => o.id)
    expect(ids).toEqual(['none', 'card-count'])
    expect(NONE_OVERLAY_ID).toBe('none')
  })

  it('every overlay carries a serializable id, a label and a description', () => {
    for (const overlay of listGridOverlays()) {
      expect(typeof overlay.id).toBe('string')
      expect(overlay.id).toBe(JSON.parse(JSON.stringify(overlay.id)))
      expect(overlay.label.length).toBeGreaterThan(0)
      expect(overlay.description.length).toBeGreaterThan(0)
    }
  })

  it('looks overlays up by id and returns null for an unknown id', () => {
    expect(getGridOverlay('card-count')?.label).toBe('Card count')
    expect(getGridOverlay('dwell-time')).toBeNull()
  })

  it('resolves an unknown, empty or missing id to None (#1146 preset forward compat)', () => {
    expect(resolveGridOverlayId('card-count')).toBe('card-count')
    expect(resolveGridOverlayId('dwell-time')).toBe('none')
    expect(resolveGridOverlayId('')).toBe('none')
    expect(resolveGridOverlayId(null)).toBe('none')
    expect(resolveGridOverlayId(undefined)).toBe('none')
  })

  it('refuses a duplicate id rather than shadowing a persisted one', () => {
    expect(() =>
      registerGridOverlay({ id: 'card-count', label: 'Dupe', description: 'x', compute: () => new Map() }),
    ).toThrow(/already registered/)
  })

  it('None contributes no cells, so the board renders unchanged', () => {
    const none = getGridOverlay('none')!
    const cells = none.compute({ columns: [makeColumn(1)], swimlanes: [makeSwimlane(1)], cards: [makeCard(1, 1, 1)], isFiltered: false })
    expect(cells.size).toBe(0)
  })

  it('card-count counts visible cards per cell and pluralizes its label', () => {
    const overlay = getGridOverlay('card-count')!
    const cells = overlay.compute({
      columns: [makeColumn(1), makeColumn(2)],
      swimlanes: [makeSwimlane(7)],
      cards: [makeCard(1, 1, 7), makeCard(2, 1, 7), makeCard(3, 2, 7)],
      isFiltered: false,
    })
    expect(cells.get(cellKey(1, 7))).toEqual({ value: 2, label: '2 cards' })
    expect(cells.get(cellKey(2, 7))).toEqual({ value: 1, label: '1 card' })
    // Empty cells are simply absent — the slot treats a miss as zero.
    expect(cells.has(cellKey(1, 99))).toBe(false)
  })

  it('card-count says "matching" while a filter is active, so it cannot be confused with the cell badge', () => {
    const overlay = getGridOverlay('card-count')!
    const cells = overlay.compute({
      columns: [makeColumn(1)],
      swimlanes: [makeSwimlane(7)],
      cards: [makeCard(1, 1, 7), makeCard(2, 1, 7)],
      isFiltered: true,
    })
    expect(cells.get(cellKey(1, 7))!.label).toBe('2 matching cards')
  })
})
