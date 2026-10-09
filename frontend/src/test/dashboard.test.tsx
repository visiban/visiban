import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Dashboard from '../pages/Dashboard'
import type { User } from '../types'

const mockNavigate = vi.fn()

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

vi.mock('../api/boards', () => ({
  // The import modal fetches the sample list on open (#1452); empty = gallery unavailable.
  listSampleBoards: vi.fn().mockResolvedValue([]),
  getSampleBoardFile: vi.fn(),
  listBoards: vi.fn(),
  createBoard: vi.fn(),
  deleteBoard: vi.fn(),
  importBoard: vi.fn(),
  previewTrelloImport: vi.fn(),
  confirmTrelloImport: vi.fn(),
  listBoardTemplates: vi.fn().mockResolvedValue([]),
}))

vi.mock('../api/groups', () => ({
  listGroups: vi.fn(),
}))

vi.mock('../api/notifications', () => ({
  getUnreadCount: vi.fn().mockResolvedValue(0),
  listNotifications: vi.fn().mockResolvedValue([]),
  markAllRead: vi.fn(),
  markRead: vi.fn(),
}))

vi.mock('../api/auth', () => ({
  getVersion: vi.fn().mockResolvedValue('0.3.0'),
}))

import { listBoards, deleteBoard, createBoard, importBoard, previewTrelloImport, confirmTrelloImport } from '../api/boards'
import { listGroups } from '../api/groups'
import type { TrelloImportPreview } from '../types'

const mockListBoards = listBoards as ReturnType<typeof vi.fn>
const mockListGroups = listGroups as ReturnType<typeof vi.fn>
const mockDeleteBoard = deleteBoard as ReturnType<typeof vi.fn>
const mockCreateBoard = createBoard as ReturnType<typeof vi.fn>
const mockImportBoard = importBoard as ReturnType<typeof vi.fn>
const mockPreviewTrelloImport = previewTrelloImport as ReturnType<typeof vi.fn>
const mockConfirmTrelloImport = confirmTrelloImport as ReturnType<typeof vi.fn>

// Minimal valid preview fixture — mirrors trelloImport.test.tsx's makePreview(),
// trimmed to what Dashboard's Trello-import flow needs to reach "Create board".
function trelloPreview(): TrelloImportPreview {
  return {
    source: 'trello',
    file_sha256: 'sha-1',
    board: { name: 'Product Roadmap', description: '' },
    counts: {
      lists: 1, lists_archived: 0, cards: 1, cards_archived: 0, labels: 0, checklists: 0,
      checklist_items: 0, comments: 0, attachments: 0, members: 0,
    },
    result: { columns: 1, swimlanes: 1, labels: 0, cards: 1, cards_archived: 0, checklist_items: 0, comments: 0 },
    mapping: {
      columns: [{ trello_id: 'a', name: 'To Do', position: 0, card_count: 1, archived: false }],
      labels: [],
      swimlanes: [],
      default_swimlane: 'Unassigned',
    },
    members: { total: 0, matched: 0, unmatched: [] },
    options: { swimlane_label_ids: [], default_swimlane_name: 'Unassigned', include_archived_lists: false, add_matched_members: false },
    warnings: [],
    unmappable: [],
  }
}

