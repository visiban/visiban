import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardCell from '../components/Board/BoardCell'
import type { Card, Column, Swimlane } from '../types'

// Mutable so a test can simulate an in-flight drag (#1287).
const dnd = vi.hoisted(() => ({ active: null as { id: string } | null }))

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useDndContext: () => ({ active: dnd.active }),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: {},
}))

vi.mock('../api/cards', () => ({ createCard: vi.fn() }))

vi.mock('../components/Card/CardItem', () => ({
  default: ({ card, onClick, compact }: { card: Card; onClick?: () => void; compact?: boolean }) => (
    <div data-testid={`card-${card.id}`} data-compact={String(compact ?? false)} onClick={onClick}>{card.title}</div>
  ),
}))

import { createCard } from '../api/cards'
const mockCreateCard = createCard as ReturnType<typeof vi.fn>

const column: Column = { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false }
const swimlane: Swimlane = { id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01' }

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Test Card', description: '',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '', updated_at: '',
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1,
    custom_field_values: [],
    blocker_count: 0, external_ref: null,
    ...overrides,
  }
}

const defaultProps = () => ({
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
})

describe('BoardCell', () => {
  it('renders + Add card button when canEdit and allow_card_creation', () => {
    render(<BoardCell {...defaultProps()} />)
    expect(screen.getByText('+ Add card')).toBeInTheDocument()
  })

  it('hides + Add card when canEdit is false', () => {
    const props = defaultProps()
    props.canEdit = false
    render(<BoardCell {...props} />)
    expect(screen.queryByText('+ Add card')).not.toBeInTheDocument()
  })

  it('hides + Add card when column disallows card creation', () => {
    const props = defaultProps()
    props.column = { ...column, allow_card_creation: false }
    render(<BoardCell {...props} />)
    expect(screen.queryByText('+ Add card')).not.toBeInTheDocument()
  })

  it('clicking + Add card shows input', async () => {
    render(<BoardCell {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('+ Add card'))
    expect(screen.getByPlaceholderText('Card title…')).toBeInTheDocument()
    expect(screen.getByText('Add')).toBeInTheDocument()
    expect(screen.getByText('Cancel')).toBeInTheDocument()
  })

  it('renders cards', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1, title: 'Card A' }), makeCard({ id: 2, title: 'Card B' })]
    render(<BoardCell {...props} />)
    expect(screen.getByTestId('card-1')).toBeInTheDocument()
    expect(screen.getByTestId('card-2')).toBeInTheDocument()
  })

  it('clicking card calls onCardClick', async () => {
    const props = defaultProps()
    const card = makeCard({ id: 1, title: 'Card A' })
    props.cards = [card]
    render(<BoardCell {...props} />)
    await userEvent.setup().click(screen.getByTestId('card-1'))
    expect(props.onCardClick).toHaveBeenCalledWith(card)
  })

  it('filters cards when filteredCardIds is set', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1, title: 'Card A' }), makeCard({ id: 2, title: 'Card B' })]
    props.filteredCardIds = new Set([1])
    render(<BoardCell {...props} />)
    expect(screen.getByTestId('card-1')).toBeInTheDocument()
    expect(screen.queryByTestId('card-2')).not.toBeInTheDocument()
  })

  it('creates card when Add is clicked', async () => {
    const newCard = makeCard({ id: 99, title: 'New Card' })
    mockCreateCard.mockResolvedValue(newCard)
    const props = defaultProps()
    render(<BoardCell {...props} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Add card'))
    await user.type(screen.getByPlaceholderText('Card title…'), 'New Card')
    await user.click(screen.getByText('Add'))
    expect(mockCreateCard).toHaveBeenCalledWith(1, { column: 10, swimlane: 20, title: 'New Card' })
  })

  // #1373 — handleAdd's createCard() call used to be a floating promise when
  // invoked from the Enter-key path: a rejection left the input showing the
  // typed title with no error (the existing addError UI never rendered).
  it('shows an error and keeps the input open when createCard fails (Enter key, closeEditorOnEnter)', async () => {
    mockCreateCard.mockRejectedValueOnce(new Error('network error'))
    const props = { ...defaultProps(), closeEditorOnEnter: true }
    render(<BoardCell {...props} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Add card'))
    const input = screen.getByPlaceholderText('Card title…')
    await user.type(input, 'New Card{Enter}')

    expect(await screen.findByText('Failed to add card.')).toBeInTheDocument()
    expect(props.onCardAdded).not.toHaveBeenCalled()
    // The input stays open with the typed title so the user can retry.
    expect(screen.getByDisplayValue('New Card')).toBeInTheDocument()
  })

  it('shows card count badge when 2 or more cards are present', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 }), makeCard({ id: 2, title: 'Card B' })]
    render(<BoardCell {...props} />)
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('does not show count badge for a single card', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 })]
    render(<BoardCell {...props} />)
    expect(screen.queryByText('1')).not.toBeInTheDocument()
  })

  it('empty cell has dashed border', () => {
    const { container } = render(<BoardCell {...defaultProps()} />)
    expect(container.firstChild as HTMLElement).toHaveClass('border-dashed')
  })

  it('non-empty cell does not have dashed border', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 })]
    const { container } = render(<BoardCell {...props} />)
    expect(container.firstChild as HTMLElement).not.toHaveClass('border-dashed')
  })

  it('empty cell exposes the cell itself as the add-card button with a column+swimlane accessible name (#962)', () => {
    render(<BoardCell {...defaultProps()} />)
    // Empty cells are the keyboard-reachable creation surface — the cell wrapper
    // carries role="button" with a column-and-swimlane-scoped accessible name so
    // screen readers know which slot the action targets.
    const cellAsButton = screen.getByRole('button', { name: 'Add card to To Do in Customer A' })
    expect(cellAsButton).toBeInTheDocument()
    expect(cellAsButton).toHaveAttribute('tabindex', '0')
  })

  it('empty cell does not render a separate inner + Add card button (avoids double tab-stop)', () => {
    render(<BoardCell {...defaultProps()} />)
    // The visible "+ Add card" overlay is decorative (aria-hidden) — the cell
    // itself is the only Tab stop for the create action.
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
  })

  it('Enter on a focused empty cell opens the new-card input (#962)', async () => {
    render(<BoardCell {...defaultProps()} />)
    const cell = screen.getByRole('button', { name: 'Add card to To Do in Customer A' })
    cell.focus()
    await userEvent.setup().keyboard('{Enter}')
    expect(screen.getByPlaceholderText('Card title…')).toBeInTheDocument()
  })

  it('Space on a focused empty cell opens the new-card input (#962)', async () => {
    render(<BoardCell {...defaultProps()} />)
    const cell = screen.getByRole('button', { name: 'Add card to To Do in Customer A' })
    cell.focus()
    await userEvent.setup().keyboard(' ')
    expect(screen.getByPlaceholderText('Card title…')).toBeInTheDocument()
  })

  it('clicking anywhere on an empty addable cell opens the new-card input (#962)', async () => {
    render(<BoardCell {...defaultProps()} />)
    const cell = screen.getByRole('button', { name: 'Add card to To Do in Customer A' })
    await userEvent.setup().click(cell)
    expect(screen.getByPlaceholderText('Card title…')).toBeInTheDocument()
  })

  it('non-addable empty cell is not a focusable button (canEdit false)', () => {
    const props = defaultProps()
    props.canEdit = false
    render(<BoardCell {...props} />)
    expect(screen.queryByRole('button', { name: /Add card to/i })).not.toBeInTheDocument()
  })

  it('non-addable empty cell is not a focusable button (allow_card_creation false)', () => {
    const props = defaultProps()
    props.column = { ...column, allow_card_creation: false }
    render(<BoardCell {...props} />)
    expect(screen.queryByRole('button', { name: /Add card to/i })).not.toBeInTheDocument()
  })

  it('populated cell still uses the bottom + Add card button as the affordance', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 })]
    render(<BoardCell {...props} />)
    // Populated cells keep the dense info-rich layout — the cell wrapper is no
    // longer a button, the bottom-aligned button is the only create affordance.
    expect(screen.queryByRole('button', { name: /Add card to/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Add card' })).toBeInTheDocument()
  })

  it('right-click (or touch long-press) opens the new-card input when no drag is active', () => {
    dnd.active = null
    render(<BoardCell {...defaultProps()} />)
    const cell = screen.getByRole('button', { name: 'Add card to To Do in Customer A' })
    const notCanceled = fireEvent.contextMenu(cell)
    expect(notCanceled).toBe(false)
    expect(screen.getByPlaceholderText('Card title…')).toBeInTheDocument()
  })

  it('a contextmenu during an active drag neither opens the input nor the native menu (#1287)', () => {
    // On Android a long-press fires `contextmenu`, and a long-press is also what
    // starts a touch drag — so this fires mid-drag in practice.
    dnd.active = { id: '1' }
    try {
      render(<BoardCell {...defaultProps()} />)
      const cell = screen.getByRole('button', { name: 'Add card to To Do in Customer A' })
      const notCanceled = fireEvent.contextMenu(cell)
      expect(notCanceled).toBe(false)
      expect(screen.queryByPlaceholderText('Card title…')).not.toBeInTheDocument()
    } finally {
      dnd.active = null
    }
  })

  // #1428 — create into a full column returns the move path's 409 body; the
  // reason replaces the generic text only for the three limit codes.
  it('shows the hard-WIP reason when create is refused at the limit', async () => {
    mockCreateCard.mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          detail: 'WIP limit enforced — move blocked.', code: 'wip_hard_blocked',
          column_name: 'To Do', current_count: 1, wip_limit: 1,
        },
      },
    })
    const props = defaultProps()
    render(<BoardCell {...props} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Add card'))
    await user.type(screen.getByPlaceholderText('Card title…'), 'New Card')
    await user.click(screen.getByText('Add'))

    expect(
      await screen.findByText('Column at capacity — no exceptions: "To Do" is at its limit of 1 card (1 active).'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Failed to add card.')).not.toBeInTheDocument()
    expect(props.onCardAdded).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('New Card')).toBeInTheDocument()
  })

  it('keeps the generic text for a 409 that is not a limit refusal', async () => {
    mockCreateCard.mockRejectedValueOnce({
      response: { status: 409, data: { code: 'something_else', detail: 'nope' } },
    })
    const props = defaultProps()
    render(<BoardCell {...props} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Add card'))
    await user.type(screen.getByPlaceholderText('Card title…'), 'New Card')
    await user.click(screen.getByText('Add'))
    expect(await screen.findByText('Failed to add card.')).toBeInTheDocument()
  })
})
