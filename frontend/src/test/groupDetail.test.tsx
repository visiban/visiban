import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import GroupDetail from '../pages/GroupDetail'
import type { User, Group } from '../types'

vi.mock('../api/groups', () => ({
  getGroup: vi.fn(),
  getGroupMembers: vi.fn(),
  getSubgroups: vi.fn(),
  getGroupBoards: vi.fn(),
  createGroupBoard: vi.fn(),
  removeGroupMember: vi.fn(),
  updateGroupMemberRole: vi.fn(),
  deleteGroup: vi.fn(),
  listInviteLinks: vi.fn().mockResolvedValue([]),
  createInviteLink: vi.fn(),
  revokeInviteLink: vi.fn(),
  transferGroupOwnership: vi.fn(),
}))

vi.mock('../api/boards', () => ({
  importBoard: vi.fn(),
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

import { getGroup, getGroupMembers, getSubgroups, getGroupBoards } from '../api/groups'

const mockGetGroup = getGroup as ReturnType<typeof vi.fn>
const mockGetGroupMembers = getGroupMembers as ReturnType<typeof vi.fn>
const mockGetSubgroups = getSubgroups as ReturnType<typeof vi.fn>
const mockGetGroupBoards = getGroupBoards as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false,
}

const fakeGroup: Group = {
  id: 1, name: 'Engineering', owner: fakeUser,
  parent: null, parent_name: null,
  member_count: 2, board_count: 1, subgroup_count: 0, created_at: '',
  default_board_member_role: 'member', allowed_priorities: [], shared_labels: [],
}

function renderGroupDetail() {
  return render(
    <MemoryRouter initialEntries={['/groups/1']}>
      <Routes>
        <Route path="/groups/:id" element={<GroupDetail user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('GroupDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows loading state', () => {
    mockGetGroup.mockReturnValue(new Promise(() => {}))
    mockGetGroupMembers.mockReturnValue(new Promise(() => {}))
    mockGetSubgroups.mockReturnValue(new Promise(() => {}))
    mockGetGroupBoards.mockReturnValue(new Promise(() => {}))
    renderGroupDetail()
    expect(screen.getByText(/Loading/)).toBeInTheDocument()
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
<<<<<<< HEAD
    expect(await screen.findByText('Invite link')).toBeInTheDocument()
=======
    expect(await screen.findByText('Invite links')).toBeInTheDocument()
>>>>>>> 2a0e539 (fix: update InviteLinkPanel tests for redesigned multi-link UI)
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
})
