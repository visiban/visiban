import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import GroupDetail from '../pages/GroupDetail'
import { ShellNavDataContext, EMPTY_SHELL_NAV_DATA } from '../contexts/ShellNavContext'
import type { Board, Group, GroupMembership, User } from '../types'

// #2478: the group page's roles (admin, member, viewer, navigation-only) and the Group settings
// view. The real Navbar renders, so these also prove the one-h1 rule on the loaded page.

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock('../components/Board/CreateBoardModal', () => ({
  default: ({ onConfirm }: { onConfirm: (n: string, t: string, s: string, d: boolean) => void }) => (
    <button onClick={() => onConfirm('Made Board', 'simple_kanban', '', false)}>Confirm create board</button>
  ),
}))
vi.mock('../components/Board/ImportBoardModal', () => ({ default: () => <div data-testid="import-board-modal" /> }))
vi.mock('../components/Board/TrelloImportModal', () => ({ default: () => null }))
vi.mock('../components/Board/BoardDeleteImpact', () => ({ default: () => null }))
vi.mock('../hooks/useGroupSocket', () => ({
  useGroupSocket: () => ({ connected: true, status: 'connected', lastEventAt: null, reconnectAttempt: 0 }),
}))
vi.mock('../api/groups', () => ({
  getGroup: vi.fn(), getGroupMembers: vi.fn(), getSubgroups: vi.fn(), getGroupBoards: vi.fn(),
  getGroupDescendantBoards: vi.fn().mockResolvedValue([]),
  createGroupBoard: vi.fn(), removeGroupMember: vi.fn(), updateGroupMemberRole: vi.fn(), updateGroup: vi.fn(),
  setGroupHealthStatus: vi.fn(), getGroupHealthHistory: vi.fn(), deleteGroup: vi.fn(),
  listInviteLinks: vi.fn().mockResolvedValue([]), createInviteLink: vi.fn(), revokeInviteLink: vi.fn(),
  transferGroupOwnership: vi.fn(), starGroup: vi.fn().mockResolvedValue({}), unstarGroup: vi.fn().mockResolvedValue({}),
  createGroupLabel: vi.fn(), deleteGroupLabel: vi.fn(), updateGroupBoardDefaults: vi.fn(),
}))
vi.mock('../api/boards', () => ({ importBoard: vi.fn(), deleteBoard: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../api/notifications', () => ({
  getUnreadCount: vi.fn().mockResolvedValue(0), listNotifications: vi.fn().mockResolvedValue([]), markAllRead: vi.fn(), markRead: vi.fn(),
}))
vi.mock('../api/auth', () => ({
  getVersion: vi.fn().mockResolvedValue('0.3.0'),
  getSiteConfig: vi.fn().mockResolvedValue({ registration_open: true, registration_mode: 'open', demo_mode: false, demo_login: null, invite_email_available: false }),
}))

import { getGroup, getGroupMembers, getSubgroups, getGroupBoards, createGroupBoard, deleteGroup, updateGroup } from '../api/groups'
import { deleteBoard } from '../api/boards'

const mockGetGroup = getGroup as ReturnType<typeof vi.fn>
const mockGetGroupMembers = getGroupMembers as ReturnType<typeof vi.fn>
const mockGetSubgroups = getSubgroups as ReturnType<typeof vi.fn>
const mockGetGroupBoards = getGroupBoards as ReturnType<typeof vi.fn>
const mockCreateGroupBoard = createGroupBoard as ReturnType<typeof vi.fn>
const mockDeleteGroup = deleteGroup as ReturnType<typeof vi.fn>
const mockUpdateGroup = updateGroup as ReturnType<typeof vi.fn>
const mockDeleteBoard = deleteBoard as ReturnType<typeof vi.fn>

const mkUser = (id: number, name: string): User => ({
  id, username: name.toLowerCase(), email: `${name}@example.com`, first_name: name, last_name: '', avatar_url: '',
  display_name: name, is_site_admin: false, must_change_password: false, must_change_username: false,
})
const owner = mkUser(9, 'Owen')
const admin = mkUser(1, 'Ada')
const member = mkUser(2, 'Mia')
const viewer = mkUser(3, 'Vic')

