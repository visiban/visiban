import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardSelector from '../components/Layout/BoardSelector'
import type { User } from '../types'

vi.mock('../api/boards', () => ({
  listBoards: vi.fn(),
  createBoard: vi.fn(),
  deleteBoard: vi.fn(),
  listBoardTemplates: vi.fn().mockResolvedValue([]),
}))

import { listBoards, deleteBoard } from '../api/boards'

const mockListBoards = listBoards as ReturnType<typeof vi.fn>
const mockDeleteBoard = deleteBoard as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false,
}

describe('BoardSelector', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows loading state', () => {
    mockListBoards.mockReturnValue(new Promise(() => {}))
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    expect(screen.getByText(/Loading/)).toBeInTheDocument()
  })

  it('shows boards when loaded', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, name: 'Board A', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, created_at: '', updated_at: '' },
    ])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    expect(await screen.findByText('Board A')).toBeInTheDocument()
  })

  it('shows empty state', async () => {
    mockListBoards.mockResolvedValue([])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    expect(await screen.findByText('No boards yet.')).toBeInTheDocument()
  })

  it('shows new board button', async () => {
    mockListBoards.mockResolvedValue([])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    expect(await screen.findByText('+ New board')).toBeInTheDocument()
  })

  it('calls onSelect when board is clicked', async () => {
    const board = { id: 1, uid: 'board-a', name: 'Board A', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, card_count: 0, staleness_threshold_days: 14, stale_warning_pct: 50, allowed_priorities: [], enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, export_min_role: 'member' as const, is_starred: false, created_at: '', updated_at: '' }
    mockListBoards.mockResolvedValue([board])
    const onSelect = vi.fn()
    render(<BoardSelector user={fakeUser} onSelect={onSelect} />)
    const user = userEvent.setup()
    await screen.findByText('Board A')
    await user.click(screen.getByText('Board A'))
    expect(onSelect).toHaveBeenCalledWith(board)
  })

  it('shows delete button for owned boards', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, uid: 'my-board', name: 'My Board', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, card_count: 3, staleness_threshold_days: 14, stale_warning_pct: 50, allowed_priorities: [], enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, export_min_role: 'member' as const, is_starred: false, created_at: '', updated_at: '' },
    ])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    await screen.findByText('My Board')
    expect(screen.getByTitle('Delete board')).toBeInTheDocument()
    // title alone is not a reliable accessible name (Firefox/VoiceOver skip it)
    expect(screen.getByRole('button', { name: 'Delete My Board' })).toBeInTheDocument()
  })

  it('shows delete confirmation dialog', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, uid: 'my-board', name: 'My Board', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, card_count: 5, staleness_threshold_days: 14, stale_warning_pct: 50, allowed_priorities: [], enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, export_min_role: 'member' as const, is_starred: false, created_at: '', updated_at: '' },
    ])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    const user = userEvent.setup()
    await screen.findByText('My Board')
    await user.click(screen.getByTitle('Delete board'))
    expect(screen.getByText('Delete board?')).toBeInTheDocument()
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument()
  })

  it('delete dialog has role=dialog, aria-modal, and aria-labelledby pointing at heading', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, uid: 'my-board', name: 'My Board', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, card_count: 0, staleness_threshold_days: 14, stale_warning_pct: 50, allowed_priorities: [], enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, export_min_role: 'member' as const, is_starred: false, created_at: '', updated_at: '' },
    ])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    const user = userEvent.setup()
    await screen.findByText('My Board')
    await user.click(screen.getByTitle('Delete board'))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const heading = screen.getByRole('heading', { name: 'Delete board?' })
    expect(dialog).toHaveAttribute('aria-labelledby', heading.id)
  })

  it('Escape key closes delete dialog', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, uid: 'my-board', name: 'My Board', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, card_count: 0, staleness_threshold_days: 14, stale_warning_pct: 50, allowed_priorities: [], enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, export_min_role: 'member' as const, is_starred: false, created_at: '', updated_at: '' },
    ])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    const user = userEvent.setup()
    await screen.findByText('My Board')
    await user.click(screen.getByTitle('Delete board'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows error state when board load fails', async () => {
    mockListBoards.mockRejectedValue(new Error('network error'))
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    expect(await screen.findByText('Failed to load boards.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('retry button reloads boards after error', async () => {
    mockListBoards
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue([
        { id: 1, uid: 'board-a', name: 'Board A', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, card_count: 0, staleness_threshold_days: 14, stale_warning_pct: 50, allowed_priorities: [], enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, export_min_role: 'member' as const, is_starred: false, created_at: '', updated_at: '' },
      ])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    const user = userEvent.setup()
    await screen.findByText('Failed to load boards.')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Board A')).toBeInTheDocument()
    expect(screen.queryByText('Failed to load boards.')).not.toBeInTheDocument()
  })

  it('opens create modal when + New board is clicked', async () => {
    mockListBoards.mockResolvedValue([])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    const user = userEvent.setup()
    await screen.findByText('+ New board')
    await user.click(screen.getByText('+ New board'))
    expect(screen.getByText('New Board')).toBeInTheDocument()
  })

  it('shows board description when available', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, uid: 'board-a', name: 'Board A', description: 'A test board', owner: fakeUser, group: null, group_name: null, member_count: 1, card_count: 0, staleness_threshold_days: 14, stale_warning_pct: 50, allowed_priorities: [], enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, export_min_role: 'member' as const, is_starred: false, created_at: '', updated_at: '' },
    ])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    expect(await screen.findByText('A test board')).toBeInTheDocument()
  })

  // ----------------------------------------------------------------
  // Delete confirmation — success and rejection paths (#1375)
  // ----------------------------------------------------------------

  it('removes the board from the list after a successful delete', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, uid: 'my-board', name: 'My Board', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, card_count: 0, staleness_threshold_days: 14, stale_warning_pct: 50, allowed_priorities: [], enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, export_min_role: 'member' as const, is_starred: false, created_at: '', updated_at: '' },
    ])
    mockDeleteBoard.mockResolvedValue(undefined)
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    const user = userEvent.setup()
    await screen.findByText('My Board')
    await user.click(screen.getByTitle('Delete board'))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    expect(mockDeleteBoard).toHaveBeenCalledWith(1)
    expect(screen.queryByText('My Board')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('restores the board and shows an error when delete fails', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, uid: 'my-board', name: 'My Board', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, card_count: 0, staleness_threshold_days: 14, stale_warning_pct: 50, allowed_priorities: [], enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, export_min_role: 'member' as const, is_starred: false, created_at: '', updated_at: '' },
    ])
    mockDeleteBoard.mockRejectedValue(new Error('server error'))
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    const user = userEvent.setup()
    await screen.findByText('My Board')
    await user.click(screen.getByTitle('Delete board'))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    // The optimistic removal is rolled back — the board reappears — and an
    // error explains why, rather than the board just vanishing or silently
    // reappearing with no explanation at all (#1375).
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to delete board.')
    expect(await screen.findByText('My Board')).toBeInTheDocument()
  })

  it('clears a previous delete error when a new delete is attempted', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, uid: 'board-a', name: 'Board A', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, card_count: 0, staleness_threshold_days: 14, stale_warning_pct: 50, allowed_priorities: [], enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, export_min_role: 'member' as const, is_starred: false, created_at: '', updated_at: '' },
    ])
    // Only the first delete is actually submitted below (the second click just
    // reopens the dialog) — a single mockRejectedValueOnce is all this needs;
    // a leftover queued mockResolvedValueOnce would jump ahead of a later
    // test's own mockImplementation and resolve its call prematurely.
    mockDeleteBoard.mockRejectedValueOnce(new Error('server error'))
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    const user = userEvent.setup()
    await screen.findByText('Board A')
    await user.click(screen.getByTitle('Delete board'))
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to delete board.')

    await user.click(screen.getByTitle('Delete board'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('disables every delete trigger while a delete is in flight, re-enabling once it settles', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, uid: 'board-a', name: 'Board A', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, card_count: 0, staleness_threshold_days: 14, stale_warning_pct: 50, allowed_priorities: [], enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, export_min_role: 'member' as const, is_starred: false, created_at: '', updated_at: '' },
      { id: 2, uid: 'board-b', name: 'Board B', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, card_count: 0, staleness_threshold_days: 14, stale_warning_pct: 50, allowed_priorities: [], enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, export_min_role: 'member' as const, is_starred: false, created_at: '', updated_at: '' },
    ])
    let resolveDelete: () => void = () => {}
    // mockReset (not just a fresh mockImplementation) clears any queued
    // mockResolvedValueOnce/mockRejectedValueOnce left over from an earlier
    // test — those take priority over a plain mockImplementation and would
    // resolve this call immediately instead of leaving it pending.
    mockDeleteBoard.mockReset()
    mockDeleteBoard.mockImplementation(() => new Promise<void>((resolve) => { resolveDelete = resolve }))
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    const user = userEvent.setup()
    await screen.findByText('Board A')

    await user.click(screen.getByRole('button', { name: 'Delete Board A' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    // Board A's deleteBoard() call is still pending — Board B's trigger must be
    // disabled too, otherwise a second, overlapping delete could be started and
    // its rollback snapshot could clobber Board A's outcome (#1375 follow-up).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete Board B' })).toBeDisabled())

    resolveDelete()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete Board B' })).not.toBeDisabled())
  })
})