const fakeUser: User = {
  id: 1,
  username: 'jdoe',
  email: 'j@example.com',
  first_name: 'Jane',
  last_name: 'Doe',
  avatar_url: '',
  display_name: 'Jane Doe',
  is_site_admin: false,
  must_change_password: false, must_change_username: false,
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
    </MemoryRouter>
  )
}

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListBoards.mockResolvedValue([])
    mockListGroups.mockResolvedValue([])
    mockNavigate.mockReset()
  })

  it('renders Groups and My Boards sections', async () => {
    renderDashboard()
    expect(await screen.findByText('Groups')).toBeInTheDocument()
    expect(screen.getByText('My Boards')).toBeInTheDocument()
  })

  it('shows empty state when no boards', async () => {
    renderDashboard()
    expect(await screen.findByText('No personal boards yet.')).toBeInTheDocument()
  })

  it('shows empty state when no groups', async () => {
    renderDashboard()
    expect(await screen.findByText('No groups yet. Create one to collaborate with others.')).toBeInTheDocument()
  })

  it('renders boards when available', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, name: 'Sprint Board', description: 'Current sprint', owner: fakeUser, group: null, group_name: null, member_count: 1, created_at: '', updated_at: '' },
    ])
    renderDashboard()
    expect(await screen.findByText('Sprint Board')).toBeInTheDocument()
    expect(screen.getByText('Current sprint')).toBeInTheDocument()
  })

  it('filters out grouped boards from personal list', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, name: 'Personal Board', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, created_at: '', updated_at: '' },
      { id: 2, name: 'Group Board', description: '', owner: fakeUser, group: 5, group_name: 'Eng', member_count: 1, created_at: '', updated_at: '' },
    ])
    renderDashboard()
    expect(await screen.findByText('Personal Board')).toBeInTheDocument()
    expect(screen.queryByText('Group Board')).not.toBeInTheDocument()
  })

  it('shows new board button', async () => {
    renderDashboard()
    expect(await screen.findByText('+ New board')).toBeInTheDocument()
  })

  it('shows new group button', async () => {
    renderDashboard()
    expect(await screen.findByText('+ New top-level group')).toBeInTheDocument()
  })

  it('shows import button', async () => {
    renderDashboard()
    expect(await screen.findByText('Import')).toBeInTheDocument()
  })

  it('opens create board modal on new board click', async () => {
    const user = userEvent.setup()
    renderDashboard()
    await screen.findByText('+ New board')
    await user.click(screen.getByText('+ New board'))
    expect(screen.getByText('New Board')).toBeInTheDocument()
  })

  it('opens import modal on import click', async () => {
    const user = userEvent.setup()
    renderDashboard()
    await screen.findByText('Import')
    await user.click(screen.getByText('Import'))
    expect(screen.getByText('Import Board')).toBeInTheDocument()
  })

  it('switches from the import modal to the Trello import wizard', async () => {
    const user = userEvent.setup()
    renderDashboard()
    await screen.findByText('Import')
    await user.click(screen.getByText('Import'))
    await user.click(screen.getByRole('button', { name: 'Import a Trello export' }))
    expect(screen.queryByText('Import Board')).not.toBeInTheDocument()
    expect(screen.getByText('Import from Trello')).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 2 · Choose file')).toBeInTheDocument()
  })

  it('opens create group modal on new group click', async () => {
    const user = userEvent.setup()
    renderDashboard()
    await screen.findByText('+ New top-level group')
    await user.click(screen.getByText('+ New top-level group'))
    expect(screen.getByText('New Group')).toBeInTheDocument()
  })

  it('shows delete button on board hover', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, name: 'Sprint Board', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, created_at: '', updated_at: '' },
    ])
    renderDashboard()
    await screen.findByText('Sprint Board')
    // Delete button should exist (hidden by CSS, but in DOM)
    expect(screen.getByTitle('Delete board')).toBeInTheDocument()
    // accessible name must not depend on title alone (Firefox/VoiceOver skip it)
    expect(screen.getByRole('button', { name: 'Delete Sprint Board' })).toBeInTheDocument()
  })

  it('shows delete confirmation on delete click', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, name: 'Sprint Board', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, created_at: '', updated_at: '' },
    ])
    const user = userEvent.setup()
    renderDashboard()
    await screen.findByText('Sprint Board')
    await user.click(screen.getByTitle('Delete board'))
    expect(screen.getByText('Delete board?')).toBeInTheDocument()
  })

  it('shows move button for boards', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, name: 'Sprint Board', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, created_at: '', updated_at: '' },
    ])
    renderDashboard()
    await screen.findByText('Sprint Board')
    expect(screen.getByTitle('Move to group')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move Sprint Board to group' })).toBeInTheDocument()
  })

  it('renders groups when available', async () => {
    mockListGroups.mockResolvedValue([
      { id: 1, name: 'Engineering', owner: fakeUser, parent: null, parent_name: null, member_count: 3, board_count: 2, subgroup_count: 0, created_at: '' },
    ])
    renderDashboard()
    expect(await screen.findByText('Engineering')).toBeInTheDocument()
  })

  describe('Favorite Boards section', () => {
    it('hides the section entirely when no boards are starred', async () => {
      mockListBoards.mockResolvedValue([
        { id: 1, name: 'Sprint Board', description: '', owner: fakeUser, group: null, group_name: null, is_starred: false, member_count: 1, created_at: '', updated_at: '' },
      ])
      renderDashboard()
      await screen.findByText('Sprint Board')
      expect(screen.queryByText('Favorite Boards')).not.toBeInTheDocument()
    })

    it('renders starred boards above My Boards, alphabetically sorted', async () => {
      mockListBoards.mockResolvedValue([
        { id: 1, name: 'Zeta Plans', description: '', owner: fakeUser, group: null, group_name: null, is_starred: true, member_count: 1, created_at: '', updated_at: '' },
        { id: 2, name: 'Alpha Roadmap', description: '', owner: fakeUser, group: null, group_name: null, is_starred: true, member_count: 1, created_at: '', updated_at: '' },
        { id: 3, name: 'Unstarred Board', description: '', owner: fakeUser, group: null, group_name: null, is_starred: false, member_count: 1, created_at: '', updated_at: '' },
      ])
      renderDashboard()
      expect(await screen.findByText('Favorite Boards')).toBeInTheDocument()
      // Starred rows appear in alphabetical order above the My Boards heading.
      const rendered = screen.getAllByText(/Zeta Plans|Alpha Roadmap|Unstarred Board|My Boards/).map((n) => n.textContent)
      const alphaIdx = rendered.indexOf('Alpha Roadmap')
      const zetaIdx = rendered.indexOf('Zeta Plans')
      const myBoardsIdx = rendered.indexOf('My Boards')
      expect(alphaIdx).toBeLessThan(zetaIdx)
      expect(zetaIdx).toBeLessThan(myBoardsIdx)
    })

    it('includes starred boards that live inside groups (not just personal)', async () => {
      mockListBoards.mockResolvedValue([
        { id: 1, name: 'Team Planning', description: '', owner: fakeUser, group: 7, group_name: 'Eng', is_starred: true, member_count: 3, created_at: '', updated_at: '' },
        { id: 2, name: 'Personal Draft', description: '', owner: fakeUser, group: null, group_name: null, is_starred: false, member_count: 1, created_at: '', updated_at: '' },
      ])
      renderDashboard()
      // Starred group board appears under Favorite Boards heading.
      expect(await screen.findByText('Favorite Boards')).toBeInTheDocument()
      expect(screen.getByText('Team Planning')).toBeInTheDocument()
      // Personal (unstarred) board still appears under My Boards.
      expect(screen.getByText('Personal Draft')).toBeInTheDocument()
      // Team Planning should NOT appear under My Boards (filtered by !b.group).
      const personalRowHeading = screen.getByText('My Boards')
      const mySection = personalRowHeading.closest('section')
      expect(mySection).not.toBeNull()
      expect(mySection!.textContent).not.toContain('Team Planning')
    })
  })

  describe('join group modal — token extraction', () => {
    // The "Join a group with an invite link" button is rendered by OnboardingEmptyState,
    // which is only shown when both boards and groups lists are empty (the default mock state).

    it('navigates to /join/<token> when a full invite URL is pasted', async () => {
      const user = userEvent.setup({ delay: null })
      renderDashboard()

      // Wait for the empty-state to appear, then open the join modal
      await screen.findByText('Join a group with an invite link')
      await user.click(screen.getByText('Join a group with an invite link'))

      // The modal should now be open
      expect(screen.getByText('Join a group')).toBeInTheDocument()

      // Paste a full invite URL — the handler must strip everything before /join/.
      // Use paste (one state update) instead of type (one per char) — typing 31 chars
      // exceeds the 5000ms test timeout in CI.
      const input = screen.getByPlaceholderText(/https:.*\/join\/abc123 or abc123/i)
      input.focus()
      await user.paste('https://example.com/join/abc123')

      await user.click(screen.getByRole('button', { name: 'Join' }))

      expect(mockNavigate).toHaveBeenCalledWith('/join/abc123')
    })

    it('navigates to /join/<token> when a bare token is pasted', async () => {
      const user = userEvent.setup({ delay: null })
      renderDashboard()

      await screen.findByText('Join a group with an invite link')
      await user.click(screen.getByText('Join a group with an invite link'))

      expect(screen.getByText('Join a group')).toBeInTheDocument()

      const input = screen.getByPlaceholderText(/https:.*\/join\/abc123 or abc123/i)
      input.focus()
      await user.paste('xyz789')

      await user.click(screen.getByRole('button', { name: 'Join' }))

      expect(mockNavigate).toHaveBeenCalledWith('/join/xyz789')
    })
  })
})