const baseGroup = {
  health_status: null, effective_health_status: null, health_status_source: null, health_status_changed_at: null,
  health_status_changed_by: null, health_status_note: null, health_review_days: null, health_review_due_at: null,
  id: 1, name: 'Engineering', description: 'Platform work', owner, parent: null, parent_name: null,
  member_count: 4, board_count: 1, subgroup_count: 0, created_at: '', default_board_member_role: 'member',
  allowed_priorities: [], shared_labels: [], is_starred: false, navigation_only: false, can_place_boards: false,
} as unknown as Group

const memberships = (rows: Array<[User, string]>) =>
  rows.map(([user, role], i) => ({ id: i + 1, user, role, joined_at: '' })) as unknown as GroupMembership[]
const allMembers = memberships([[owner, 'admin'], [admin, 'admin'], [member, 'member'], [viewer, 'viewer']])

const board = (over: Partial<Board> = {}) => ({
  id: 5, uid: 'b5', name: 'Roadmap', description: '', owner: member, group: 1, group_name: 'Engineering',
  member_count: 1, card_count: 3, archived_card_count: 0, created_at: '', updated_at: '', is_starred: false,
  health_status: null, effective_health_status: null, health_status_source: null,
  ...over,
}) as unknown as Board

function setup(group: Partial<Group>, user: User, opts: { boards?: Board[]; subgroups?: Group[]; members?: GroupMembership[] } = {}) {
  mockGetGroup.mockResolvedValue({ ...baseGroup, ...group })
  mockGetGroupMembers.mockResolvedValue(opts.members ?? allMembers)
  mockGetSubgroups.mockResolvedValue(opts.subgroups ?? [])
  mockGetGroupBoards.mockResolvedValue(opts.boards ?? [board()])
  return user
}

const shell = { ...EMPTY_SHELL_NAV_DATA, addBoard: vi.fn(), removeBoard: vi.fn(), addGroup: vi.fn(), removeGroup: vi.fn() }

function Probe() {
  const l = useLocation()
  return <span data-testid="probe">{l.search}</span>
}

function renderPage(user: User, url = '/groups/1') {
  return render(
    <ShellNavDataContext.Provider value={shell}>
      <MemoryRouter initialEntries={[url]}>
        <Probe />
        <Routes>
          <Route path="/groups/:id" element={<GroupDetail user={user} onLogout={vi.fn()} onUserUpdated={vi.fn()} />} />
        </Routes>
      </MemoryRouter>
    </ShellNavDataContext.Provider>,
  )
}

const h2 = (name: string) => screen.findByRole('heading', { level: 2, name })

