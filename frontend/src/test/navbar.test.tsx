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

import { getUnreadCount } from '../api/notifications'

const mockGetUnreadCount = getUnreadCount as ReturnType<typeof vi.fn>

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

  it('does not show version badge in navbar (version lives in Settings only)', () => {
    renderNavbar()
    // Version strings must not appear in the navbar per design system rules.
    // They are surfaced exclusively in Settings → About.
    expect(screen.queryByText('dev')).not.toBeInTheDocument()
    expect(screen.queryByText(/^\d+\.\d+/)).not.toBeInTheDocument()
  })

  describe('ARIA landmarks and Row 1 surface (#848)', () => {
    it('renders the header as a banner landmark', () => {
      renderNavbar()
      const banner = screen.getByRole('banner')
      expect(banner.tagName).toBe('HEADER')
    })

    it('applies Row 1 height and surface tokens', () => {
      renderNavbar()
      const banner = screen.getByRole('banner')
      expect(banner.className).toContain('h-14')
      expect(banner.className).toContain('bg-sunken')
      expect(banner.className).toContain('border-b')
      expect(banner.className).toContain('border-line')
    })

    it('applies Row 1 typography tokens', () => {
      renderNavbar()
      const banner = screen.getByRole('banner')
      expect(banner.className).toContain('text-sm')
      expect(banner.className).toContain('text-fg')
    })
  })
})