describe('Dashboard — hosted demo (#1179)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListBoards.mockResolvedValue([])
    mockListGroups.mockResolvedValue([])
  })

  it('+ New board and Import are aria-disabled with the fixed-lead reason', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <Dashboard user={{ ...fakeUser, demo_mode: true }} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
      </MemoryRouter>
    )
    const newBoard = await screen.findByRole('button', { name: /^New board\./ })
    expect(newBoard).toHaveAttribute('aria-disabled', 'true')
    expect(newBoard).toHaveAttribute('title', "This is a shared demo — boards can't be created here.")
    const importBtn = screen.getByRole('button', { name: /^Import\./ })
    expect(importBtn).toHaveAttribute('aria-disabled', 'true')
    expect(importBtn).toHaveAttribute('title', "This is a shared demo — boards can't be imported here.")
    await user.click(newBoard)
    await user.click(importBtn)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

// #1289 — archived cards cascade with the board, so they must gate typed-name
// confirmation exactly like active cards, and the dialog must name them.
describe('Dashboard — delete confirmation and archived cards (#1289)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListGroups.mockResolvedValue([])
  })

  async function openDeleteDialog(card_count: number, archived_card_count: number) {
    mockListBoards.mockResolvedValue([
      { id: 1, name: 'Sprint Board', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, card_count, archived_card_count, created_at: '', updated_at: '' },
    ])
    const user = userEvent.setup()
    renderDashboard()
    await screen.findByText('Sprint Board')
    await user.click(screen.getByTitle('Delete board'))
    return { user, dialog: screen.getByRole('dialog', { name: 'Delete board?' }) }
  }

  it('requires typed confirmation for a board holding only archived cards', async () => {
    const { user, dialog } = await openDeleteDialog(0, 500)
    expect(dialog).toHaveTextContent('This board has 500 archived cards. Type the board name to confirm deletion.')
    const deleteButton = screen.getByRole('button', { name: 'Delete' })
    expect(deleteButton).toBeDisabled()
    await user.type(screen.getByPlaceholderText('Type "Sprint Board" to confirm'), 'Sprint Board')
    expect(deleteButton).toBeEnabled()
  })

  it('names both active and archived cards when the board has both', async () => {
    const { dialog } = await openDeleteDialog(1, 3)
    expect(dialog).toHaveTextContent('This board has 1 card and 3 archived cards. Type the board name to confirm deletion.')
  })

  it('mentions archived cards and allows single-click delete for an empty board', async () => {
    const { dialog } = await openDeleteDialog(0, 0)
    expect(dialog).toHaveTextContent('all its data, including archived cards, will be permanently deleted')
    expect(screen.queryByPlaceholderText('Type "Sprint Board" to confirm')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled()
  })
})

