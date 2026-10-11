import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import GroupDetail from '../pages/GroupDetail'
import type { User, Group } from '../types'
import type { BoardEvent } from '../hooks/useBoardSocket'

// #1374 — real useNavigate so the many `void navigate(...)` sites (escape,
// 404/403 redirect, create/import board, delete group, breadcrumb, Trello
// import) can be asserted on without wiring up extra routes per test.
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

vi.mock('../components/Board/CreateBoardModal', () => ({
  default: ({ onConfirm, onCancel }: { onConfirm: (n: string, t: string, s: string, d: boolean) => void; onCancel: () => void }) => (
    <div data-testid="create-board-modal">
      <button onClick={() => onConfirm('New Board', 'simple_kanban', '', false)}>Confirm create board</button>
      <button onClick={onCancel}>Cancel create board</button>
    </div>
  ),
}))

vi.mock('../components/Board/ImportBoardModal', () => ({
  default: ({ onImport, onCancel, onSwitchToTrello }: { onImport: (file: File, name?: string, options?: Record<string, boolean>) => void; onCancel: () => void; onSwitchToTrello?: () => void }) => (
    <div data-testid="import-board-modal">
      <button onClick={() => onImport(new File(['{}'], 'board.json'), 'Imported Board')}>Confirm import board</button>
      <button onClick={() => onImport(new File(['{}'], 'board.json'), undefined, { labels: false, cards: true, comments: true, checklist: true, history: true })}>Confirm selective import board</button>
      <button onClick={onCancel}>Cancel import board</button>
      {onSwitchToTrello && <button onClick={onSwitchToTrello}>Switch to Trello</button>}
    </div>
  ),
}))

vi.mock('../components/Board/TrelloImportModal', () => ({
  default: ({ onCancel, onImported }: { onCancel: () => void; onImported: (board: { id: number }) => void }) => (
    <div data-testid="trello-import-modal">
      <button onClick={() => onImported({ id: 77 })}>Confirm trello import</button>
      <button onClick={onCancel}>Cancel trello import</button>
    </div>
  ),
}))

// Capture the onEvent callback passed to useGroupSocket so tests can simulate
// server-pushed board.created/updated/deleted events.
let capturedOnEvent: ((evt: BoardEvent) => void) | null = null
let capturedOnReconnected: (() => void) | null = null
vi.mock('../hooks/useGroupSocket', () => ({
  useGroupSocket: (
    _groupId: number | null,
    onEvent: (evt: BoardEvent) => void,
    options?: { onReconnected?: () => void },
  ) => {
    capturedOnEvent = onEvent
    capturedOnReconnected = options?.onReconnected ?? null
    return { connected: true, status: 'connected', lastEventAt: null, reconnectAttempt: 0 }
  },
}))

vi.mock('../api/groups', () => ({
  getGroup: vi.fn(),
  getGroupMembers: vi.fn(),
  getSubgroups: vi.fn(),
  getGroupBoards: vi.fn(),
  getGroupDescendantBoards: vi.fn().mockResolvedValue([]),
  createGroupBoard: vi.fn(),
  removeGroupMember: vi.fn(),
  updateGroupMemberRole: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
  listInviteLinks: vi.fn().mockResolvedValue([]),
  createInviteLink: vi.fn(),
  revokeInviteLink: vi.fn(),
  transferGroupOwnership: vi.fn(),
  starGroup: vi.fn().mockResolvedValue({}),
  unstarGroup: vi.fn().mockResolvedValue({}),
  createGroupLabel: vi.fn(),
  deleteGroupLabel: vi.fn().mockResolvedValue({}),
  updateGroupBoardDefaults: vi.fn(),
}))

vi.mock('../api/boards', () => ({
  importBoard: vi.fn(),
  previewTrelloImport: vi.fn(),
  confirmTrelloImport: vi.fn(),
}))

vi.mock('../api/notifications', () => ({
  getUnreadCount: vi.fn().mockResolvedValue(0),
  listNotifications: vi.fn().mockResolvedValue([]),
  markAllRead: vi.fn(),
  markRead: vi.fn(),
}))

vi.mock('../api/auth', () => ({
  getVersion: vi.fn().mockResolvedValue('0.3.0'),
  // InviteLinkPanel's EmailInviteForm reads it (#731); unavailable keeps the
  // section hidden so these tests stay about the page.
  getSiteConfig: vi.fn().mockResolvedValue({
    registration_open: true,
    registration_mode: 'open',
    demo_mode: false,
    demo_login: null,
    invite_email_available: false,
  }),
}))

import { getGroup, getGroupMembers, getSubgroups, getGroupBoards, getGroupDescendantBoards, updateGroup, starGroup, unstarGroup, createGroupLabel, updateGroupBoardDefaults, listInviteLinks, createGroupBoard, deleteGroup } from '../api/groups'
import { importBoard } from '../api/boards'
import { getSiteConfig } from '../api/auth'

const mockGetGroup = getGroup as ReturnType<typeof vi.fn>
const mockGetGroupMembers = getGroupMembers as ReturnType<typeof vi.fn>
const mockGetSubgroups = getSubgroups as ReturnType<typeof vi.fn>
const mockGetGroupBoards = getGroupBoards as ReturnType<typeof vi.fn>
const mockGetGroupDescendantBoards = getGroupDescendantBoards as ReturnType<typeof vi.fn>
const mockUpdateGroup = updateGroup as ReturnType<typeof vi.fn>
const mockStarGroup = starGroup as ReturnType<typeof vi.fn>
const mockUnstarGroup = unstarGroup as ReturnType<typeof vi.fn>
const mockCreateGroupLabel = createGroupLabel as ReturnType<typeof vi.fn>
const mockUpdateGroupBoardDefaults = updateGroupBoardDefaults as ReturnType<typeof vi.fn>
const mockCreateGroupBoard = createGroupBoard as ReturnType<typeof vi.fn>
const mockDeleteGroup = deleteGroup as ReturnType<typeof vi.fn>
const mockImportBoard = importBoard as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false,
}

const fakeGroup: Group = {
  id: 1, name: 'Engineering', description: '', owner: fakeUser,
  parent: null, parent_name: null,
  member_count: 2, board_count: 1, subgroup_count: 0, created_at: '',
  default_board_member_role: 'member', allowed_priorities: [], shared_labels: [],
  is_starred: false,
}

