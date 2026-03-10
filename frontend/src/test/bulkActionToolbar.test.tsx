import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BulkActionToolbar from '../components/Board/BulkActionToolbar'
import type { BoardFull } from '../types'

vi.mock('../api/cards', () => ({
  moveCard: vi.fn(),
  updateCard: vi.fn(),
  deleteCard: vi.fn(),
}))

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
})
