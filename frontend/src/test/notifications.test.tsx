import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { User, Notification } from '../types'
import Navbar from '../components/Layout/Navbar'

// ---- Mocks ----

const mockNotifications: Notification[] = [
  {
    id: 1,
    verb: 'Alice moved card "Setup CI" to Done',
    card_id: 10,
    card_title: 'Setup CI',
    board_id: 1,
    board_name: 'Sprint 1',
    read: false,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  {
    id: 2,
    verb: 'Bob commented on "Fix login"',
    card_id: 11,
    card_title: 'Fix login',
    board_id: 1,
    board_name: 'Sprint 1',
    read: false,
    created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
  },
]

vi.mock('../api/notifications', () => ({
  listNotifications: vi.fn(),
  getUnreadCount: vi.fn(),
  markAllRead: vi.fn(),
  markRead: vi.fn(),
}))

vi.mock('../api/auth', () => ({
  getVersion: vi.fn().mockResolvedValue('1.0.0'),
}))

import { listNotifications, getUnreadCount, markAllRead, markRead } from '../api/notifications'

const mockedListNotifications = vi.mocked(listNotifications)
const mockedGetUnreadCount = vi.mocked(getUnreadCount)
const mockedMarkAllRead = vi.mocked(markAllRead)
const mockedMarkRead = vi.mocked(markRead)

const testUser: User = {
  id: 1,
  username: 'testuser',
  email: 'test@example.com',
  first_name: 'Test',
  last_name: 'User',
  avatar_url: '',
  display_name: 'Test User',
  is_site_admin: false,
  must_change_password: false,
}

function renderNavbar() {
  return render(
    <MemoryRouter>
      <Navbar user={testUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
    </MemoryRouter>
  )
}

describe('Notification dropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedGetUnreadCount.mockResolvedValue(0)
    mockedListNotifications.mockResolvedValue([])
    mockedMarkAllRead.mockResolvedValue(undefined)
    mockedMarkRead.mockResolvedValue(undefined)
  })

  it('shows unread count badge when there are unread notifications', async () => {
    mockedGetUnreadCount.mockResolvedValue(3)
    renderNavbar()

    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument()
    })
  })

  it('shows 9+ when unread count exceeds 9', async () => {
    mockedGetUnreadCount.mockResolvedValue(15)
    renderNavbar()

    await waitFor(() => {
      expect(screen.getByText('9+')).toBeInTheDocument()
    })
  })

  it('does not show badge when unread count is 0', async () => {
    mockedGetUnreadCount.mockResolvedValue(0)
    renderNavbar()

    // Wait for the count fetch to resolve
    await waitFor(() => {
      expect(mockedGetUnreadCount).toHaveBeenCalled()
    })

    // The badge element should not exist (no number rendered)
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('clicking a notification removes it from the list and decrements count', async () => {
    const user = userEvent.setup()
    mockedGetUnreadCount.mockResolvedValue(2)
    mockedListNotifications.mockResolvedValue([...mockNotifications])

    renderNavbar()

    // Wait for count badge
    await waitFor(() => {
      expect(screen.getByText('2')).toBeInTheDocument()
    })

    // Open the dropdown
    await user.click(screen.getByTitle('Notifications'))

    // Both notifications should appear
    await waitFor(() => {
      expect(screen.getByText('Alice moved card "Setup CI" to Done')).toBeInTheDocument()
      expect(screen.getByText('Bob commented on "Fix login"')).toBeInTheDocument()
    })

    // Click the first notification
    await user.click(screen.getByText('Alice moved card "Setup CI" to Done'))

    expect(mockedMarkRead).toHaveBeenCalledWith([1])

    // First notification should be removed from list
    await waitFor(() => {
      expect(screen.queryByText('Alice moved card "Setup CI" to Done')).not.toBeInTheDocument()
    })

    // Count should decrement to 1
    await waitFor(() => {
      expect(screen.getByText('1')).toBeInTheDocument()
    })
  })

  it('mark-all-read clears the notification list and count', async () => {
    const user = userEvent.setup()
    mockedGetUnreadCount.mockResolvedValue(2)
    mockedListNotifications.mockResolvedValue([...mockNotifications])

    renderNavbar()

    await waitFor(() => {
      expect(screen.getByText('2')).toBeInTheDocument()
    })

    // Open dropdown
    await user.click(screen.getByTitle('Notifications'))

    await waitFor(() => {
      expect(screen.getByText('Mark all read')).toBeInTheDocument()
    })

    // Click "Mark all read"
    await user.click(screen.getByText('Mark all read'))

    expect(mockedMarkAllRead).toHaveBeenCalledOnce()

    // Notification list should be empty — show empty state
    await waitFor(() => {
      expect(screen.getByText('No notifications')).toBeInTheDocument()
    })

    // Badge should disappear (count = 0)
    expect(screen.queryByText('2')).not.toBeInTheDocument()
  })

  it('shows empty state when there are no notifications', async () => {
    const user = userEvent.setup()
    mockedGetUnreadCount.mockResolvedValue(0)
    mockedListNotifications.mockResolvedValue([])

    renderNavbar()

    await waitFor(() => {
      expect(mockedGetUnreadCount).toHaveBeenCalled()
    })

    // Open dropdown
    await user.click(screen.getByTitle('Notifications'))

    await waitFor(() => {
      expect(screen.getByText('No notifications')).toBeInTheDocument()
    })
  })
})
