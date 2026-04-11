import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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
  listBoards: vi.fn(),
  createBoard: vi.fn(),
  deleteBoard: vi.fn(),
  importBoard: vi.fn(),
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
  })

  it('renders groups when available', async () => {
    mockListGroups.mockResolvedValue([
      { id: 1, name: 'Engineering', owner: fakeUser, parent: null, parent_name: null, member_count: 3, board_count: 2, subgroup_count: 0, created_at: '' },
    ])
    renderDashboard()
    expect(await screen.findByText('Engineering')).toBeInTheDocument()
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

      // Type a full invite URL — the handler must strip everything before /join/
      const input = screen.getByPlaceholderText(/https:.*\/join\/abc123 or abc123/i)
      await user.type(input, 'https://example.com/join/abc123')

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
      await user.type(input, 'xyz789')

      await user.click(screen.getByRole('button', { name: 'Join' }))

      expect(mockNavigate).toHaveBeenCalledWith('/join/xyz789')
    })
  })
})
