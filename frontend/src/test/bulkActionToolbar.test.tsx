import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BulkActionToolbar from '../components/Board/BulkActionToolbar'
import type { BoardFull, Card } from '../types'

vi.mock('../api/cards', () => ({
  moveCard: vi.fn(),
  updateCard: vi.fn(),
  deleteCard: vi.fn(),
  archiveCard: vi.fn(),
}))

import { moveCard, updateCard, deleteCard, archiveCard } from '../api/cards'
import { flagsWrapper } from './instanceFlagsWrapper'
import { DEMO_CARD_FOOTER_NOTE } from '../constants/demoCopy'
const mockMoveCard = moveCard as ReturnType<typeof vi.fn>
const mockUpdateCard = updateCard as ReturnType<typeof vi.fn>
const mockDeleteCard = deleteCard as ReturnType<typeof vi.fn>
const mockArchiveCard = archiveCard as ReturnType<typeof vi.fn>

function makeBoard(): BoardFull {
  return {
    health_status: null, effective_health_status: null, health_status_source: null, default_preset: null,
    id: 1, uid: 'boarduid0001', name: 'Test', description: '', group: null, group_name: null,
    archived_card_count: 0,
    columns: [
      { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
      { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
    ],
    swimlanes: [{ id: 20, uid: 'laneuid00001', name: 'Lane', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null }],
    cards: [
      { id: 100, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Card 1', description: '', priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '' },
      { id: 101, uid: 'carduid00002', column: 10, swimlane: 20, title: 'Card 2', description: '', priority: 'low', assignee: null, labels: [], due_date: null, weight: 1, position: 1, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '' },
    ],
    labels: [],
    members: [
      { id: 1, user: { id: 1, username: 'jdoe', avatar_url: '', display_name: 'Jane Doe' }, role: 'admin', is_moderator: false, joined_at: '' },
    ],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false, show_row_chip_field_names: true, export_min_role: 'viewer', card_density: 'comfortable', is_starred: false, created_at: '', updated_at: '', current_user_role: 'admin',
    owner: { id: 1, username: 'jdoe', display_name: 'Jane Doe', avatar_url: '' },
    capabilities: { movement_export: false },
    share_token: null,
    share_token_expires_at: null,
    share_link_active: false,
    custom_field_definitions: [],
    swimlane_custom_field_definitions: [],
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
        onCardsArchived={vi.fn()}
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
        onCardsArchived={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    expect(screen.getByText('Move to...')).toBeInTheDocument()
    expect(screen.getByText('Assign to...')).toBeInTheDocument()
    expect(screen.getByText('Priority...')).toBeInTheDocument()
    expect(screen.getByText('Archive')).toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
  })

  it('shows move dropdown on click', async () => {
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await userEvent.setup().click(screen.getByText('Move to...'))
    expect(screen.getByText('To Do')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    // #2094: the column color dot carries the neutral ring
    expect(screen.getByText('To Do').parentElement?.querySelector('.color-dot')).not.toBeNull()
  })

  it('publishes its height for the toast region and outranks it while a menu is open (#2060)', async () => {
    const { container } = render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    const bar = container.querySelector('div.fixed') as HTMLElement
    expect(document.documentElement.style.getPropertyValue('--bulk-toolbar-h')).toMatch(/px$/)
    expect(bar.className).toContain('z-40')
    // Explicit width (#2071): a fixed, left-1/2 box shrink-fits into half the
    // viewport otherwise. Wrapping keeps every control inside the capped box.
    expect(bar.className).toContain('w-max')
    expect(bar.className).toContain('max-w-[calc(100%-2rem)]')
    expect(bar.className).toContain('flex-wrap')
    await userEvent.setup().click(screen.getByText('Move to...'))
    // Below 540px the menu anchors to the bar, not its mid-row trigger.
    expect(screen.getByRole('menu').className).toContain('max-[540px]:inset-x-0')
    expect(bar.className).toContain('z-[56]')
  })

  it('shows assign dropdown with members', async () => {
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={vi.fn()}
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
        onCardsArchived={vi.fn()}
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
        onCardsArchived={vi.fn()}
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
        onCardsArchived={vi.fn()}
        onClearSelection={onClear}
      />
    )
    const deselect = screen.getByTitle('Deselect all (Esc)')
    // title alone is not a reliable accessible name (Firefox/VoiceOver skip it); assert the
    // attribute directly since aria-label and title share the same text here, so getByRole's
    // computed-name resolution would pass via the title fallback even without aria-label
    expect(deselect).toHaveAttribute('aria-label', 'Deselect all (Esc)')
    await userEvent.setup().click(deselect)
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
        onCardsArchived={vi.fn()}
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
        onCardsArchived={vi.fn()}
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
        onCardsArchived={vi.fn()}
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
        onCardsArchived={vi.fn()}
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
        onCardsArchived={vi.fn()}
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
        onCardsArchived={vi.fn()}
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
        onCardsArchived={vi.fn()}
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
        onCardsArchived={vi.fn()}
        onClearSelection={onClearSelection}
      />
    )
    await user.click(screen.getByText('Delete'))
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' })
    await user.click(deleteButtons[deleteButtons.length - 1])

    await waitFor(() => expect(onCardsDeleted).toHaveBeenCalledWith([100]))
    expect(onClearSelection).toHaveBeenCalled()
  })

  it('calls onCardsArchived and onClearSelection when Archive is clicked', async () => {
    const user = userEvent.setup()
    mockArchiveCard.mockResolvedValue(undefined)
    const onCardsArchived = vi.fn()
    const onClearSelection = vi.fn()

    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={new Set([100, 101])}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={onCardsArchived}
        onClearSelection={onClearSelection}
      />
    )
    await user.click(screen.getByText('Archive'))

    await waitFor(() => expect(onCardsArchived).toHaveBeenCalledWith([100, 101]))
    expect(onClearSelection).toHaveBeenCalled()
    expect(mockArchiveCard).toHaveBeenCalledWith(1, 100)
    expect(mockArchiveCard).toHaveBeenCalledWith(1, 101)
  })

  it('archives only successful cards when some archive calls fail', async () => {
    const user = userEvent.setup()
    mockArchiveCard
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('network error'))
    const onCardsArchived = vi.fn()

    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={new Set([100, 101])}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={onCardsArchived}
        onClearSelection={vi.fn()}
      />
    )
    await user.click(screen.getByText('Archive'))

    await waitFor(() => expect(onCardsArchived).toHaveBeenCalledWith([100]))
  })

  it('toggles move dropdown closed when clicked twice', async () => {
    const user = userEvent.setup()
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={vi.fn()}
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
        onCardsArchived={vi.fn()}
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
    let resolveDelete!: () => void
    mockDeleteCard.mockReturnValue(new Promise<void>((res) => { resolveDelete = res }))

    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={new Set([100])}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await user.click(screen.getByText('Delete'))
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' })
    await user.click(deleteButtons[deleteButtons.length - 1])

    expect(screen.getByText('Working...')).toBeInTheDocument()
    expect(screen.getByText('Working...')).toHaveClass('animate-pulse', 'motion-reduce:animate-none')
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
        onCardsArchived={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    await user.click(screen.getByText('Move to...'))
    await user.click(screen.getByText('Done'))

    await waitFor(() => expect(mockMoveCard).toHaveBeenCalledTimes(2))
    expect(onCardsUpdated).not.toHaveBeenCalled()
  })

  it('shows partial error when some deletes fail and keeps selection', async () => {
    const user = userEvent.setup()
    mockDeleteCard
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('forbidden'))
    const onClearSelection = vi.fn()

    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={new Set([100, 101])}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={vi.fn()}
        onClearSelection={onClearSelection}
      />
    )
    await user.click(screen.getByText('Delete'))
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' })
    await user.click(deleteButtons[deleteButtons.length - 1])

    await waitFor(() =>
      expect(screen.getByText(/could not be deleted/)).toBeInTheDocument()
    )
    expect(onClearSelection).not.toHaveBeenCalled()
  })

  it('shows partial error when some archives fail and keeps selection', async () => {
    const user = userEvent.setup()
    mockArchiveCard
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('forbidden'))
    const onClearSelection = vi.fn()

    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={new Set([100, 101])}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={vi.fn()}
        onClearSelection={onClearSelection}
      />
    )
    await user.click(screen.getByText('Archive'))

    await waitFor(() =>
      expect(screen.getByText(/could not be archived/)).toBeInTheDocument()
    )
    expect(onClearSelection).not.toHaveBeenCalled()
  })

  it('"Move to..." trigger has aria-haspopup="menu"', () => {
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    const trigger = screen.getByText('Move to...').closest('button') as HTMLButtonElement
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
  })

  it('"Move to..." trigger aria-expanded reflects open state', async () => {
    const user = userEvent.setup()
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    const trigger = screen.getByText('Move to...').closest('button') as HTMLButtonElement
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows warning in delete modal when member selects cards by others', async () => {
    const user = userEvent.setup()
    // memberUser is used both as a board member (BoardUser shape) and as the
    // currentUser prop (full User shape). Declare with the full User shape so
    // both usages type-check correctly — BoardUser is structurally satisfied by User.
    const memberUser = { id: 99, username: 'member', email: '', first_name: 'Member', last_name: '', avatar_url: '', display_name: 'Member', is_site_admin: false, must_change_password: false, must_change_username: false }
    const board = makeBoard()
    board.current_user_role = 'member'
    board.members = [{ id: 2, user: memberUser, role: 'member', is_moderator: false, joined_at: '' }]
    // cards have created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, current user is 99

    render(
      <BulkActionToolbar
        board={board}
        selectedCardIds={new Set([100, 101])}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={vi.fn()}
        onClearSelection={vi.fn()}
        currentUser={memberUser}
      />
    )
    await user.click(screen.getByText('Delete'))

    expect(screen.getByText(/None of the selected cards will be deleted/)).toBeInTheDocument()
  })

  it('dropdown triggers have aria-expanded reflecting open/closed state', async () => {
    const user = userEvent.setup()
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    const moveTrigger = screen.getByText('Move to...').closest('button') as HTMLButtonElement
    expect(moveTrigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(moveTrigger)
    expect(moveTrigger).toHaveAttribute('aria-expanded', 'true')
    // Closing: click again
    await user.click(moveTrigger)
    expect(moveTrigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('Move/Assign/Priority menuitems carry a visible keyboard-focus ring (#1234)', async () => {
    // Roving-tabindex menuitems are real tab stops; `hover:` alone is
    // invisible to a keyboard user who arrowed onto an item without
    // touching the mouse. Regression guard for the missing
    // `focus:outline-none focus:ring-2 focus:ring-primary-emphasis` classes.
    const user = userEvent.setup()
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )

    await user.click(screen.getByText('Move to...'))
    expect(screen.getByRole('menuitem', { name: 'To Do' }).className).toMatch(/focus:ring-2 focus:ring-primary-emphasis/)
    await user.click(screen.getByText('Move to...'))

    await user.click(screen.getByText('Assign to...'))
    expect(screen.getByRole('menuitem', { name: 'Unassign' }).className).toMatch(/focus:ring-2 focus:ring-primary-emphasis/)
    expect(screen.getByRole('menuitem', { name: 'Jane Doe' }).className).toMatch(/focus:ring-2 focus:ring-primary-emphasis/)
    await user.click(screen.getByText('Assign to...'))

    await user.click(screen.getByText('Priority...'))
    expect(screen.getByRole('menuitem', { name: 'urgent' }).className).toMatch(/focus:ring-2 focus:ring-primary-emphasis/)
  })

  it('deselect-all button has an accessible title so screen reader users know its purpose', () => {
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={selectedIds}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )
    const deselect = screen.getByTitle('Deselect all (Esc)')
    expect(deselect).toBeInTheDocument()
    expect(deselect.tagName.toLowerCase()).toBe('button')
  })
})

