import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { User, Notification } from '../types'
import Navbar from '../components/Layout/Navbar'

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => mockNavigate }
})

// ---- Mocks ----

const mockNotifications: Notification[] = [
  {
    id: 1,
    verb: 'Alice moved card "Setup CI" to Done',
    actor: { id: 7, username: 'alice', display_name: 'Alice', avatar_url: '' },
    card_id: 10,
    card_title: 'Setup CI',
    board_id: 1,
    board_name: 'Sprint 1',
    action_type: 'card_moved',
    read: false,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  {
    id: 2,
    verb: 'Bob commented on "Fix login"',
    actor: { id: 8, username: 'bob', display_name: 'Bob', avatar_url: '' },
    card_id: 11,
    card_title: 'Fix login',
    board_id: 1,
    board_name: 'Sprint 1',
    action_type: 'mentioned',
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
  must_change_password: false, must_change_username: false,
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

  it('clicking a card notification navigates to /boards/:id?card=:card_id', async () => {
    const user = userEvent.setup({ delay: null })
    mockedGetUnreadCount.mockResolvedValue(1)
    mockedListNotifications.mockResolvedValue([mockNotifications[0]])

    renderNavbar()

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument())
    await user.click(screen.getByTitle(/Notifications/))
    await waitFor(() => screen.getByText('Alice moved card "Setup CI" to Done'))

    await user.click(screen.getByText('Alice moved card "Setup CI" to Done'))

    expect(mockNavigate).toHaveBeenCalledWith('/boards/1?card=10')
  })

  it('clicking a board-only notification (no card_id) navigates to /boards/:id', async () => {
    const user = userEvent.setup({ delay: null })
    const boardOnlyNotification: Notification = {
      id: 3,
      verb: 'You were added to Sprint 1',
      actor: { id: 9, username: 'inviter', display_name: 'Inviter', avatar_url: '' },
      card_id: null,
      card_title: null,
      board_id: 1,
      board_name: 'Sprint 1',
      action_type: 'board_invite',
      read: false,
      created_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    }
    mockedGetUnreadCount.mockResolvedValue(1)
    mockedListNotifications.mockResolvedValue([boardOnlyNotification])

    renderNavbar()

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument())
    await user.click(screen.getByTitle(/Notifications/))
    await waitFor(() => screen.getByText('You were added to Sprint 1'))

    await user.click(screen.getByText('You were added to Sprint 1'))

    expect(mockNavigate).toHaveBeenCalledWith('/boards/1')
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
    const user = userEvent.setup({ delay: null })
    mockedGetUnreadCount.mockResolvedValue(2)
    mockedListNotifications.mockResolvedValue([...mockNotifications])

    renderNavbar()

    // Wait for count badge
    await waitFor(() => {
      expect(screen.getByText('2')).toBeInTheDocument()
    })

    // Open the dropdown
    await user.click(screen.getByTitle(/Notifications/))

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
    const user = userEvent.setup({ delay: null })
    mockedGetUnreadCount.mockResolvedValue(2)
    mockedListNotifications.mockResolvedValue([...mockNotifications])

    renderNavbar()

    await waitFor(() => {
      expect(screen.getByText('2')).toBeInTheDocument()
    })

    // Open dropdown
    await user.click(screen.getByTitle(/Notifications/))

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

  it('renders "View board" affordance for board invite notifications', async () => {
    const user = userEvent.setup({ delay: null })
    const boardInviteNotification: Notification = {
      id: 4,
      verb: 'You were added to Sprint 1',
      actor: { id: 10, username: 'admin', display_name: 'Admin', avatar_url: '' },
      card_id: null,
      card_title: null,
      board_id: 1,
      board_name: 'Sprint 1',
      action_type: 'board_invite',
      read: false,
      created_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    }
    mockedGetUnreadCount.mockResolvedValue(1)
    mockedListNotifications.mockResolvedValue([boardInviteNotification])

    renderNavbar()

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument())
    await user.click(screen.getByTitle(/Notifications/))
    await waitFor(() => screen.getByText('You were added to Sprint 1'))

    expect(screen.getByText('View board →')).toBeInTheDocument()
  })

  it('does not render "View board" affordance for card-scoped notifications', async () => {
    const user = userEvent.setup({ delay: null })
    mockedGetUnreadCount.mockResolvedValue(1)
    mockedListNotifications.mockResolvedValue([mockNotifications[0]])

    renderNavbar()

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument())
    await user.click(screen.getByTitle(/Notifications/))
    await waitFor(() => screen.getByText('Alice moved card "Setup CI" to Done'))

    expect(screen.queryByText('View board →')).not.toBeInTheDocument()
  })

  it('shows empty state when there are no notifications', async () => {
    const user = userEvent.setup({ delay: null })
    mockedGetUnreadCount.mockResolvedValue(0)
    mockedListNotifications.mockResolvedValue([])

    renderNavbar()

    await waitFor(() => {
      expect(mockedGetUnreadCount).toHaveBeenCalled()
    })

    // Open dropdown
    await user.click(screen.getByTitle(/Notifications/))

    await waitFor(() => {
      expect(screen.getByText('No notifications')).toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// Deep-link archived card — getCardStatus API contract
// ---------------------------------------------------------------------------

import { getCardStatus } from '../api/cards'
import apiClient from '../api/client'

vi.mock('../api/client', () => ({
  default: {
    get: vi.fn(),
  },
}))

describe('getCardStatus', () => {
  const mockedGet = vi.mocked(apiClient.get)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns { archived: true } for an archived card', async () => {
    mockedGet.mockResolvedValueOnce({ data: { archived: true } } as never)
    const result = await getCardStatus(1, 42)
    expect(mockedGet).toHaveBeenCalledWith('/api/v1/boards/1/cards/42/status/')
    expect(result).toEqual({ archived: true })
  })

  it('returns null when the card does not exist (404)', async () => {
    mockedGet.mockRejectedValueOnce(
      Object.assign(new Error('Not found'), { response: { status: 404 } })
    )
    const result = await getCardStatus(1, 999)
    expect(result).toBeNull()
  })
})
