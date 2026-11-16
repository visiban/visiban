import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import BoardCell from '../components/Board/BoardCell'
import type { Card, Column, Swimlane } from '../types'
import type { TrippedLimit } from '../utils/placementLimits'

// Drop feedback (#1150, #2326): a card drag over a cell whose limit the drop
// would trip takes the warning treatment and writes the limit out (WCAG 1.4.1);
// an open target takes the selection treatment and shows a placeholder.

const dnd = vi.hoisted(() => ({ isOver: true, active: { id: '7' } as { id: string; rect?: { current: { initial: { height: number } } } } | null }))

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
vi.mock('../components/Card/CardItem', () => ({ default: () => <div /> }))

const column: Column = { id: 10, uid: 'c10', name: 'Ready', position: 0, color: '#000000', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null }
const swimlane: Swimlane = { id: 20, uid: 's20', name: 'Payouts', position: 0, color: '#000000', is_collapsed: false, created_at: '', wip_limit: 5, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null }

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
  it('gives a blocked target the warning treatment and names the limit (#2326)', () => {
    const verdict = vi.fn(() => [tripped('block')])
    const { container } = renderCell(verdict)
    expect(verdict).toHaveBeenCalledWith(7, column, swimlane)
    expect(screen.getByTestId('cell-drop-blocked')).toHaveTextContent('⚠ WIP limit 5/5 · Payouts')
    expect(screen.getByTestId('cell-drop-blocked')).toHaveAttribute('aria-hidden', 'true')
    // An opaque pill, legible over the card beneath it; warning text, never danger.
    expect(screen.getByTestId('cell-drop-blocked').className).toContain('bg-canvas')
    expect(screen.getByTestId('cell-drop-blocked').className).toContain('text-warning-on-tint')
    expect(screen.getByTestId('cell-drop-blocked').className).not.toContain('text-danger')
    const cell = container.querySelector('[data-board-cell]') as HTMLElement
    expect(cell.className).toContain('border-warning')
    expect(cell.className).toContain('bg-warning/20')
    expect(cell.className).toContain('border-dashed')
    expect(cell.className).not.toContain('ring-danger-emphasis')
    expect(cell.className).not.toContain('bg-primary/20')
    // The empty slot follows the warning edge and is not a landing placeholder.
    expect(container.querySelector('.border-warning.h-10')).not.toBeNull()
    expect(screen.queryByTestId('cell-drop-placeholder')).toBeNull()
  })

  it('uses the hard glyph for a hard limit', () => {
    renderCell(() => [tripped('hard')])
    expect(screen.getByTestId('cell-drop-blocked')).toHaveTextContent('⛔ WIP limit 5/5 · Payouts')
  })

  it('gives an open target the selection treatment and a placeholder (#2326)', () => {
    const { container } = renderCell(() => [])
    expect(screen.queryByTestId('cell-drop-blocked')).toBeNull()
    const cell = container.querySelector('[data-board-cell]') as HTMLElement
    expect(cell.className).toContain('bg-primary/20')
    expect(cell.className).toContain('border-dashed')
    expect(cell.className).toContain('border-info')
    expect(cell.className).not.toContain('border-warning')
    expect(screen.getByTestId('cell-drop-placeholder').className).toContain('border-info')
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

describe('BoardCell entry criteria drop message (#1101)', () => {
  const renderWithCriteria = (
    getEntryCriteria: (cardId: number, col: Column) => string[],
    getDropVerdict?: (cardId: number) => TrippedLimit[],
  ) => render(
    <BoardCell
      column={column} swimlane={swimlane} cards={[]} boardId={1} canEdit closeEditorOnEnter={false}
      filteredCardIds={null} selectedCardIds={new Set()} onToggleCardSelection={vi.fn()}
      onCardClick={vi.fn()} onCardAdded={vi.fn()}
      getDropVerdict={getDropVerdict} getEntryCriteria={getEntryCriteria}
    />,
  )

  it('lists the entry criteria while a card is over the cell', () => {
    const criteria = vi.fn(() => ['Has an owner', 'Tests pass'])
    renderWithCriteria(criteria, () => [])
    expect(criteria).toHaveBeenCalledWith(7, column)
    const pill = screen.getByTestId('cell-drop-entry-criteria')
    expect(pill).toHaveTextContent('Entry: Has an owner · Tests pass')
    // The drag live region reads them; the pill is visual only.
    expect(pill).toHaveAttribute('aria-hidden', 'true')
  })

  it('a blocked cell shows only its verdict', () => {
    const criteria = vi.fn(() => ['Has an owner'])
    renderWithCriteria(criteria, () => [tripped('block')])
    expect(screen.queryByTestId('cell-drop-entry-criteria')).not.toBeInTheDocument()
    expect(screen.getByTestId('cell-drop-blocked')).toBeInTheDocument()
  })

  it('shows nothing for a column without criteria', () => {
    renderWithCriteria(() => [], () => [])
    expect(screen.queryByTestId('cell-drop-entry-criteria')).not.toBeInTheDocument()
  })
})

describe('BoardCell populated drop target (#2326, #2320)', () => {
  const cards = [{ id: 1, column: 10, swimlane: 20, position: 0, title: 'One' }] as unknown as Card[]
  const renderPopulated = () => render(
    <BoardCell
      column={column} swimlane={swimlane} cards={cards} boardId={1} canEdit closeEditorOnEnter={false}
      filteredCardIds={null} selectedCardIds={new Set()} onToggleCardSelection={vi.fn()}
      onCardClick={vi.fn()} onCardAdded={vi.fn()}
      getDropVerdict={() => []}
    />,
  )

  it('shows the placeholder after the last card, as tall as the lifted card', () => {
    dnd.active = { id: '7', rect: { current: { initial: { height: 92 } } } }
    renderPopulated()
    const placeholder = screen.getByTestId('cell-drop-placeholder')
    expect(placeholder).toHaveAttribute('aria-hidden', 'true')
    expect(placeholder.style.height).toBe('92px')
    expect(placeholder.className).toContain('bg-primary/40')
    dnd.active = { id: '7' }
  })

  it('falls back to 40px when the lifted card has no measured rect', () => {
    renderPopulated()
    expect(screen.getByTestId('cell-drop-placeholder').style.height).toBe('40px')
  })

  it('keeps the add button focusable during a drag: transparent, never invisible (#2320)', () => {
    renderPopulated()
    const btn = screen.getByRole('button', { name: 'Add card to Ready in Payouts' })
    expect(btn.className).toContain('opacity-0')
    expect(btn.className).not.toContain('invisible')
  })
})