describe('BulkActionToolbar — hosted demo visitor (#1179)', () => {
  const visitor = {
    id: 99, username: 'visitor', email: '', first_name: '', last_name: '', avatar_url: '',
    display_name: 'Visitor', is_site_admin: false, must_change_password: false, must_change_username: false,
  }
  const memberBoard = (): BoardFull => ({
    ...makeBoard(),
    current_user_role: 'member',
    members: [{ id: 2, user: visitor, role: 'member', is_moderator: false, joined_at: '' }],
  })

  beforeEach(() => { vi.clearAllMocks() })

  it('withholds Archive and Delete in demo mode: aria-disabled with the shared reason, and a click does nothing (#2105)', async () => {
    const board = memberBoard()
    board.cards = board.cards.map((c) => ({ ...c, created_by: { id: 99, username: 'visitor', display_name: 'Visitor', avatar_url: '' } }))
    const onCardsArchived = vi.fn()
    render(
      <BulkActionToolbar
        board={board}
        selectedCardIds={new Set([100, 101])}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={onCardsArchived}
        onClearSelection={vi.fn()}
        currentUser={visitor}
      />,
      { wrapper: flagsWrapper({ demo_mode: true }) }
    )
    const user = userEvent.setup()
    const archive = screen.getByRole('button', { name: `Archive. ${DEMO_CARD_FOOTER_NOTE}` })
    const del = screen.getByRole('button', { name: `Delete. ${DEMO_CARD_FOOTER_NOTE}` })
    for (const b of [archive, del]) {
      expect(b).toHaveAttribute('aria-disabled', 'true')
      expect(b).not.toBeDisabled() // stays focusable so the reason is reachable
      expect(b).toHaveAttribute('title', DEMO_CARD_FOOTER_NOTE)
    }
    await user.click(archive)
    await user.click(del)
    expect(mockArchiveCard).not.toHaveBeenCalled()
    expect(screen.queryByText(/permanently delete/)).not.toBeInTheDocument()
    expect(onCardsArchived).not.toHaveBeenCalled()
  })

  it('still shows bulk Delete outside demo mode', () => {
    render(
      <BulkActionToolbar
        board={memberBoard()}
        selectedCardIds={new Set([100, 101])}
        onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()}
        onCardsArchived={vi.fn()}
        onClearSelection={vi.fn()}
        currentUser={visitor}
      />
    )
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    for (const name of ['Archive', 'Delete']) {
      const b = screen.getByRole('button', { name })
      expect(b).not.toHaveAttribute('aria-disabled')
      expect(b).not.toHaveAttribute('aria-label')
      expect(b).not.toHaveAttribute('title', DEMO_CARD_FOOTER_NOTE)
    }
  })
})

