import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Dashboard from '../pages/Dashboard'
import type { User } from '../types'

vi.mock('../api/boards', () => ({
  listBoards: vi.fn(),
  createBoard: vi.fn(),
  deleteBoard: vi.fn(),
  importBoard: vi.fn(),
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

import { listBoards } from '../api/boards'
import { listGroups } from '../api/groups'

const mockListBoards = listBoards as ReturnType<typeof vi.fn>
const mockListGroups = listGroups as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1,
  username: 'jdoe',
  email: 'j@example.com',
  first_name: 'Jane',
  last_name: 'Doe',
  avatar_url: '',
  display_name: 'Jane Doe',
  is_site_admin: false,
  must_change_password: false,
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
})
