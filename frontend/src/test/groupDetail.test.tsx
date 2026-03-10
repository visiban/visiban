import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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

    expect(await screen.findByText('Sprint Board')).toBeInTheDocument()
    expect(screen.getByText('Subgroups')).toBeInTheDocument()
    expect(screen.getByText('Boards')).toBeInTheDocument()
    expect(screen.getByText('Members')).toBeInTheDocument()
  })

  it('shows delete group button for admin', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    expect(await screen.findByText('Delete group')).toBeInTheDocument()
  })
})
