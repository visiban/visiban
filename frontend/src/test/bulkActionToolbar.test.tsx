import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BulkActionToolbar from '../components/Board/BulkActionToolbar'
import type { BoardFull } from '../types'

vi.mock('../api/cards', () => ({
  moveCard: vi.fn(),
  updateCard: vi.fn(),
  deleteCard: vi.fn(),
}))

import { moveCard, updateCard, deleteCard } from '../api/cards'
const mockMoveCard = moveCard as ReturnType<typeof vi.fn>
const mockUpdateCard = updateCard as ReturnType<typeof vi.fn>
const mockDeleteCard = deleteCard as ReturnType<typeof vi.fn>

function makeBoard(): BoardFull {
  return {
    id: 1, name: 'Test', description: '', group: null, group_name: null,
    columns: [
      { id: 10, name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true },
      { id: 11, name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true },
    ],
    swimlanes: [{ id: 20, name: 'Lane', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '' }],
    cards: [
      { id: 100, column: 10, swimlane: 20, title: 'Card 1', description: '', priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: 1, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false },
      { id: 101, column: 10, swimlane: 20, title: 'Card 2', description: '', priority: 'low', assignee: null, labels: [], due_date: null, weight: 1, position: 1, created_by: 1, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false },
    ],
    labels: [],
    members: [
      { id: 1, user: { id: 1, username: 'jdoe', email: '', first_name: 'Jane', last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe', is_site_admin: false, must_change_password: false }, role: 'admin', joined_at: '' },
    ],
    created_at: '', updated_at: '', current_user_role: 'admin',
  }
}

describe('BulkActionToolbar', () => {
  const selectedIds = new Set([100, 101])

  beforeEach(() => { vi.clearAllMocks() })

  it('shows selected count', () => {
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    expect(screen.getByText('2 selected')).toBeInTheDocument()
  })

  it('shows action buttons', () => {
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    expect(screen.getByText('Move to...')).toBeInTheDocument()
    expect(screen.getByText('Assign to...')).toBeInTheDocument()
    expect(screen.getByText('Priority...')).toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
  })

  it('shows move dropdown on click', async () => {
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await userEvent.setup().click(screen.getByText('Move to...'))
    expect(screen.getByText('To Do')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
  })

  it('shows assign dropdown with members', async () => {
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await userEvent.setup().click(screen.getByText('Assign to...'))
    expect(screen.getByText('Unassign')).toBeInTheDocument()
    expect(screen.getByText('Jane Doe')).toBeInTheDocument()
  })

  it('shows priority dropdown', async () => {
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await userEvent.setup().click(screen.getByText('Priority...'))
    expect(screen.getByText('low')).toBeInTheDocument()
    expect(screen.getByText('medium')).toBeInTheDocument()
    expect(screen.getByText('high')).toBeInTheDocument()
    expect(screen.getByText('urgent')).toBeInTheDocument()
  })

  it('shows delete confirmation on delete click', async () => {
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await userEvent.setup().click(screen.getByText('Delete'))
    expect(screen.getByText('Delete 2 cards?')).toBeInTheDocument()
  })

  it('calls onClearSelection when deselect is clicked', async () => {
    const onClear = vi.fn()
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onClearSelection={onClear}
      />
    )
    await userEvent.setup().click(screen.getByTitle('Deselect all (Esc)'))
    expect(onClear).toHaveBeenCalledOnce()
  })

  it('cancels delete confirmation when Cancel is clicked', async () => {
    const user = userEvent.setup()
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await user.click(screen.getByText('Delete'))
    expect(screen.getByText('Delete 2 cards?')).toBeInTheDocument()
    await user.click(screen.getByText('Cancel'))
    expect(screen.queryByText('Delete 2 cards?')).not.toBeInTheDocument()
  })

  it('shows singular "card" in delete confirmation for single selection', async () => {
    const user = userEvent.setup()
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={new Set([100])}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await user.click(screen.getByText('Delete'))
    expect(screen.getByText('Delete 1 card?')).toBeInTheDocument()
    expect(screen.getByText(/This will permanently delete this card/)).toBeInTheDocument()
  })

  it('calls handleMove and onCardsUpdated when a column is selected in move dropdown', async () => {
    const user = userEvent.setup()
    const updatedCard = { ...makeBoard().cards[0], column: 11 }
    mockMoveCard.mockResolvedValue({ card: updatedCard })
    const onCardsUpdated = vi.fn()
    const onClearSelection = vi.fn()

    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={new Set([100])}
        onCardsUpdated={onCardsUpdated}
        onCardsDeleted={vi.fn()}
        onClearSelection={onClearSelection}
      />
    )
    await user.click(screen.getByText('Move to...'))
    await user.click(screen.getByText('Done'))

    await waitFor(() => expect(onClearSelection).toHaveBeenCalled())
    expect(onCardsUpdated).toHaveBeenCalledWith([updatedCard])
    expect(mockMoveCard).toHaveBeenCalledWith(1, 100, {
      column_id: 11,
      swimlane_id: 20,
      position: 9999,
    })
  })

  it('continues moving remaining cards when one move fails', async () => {
    const user = userEvent.setup()
    const updatedCard = { ...makeBoard().cards[1], column: 11 }
    mockMoveCard
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({ card: updatedCard })
    const onCardsUpdated = vi.fn()

    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={new Set([100, 101])}
        onCardsUpdated={onCardsUpdated}
        onCardsDeleted={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await user.click(screen.getByText('Move to...'))
    await user.click(screen.getByText('Done'))

    await waitFor(() => expect(onCardsUpdated).toHaveBeenCalledWith([updatedCard]))
  })

  it('calls handleAssign with user id when a member is selected', async () => {
    const user = userEvent.setup()
    const updatedCard = { ...makeBoard().cards[0], assignee: makeBoard().members[0].user }
    mockUpdateCard.mockResolvedValue(updatedCard)
    const onCardsUpdated = vi.fn()

    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={new Set([100])}
        onCardsUpdated={onCardsUpdated}
        onCardsDeleted={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await user.click(screen.getByText('Assign to...'))
    await user.click(screen.getByText('Jane Doe'))

    await waitFor(() => expect(onCardsUpdated).toHaveBeenCalledWith([updatedCard]))
    expect(mockUpdateCard).toHaveBeenCalledWith(1, 100, { assignee_id: 1 })
  })

  it('calls handleAssign with null when Unassign is selected', async () => {
    const user = userEvent.setup()
    const updatedCard = { ...makeBoard().cards[0], assignee: null }
    mockUpdateCard.mockResolvedValue(updatedCard)
    const onCardsUpdated = vi.fn()

    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={new Set([100])}
        onCardsUpdated={onCardsUpdated}
        onCardsDeleted={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await user.click(screen.getByText('Assign to...'))
    await user.click(screen.getByText('Unassign'))

    await waitFor(() => expect(onCardsUpdated).toHaveBeenCalledWith([updatedCard]))
    expect(mockUpdateCard).toHaveBeenCalledWith(1, 100, { assignee_id: null })
  })

  it('calls handlePriority and onCardsUpdated when a priority is selected', async () => {
    const user = userEvent.setup()
    const updatedCard = { ...makeBoard().cards[0], priority: 'urgent' as const }
    mockUpdateCard.mockResolvedValue(updatedCard)
    const onCardsUpdated = vi.fn()

    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={new Set([100])}
        onCardsUpdated={onCardsUpdated}
        onCardsDeleted={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await user.click(screen.getByText('Priority...'))
    await user.click(screen.getByText('urgent'))

    await waitFor(() => expect(onCardsUpdated).toHaveBeenCalledWith([updatedCard]))
    expect(mockUpdateCard).toHaveBeenCalledWith(1, 100, { priority: 'urgent' })
  })

  it('calls onCardsDeleted and onClearSelection when delete is confirmed', async () => {
    const user = userEvent.setup()
    mockDeleteCard.mockResolvedValue(undefined)
    const onCardsDeleted = vi.fn()
    const onClearSelection = vi.fn()

    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={new Set([100])}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={onCardsDeleted}
        onClearSelection={onClearSelection}
      />
    )
    // Open confirmation modal
    await user.click(screen.getByText('Delete'))
    // Modal's confirm Delete button is inside the dialog — use the red confirm button
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' })
    // The confirm button is the last/second Delete button (modal's confirm)
    await user.click(deleteButtons[deleteButtons.length - 1])

    await waitFor(() => expect(onCardsDeleted).toHaveBeenCalledWith([100]))
    expect(onClearSelection).toHaveBeenCalled()
  })

  it('toggles move dropdown closed when clicked twice', async () => {
    const user = userEvent.setup()
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await user.click(screen.getByText('Move to...'))
    expect(screen.getByText('To Do')).toBeInTheDocument()
    await user.click(screen.getByText('Move to...'))
    expect(screen.queryByText('To Do')).not.toBeInTheDocument()
  })

  it('closes delete confirmation on Escape key', async () => {
    const user = userEvent.setup()
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await user.click(screen.getByText('Delete'))
    expect(screen.getByText('Delete 2 cards?')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByText('Delete 2 cards?')).not.toBeInTheDocument()
    )
  })

  it('shows Working... indicator while busy', async () => {
    const user = userEvent.setup()
    // Mock a slow delete to observe busy state
    let resolveDelete!: () => void
    mockDeleteCard.mockReturnValue(new Promise<void>((res) => { resolveDelete = res }))

    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={new Set([100])}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await user.click(screen.getByText('Delete'))
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' })
    await user.click(deleteButtons[deleteButtons.length - 1])

    expect(screen.getByText('Working...')).toBeInTheDocument()
    resolveDelete()
    await waitFor(() => expect(screen.queryByText('Working...')).not.toBeInTheDocument())
  })

  it('does not call onCardsUpdated when all moves fail', async () => {
    const user = userEvent.setup()
    mockMoveCard.mockRejectedValue(new Error('network error'))
    const onCardsUpdated = vi.fn()

    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={new Set([100, 101])}
        onCardsUpdated={onCardsUpdated}
        onCardsDeleted={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await user.click(screen.getByText('Move to...'))
    await user.click(screen.getByText('Done'))

    await waitFor(() => expect(mockMoveCard).toHaveBeenCalledTimes(2))
    expect(onCardsUpdated).not.toHaveBeenCalled()
  })
})