// #1374 — floating promises: initial load and delete failures must surface an
// error instead of failing silently, and a failed delete must not leave a
// board permanently missing from the list.
describe('Dashboard — rejection paths (#1374)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows an error when the initial board load fails', async () => {
    mockListBoards.mockRejectedValue(new Error('network error'))
    mockListGroups.mockResolvedValue([])
    renderDashboard()
    expect(await screen.findByTestId('dashboard-load-error')).toHaveTextContent(
      'Failed to load boards. Try refreshing the page.'
    )
  })

  it('shows an error when the initial group load fails', async () => {
    mockListBoards.mockResolvedValue([])
    mockListGroups.mockRejectedValue(new Error('network error'))
    renderDashboard()
    expect(await screen.findByTestId('dashboard-load-error')).toHaveTextContent(
      'Failed to load groups. Try refreshing the page.'
    )
  })

  it('reconciles with the server and shows an error when deleting a board fails', async () => {
    const board = { id: 1, name: 'Sprint Board', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, created_at: '', updated_at: '' }
    mockListBoards.mockResolvedValueOnce([board])
    mockListGroups.mockResolvedValue([])
    mockDeleteBoard.mockRejectedValue(new Error('server error'))
    // Refetch after the failed delete finds the board is still there.
    mockListBoards.mockResolvedValueOnce([board])

    const user = userEvent.setup()
    renderDashboard()
    await screen.findByText('Sprint Board')
    await user.click(screen.getByTitle('Delete board'))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    // Board reappears after the reconciling refetch, and the error is shown.
    expect(await screen.findByText('Sprint Board')).toBeInTheDocument()
    expect(await screen.findByTestId('dashboard-load-error')).toHaveTextContent(
      'Failed to delete the board. Please try again.'
    )
  })

  it('falls back to the pre-delete snapshot when both the delete and the reconciling refetch fail', async () => {
    const board = { id: 1, name: 'Sprint Board', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, created_at: '', updated_at: '' }
    mockListBoards.mockResolvedValueOnce([board])
    mockListGroups.mockResolvedValue([])
    mockDeleteBoard.mockRejectedValue(new Error('server error'))
    // The reconciling refetch also fails.
    mockListBoards.mockRejectedValueOnce(new Error('network error'))

    const user = userEvent.setup()
    renderDashboard()
    await screen.findByText('Sprint Board')
    await user.click(screen.getByTitle('Delete board'))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    // The board is restored from the pre-delete snapshot rather than left missing.
    expect(await screen.findByText('Sprint Board')).toBeInTheDocument()
    expect(await screen.findByTestId('dashboard-load-error')).toHaveTextContent(
      'Failed to delete the board. Please try again.'
    )
  })
})

