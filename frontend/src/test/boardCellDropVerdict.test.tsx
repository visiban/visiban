import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import BoardCell from '../components/Board/BoardCell'
import type { Column, Swimlane } from '../types'
import type { TrippedLimit } from '../utils/placementLimits'

// The drop ring (#1150): a card drag over a cell whose limit the drop would
// trip draws a danger ring and writes the limit out (WCAG 1.4.1).

const dnd = vi.hoisted(() => ({ isOver: true, active: { id: '7' } as { id: string } | null }))

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: () => {}, isOver: dnd.isOver }),
  useDndContext: () => ({ active: dnd.active }),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: {},
}))

vi.mock('../api/cards', () => ({ createCard: vi.fn() }))
vi.mock('../components/Card/CardItem', () => ({ default: () => <div /> }))

const column: Column = { id: 10, uid: 'c10', name: 'Ready', position: 0, color: '#000000', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false }
const swimlane: Swimlane = { id: 20, uid: 's20', name: 'Payouts', position: 0, color: '#000000', is_collapsed: false, created_at: '', wip_limit: 5, weight_limit: null, limit_enforcement: null, limit_column_ids: null }

const tripped = (mode: 'hard' | 'block'): TrippedLimit => ({ scope: 'swimlane', kind: 'wip', mode, name: 'Payouts', current: 5, limit: 5, cardWeight: 1 })

function renderCell(getDropVerdict?: (cardId: number) => TrippedLimit[]) {
  return render(
    <BoardCell
      column={column} swimlane={swimlane} cards={[]} boardId={1} canEdit closeEditorOnEnter={false}
      filteredCardIds={null} selectedCardIds={new Set()} onToggleCardSelection={vi.fn()}
      onCardClick={vi.fn()} onCardAdded={vi.fn()}
      getDropVerdict={getDropVerdict}
    />,
  )
}

describe('BoardCell drop verdict (#1150)', () => {
  it('rings a blocked target in danger and names the limit', () => {
    const verdict = vi.fn(() => [tripped('block')])
    const { container } = renderCell(verdict)
    expect(verdict).toHaveBeenCalledWith(7, column, swimlane)
    expect(screen.getByTestId('cell-drop-blocked')).toHaveTextContent('⚠ WIP limit 5/5 · Payouts')
    expect(screen.getByTestId('cell-drop-blocked')).toHaveAttribute('aria-hidden', 'true')
    // An opaque pill, legible over the card beneath it.
    expect(screen.getByTestId('cell-drop-blocked').className).toContain('bg-canvas')
    const cell = container.querySelector('[data-board-cell]') as HTMLElement
    expect(cell.className).toContain('ring-danger-emphasis')
    expect(container.querySelector('.border-danger-emphasis')).not.toBeNull()
  })

  it('uses the hard glyph for a hard limit', () => {
    renderCell(() => [tripped('hard')])
    expect(screen.getByTestId('cell-drop-blocked')).toHaveTextContent('⛔ WIP limit 5/5 · Payouts')
  })

  it('keeps the ordinary drop feedback when nothing trips', () => {
    const { container } = renderCell(() => [])
    expect(screen.queryByTestId('cell-drop-blocked')).toBeNull()
    const cell = container.querySelector('[data-board-cell]') as HTMLElement
    expect(cell.className).toContain('bg-surface-hover/40')
    expect(cell.className).not.toContain('ring-danger-emphasis')
  })

  it('asks nothing while no card drag is over the cell', () => {
    dnd.isOver = false
    const verdict = vi.fn(() => [tripped('block')])
    renderCell(verdict)
    expect(verdict).not.toHaveBeenCalled()
    dnd.isOver = true
  })

  it('ignores a column or swimlane drag', () => {
    dnd.active = { id: 'swim:20' }
    const verdict = vi.fn(() => [tripped('block')])
    renderCell(verdict)
    expect(verdict).not.toHaveBeenCalled()
    dnd.active = { id: '7' }
  })
})
