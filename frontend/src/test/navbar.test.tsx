import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Navbar from '../components/Layout/Navbar'
import type { User } from '../types'

vi.mock('../api/notifications', () => ({
  listNotifications: vi.fn().mockResolvedValue([]),
  getUnreadCount: vi.fn().mockResolvedValue(0),
  markAllRead: vi.fn().mockResolvedValue(undefined),
  markRead: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../api/auth', () => ({
  getVersion: vi.fn().mockResolvedValue('0.3.0'),
}))

import { getUnreadCount } from '../api/notifications'
import { getVersion } from '../api/auth'

const mockGetUnreadCount = getUnreadCount as ReturnType<typeof vi.fn>
const mockGetVersion = getVersion as ReturnType<typeof vi.fn>

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

function renderNavbar(props: Partial<React.ComponentProps<typeof Navbar>> = {}) {
  return render(
    <MemoryRouter>
      <Navbar
        user={fakeUser}
        onLogout={vi.fn()}
        onUserUpdated={vi.fn()}
        {...props}
      />
    </MemoryRouter>
  )
}

describe('Navbar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUnreadCount.mockResolvedValue(0)
  })

  it('renders app name link', () => {
    renderNavbar()
    expect(screen.getByAltText('Visiban')).toBeInTheDocument()
  })

  it('renders user display name', () => {
    renderNavbar()
    expect(screen.getByText('Jane Doe')).toBeInTheDocument()
  })

  it('renders sign out button', () => {
    renderNavbar()
    expect(screen.getByText('Sign out')).toBeInTheDocument()
  })

  it('calls onLogout when sign out is clicked', async () => {
    const onLogout = vi.fn()
    renderNavbar({ onLogout })
    await userEvent.setup().click(screen.getByText('Sign out'))
    expect(onLogout).toHaveBeenCalledOnce()
  })

  it('renders breadcrumb items', () => {
    renderNavbar({ breadcrumb: [{ label: 'Engineering', href: '/groups/1' }, { label: 'Sprint Board' }] })
    expect(screen.getByText('Engineering')).toBeInTheDocument()
    expect(screen.getByText('Sprint Board')).toBeInTheDocument()
  })

  it('renders notification bell', () => {
    renderNavbar()
    expect(screen.getByTitle('Notifications')).toBeInTheDocument()
  })

  it('shows unread badge when count > 0', async () => {
    mockGetUnreadCount.mockResolvedValue(5)
    renderNavbar()
    expect(await screen.findByText('5')).toBeInTheDocument()
  })

  it('shows 9+ when unread count > 9', async () => {
    mockGetUnreadCount.mockResolvedValue(15)
    renderNavbar()
    expect(await screen.findByText('9+')).toBeInTheDocument()
  })

  it('shows version badge for dev builds only', async () => {
    mockGetVersion.mockResolvedValue('dev')
    renderNavbar()
    expect(await screen.findByText('dev')).toBeInTheDocument()
  })

  it('hides version badge for versioned builds', async () => {
    renderNavbar()
    expect(screen.queryByText('0.3.0')).not.toBeInTheDocument()
  })
})