// #1374 — navigate(...) after create/import/Trello-import was wrapped in void
// to silence the floating-promise lint rule. These exercise the actual
// navigation target so a wrong path still fails loudly.
describe('Dashboard — navigates to the new board after create/import (#1374)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListBoards.mockResolvedValue([])
    mockListGroups.mockResolvedValue([])
    mockNavigate.mockReset()
  })

  it('navigates to the new board after a successful create', async () => {
    const user = userEvent.setup()
    mockCreateBoard.mockResolvedValue({
      id: 42, name: 'New Board', description: '', owner: fakeUser,
      group: null, group_name: null, member_count: 1, created_at: '', updated_at: '',
    })
    renderDashboard()
    await screen.findByText('+ New board')
    await user.click(screen.getByText('+ New board'))
    await user.type(screen.getByPlaceholderText(/e.g. Q3 Pipeline/), 'New Board')
    await user.click(screen.getByRole('button', { name: 'Create Board' }))
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/boards/42'))
  })

  it('navigates to the new board after a successful import', async () => {
    const user = userEvent.setup()
    mockImportBoard.mockResolvedValue({
      id: 55, name: 'Imported Board', description: '', owner: fakeUser,
      group: null, group_name: null, member_count: 1, created_at: '', updated_at: '',
    })
    renderDashboard()
    await screen.findByText('Import')
    await user.click(screen.getByText('Import'))
    const dialog = await screen.findByRole('dialog')
    const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(fileInput, new File(['{}'], 'board.json', { type: 'application/json' }))
    await user.click(within(dialog).getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/boards/55'))
  })

  // #1526: a CSV import that only raised warnings (nothing skipped) must still
  // hand its summary to the board page; hasImportSkips guards this seam.
  it('forwards a warnings-only import summary to the board', async () => {
    const user = userEvent.setup()
    const importSummary = {
      options_applied: { labels: true, cards: true, comments: true, checklist: true, history: true },
      skipped: { cards: 0, comments: 0, checklist_items: 0, label_refs: 0, movements: 0, activities: 0 },
      warnings: ["Skipped column 'X': the field name is empty."],
    }
    mockImportBoard.mockResolvedValue({
      id: 58, name: 'Imported Board', description: '', owner: fakeUser,
      group: null, group_name: null, member_count: 1, created_at: '', updated_at: '',
      import_summary: importSummary,
    })
    renderDashboard()
    await screen.findByText('Import')
    await user.click(screen.getByText('Import'))
    const dialog = await screen.findByRole('dialog')
    const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(fileInput, new File(['{}'], 'board.json', { type: 'application/json' }))
    await user.click(within(dialog).getByRole('button', { name: 'Import' }))
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/boards/58', { state: { importSummary } }),
    )
  })

  // #119: unchecking an Include option sends it, and a non-empty skip
  // summary is handed to the board page in the navigation state.
  it('sends import options and forwards the skip summary to the board', async () => {
    const user = userEvent.setup()
    const importSummary = {
      options_applied: { labels: true, cards: false, comments: false, checklist: false, history: false },
      skipped: { cards: 2, comments: 0, checklist_items: 0, label_refs: 0, movements: 0, activities: 0 },
    }
    mockImportBoard.mockResolvedValue({
      id: 57, name: 'Imported Board', description: '', owner: fakeUser,
      group: null, group_name: null, member_count: 1, created_at: '', updated_at: '',
      import_summary: importSummary,
    })
    renderDashboard()
    await screen.findByText('Import')
    await user.click(screen.getByText('Import'))
    const dialog = await screen.findByRole('dialog')
    const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['{}'], 'board.json', { type: 'application/json' })
    await user.upload(fileInput, file)
    await user.click(within(dialog).getByRole('checkbox', { name: 'Cards' }))
    await user.click(within(dialog).getByRole('button', { name: 'Import' }))
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/boards/57', { state: { importSummary } }),
    )
    expect(mockImportBoard).toHaveBeenCalledWith(file, undefined, undefined, {
      labels: true, cards: false, comments: false, checklist: false, history: false,
    })
  })

  it('navigates to the new board after a successful Trello import', async () => {
    const user = userEvent.setup()
    mockPreviewTrelloImport.mockResolvedValue(trelloPreview())
    mockConfirmTrelloImport.mockResolvedValue({ board: { id: 77, name: 'Product Roadmap' }, summary: {} })
    renderDashboard()
    await screen.findByText('Import')
    await user.click(screen.getByText('Import'))
    await user.click(screen.getByRole('button', { name: 'Import a Trello export' }))
    await screen.findByText('Import from Trello')

    const fileInput = document.getElementById('trello-file') as HTMLInputElement
    await user.upload(fileInput, new File(['{"lists":[],"cards":[]}'], 'board.json', { type: 'application/json' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText('Step 2 of 2 · Review and configure')

    await user.click(screen.getByRole('button', { name: 'Create board' }))
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/boards/77'))
  })
})