// #1289 — archived cards cascade with the board, so they must gate typed-name
// confirmation exactly like active cards, and the dialog must name them.
describe('BoardSelector — delete confirmation and archived cards (#1289)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const boardWith = (card_count: number, archived_card_count: number) => ({
    id: 1, uid: 'my-board', name: 'My Board', description: '', owner: fakeUser, group: null, group_name: null,
    member_count: 1, card_count, archived_card_count, staleness_threshold_days: 14, stale_warning_pct: 50,
    allowed_priorities: [], enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false,
    export_min_role: 'member' as const, is_starred: false, created_at: '', updated_at: '',
  })

  async function openDeleteDialog(card_count: number, archived_card_count: number) {
    mockListBoards.mockResolvedValue([boardWith(card_count, archived_card_count)])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    const user = userEvent.setup()
    await screen.findByText('My Board')
    await user.click(screen.getByTitle('Delete board'))
    return { user, dialog: screen.getByRole('dialog') }
  }

  it('requires typed confirmation for a board holding only archived cards', async () => {
    const { user, dialog } = await openDeleteDialog(0, 4)
    expect(dialog).toHaveTextContent('This board has 4 archived cards. Type the board name to confirm deletion.')
    const deleteButton = screen.getByRole('button', { name: 'Delete' })
    expect(deleteButton).toBeDisabled()
    await user.type(screen.getByPlaceholderText('Type "My Board" to confirm'), 'My Board')
    expect(deleteButton).toBeEnabled()
  })

  it('names both active and archived cards when the board has both', async () => {
    const { dialog } = await openDeleteDialog(2, 1)
    expect(dialog).toHaveTextContent('This board has 2 cards and 1 archived card. Type the board name to confirm deletion.')
  })

  it('mentions archived cards and allows single-click delete for an empty board', async () => {
    const { dialog } = await openDeleteDialog(0, 0)
    expect(dialog).toHaveTextContent('including archived cards')
    expect(screen.queryByPlaceholderText('Type "My Board" to confirm')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled()
  })
})