describe('BulkActionToolbar — partial failure reporting (#1733)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const renderToolbar = (over: object = {}) => {
    const props = { onCardsUpdated: vi.fn<(cards: Card[]) => void>(), onClearSelection: vi.fn<() => void>(), ...over }
    render(
      <BulkActionToolbar
        board={makeBoard()}
        selectedCardIds={new Set([100, 101])}
        onCardsUpdated={props.onCardsUpdated}
        onCardsDeleted={vi.fn()}
        onCardsArchived={vi.fn()}
        onClearSelection={props.onClearSelection}
      />
    )
    return props
  }

  const axiosErr = (status: number, data: unknown = {}) =>
    Object.assign(new Error('x'), { isAxiosError: true, response: { status, data } })

  it('assign partial failure keeps selection, applies fulfilled, shows error', async () => {
    const user = userEvent.setup()
    const ok = { ...makeBoard().cards[0], assignee: makeBoard().members[0].user }
    mockUpdateCard.mockResolvedValueOnce(ok).mockRejectedValueOnce(axiosErr(403))
    const { onCardsUpdated, onClearSelection } = renderToolbar()
    await user.click(screen.getByText('Assign to...'))
    await user.click(screen.getByText('Jane Doe'))
    expect(await screen.findByText(/1 of 2 cards could not be assigned — you do not have permission/)).toBeInTheDocument()
    expect(onCardsUpdated).toHaveBeenCalledWith([ok])
    expect(onClearSelection).not.toHaveBeenCalled()
  })

  it('priority partial failure keeps selection and reports a network error', async () => {
    const user = userEvent.setup()
    const ok = { ...makeBoard().cards[0], priority: 'high' }
    mockUpdateCard.mockResolvedValueOnce(ok).mockRejectedValueOnce(new Error('Network Error'))
    const { onCardsUpdated, onClearSelection } = renderToolbar()
    await user.click(screen.getByText('Priority...'))
    await user.click(screen.getByText(/high/i))
    expect(await screen.findByText(/1 of 2 cards could not be updated — a network error occurred/)).toBeInTheDocument()
    expect(onCardsUpdated).toHaveBeenCalledWith([ok])
    expect(onClearSelection).not.toHaveBeenCalled()
  })

  it('mixed failure reasons are reported as such', async () => {
    const user = userEvent.setup()
    mockUpdateCard.mockRejectedValueOnce(axiosErr(404)).mockRejectedValueOnce(axiosErr(500))
    renderToolbar()
    await user.click(screen.getByText('Priority...'))
    await user.click(screen.getByText(/high/i))
    expect(await screen.findByText(/2 of 2 cards could not be updated — for more than one reason/)).toBeInTheDocument()
  })

  it('priority clears selection when all succeed', async () => {
    const user = userEvent.setup()
    mockUpdateCard.mockResolvedValue(makeBoard().cards[0])
    const { onClearSelection } = renderToolbar()
    await user.click(screen.getByText('Priority...'))
    await user.click(screen.getByText(/high/i))
    await waitFor(() => expect(onClearSelection).toHaveBeenCalled())
    expect(screen.queryByText(/could not be/)).not.toBeInTheDocument()
  })

  it('assign clears selection when all succeed', async () => {
    const user = userEvent.setup()
    mockUpdateCard.mockResolvedValue(makeBoard().cards[0])
    const { onClearSelection } = renderToolbar()
    await user.click(screen.getByText('Assign to...'))
    await user.click(screen.getByText('Jane Doe'))
    await waitFor(() => expect(onClearSelection).toHaveBeenCalled())
    expect(screen.queryByText(/could not be/)).not.toBeInTheDocument()
  })

  it('move failure that is not a limit does not blame WIP', async () => {
    const user = userEvent.setup()
    mockMoveCard.mockRejectedValue(axiosErr(409, { code: 'version_conflict' }))
    const { onClearSelection } = renderToolbar()
    await user.click(screen.getByText('Move to...'))
    await user.click(screen.getByText('Done'))
    expect(await screen.findByText(/2 of 2 cards could not be moved — someone else changed a card/)).toBeInTheDocument()
    expect(screen.queryByText(/limit/)).not.toBeInTheDocument()
    expect(onClearSelection).not.toHaveBeenCalled()
  })

  it('move failure from a WIP limit names the column limit', async () => {
    const user = userEvent.setup()
    mockMoveCard.mockRejectedValue(axiosErr(409, { code: 'wip_limit_exceeded' }))
    renderToolbar()
    await user.click(screen.getByText('Move to...'))
    await user.click(screen.getByText('Done'))
    expect(await screen.findByText(/could not be moved — a column limit was reached/)).toBeInTheDocument()
  })

  it('move failure in maintenance mode names it instead of "something went wrong" (#1761)', async () => {
    const user = userEvent.setup()
    mockMoveCard.mockRejectedValue(axiosErr(503, { code: 'maintenance_mode' }))
    renderToolbar()
    await user.click(screen.getByText('Move to...'))
    await user.click(screen.getByText('Done'))
    expect(await screen.findByText(/could not be moved — maintenance mode is active/)).toBeInTheDocument()
  })

  it('move failure with no response reports a network error', async () => {
    const user = userEvent.setup()
    mockMoveCard.mockRejectedValue(new Error('Network Error'))
    renderToolbar()
    await user.click(screen.getByText('Move to...'))
    await user.click(screen.getByText('Done'))
    expect(await screen.findByText(/could not be moved — a network error occurred/)).toBeInTheDocument()
  })

  it('reports failures inside a persistent polite live region', async () => {
    const user = userEvent.setup()
    renderToolbar()
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveAttribute('aria-atomic', 'true')
    expect(region).toBeEmptyDOMElement()
    mockUpdateCard.mockRejectedValue(axiosErr(500))
    await user.click(screen.getByText('Priority...'))
    await user.click(screen.getByText(/high/i))
    await waitFor(() => expect(screen.getByRole('status')).toBe(region))
    expect(region).toHaveTextContent('2 of 2 cards could not be updated — something went wrong.')
  })

  it('uses singular noun and number-neutral reason for one card', async () => {
    const user = userEvent.setup()
    mockMoveCard.mockRejectedValue(axiosErr(404))
    render(
      <BulkActionToolbar board={makeBoard()} selectedCardIds={new Set([100])} onCardsUpdated={vi.fn()}
        onCardsDeleted={vi.fn()} onCardsArchived={vi.fn()} onClearSelection={vi.fn()} />
    )
    await user.click(screen.getByText('Move to...'))
    await user.click(screen.getByText('Done'))
    expect(await screen.findByText('1 of 1 card could not be moved — not found.')).toBeInTheDocument()
  })

  it('archive keeps the ownership reason only for 403 and names others honestly', async () => {
    const user = userEvent.setup()
    mockArchiveCard.mockRejectedValueOnce(axiosErr(403)).mockRejectedValueOnce(axiosErr(403))
    renderToolbar()
    await user.click(screen.getByText('Archive'))
    expect(await screen.findByText(/2 of 2 cards could not be archived — you can only archive cards you created\./)).toBeInTheDocument()
    mockArchiveCard.mockRejectedValue(new Error('Network Error'))
    await user.click(screen.getByText('Archive'))
    expect(await screen.findByText(/could not be archived — a network error occurred/)).toBeInTheDocument()
  })

  it('delete partial failure keeps selection and uses the 403 ownership reason', async () => {
    const user = userEvent.setup()
    mockDeleteCard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(axiosErr(403))
    const onCardsDeleted = vi.fn()
    const onClearSelection = vi.fn()
    render(
      <BulkActionToolbar board={makeBoard()} selectedCardIds={new Set([100, 101])} onCardsUpdated={vi.fn()}
        onCardsDeleted={onCardsDeleted} onCardsArchived={vi.fn()} onClearSelection={onClearSelection} />
    )
    await user.click(screen.getByText('Delete'))
    const deleteButtons = screen.getAllByText('Delete')
    await user.click(deleteButtons[deleteButtons.length - 1])
    expect(await screen.findByText(/1 of 2 cards could not be deleted — you can only delete cards you created\./)).toBeInTheDocument()
    expect(onCardsDeleted).toHaveBeenCalledWith([100])
    expect(onClearSelection).not.toHaveBeenCalled()
  })
})

