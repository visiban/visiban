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

  it('wraps breadcrumb in a nav landmark labeled "Breadcrumb"', () => {
    renderNavbar({ breadcrumb: [{ label: 'Engineering', href: '/groups/1' }, { label: 'Sprint Board' }] })
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument()
  })

  it('renders group segment as a link to the group page', () => {
    renderNavbar({ breadcrumb: [{ label: 'Engineering', href: '/groups/42' }, { label: 'Sprint Board' }] })
    const link = screen.getByRole('link', { name: 'Engineering' })
    expect(link).toHaveAttribute('href', '/groups/42')
  })

  it('marks the current (last) breadcrumb segment with aria-current="page"', () => {
    renderNavbar({ breadcrumb: [{ label: 'Engineering', href: '/groups/1' }, { label: 'Sprint Board' }] })
    const current = screen.getByText('Sprint Board')
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(current.tagName).toBe('SPAN')
  })

  it('omits the group segment entirely when the board has no group', () => {
    renderNavbar({ breadcrumb: [{ label: 'Solo Board' }] })
    expect(screen.queryByRole('link', { name: /group/i })).not.toBeInTheDocument()
    // Exactly one separator '/' renders before the single (board) segment.
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(nav.textContent).toBe('/Solo Board')
  })

  it('renders a logo-only (no breadcrumb nav) on pages with no breadcrumb prop', () => {
    renderNavbar()
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument()
  })

  it('sets title attribute on long names so truncation exposes the full value on hover', () => {
    const longGroup = 'A very long group name that will definitely exceed twelve rem and be truncated'
    const longBoard = 'An equally verbose board name chosen deliberately for testing the eighteen rem cap'
    renderNavbar({ breadcrumb: [{ label: longGroup, href: '/groups/1' }, { label: longBoard }] })
    expect(screen.getByRole('link', { name: longGroup })).toHaveAttribute('title', longGroup)
    expect(screen.getByText(longBoard)).toHaveAttribute('title', longBoard)
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
})
