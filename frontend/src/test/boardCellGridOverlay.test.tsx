/**
 * Tests for the grid overlay layer inside BoardCell (#1147) — the dual encoding, the
 * value badge's mutual exclusion with the built-in count, suppression during a drag,
 * and the empty-addable-cell accessible name.
 *
 * Separate from boardCell.test.tsx because these need `isOver` / `active` to be
 * controllable per test, which that file's fixed dnd-kit doubles do not allow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import BoardCell from '../components/Board/BoardCell'
import { buildGridOverlayState } from '../gridOverlays/slot'
import { getGridOverlay } from '../gridOverlays/registry'
import { cellKey } from '../gridOverlays/types'
import type { Card, Column, Swimlane } from '../types'

const dnd = vi.hoisted(() => ({ isOver: false, active: null as { id: string } | null }))

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: () => {}, isOver: dnd.isOver }),
  useDndContext: () => ({ active: dnd.active }),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: {},
  rectSortingStrategy: {},
}))

vi.mock('../api/cards', () => ({ createCard: vi.fn() }))

vi.mock('../components/Card/CardItem', () => ({
  default: ({ card }: { card: Card }) => <div data-testid={`card-${card.id}`}>{card.title}</div>,
}))

const column: Column = { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false }
const swimlane: Swimlane = { id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01' }

function makeCard(id: number): Card {
  return {
    id, uid: `carduid0000${id}`, column: 10, swimlane: 20, title: `Card ${id}`, description: '',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1, position: id,
    created_by: { id: 1, username: 'u', display_name: 'U', avatar_url: '' },
    created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0,
    checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
    version: 1, custom_field_values: [], blocker_count: 0,
  }
}

/** The real overlay state for a board holding `count` cards in this one cell. */
function overlayFor(count: number) {
  const cards = Array.from({ length: count }, (_, i) => makeCard(i + 1))
  const state = buildGridOverlayState(getGridOverlay('card-count'), {
    columns: [column],
    swimlanes: [swimlane],
    cards,
    isFiltered: false,
  })!
  return { cell: state.cells.get(cellKey(column.id, swimlane.id)), label: state.label }
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    column,
    swimlane,
    cards: [] as Card[],
    boardId: 1,
    canEdit: true,
    closeEditorOnEnter: false,
    filteredCardIds: null as Set<number> | null,
    selectedCardIds: new Set<number>(),
    onToggleCardSelection: vi.fn(),
    onCardClick: vi.fn(),
    onCardAdded: vi.fn(),
    ...overrides,
  }
}

describe('BoardCell — grid overlay layer (#1147)', () => {
  beforeEach(() => {
    dnd.isOver = false
    dnd.active = null
  })

  it('renders nothing extra when no overlay is active (the None default)', () => {
    const { container } = render(<BoardCell {...props({ cards: [makeCard(1), makeCard(2)] })} />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(container.querySelector('[class*="bg-primary-emphasis/"]')).toBeNull()
    // The built-in count badge still owns the corner.
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('encodes the value twice — tint plus a bottom bar — and announces it in words', () => {
    const { cell, label } = overlayFor(3)
    const { container } = render(
      <BoardCell {...props({ cards: [makeCard(1), makeCard(2), makeCard(3)], overlayCell: cell, overlayLabel: label })} />,
    )
    // Color channel.
    expect(container.querySelector('.bg-primary-emphasis\\/10')).not.toBeNull()
    // Non-color channel: the bar's own height class.
    expect(container.querySelector('.h-px')).not.toBeNull()
    // Third channel: the value, announced with its level.
    expect(screen.getByRole('img', { name: 'Card count: 3 cards, level 1 of 4' })).toHaveTextContent('3')
  })

  it('lifts the value badge above the cards but below the sticky label and header', () => {
    // CardItem's root is `relative z-0`, so a z-auto badge earlier in DOM order paints
    // underneath the first card and the value is invisible on every populated cell.
    const { cell, label } = overlayFor(2)
    render(<BoardCell {...props({ cards: [makeCard(1), makeCard(2)], overlayCell: cell, overlayLabel: label })} />)
    const badge = screen.getByRole('img', { name: /Card count/ })
    expect(badge.className).toContain('z-[5]')
    // Never 10 or 20: those belong to the sticky swimlane label panel and header row.
    expect(badge.className).not.toMatch(/\bz-(10|20|30)\b/)
  })

  it('suppresses the built-in count badge so the corner never shows two numbers', () => {
    const { cell, label } = overlayFor(2)
    render(<BoardCell {...props({ cards: [makeCard(1), makeCard(2)], overlayCell: cell, overlayLabel: label })} />)
    // Exactly one "2" in the cell: the overlay badge, not the built-in count too.
    expect(screen.getAllByText('2')).toHaveLength(1)
    expect(screen.getByRole('img', { name: /Card count/ })).toBeInTheDocument()
  })

  it('stands down entirely on the cell being dragged over, so drop feedback owns the background', () => {
    const { cell, label } = overlayFor(3)
    dnd.isOver = true
    dnd.active = { id: '42' }
    const { container } = render(
      <BoardCell {...props({ cards: [makeCard(1), makeCard(2), makeCard(3)], overlayCell: cell, overlayLabel: label })} />,
    )
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(container.querySelector('[class*="bg-primary-emphasis/"]')).toBeNull()
  })

  it('keeps shading a cell that is merely part of an active drag, not the drop target', () => {
    const { cell, label } = overlayFor(3)
    dnd.isOver = false
    dnd.active = { id: '42' }
    render(<BoardCell {...props({ cards: [makeCard(1), makeCard(2), makeCard(3)], overlayCell: cell, overlayLabel: label })} />)
    expect(screen.getByRole('img', { name: /Card count/ })).toBeInTheDocument()
  })

  it('folds the reading into an empty addable cell’s own aria-label, which would otherwise swallow it', () => {
    // An empty addable cell is role="button" with an aria-label, and an aria-label
    // overrides every descendant's text.
    const cell = { value: 4, label: '4 units', encoding: { level: 2, tintClass: 'bg-primary-emphasis/20', barHeightClass: 'h-0.5', barToneClass: 'bg-primary-emphasis/70', levelLabel: 'level 2 of 4' } }
    render(<BoardCell {...props({ overlayCell: cell, overlayLabel: 'Dwell time' })} />)
    expect(
      screen.getByRole('button', { name: 'Add card to To Do in Customer A — Dwell time: 4 units, level 2 of 4' }),
    ).toBeInTheDocument()
    // No second announcement from the badge.
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})