function renderGroupDetail(locationState?: Record<string, unknown>, user: User = fakeUser) {
  const initialEntries = locationState
    ? [{ pathname: '/groups/1', state: locationState }]
    : ['/groups/1']
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/groups/:id" element={<GroupDetail user={user} onLogout={vi.fn()} onUserUpdated={vi.fn()} />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('GroupDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnEvent = null
    capturedOnReconnected = null
    // Re-apply default resolved values cleared by clearAllMocks (implementation is preserved
    // but clearAllMocks wipes the mockResolvedValue queue for one-shot overrides).
    mockGetGroupDescendantBoards.mockResolvedValue([])
    mockStarGroup.mockResolvedValue({})
    mockUnstarGroup.mockResolvedValue({})
  })

  it('shows loading state', () => {
    mockGetGroup.mockReturnValue(new Promise(() => {}))
    mockGetGroupMembers.mockReturnValue(new Promise(() => {}))
    mockGetSubgroups.mockReturnValue(new Promise(() => {}))
    mockGetGroupBoards.mockReturnValue(new Promise(() => {}))
    renderGroupDetail()
    expect(document.querySelector('[role="status"]')).not.toBeNull()
  })

  it('shows error on failure', async () => {
    mockGetGroup.mockRejectedValue(new Error('fail'))
    mockGetGroupMembers.mockRejectedValue(new Error('fail'))
    mockGetSubgroups.mockRejectedValue(new Error('fail'))
    mockGetGroupBoards.mockRejectedValue(new Error('fail'))
    renderGroupDetail()
    expect(await screen.findByText('Failed to load group')).toBeInTheDocument()
  })

  it('renders group details when loaded', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([
      { id: 1, name: 'Sprint Board', description: '', owner: fakeUser, group: 1, group_name: 'Engineering', member_count: 1, created_at: '', updated_at: '' },
    ])
    renderGroupDetail()

    // Boards tab is shown by default
    expect(await screen.findByText('Sprint Board')).toBeInTheDocument()
    expect(screen.getByText('Subgroups')).toBeInTheDocument()

    // Members and Settings content live in the Settings tab
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0])
    expect(await screen.findByText('Members')).toBeInTheDocument()
  })

  it('gives the move-board button an accessible name beyond title alone', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([
      { id: 1, name: 'Sprint Board', description: '', owner: fakeUser, group: 1, group_name: 'Engineering', member_count: 1, created_at: '', updated_at: '' },
    ])
    renderGroupDetail()

    expect(await screen.findByText('Sprint Board')).toBeInTheDocument()
    // title alone is not a reliable accessible name (Firefox/VoiceOver skip it)
    expect(screen.getByRole('button', { name: 'Move Sprint Board to another group' })).toBeInTheDocument()
  })

  it('shows delete group button for admin', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    // Navigate to Settings tab where the danger zone lives
    fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
    expect(await screen.findByText('Delete group')).toBeInTheDocument()
  })

  it('shows + New board button for admin', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    expect(await screen.findByText('+ New board')).toBeInTheDocument()
  })

  it('shows + Create subgroup button for admin', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    expect(await screen.findByText('+ Create subgroup')).toBeInTheDocument()
  })

  it('shows Import button for admin', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    expect(await screen.findByText('Import')).toBeInTheDocument()
  })

  it('renders subgroups when available', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([
      { id: 2, name: 'Frontend', owner: fakeUser, parent: 1, parent_name: 'Engineering', member_count: 1, board_count: 0, subgroup_count: 0, created_at: '' },
    ])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    expect(await screen.findByText('Frontend')).toBeInTheDocument()
  })

  it('renders member list with roles', async () => {
    const otherUser: User = { ...fakeUser, id: 2, username: 'alice', display_name: 'Alice Smith' }
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
      { id: 2, user: otherUser, role: 'member', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    // Navigate to Settings tab where members are listed
    fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
    expect(await screen.findByText('Alice Smith')).toBeInTheDocument()
    // Admin can see role selectors and remove buttons for other members
    expect(screen.getByText('Remove')).toBeInTheDocument()
  })

  it('cancelling a member removal returns focus to that member\'s Remove trigger (#1367)', async () => {
    const otherUser: User = { ...fakeUser, id: 2, username: 'alice', display_name: 'Alice Smith' }
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
      { id: 2, user: otherUser, role: 'member', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
    await screen.findByText('Alice Smith')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Remove Alice Smith from group' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Remove Alice Smith from group' })).toHaveFocus()
  })

  it('hides admin controls for non-admin member', async () => {
    const otherOwner: User = { ...fakeUser, id: 99, username: 'boss', display_name: 'Boss' }
    mockGetGroup.mockResolvedValue({ ...fakeGroup, owner: otherOwner })
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'member', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    // Non-admin lands on Boards tab; Settings tab is hidden entirely
    await screen.findByText(/Subgroups let you organize/)
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.queryByText('Delete group')).not.toBeInTheDocument()
    expect(screen.queryByText('+ New board')).not.toBeInTheDocument()
    expect(screen.queryByText('+ Create subgroup')).not.toBeInTheDocument()
  })

  it('shows invite link panel for admin', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    // Navigate to Settings tab where the invite link panel lives
    fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
    expect(await screen.findByText('Invite links')).toBeInTheDocument()
  })

  it('passes the site-admin flag to the email invite form (#1445)', async () => {
    vi.mocked(getSiteConfig).mockResolvedValueOnce({
      registration_open: false, registration_mode: 'invite_only', demo_mode: false, demo_login: null, invite_email_available: true,
    } as Awaited<ReturnType<typeof getSiteConfig>>)
    const siteAdmin: User = { ...fakeUser, is_site_admin: true }
    mockGetGroup.mockResolvedValue({ ...fakeGroup, owner: siteAdmin })
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: siteAdmin, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail(undefined, siteAdmin)

    fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
    expect(await screen.findByText('New people can join this site only from invites you email, not from a shareable link.')).toBeInTheDocument()
    expect(screen.queryByText(/New users can't sign up/)).not.toBeInTheDocument()
  })

  it('shows subgroup empty state description for non-admin', async () => {
    const otherOwner: User = { ...fakeUser, id: 99, username: 'boss', display_name: 'Boss' }
    mockGetGroup.mockResolvedValue({ ...fakeGroup, owner: otherOwner })
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'member', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    expect(await screen.findByText('Subgroups let you organize boards and members into nested workspaces.')).toBeInTheDocument()
  })

  it('shows subgroup empty state description for admin', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    expect(await screen.findByText('Subgroups let you organize boards and members into nested workspaces.')).toBeInTheDocument()
  })

  it('shows join confirmation banner when arriving from invite flow', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail({ joinedGroup: 'Engineering' })

    expect(await screen.findByText(/You've joined/)).toBeInTheDocument()
    expect(screen.getByText(/You've joined/).closest('span')).toHaveTextContent("You've joined Engineering. Welcome!")
  })

  it('does not show join banner when navigating directly to group page', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    await screen.findByRole('heading', { name: 'Engineering' }) // wait for load
    expect(screen.queryByText(/You've joined/)).not.toBeInTheDocument()
  })

  it('renders ancestor breadcrumb when ancestors array is present', async () => {
    mockGetGroup.mockResolvedValue({
      ...fakeGroup,
      ancestors: [{ id: 10, name: 'RootOrg' }, { id: 11, name: 'PlatformTeam' }],
    })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    // Both the Navbar and in-page breadcrumbs render the ancestor links
    expect((await screen.findAllByText('RootOrg')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('PlatformTeam').length).toBeGreaterThanOrEqual(1)
  })

  it('does not render breadcrumb for root-level groups', async () => {
    mockGetGroup.mockResolvedValue({ ...fakeGroup, ancestors: [] })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    await screen.findByRole('heading', { name: 'Engineering' })
    expect(screen.queryByRole('navigation', { name: 'Group breadcrumb' })).not.toBeInTheDocument()
  })

  it('admin sees description edit placeholder when description is empty', async () => {
    mockGetGroup.mockResolvedValue({ ...fakeGroup, description: '' })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    await screen.findByRole('heading', { name: 'Engineering' })
    expect(screen.getByText('Add a description…')).toBeInTheDocument()
  })

  it('admin can click description area to edit it', async () => {
    mockGetGroup.mockResolvedValue({ ...fakeGroup, description: 'Our main engineering group' })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    const descText = await screen.findByText('Our main engineering group')
    fireEvent.click(descText)

    const textarea = screen.getByRole('textbox', { name: '' })
    expect((textarea as HTMLTextAreaElement).value).toBe('Our main engineering group')
  })

  it('description edit saves on blur and calls updateGroup', async () => {
    mockGetGroup.mockResolvedValue({ ...fakeGroup, description: 'Original' })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    mockUpdateGroup.mockResolvedValue({ ...fakeGroup, description: 'Updated' })
    renderGroupDetail()

    const descText = await screen.findByText('Original')
    fireEvent.click(descText)

    const textarea = screen.getByRole('textbox', { name: '' })
    fireEvent.change(textarea, { target: { value: 'Updated' } })
    fireEvent.blur(textarea)

    expect(mockUpdateGroup).toHaveBeenCalledWith(1, { description: 'Updated' })
  })

  it('description edit cancels on Escape', async () => {
    mockGetGroup.mockResolvedValue({ ...fakeGroup, description: 'Original' })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    const descText = await screen.findByText('Original')
    fireEvent.click(descText)

    const textarea = screen.getByRole('textbox', { name: '' })
    fireEvent.change(textarea, { target: { value: 'Should not save' } })
    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(screen.queryByRole('textbox', { name: '' })).not.toBeInTheDocument()
    expect(mockUpdateGroup).not.toHaveBeenCalled()
  })

  it('non-admin with description sees plain text, no edit affordance', async () => {
    const otherOwner: User = { ...fakeUser, id: 99, username: 'boss', display_name: 'Boss' }
    mockGetGroup.mockResolvedValue({ ...fakeGroup, description: 'Team description', owner: otherOwner })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'member', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    expect(await screen.findByText('Team description')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Team description'))
    // No textarea should appear for non-admin
    expect(screen.queryByRole('textbox', { name: '' })).not.toBeInTheDocument()
  })

  it('admin can click heading to start inline rename', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    const heading = await screen.findByRole('heading', { name: 'Engineering' })
    fireEvent.click(within(heading).getByRole('button'))

    const input = screen.getByRole('textbox')
    expect(input).toBeInTheDocument()
    expect((input as HTMLInputElement).value).toBe('Engineering')
  })

  it('admin can start rename and description edit from the keyboard (#1376)', async () => {
    mockGetGroup.mockResolvedValue({ ...fakeGroup, description: 'Team description' })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    const user = userEvent.setup()
    renderGroupDetail()

    const heading = await screen.findByRole('heading', { name: 'Engineering' })
    const nameButton = within(heading).getByRole('button')
    nameButton.focus()
    expect(nameButton).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('textbox')).toHaveValue('Engineering')
    await user.keyboard('{Escape}')

    expect(screen.getByRole('button', { name: 'Rename group' })).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('button', { name: 'Edit description' })).toHaveAttribute('tabindex', '-1')

    const descButton = screen.getByRole('button', { name: 'Team description' })
    descButton.focus()
    await user.keyboard(' ')
    expect(screen.getByRole('textbox')).toHaveValue('Team description')
  })

  it('admin rename saves on Enter and updates heading', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    mockUpdateGroup.mockResolvedValue({ ...fakeGroup, name: 'Platform' })
    renderGroupDetail()

    const heading = await screen.findByRole('heading', { name: 'Engineering' })
    fireEvent.click(within(heading).getByRole('button'))

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Platform' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mockUpdateGroup).toHaveBeenCalledWith(1, { name: 'Platform' })
  })

  it('admin rename cancels on Escape', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    const heading = await screen.findByRole('heading', { name: 'Engineering' })
    fireEvent.click(within(heading).getByRole('button'))

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Should not save' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(mockUpdateGroup).not.toHaveBeenCalled()
  })

  it('non-admin cannot click heading to rename', async () => {
    const otherOwner: User = { ...fakeUser, id: 99, username: 'boss', display_name: 'Boss' }
    mockGetGroup.mockResolvedValue({ ...fakeGroup, owner: otherOwner })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'member', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    // Wait for load — non-admin sees empty boards state text
    await screen.findByText(/Subgroups let you organize/)
    // No input should appear — heading is not interactive for non-admins
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('dismisses join banner when × is clicked', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail({ joinedGroup: 'Engineering' })

    expect(await screen.findByText(/You've joined/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByText(/You've joined/)).not.toBeInTheDocument()
  })

  it('toggling showSubgroupBoards calls getGroupDescendantBoards with the group ID', async () => {
    // The component issues a single getGroupDescendantBoards(groupId) request when the
    // toggle is turned on — avoiding the previous N+1 pattern of one getGroupBoards call
    // per direct subgroup. This test verifies that N+1 fix is exercised.
    const subgroup = {
      id: 5, name: 'Frontend', owner: fakeUser, parent: 1, parent_name: 'Engineering',
      member_count: 1, board_count: 1, subgroup_count: 0, created_at: '',
    }
    const subgroupBoard = {
      id: 10, name: 'Subgroup Sprint', description: '', owner: fakeUser,
      group: 5, group_name: 'Frontend', member_count: 1, created_at: '', updated_at: '',
    }

    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([subgroup])
    mockGetGroupBoards.mockResolvedValue([]) // group's own boards (no duplicates to exclude)
    mockGetGroupDescendantBoards.mockResolvedValue([subgroupBoard])

    renderGroupDetail()

    // Wait for load — toggle is only rendered when subgroups exist
    const toggle = await screen.findByRole('switch')
    expect(toggle).toBeInTheDocument()

    // Toggle on
    fireEvent.click(toggle)

    // The subgroup's board should appear under the toggle section
    expect(await screen.findByText('Subgroup Sprint')).toBeInTheDocument()

    // A single call with the root group ID — not one per subgroup
    expect(mockGetGroupDescendantBoards).toHaveBeenCalledWith(1)
    expect(mockGetGroupDescendantBoards).toHaveBeenCalledTimes(1)
  })

  // ---------------------------------------------------------------------------
  // Star / unstar (#1046)
  // ---------------------------------------------------------------------------

  describe('star / unstar', () => {
    function setupAdmin(isStarred = false) {
      mockGetGroup.mockResolvedValue({ ...fakeGroup, is_starred: isStarred })
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([])
    }

    it('star button shows hollow star when group is not starred', async () => {
      setupAdmin(false)
      renderGroupDetail()
      await screen.findByRole('heading', { name: 'Engineering' })
      const btn = screen.getByRole('button', { name: 'Star group' })
      expect(btn).toBeInTheDocument()
      // Button text content is the hollow star glyph
      expect(btn).toHaveTextContent('☆')
    })

    it('star button shows filled star when group is already starred', async () => {
      setupAdmin(true)
      renderGroupDetail()
      await screen.findByRole('heading', { name: 'Engineering' })
      const btn = screen.getByRole('button', { name: 'Unstar group' })
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveTextContent('★')
    })

    it('clicking star on an unstarred group calls starGroup and flips to filled star', async () => {
      setupAdmin(false)
      renderGroupDetail()
      await screen.findByRole('heading', { name: 'Engineering' })

      fireEvent.click(screen.getByRole('button', { name: 'Star group' }))

      expect(mockStarGroup).toHaveBeenCalledWith(1)
      expect(mockUnstarGroup).not.toHaveBeenCalled()

      // Optimistic UI: the button label flips immediately to "Unstar group"
      expect(await screen.findByRole('button', { name: 'Unstar group' })).toBeInTheDocument()
    })

    it('clicking unstar on a starred group calls unstarGroup and flips to hollow star', async () => {
      setupAdmin(true)
      renderGroupDetail()
      await screen.findByRole('heading', { name: 'Engineering' })

      fireEvent.click(screen.getByRole('button', { name: 'Unstar group' }))

      expect(mockUnstarGroup).toHaveBeenCalledWith(1)
      expect(mockStarGroup).not.toHaveBeenCalled()

      // Optimistic UI: the button label flips immediately to "Star group"
      expect(await screen.findByRole('button', { name: 'Star group' })).toBeInTheDocument()
    })

    it('reverts star state when starGroup API call fails', async () => {
      setupAdmin(false)
      mockStarGroup.mockRejectedValueOnce(new Error('network error'))
      renderGroupDetail()
      await screen.findByRole('heading', { name: 'Engineering' })

      fireEvent.click(screen.getByRole('button', { name: 'Star group' }))

      // After the rejection the state should revert to unstarred
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Star group' })).toBeInTheDocument()
      })
    })

    it('reverts unstar state when unstarGroup API call fails', async () => {
      setupAdmin(true)
      mockUnstarGroup.mockRejectedValueOnce(new Error('network error'))
      renderGroupDetail()
      await screen.findByRole('heading', { name: 'Engineering' })

      fireEvent.click(screen.getByRole('button', { name: 'Unstar group' }))

      // After the rejection the state should revert to starred
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Unstar group' })).toBeInTheDocument()
      })
    })

    it('group.star_changed WS event updates star indicator for current user', async () => {
      setupAdmin(false)
      renderGroupDetail()
      await screen.findByRole('heading', { name: 'Engineering' })
      expect(screen.getByRole('button', { name: 'Star group' })).toBeInTheDocument()

      act(() => {
        capturedOnEvent?.({
          event: 'group.star_changed',
          data: { id: 1, user_id: fakeUser.id, is_starred: true },
        } as BoardEvent)
      })

      expect(screen.getByRole('button', { name: 'Unstar group' })).toBeInTheDocument()
    })

    it('group.star_changed WS event for a different user does not change star indicator', async () => {
      setupAdmin(false)
      renderGroupDetail()
      await screen.findByRole('heading', { name: 'Engineering' })

      act(() => {
        capturedOnEvent?.({
          event: 'group.star_changed',
          data: { id: 1, user_id: 999, is_starred: true },
        } as BoardEvent)
      })

      // Still showing "Star group" (hollow) — different user, no local state change
      expect(screen.getByRole('button', { name: 'Star group' })).toBeInTheDocument()
    })
  })

  // ---------------------------------------------------------------------------
  // Real-time member + invite events (#1051)
  // ---------------------------------------------------------------------------

  describe('real-time member + invite events', () => {
    const mockListInviteLinks = listInviteLinks as ReturnType<typeof vi.fn>

    function setupAdmin() {
      mockGetGroup.mockResolvedValue(fakeGroup)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([])
    }

    it('member.removed WS event refetches the members list', async () => {
      setupAdmin()
      renderGroupDetail()
      await screen.findByRole('heading', { name: 'Engineering' })
      // Initial load fetched members once.
      expect(mockGetGroupMembers).toHaveBeenCalledTimes(1)

      act(() => {
        capturedOnEvent?.({ event: 'member.removed', data: { user_id: 2 } } as BoardEvent)
      })

      await waitFor(() => expect(mockGetGroupMembers).toHaveBeenCalledTimes(2))
    })

    it('invite_link.revoked WS event reloads the invite panel', async () => {
      setupAdmin()
      renderGroupDetail()
      // Mount the invite panel (Settings tab) — it fetches links once.
      fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
      await screen.findByText('Invite links')
      expect(mockListInviteLinks).toHaveBeenCalledTimes(1)

      act(() => {
        capturedOnEvent?.({ event: 'invite_link.revoked', data: { id: 7 } } as BoardEvent)
      })

      // The bumped reloadSignal triggers a refetch in InviteLinkPanel.
      await waitFor(() => expect(mockListInviteLinks).toHaveBeenCalledTimes(2))
    })

    it('invite_link.created WS event reloads the invite panel (#731)', async () => {
      setupAdmin()
      renderGroupDetail()
      fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
      await screen.findByText('Invite links')
      expect(mockListInviteLinks).toHaveBeenCalledTimes(1)

      act(() => {
        capturedOnEvent?.({ event: 'invite_link.created', data: { id: 9 } } as BoardEvent)
      })

      await waitFor(() => expect(mockListInviteLinks).toHaveBeenCalledTimes(2))
    })

    it('invite_link.revoked WS event does not refetch the members list', async () => {
      setupAdmin()
      renderGroupDetail()
      await screen.findByRole('heading', { name: 'Engineering' })
      expect(mockGetGroupMembers).toHaveBeenCalledTimes(1)

      act(() => {
        capturedOnEvent?.({ event: 'invite_link.revoked', data: { id: 7 } } as BoardEvent)
      })

      // Members are unaffected by an invite revoke — no extra members fetch.
      await Promise.resolve()
      expect(mockGetGroupMembers).toHaveBeenCalledTimes(1)
    })
  })

  // ---------------------------------------------------------------------------
  // Board-defaults tab (#1046)
  // ---------------------------------------------------------------------------

  describe('board-defaults tab', () => {
    async function loadAndSwitchToSettings() {
      mockGetGroup.mockResolvedValue({
        ...fakeGroup,
        default_board_member_role: 'member',
        allowed_priorities: ['low', 'medium', 'high', 'urgent'],
        shared_labels: [
          { id: 10, name: 'Bug', color: '#ef4444' },
        ],
      })
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([])
      renderGroupDetail()

      fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
    }

    it('switching to Settings tab renders the Board defaults section heading', async () => {
      await loadAndSwitchToSettings()
      expect(await screen.findByText('Board defaults')).toBeInTheDocument()
    })

    it('board defaults section shows the default member role label', async () => {
      await loadAndSwitchToSettings()
      expect(await screen.findByText('Default member role for new boards')).toBeInTheDocument()
    })

    it('flags the default member role as deprecated (#1430)', async () => {
      await loadAndSwitchToSettings()
      expect(
        await screen.findByText('Deprecated. This setting has no effect: group members get their group role on every group board.'),
      ).toBeInTheDocument()
    })

    it('associates the deprecation hint with the default role control (#1430)', async () => {
      await loadAndSwitchToSettings()
      const hint = await screen.findByText(/Deprecated\. This setting has no effect/)
      const control = screen.getByLabelText('Default member role for new boards')
      expect(control).toHaveAccessibleDescription(hint.textContent ?? '')
    })

    it('board defaults section shows the allowed priorities label', async () => {
      await loadAndSwitchToSettings()
      expect(await screen.findByText('Allowed priorities on new boards')).toBeInTheDocument()
    })

    it('board defaults section renders priority toggle buttons', async () => {
      await loadAndSwitchToSettings()
      await screen.findByText('Board defaults')
      // All four priorities should be rendered as buttons
      expect(screen.getByRole('button', { name: /low/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /medium/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /high/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /urgent/i })).toBeInTheDocument()
    })

    it('active priority toggles use /20 tints with on-tint text and a focus ring (#1550)', async () => {
      await loadAndSwitchToSettings()
      await screen.findByText('Board defaults')
      const expected: Record<string, string> = {
        low: 'text-info-on-tint', medium: 'text-warning-on-tint',
        high: 'text-danger-on-tint', urgent: 'text-danger-on-tint',
      }
      for (const [name, textClass] of Object.entries(expected)) {
        const btn = screen.getByRole('button', { name })
        expect(btn).toHaveClass(textClass, 'focus:ring-2')
        expect(btn.className).toMatch(/bg-(info|warning|danger)\/20/)
        expect(btn.className).not.toMatch(/bg-(info|warning|danger)\/(50|60)/)
      }
    })

    it('medium, high and urgent toggles are visually distinct (#1592)', async () => {
      await loadAndSwitchToSettings()
      await screen.findByText('Board defaults')
      const medium = screen.getByRole('button', { name: 'medium' })
      const high = screen.getByRole('button', { name: 'high' })
      const urgent = screen.getByRole('button', { name: 'urgent' })
      expect(medium).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByRole('button', { name: 'low' })).toHaveClass('bg-info/20', 'border-info/60')
      expect(medium).toHaveClass('bg-warning/20', 'border-warning/60')
      expect(high).toHaveClass('bg-danger/20', 'border-danger/60')
      expect(high).not.toHaveClass('bg-warning/20')
      expect(urgent).toHaveClass('border-danger', 'font-semibold')
      expect(urgent).not.toHaveClass('border-danger/60')
    })

    it('a disabled priority toggle reports aria-pressed=false (#1592)', async () => {
      mockUpdateGroupBoardDefaults.mockResolvedValue({
        ...fakeGroup,
        allowed_priorities: ['medium', 'high', 'urgent'],
      })
      await loadAndSwitchToSettings()
      await screen.findByText('Board defaults')
      expect(screen.getByRole('button', { name: 'low' })).toHaveAttribute('aria-pressed', 'true')
      fireEvent.click(screen.getByRole('button', { name: 'low' }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'low' })).toHaveAttribute('aria-pressed', 'false')
      })
      expect(screen.getByRole('button', { name: 'low' })).not.toHaveClass('bg-info/20')
    })

    it('toggling a priority button calls updateGroupBoardDefaults', async () => {
      mockUpdateGroupBoardDefaults.mockResolvedValue({
        ...fakeGroup,
        allowed_priorities: ['medium', 'high', 'urgent'],
      })
      await loadAndSwitchToSettings()
      await screen.findByText('Board defaults')

      // Click the "low" priority button to disable it (accessible name is the text content)
      fireEvent.click(screen.getByRole('button', { name: 'low' }))

      await waitFor(() => {
        expect(mockUpdateGroupBoardDefaults).toHaveBeenCalledWith(1, expect.objectContaining({
          allowed_priorities: expect.not.arrayContaining(['low']),
        }))
      })
    })

    it('board defaults section shows the shared label library heading', async () => {
      await loadAndSwitchToSettings()
      expect(await screen.findByText('Shared label library')).toBeInTheDocument()
    })

    it('shared labels in the group are listed under the shared label library', async () => {
      await loadAndSwitchToSettings()
      // The label "Bug" was added to the group fixture
      expect(await screen.findByText('Bug')).toBeInTheDocument()
    })

    it('Add button is disabled when label name input is empty', async () => {
      await loadAndSwitchToSettings()
      await screen.findByText('Shared label library')

      const addBtn = screen.getByRole('button', { name: 'Add' })
      expect(addBtn).toBeDisabled()
    })

    it('Add button is enabled after typing a label name', async () => {
      await loadAndSwitchToSettings()
      await screen.findByText('Shared label library')

      const input = screen.getByPlaceholderText('Label name…')
      fireEvent.change(input, { target: { value: 'Enhancement' } })

      expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled()
    })

    it('submitting Add calls createGroupLabel with name and color', async () => {
      const newLabel = { id: 20, name: 'Enhancement', color: '#EAB308' }
      mockCreateGroupLabel.mockResolvedValue(newLabel)
      await loadAndSwitchToSettings()
      await screen.findByText('Shared label library')

      const input = screen.getByPlaceholderText('Label name…')
      fireEvent.change(input, { target: { value: 'Enhancement' } })
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))

      await waitFor(() => {
        expect(mockCreateGroupLabel).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'Enhancement' }))
      })
    })

    it('new label appears in the list after successful creation', async () => {
      const newLabel = { id: 20, name: 'Enhancement', color: '#EAB308' }
      mockCreateGroupLabel.mockResolvedValue(newLabel)
      await loadAndSwitchToSettings()
      await screen.findByText('Shared label library')

      const input = screen.getByPlaceholderText('Label name…')
      fireEvent.change(input, { target: { value: 'Enhancement' } })
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))

      expect(await screen.findByText('Enhancement')).toBeInTheDocument()
    })

    it('pressing Enter in label name input also triggers creation', async () => {
      const newLabel = { id: 21, name: 'Spike', color: '#EAB308' }
      mockCreateGroupLabel.mockResolvedValue(newLabel)
      await loadAndSwitchToSettings()
      await screen.findByText('Shared label library')

      const input = screen.getByPlaceholderText('Label name…')
      fireEvent.change(input, { target: { value: 'Spike' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(mockCreateGroupLabel).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'Spike' }))
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Shared-labels tab (within Settings, #1046)
  // ---------------------------------------------------------------------------

  describe('shared-labels tab', () => {
    it('shows existing shared labels for the group', async () => {
      const groupWithLabels: Group = {
        ...fakeGroup,
        shared_labels: [
          { id: 1, name: 'Frontend', color: '#3b82f6' },
          { id: 2, name: 'Backend', color: '#22c55e' },
        ],
      }
      mockGetGroup.mockResolvedValue(groupWithLabels)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([])
      renderGroupDetail()

      fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])

      expect(await screen.findByText('Frontend')).toBeInTheDocument()
      expect(screen.getByText('Backend')).toBeInTheDocument()
    })

    it('shows empty-state text when group has no shared labels', async () => {
      mockGetGroup.mockResolvedValue({ ...fakeGroup, shared_labels: [] })
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([])
      renderGroupDetail()

      fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])

      expect(await screen.findByText('No shared labels yet.')).toBeInTheDocument()
    })

    it('each shared label has a Remove button', async () => {
      const groupWithLabels: Group = {
        ...fakeGroup,
        shared_labels: [
          { id: 1, name: 'Docs', color: '#8b5cf6' },
          { id: 2, name: 'Chore', color: '#64748b' },
        ],
      }
      mockGetGroup.mockResolvedValue(groupWithLabels)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([])
      renderGroupDetail()

      fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
      await screen.findByText('Docs')

      // Each label row carries a Remove button
      expect(screen.getByRole('button', { name: 'Remove Docs from group' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Remove Chore from group' })).toBeInTheDocument()
    })

    it('clicking Remove on a label shows an inline confirm prompt', async () => {
      const groupWithLabel: Group = {
        ...fakeGroup,
        shared_labels: [{ id: 1, name: 'Design', color: '#f59e0b' }],
      }
      mockGetGroup.mockResolvedValue(groupWithLabel)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([])
      renderGroupDetail()

      fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
      await screen.findByText('Design')

      // Click Remove on the label. The label-row Remove button is the first one;
      // the member-row Remove button lives in the Members section below.
      const removeBtn = screen.getByRole('button', { name: 'Remove Design from group' })
      fireEvent.click(removeBtn)

      // Inline confirmation prompt should appear
      expect(await screen.findByText(/from this group\?/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    })

    it('confirming label removal removes the label from the list', async () => {
      const groupWithLabel: Group = {
        ...fakeGroup,
        shared_labels: [{ id: 1, name: 'Design', color: '#f59e0b' }],
      }
      mockGetGroup.mockResolvedValue(groupWithLabel)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([])
      renderGroupDetail()

      fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
      await screen.findByText('Design')

      fireEvent.click(screen.getByRole('button', { name: 'Remove Design from group' }))
      await screen.findByText(/from this group\?/)
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

      await waitFor(() => {
        expect(screen.queryByText('Design')).not.toBeInTheDocument()
      })
    })

    it('cancelling label removal returns focus to the Remove trigger (#1367)', async () => {
      const groupWithLabel: Group = {
        ...fakeGroup,
        shared_labels: [{ id: 1, name: 'Design', color: '#f59e0b' }],
      }
      mockGetGroup.mockResolvedValue(groupWithLabel)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([])
      renderGroupDetail()

      fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
      await screen.findByText('Design')

      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Remove Design from group' }))
      await screen.findByText(/from this group\?/)
      await user.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(screen.getByRole('button', { name: 'Remove Design from group' })).toHaveFocus()
    })

    it('cancelling label removal preserves the label in the list', async () => {
      const groupWithLabel: Group = {
        ...fakeGroup,
        shared_labels: [{ id: 1, name: 'Design', color: '#f59e0b' }],
      }
      mockGetGroup.mockResolvedValue(groupWithLabel)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([])
      renderGroupDetail()

      fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
      await screen.findByText('Design')

      fireEvent.click(screen.getByRole('button', { name: 'Remove Design from group' }))
      await screen.findByText(/from this group\?/)
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      // Label should still be visible
      expect(screen.getByText('Design')).toBeInTheDocument()
    })

    it('label removal: Escape cancels the prompt without leaving the page (#1238)', async () => {
      mockGetGroup.mockResolvedValue({ ...fakeGroup, shared_labels: [{ id: 1, name: 'Design', color: '#f59e0b' }] })
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([])
      renderGroupDetail()

      fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
      await screen.findByText('Design')
      fireEvent.click(screen.getByRole('button', { name: 'Remove Design from group' }))
      expect(screen.getByText(/from this group\?/)).toBeInTheDocument()

      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(screen.queryByText(/from this group\?/)).not.toBeInTheDocument()
      expect(screen.getByText('Design')).toBeInTheDocument()
    })

    it('member removal: full-sentence Confirm/Cancel prompt, and Escape cancels it without leaving the page (#1238)', async () => {
      const otherUser: User = { ...fakeUser, id: 2, username: 'alice', display_name: 'Alice Smith' }
      mockGetGroup.mockResolvedValue(fakeGroup)
      mockGetGroupMembers.mockResolvedValue([
        { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
        { id: 2, user: otherUser, role: 'member', joined_at: '' },
      ])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([])
      renderGroupDetail()

      fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
      await screen.findByText('Alice Smith')
      fireEvent.click(screen.getByRole('button', { name: 'Remove Alice Smith from group' }))

      expect(screen.getByText(/from this group\?/).textContent).toBe('Remove Alice Smith from this group?')
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()

      // Escape dismisses the prompt rather than reaching the page-level navigate(-1)
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(screen.queryByText(/from this group\?/)).not.toBeInTheDocument()
      expect(screen.getByText('Alice Smith')).toBeInTheDocument()
    })
  })

  describe('live updates (#753)', () => {
    const existingBoard = {
      id: 1, name: 'Sprint Board', description: '', owner: fakeUser,
      group: 1, group_name: 'Engineering', member_count: 1,
      created_at: '', updated_at: '',
    }

    async function loadGroup() {
      mockGetGroup.mockResolvedValue(fakeGroup)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([existingBoard])
      renderGroupDetail()
      await screen.findByText('Sprint Board')
    }

    it('appends a new board on board.created and applies the fade-in class', async () => {
      await loadGroup()
      const incoming = { ...existingBoard, id: 2, name: 'Live Board' }
      // act(sync) flushes the state update synchronously, so the row is in the
      // DOM immediately. Using findByText here would poll for up to several
      // hundred ms, during which the component's 200 ms setTimeout can fire and
      // clear animate-fade-in before we assert on it (flaky under CI load).
      act(() => {
        capturedOnEvent?.({ event: 'board.created', data: incoming } as BoardEvent)
      })
      const liveBoard = screen.getByText('Live Board')
      expect(liveBoard).toBeInTheDocument()
      const trigger = liveBoard.closest('[data-board-id]') as HTMLElement
      expect(trigger.parentElement?.className).toContain('animate-fade-in')
      expect(trigger.parentElement?.className).toContain('motion-reduce:animate-none')
    })

    it('ignores duplicate board.created for a board already in the list', async () => {
      await loadGroup()
      act(() => {
        capturedOnEvent?.({ event: 'board.created', data: existingBoard } as BoardEvent)
      })
      // Still exactly one row for Sprint Board.
      expect(screen.getAllByText('Sprint Board')).toHaveLength(1)
    })

    it('patches the existing row on board.updated', async () => {
      await loadGroup()
      act(() => {
        capturedOnEvent?.({
          event: 'board.updated',
          data: { ...existingBoard, name: 'Renamed Board' },
        } as BoardEvent)
      })
      expect(await screen.findByText('Renamed Board')).toBeInTheDocument()
      expect(screen.queryByText('Sprint Board')).not.toBeInTheDocument()
    })

    it('board.updated carrying the actor is_starred leaves the local star unchanged (#1559)', async () => {
      mockGetGroup.mockResolvedValue(fakeGroup)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([{ ...existingBoard, uid: 'board-uid-1', is_starred: false }])
      renderGroupDetail()
      await screen.findByText('Sprint Board')
      const row = () => screen.getByText(/Sprint Board|Renamed By Starrer/).closest('[data-board-id]') as HTMLElement
      expect(row()).toHaveAttribute('data-starred', 'false')
      act(() => {
        capturedOnEvent?.({
          event: 'board.updated',
          data: { ...existingBoard, uid: 'board-uid-1', name: 'Renamed By Starrer', is_starred: true },
        } as BoardEvent)
      })
      expect(await screen.findByText('Renamed By Starrer')).toBeInTheDocument()
      expect(row()).toHaveAttribute('data-starred', 'false')
      // The user's own board.star_changed still updates it.
      act(() => {
        capturedOnEvent?.({
          event: 'board.star_changed',
          data: { uid: 'board-uid-1', user_id: fakeUser.id, is_starred: true },
        } as BoardEvent)
      })
      expect(row()).toHaveAttribute('data-starred', 'true')
    })

    it('board.created with the creator is_starred appends an unstarred row (#1559)', async () => {
      await loadGroup()
      act(() => {
        capturedOnEvent?.({
          event: 'board.created',
          data: { ...existingBoard, id: 3, name: 'Starred By Creator', is_starred: true },
        } as BoardEvent)
      })
      const row = screen.getByText('Starred By Creator').closest('[data-board-id]') as HTMLElement
      expect(row).toHaveAttribute('data-starred', 'false')
    })

    it('board.updated for an unknown board id is a no-op', async () => {
      await loadGroup()
      act(() => {
        capturedOnEvent?.({
          event: 'board.updated',
          data: { ...existingBoard, id: 999, name: 'Ghost' },
        } as BoardEvent)
      })
      expect(screen.queryByText('Ghost')).not.toBeInTheDocument()
      expect(screen.getByText('Sprint Board')).toBeInTheDocument()
    })

    it('removes the row on board.deleted', async () => {
      await loadGroup()
      act(() => {
        capturedOnEvent?.({
          event: 'board.deleted',
          data: { id: 1, board_uid: 'abc' },
        } as BoardEvent)
      })
      await waitFor(() => {
        expect(screen.queryByText('Sprint Board')).not.toBeInTheDocument()
      })
    })

    it('refetches the boards list on reconnect to recover missed events', async () => {
      await loadGroup()
      // A board was created server-side while we were disconnected; the refetch
      // returns the new list.
      const refreshed = [existingBoard, { ...existingBoard, id: 9, name: 'Missed While Offline' }]
      mockGetGroupBoards.mockResolvedValueOnce(refreshed)
      await act(async () => {
        capturedOnReconnected?.()
      })
      expect(await screen.findByText('Missed While Offline')).toBeInTheDocument()
    })

    it('restores focus to the first remaining board after a remote delete', async () => {
      mockGetGroup.mockResolvedValue(fakeGroup)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      const boardA = { ...existingBoard, id: 1, name: 'Alpha' }
      const boardB = { ...existingBoard, id: 2, name: 'Bravo' }
      mockGetGroupBoards.mockResolvedValue([boardA, boardB])
      renderGroupDetail()
      const alphaBtn = (await screen.findByText('Alpha')).closest('[data-board-id]') as HTMLElement
      alphaBtn.focus()
      expect(document.activeElement).toBe(alphaBtn)

      // Delete the currently-focused board.
      act(() => {
        capturedOnEvent?.({ event: 'board.deleted', data: { id: 1 } } as BoardEvent)
      })

      await waitFor(() => {
        expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
      })
      // Focus moved to the remaining board (Bravo).
      const bravoBtn = screen.getByText('Bravo').closest('[data-board-id]') as HTMLElement
      expect(document.activeElement).toBe(bravoBtn)
    })

    it('refetches the group on group.updated (#906)', async () => {
      const updatedGroup: Group = { ...fakeGroup, owner: { ...fakeUser, id: 2, username: 'newowner', display_name: 'New Owner' } }
      // First call: initial load; second call: triggered by group.updated event
      mockGetGroup
        .mockResolvedValueOnce(fakeGroup)
        .mockResolvedValueOnce(updatedGroup)
      await loadGroup()

      act(() => {
        capturedOnEvent?.({ event: 'group.updated', data: { id: 1, name: fakeGroup.name, owner: { id: 2, username: 'newowner', display_name: 'New Owner', avatar_url: null } } } as BoardEvent)
      })

      // getGroup must be called a second time — once for initial load, once for the event
      await waitFor(() => {
        expect(mockGetGroup).toHaveBeenCalledTimes(2)
      })
    })

    it('patches is_starred on board.star_changed for the current user (#952)', async () => {
      const boardWithUid = { ...existingBoard, uid: 'board-uid-1', is_starred: false }
      mockGetGroup.mockResolvedValue(fakeGroup)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([boardWithUid])
      renderGroupDetail()
      await screen.findByText('Sprint Board')

      act(() => {
        capturedOnEvent?.({
          event: 'board.star_changed',
          data: { uid: 'board-uid-1', user_id: fakeUser.id, is_starred: true },
        } as BoardEvent)
      })

      // No refetch — the boards list is patched in place. Star state mutation
      // is not directly visible in this rendering, but the event handler must
      // accept the payload without throwing and without triggering getGroup.
      expect(mockGetGroup).toHaveBeenCalledTimes(1)
    })

    it('ignores board.star_changed for a different user (#952)', async () => {
      const boardWithUid = { ...existingBoard, uid: 'board-uid-1', is_starred: false }
      mockGetGroup.mockResolvedValue(fakeGroup)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([boardWithUid])
      renderGroupDetail()
      await screen.findByText('Sprint Board')

      // Star event for a different user must not affect local state and must
      // not throw.  Star is per-user; the group channel broadcasts to all
      // group members, so each client filters on user_id === me.
      act(() => {
        capturedOnEvent?.({
          event: 'board.star_changed',
          data: { uid: 'board-uid-1', user_id: 999, is_starred: true },
        } as BoardEvent)
      })

      expect(mockGetGroup).toHaveBeenCalledTimes(1)
    })

    it('removes a subgroup row on group.deleted (#998)', async () => {
      const subgroup = { ...fakeGroup, id: 2, name: 'Sub Team', parent: 1 }
      mockGetGroup.mockResolvedValue(fakeGroup)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([subgroup])
      mockGetGroupBoards.mockResolvedValue([existingBoard])
      renderGroupDetail()
      expect(await screen.findByText('Sub Team')).toBeInTheDocument()

      act(() => {
        capturedOnEvent?.({ event: 'group.deleted', data: { id: 2 } } as BoardEvent)
      })

      await waitFor(() => {
        expect(screen.queryByText('Sub Team')).not.toBeInTheDocument()
      })
    })

    it('refetches subgroups on group.created (#998)', async () => {
      await loadGroup()
      act(() => {
        capturedOnEvent?.({ event: 'group.created', data: { id: 3, name: 'New Sub', parent: 1 } } as BoardEvent)
      })
      // getSubgroups: once on initial load, once on the event.
      await waitFor(() => {
        expect(mockGetSubgroups).toHaveBeenCalledTimes(2)
      })
    })

    it('refetches members on member.added and member.updated (#998)', async () => {
      await loadGroup()
      act(() => {
        capturedOnEvent?.({ event: 'member.added', data: { id: 5, user: fakeUser, role: 'member', joined_at: '' } } as BoardEvent)
      })
      await waitFor(() => {
        expect(mockGetGroupMembers).toHaveBeenCalledTimes(2)
      })
      act(() => {
        capturedOnEvent?.({ event: 'member.updated', data: { id: 5, user: fakeUser, role: 'admin', joined_at: '' } } as BoardEvent)
      })
      await waitFor(() => {
        expect(mockGetGroupMembers).toHaveBeenCalledTimes(3)
      })
    })

    it('refetches the group on group.label.* events (#998)', async () => {
      await loadGroup()
      const before = mockGetGroup.mock.calls.length
      act(() => {
        capturedOnEvent?.({ event: 'group.label.created', data: { id: 7, name: 'Urgent', color: '#f00' } } as BoardEvent)
      })
      await waitFor(() => {
        expect(mockGetGroup.mock.calls.length).toBe(before + 1)
      })
    })
  })
})

// #1374 — every `navigate(...)` call on this page was wrapped in `void` to
// silence the floating-promise lint rule. These tests exercise the actual
// navigation targets so a future regression (wrong path, wrong args) still
// fails loudly even though the lint rule itself can no longer catch it.
describe('GroupDetail — navigation (#1374)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnEvent = null
    capturedOnReconnected = null
    mockGetGroupDescendantBoards.mockResolvedValue([])
    mockStarGroup.mockResolvedValue({})
    mockUnstarGroup.mockResolvedValue({})
  })

  function setupAdmin(overrides: Partial<Group> = {}) {
    mockGetGroup.mockResolvedValue({ ...fakeGroup, ...overrides })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
  }

  it('Escape navigates to / when there is no browser history to go back to', async () => {
    setupAdmin()
    renderGroupDetail()
    // JSDOM has no real history, so history.length === 1 → navigate("/")
    await screen.findByText('+ New board')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(mockNavigate).toHaveBeenCalledWith('/')
  })

  it('Escape navigates back when browser history has previous entries', async () => {
    setupAdmin()
    const historySpy = vi.spyOn(window.history, 'length', 'get').mockReturnValue(2)
    try {
      renderGroupDetail()
      await screen.findByText('+ New board')
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(mockNavigate).toHaveBeenCalledWith(-1)
    } finally {
      historySpy.mockRestore()
    }
  })

  it('redirects to / when the group fails to load with 404 or 403', async () => {
    mockGetGroup.mockRejectedValue({ response: { status: 404 } })
    mockGetGroupMembers.mockRejectedValue({ response: { status: 404 } })
    mockGetSubgroups.mockRejectedValue({ response: { status: 404 } })
    mockGetGroupBoards.mockRejectedValue({ response: { status: 404 } })
    renderGroupDetail()
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
    })
  })

  it('navigates to the new board after creating one', async () => {
    setupAdmin()
    mockCreateGroupBoard.mockResolvedValue({
      id: 42, name: 'New Board', description: '', owner: fakeUser,
      group: 1, group_name: 'Engineering', member_count: 1, created_at: '', updated_at: '',
    })
    renderGroupDetail()
    fireEvent.click(await screen.findByText('+ New board'))
    fireEvent.click(screen.getByText('Confirm create board'))
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/boards/42')
    })
  })

  it('navigates to the new board after importing one', async () => {
    setupAdmin()
    mockImportBoard.mockResolvedValue({
      id: 55, name: 'Imported Board', description: '', owner: fakeUser,
      group: 1, group_name: 'Engineering', member_count: 1, created_at: '', updated_at: '',
    })
    renderGroupDetail()
    fireEvent.click(await screen.findByText('Import'))
    fireEvent.click(screen.getByText('Confirm import board'))
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/boards/55')
    })
  })

  // #1526: a warnings-only CSV import summary is still forwarded to the board page.
  it('forwards a warnings-only import summary to the board', async () => {
    setupAdmin()
    const importSummary = {
      options_applied: { labels: true, cards: true, comments: true, checklist: true, history: true },
      skipped: { cards: 0, comments: 0, checklist_items: 0, label_refs: 0, movements: 0, activities: 0 },
      warnings: ["Skipped column 'X': the field name is empty."],
    }
    mockImportBoard.mockResolvedValue({
      id: 59, name: 'Imported Board', description: '', owner: fakeUser,
      group: 1, group_name: 'Engineering', member_count: 1, created_at: '', updated_at: '',
      import_summary: importSummary,
    })
    renderGroupDetail()
    fireEvent.click(await screen.findByText('Import'))
    fireEvent.click(screen.getByText('Confirm import board'))
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/boards/59', { state: { importSummary } })
    })
  })

  // #119: a selective import passes its options through with the group id,
  // and hands a non-empty skip summary to the board page.
  it('passes import options through and forwards the skip summary', async () => {
    setupAdmin()
    const importSummary = {
      options_applied: { labels: false, cards: true, comments: true, checklist: true, history: true },
      skipped: { cards: 0, comments: 0, checklist_items: 0, label_refs: 4, movements: 0, activities: 0 },
    }
    mockImportBoard.mockResolvedValue({
      id: 56, name: 'Imported Board', description: '', owner: fakeUser,
      group: 1, group_name: 'Engineering', member_count: 1, created_at: '', updated_at: '',
      import_summary: importSummary,
    })
    renderGroupDetail()
    fireEvent.click(await screen.findByText('Import'))
    fireEvent.click(screen.getByText('Confirm selective import board'))
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/boards/56', { state: { importSummary } })
    })
    expect(mockImportBoard).toHaveBeenCalledWith(
      expect.any(File), undefined, 1,
      { labels: false, cards: true, comments: true, checklist: true, history: true },
    )
  })

  it('navigates to the new board after a Trello import', async () => {
    setupAdmin()
    renderGroupDetail()
    fireEvent.click(await screen.findByText('Import'))
    fireEvent.click(screen.getByText('Switch to Trello'))
    fireEvent.click(screen.getByText('Confirm trello import'))
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/boards/77')
    })
  })

  it('navigates to / after deleting the group', async () => {
    setupAdmin()
    mockDeleteGroup.mockResolvedValue(undefined)
    renderGroupDetail()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
    fireEvent.click(await screen.findByRole('button', { name: 'Delete group' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete group' }))
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/')
    })
  })

  it('navigates to the ancestor group when its breadcrumb link is clicked', async () => {
    setupAdmin({ ancestors: [{ id: 10, name: 'RootOrg' }, { id: 11, name: 'PlatformTeam' }] })
    renderGroupDetail()
    await screen.findAllByText('RootOrg')
    const breadcrumbNav = screen.getByRole('navigation', { name: 'Group breadcrumb' })
    fireEvent.click(within(breadcrumbNav).getByText('RootOrg'))
    expect(mockNavigate).toHaveBeenCalledWith('/groups/10')
  })
})