describe('GroupDetail roles and Group settings (#2478)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeleteBoard.mockResolvedValue(undefined)
  })

  it('has exactly one h1 (the group name in the shell breadcrumb) and an h2 page heading', async () => {
    renderPage(setup({ ancestors: [{ id: 10, name: 'RootOrg' }] }, admin))
    await h2('Engineering')
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
    expect(h1s[0]).toHaveTextContent('Engineering')
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(nav).getByRole('link', { name: 'Home' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'RootOrg' })).toHaveAttribute('href', '/groups/10')
  })

  it('has one h1 in the settings view too', async () => {
    renderPage(setup({}, admin), '/groups/1?tab=settings')
    await h2('Group settings')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 3, name: 'Members' })).toBeInTheDocument()
  })

  describe('admin', () => {
    it('sees Invite, Group settings, rename, an editable description and Manage', async () => {
      renderPage(setup({ owner: admin }, admin))
      await h2('Engineering')
      expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Group settings' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Rename group' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Platform work/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '+ New subgroup' })).toBeInTheDocument()
    })

    it('Manage opens Group settings on Members and Back to group returns', async () => {
      renderPage(setup({ owner: admin }, admin))
      await h2('Engineering')
      fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
      await h2('Group settings')
      expect(screen.getByTestId('probe')).toHaveTextContent('tab=settings')
      expect(screen.getByTestId('probe')).toHaveTextContent('section=members')
      fireEvent.click(screen.getByRole('button', { name: 'Back to group' }))
      await h2('Engineering')
      expect(screen.getByTestId('probe')).toHaveTextContent('')
    })

    it('shows New board and Import only when the server allows board placement', async () => {
      const { unmount } = renderPage(setup({ owner: admin, can_place_boards: true }, admin))
      await h2('Engineering')
      expect(screen.getByRole('button', { name: 'New board' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument()
      unmount()
      renderPage(setup({ owner: admin, can_place_boards: false }, admin))
      await h2('Engineering')
      expect(screen.queryByRole('button', { name: 'New board' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument()
    })

    it('opens the import dialog from ?import=1 and drops the param', async () => {
      renderPage(setup({ owner: admin, can_place_boards: true }, admin), '/groups/1?import=1')
      expect(await screen.findByTestId('import-board-modal')).toBeInTheDocument()
      await waitFor(() => expect(screen.getByTestId('probe')).not.toHaveTextContent('import'))
    })

    it('shows Move and, for the owner, Delete in a board row menu; a failed delete is announced', async () => {
      renderPage(setup({ owner: admin }, admin, { boards: [board({ owner: admin })] }))
      await h2('Engineering')
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Roadmap' }))
      expect(await screen.findByRole('menuitem', { name: 'Move to another group' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const user = userEvent.setup()
      await user.type(await screen.findByLabelText('Board name to confirm'), 'Roadmap')
      mockDeleteBoard.mockRejectedValueOnce(new Error('boom'))
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
      expect(await screen.findByText('Failed to delete the board. Please try again.')).toHaveAttribute('role', 'status')
      expect(shell.removeBoard).not.toHaveBeenCalled()
      expect(screen.getByText('Roadmap')).toBeInTheDocument()
    })

    it('a confirmed board delete removes the row and tells the shell', async () => {
      renderPage(setup({ owner: admin }, admin, { boards: [board({ owner: admin, card_count: 0 })] }))
      await h2('Engineering')
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Roadmap' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(mockDeleteBoard).toHaveBeenCalledWith(5))
      await waitFor(() => expect(shell.removeBoard).toHaveBeenCalledWith(5))
      expect(screen.queryByText('Roadmap')).not.toBeInTheDocument()
    })

    it('tells the shell about a board created here and a rename', async () => {
      mockCreateGroupBoard.mockResolvedValue(board({ id: 8, name: 'Made Board' }))
      mockUpdateGroup.mockResolvedValue({})
      renderPage(setup({ owner: admin, can_place_boards: true }, admin))
      await h2('Engineering')
      fireEvent.click(screen.getByRole('button', { name: 'New board' }))
      fireEvent.click(screen.getByText('Confirm create board'))
      await waitFor(() => expect(shell.addBoard).toHaveBeenCalledWith(expect.objectContaining({ id: 8 })))
      fireEvent.click(screen.getByRole('button', { name: 'Engineering' }))
      const input = screen.getByRole('textbox', { name: 'Group name' })
      fireEvent.change(input, { target: { value: 'Platform' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(shell.addGroup).toHaveBeenCalledWith(expect.objectContaining({ id: 1, name: 'Platform' })))
    })

    it('Delete group needs the group name typed, then tells the shell and leaves', async () => {
      mockDeleteGroup.mockResolvedValue(undefined)
      renderPage(setup({ owner: admin }, admin), '/groups/1?tab=settings&section=danger-zone')
      fireEvent.click(await screen.findByRole('button', { name: 'Delete group' }))
      const dialog = await screen.findByRole('dialog')
      const confirm = within(dialog).getByRole('button', { name: 'Delete group' })
      expect(confirm).toBeDisabled()
      fireEvent.change(within(dialog).getByLabelText(/Type the group/), { target: { value: 'Engineering' } })
      expect(confirm).toBeEnabled()
      fireEvent.click(confirm)
      await waitFor(() => expect(mockDeleteGroup).toHaveBeenCalledWith(1))
      await waitFor(() => expect(shell.removeGroup).toHaveBeenCalledWith(1))
      expect(mockNavigate).toHaveBeenCalledWith('/')
    })
  })

  describe('deep links', () => {
    it('?tab=settings&section=danger-zone opens that section', async () => {
      renderPage(setup({ owner: admin }, admin), '/groups/1?tab=settings&section=danger-zone')
      expect(await screen.findByRole('heading', { level: 3, name: 'Danger zone' })).toBeInTheDocument()
      expect(screen.getByText('The new owner must already be a group admin.')).toBeInTheDocument()
    })

    it('an unknown section falls back to Members', async () => {
      renderPage(setup({ owner: admin }, admin), '/groups/1?tab=settings&section=nope')
      expect(await screen.findByRole('heading', { level: 3, name: 'Members' })).toBeInTheDocument()
    })

    it('shows the Board defaults deprecation note and no priorities control', async () => {
      renderPage(setup({ owner: admin }, admin), '/groups/1?tab=settings&section=board-defaults')
      expect(await screen.findByText(/Deprecated\. This setting has no effect: group members/)).toBeInTheDocument()
      expect(screen.queryByText('Allowed priorities on new boards')).not.toBeInTheDocument()
    })

    it('lists the six sections in the nav', async () => {
      renderPage(setup({ owner: admin }, admin), '/groups/1?tab=settings')
      const nav = await screen.findByRole('navigation', { name: 'Group settings sections' })
      expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual([
        'Members4', 'Invite links', 'Health status review', 'Board defaults', 'Shared labels', 'Danger zone',
      ])
    })

    it('Delete group is for the owner only; others read who owns it', async () => {
      renderPage(setup({}, admin), '/groups/1?tab=settings&section=danger-zone')
      await screen.findByRole('heading', { level: 3, name: 'Danger zone' })
      expect(screen.queryByRole('button', { name: 'Delete group' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Transfer ownership' })).not.toBeInTheDocument()
      expect(screen.getByText(/Only the group owner \(Owen\)/)).toBeInTheDocument()
    })
  })

  describe.each([
    ['member', member],
    ['viewer', viewer],
  ] as const)('%s', (_label, who) => {
    it('sees the overview and the Members column but no admin controls', async () => {
      renderPage(setup({}, who))
      await h2('Engineering')
      expect(screen.getByTestId('group-members-card')).toBeInTheDocument()
      const card = within(screen.getByTestId('group-members-card'))
      expect(card.getByText('Ada')).toBeInTheDocument()
      expect(card.getByText('Owner')).toBeInTheDocument()
      expect(card.getByText('viewer')).toBeInTheDocument()
      expect(card.queryByRole('button', { name: 'Manage' })).not.toBeInTheDocument()
      for (const name of ['Invite', 'Group settings', 'Rename group', '+ New subgroup', 'New board', 'Import']) {
        expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
      }
      // The name is plain heading text, not a rename button; the description is read-only.
      expect(screen.queryByRole('button', { name: 'Engineering' })).not.toBeInTheDocument()
      expect(screen.getByText('Platform work').closest('button')).toBeNull()
    })

    it('gets the overview, not Group settings, from a ?tab=settings deep link', async () => {
      renderPage(setup({}, who), '/groups/1?tab=settings&section=danger-zone')
      await h2('Engineering')
      expect(screen.queryByRole('heading', { name: 'Group settings' })).not.toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Danger zone' })).not.toBeInTheDocument()
    })

    it('has no board menu unless the board is theirs to delete', async () => {
      renderPage(setup({}, who, { boards: [board({ owner })] }))
      await h2('Engineering')
      expect(screen.getByText('Roadmap')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'More actions for Roadmap' })).not.toBeInTheDocument()
    })

    it('shows New board only when the server allows board placement', async () => {
      renderPage(setup({ can_place_boards: true }, who))
      await h2('Engineering')
      expect(screen.getByRole('button', { name: 'New board' })).toBeInTheDocument()
    })
  })

  describe('absent input', () => {
    it('treats a missing can_place_boards as not allowed', async () => {
      const group = { ...baseGroup, owner: admin } as unknown as Record<string, unknown>
      delete group.can_place_boards
      renderPage(setup(group as Partial<Group>, admin))
      await h2('Engineering')
      expect(screen.queryByRole('button', { name: 'New board' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument()
    })

    it('a ?import=1 link does not open the dialog without can_place_boards', async () => {
      renderPage(setup({ owner: admin, can_place_boards: false }, admin), '/groups/1?import=1')
      await h2('Engineering')
      await waitFor(() => expect(screen.getByTestId('probe')).not.toHaveTextContent('import'))
      expect(screen.queryByTestId('import-board-modal')).not.toBeInTheDocument()
    })

    it('shows the trail without ancestors when the group has none listed', async () => {
      renderPage(setup({ ancestors: undefined }, member))
      await h2('Engineering')
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    })
  })

  describe('navigation-only group', () => {
    const navOnly = { navigation_only: true, member_count: 0, board_count: 0, subgroup_count: 0, effective_health_status: null, health_review_due_at: null } as Partial<Group>

    it('withholds counts, the health control, the Members column and every admin control', async () => {
      renderPage(setup(navOnly, member, { boards: [], members: [] }))
      await h2('Engineering')
      expect(screen.queryByTestId('group-members-card')).not.toBeInTheDocument()
      expect(screen.queryByText(/0 members/)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Health status/ })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Group settings' })).not.toBeInTheDocument()
    })

    it('shows no counts or review cue on a navigation-only subgroup card', async () => {
      const sub = { ...baseGroup, id: 2, name: 'Hidden', navigation_only: true, board_count: 0, member_count: 0, health_review_due_at: '2020-01-01T00:00:00Z', effective_health_status: 'on_track', health_status: 'on_track', health_status_changed_at: '2020-01-01T00:00:00Z' } as Group
      renderPage(setup({}, member, { subgroups: [sub] }))
      await h2('Engineering')
      const card = screen.getByText('Hidden').closest('button') as HTMLElement
      expect(within(card).queryByText(/board/)).not.toBeInTheDocument()
      expect(within(card).queryByText(/Not reviewed/)).not.toBeInTheDocument()
    })
  })

  it('shows the Not reviewed cue on a subgroup card (#2244)', async () => {
    const sub = { ...baseGroup, id: 2, name: 'Stale team', health_review_due_at: '2020-01-10T00:00:00Z', effective_health_status: 'on_track', health_status: 'on_track', health_status_changed_at: '2020-01-01T00:00:00Z' } as Group
    renderPage(setup({}, member, { subgroups: [sub] }))
    await h2('Engineering')
    expect(screen.getByText(/^Not reviewed in \d+ days$/)).toBeInTheDocument()
  })

  describe('focus (#2478 ux-review)', () => {
    it('moves focus to the new view heading on Group settings and on Back to group', async () => {
      renderPage(setup({ owner: admin }, admin))
      await h2('Engineering')
      fireEvent.click(screen.getByRole('button', { name: 'Group settings' }))
      await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Group settings' })).toHaveFocus())
      fireEvent.click(screen.getByRole('button', { name: 'Back to group' }))
      await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Engineering' })).toHaveFocus())
    })

    it('header Invite opens the Invite links section', async () => {
      renderPage(setup({ owner: admin }, admin))
      await h2('Engineering')
      fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
      expect(await screen.findByTestId('probe')).toHaveTextContent('section=invite-links')
    })

    it('after a confirmed board delete the Boards section takes focus when none are left', async () => {
      renderPage(setup({ owner: admin }, admin, { boards: [board({ owner: admin, card_count: 0 })] }))
      await h2('Engineering')
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Roadmap' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(shell.removeBoard).toHaveBeenCalledWith(5))
      await waitFor(() => expect(document.getElementById('group-boards-section')).toHaveFocus())
    })

    it('a group admin who does not own the board gets Move without Delete; a non-admin owner gets Delete without Move', async () => {
      const { unmount } = renderPage(setup({ owner }, admin, { boards: [board({ owner: member })] }))
      await h2('Engineering')
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Roadmap' }))
      expect(await screen.findByRole('menuitem', { name: 'Move to another group' })).toBeInTheDocument()
      expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument()
      unmount()
      renderPage(setup({}, member, { boards: [board({ owner: member })] }))
      await h2('Engineering')
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Roadmap' }))
      expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()
      expect(screen.queryByRole('menuitem', { name: 'Move to another group' })).not.toBeInTheDocument()
    })

    it('a navigation-only group shows no empty Boards or Subgroups states', async () => {
      renderPage(setup({ navigation_only: true, member_count: 0, board_count: 0, subgroup_count: 0 } as Partial<Group>, member, { boards: [], members: [], subgroups: [] }))
      await h2('Engineering')
      expect(screen.queryByText('No boards yet.')).not.toBeInTheDocument()
      expect(screen.queryByText('No subgroups yet')).not.toBeInTheDocument()
    })
  })
})
