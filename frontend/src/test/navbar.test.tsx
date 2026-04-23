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
    // Force the Mac platform code path so existing assertions that expect
    // ⌘K glyphs keep passing. A parallel suite lives in platform.test.ts for
    // the non-Mac branch.
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    Object.defineProperty(navigator, 'userAgentData', { value: undefined, configurable: true })
  })

  it('renders app name link', () => {
    renderNavbar()
    expect(screen.getByAltText('Visiban')).toBeInTheDocument()
  })

  it('renders an account menu trigger (avatar + chevron) instead of a bare sign-out button', () => {
    renderNavbar()
    expect(screen.getByRole('button', { name: /Account menu for Jane Doe/ })).toBeInTheDocument()
    // The pre-MR Row 1 rendered "Sign out" as a top-level button. After #850 it lives
    // only inside the user menu (collapsed by default), so it must not appear in the DOM on render.
    expect(screen.queryByRole('button', { name: /^Sign out$/ })).not.toBeInTheDocument()
  })

  it('calls onLogout when Sign out is chosen from the user menu', async () => {
    const onLogout = vi.fn()
    renderNavbar({ onLogout })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Account menu for Jane Doe/ }))
    await user.click(await screen.findByRole('menuitem', { name: /Sign out/ }))
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

  it('renders Row 1 as <header role="banner"> with h-14', () => {
    renderNavbar()
    const banner = screen.getByRole('banner')
    expect(banner.tagName).toBe('HEADER')
    expect(banner.className).toMatch(/\bh-14\b/)
    expect(banner.className).toMatch(/bg-sunken/)
  })

  it('logo link is keyboard-reachable with a visible focus ring', () => {
    renderNavbar()
    const logoLink = screen.getByAltText('Visiban').closest('a')
    expect(logoLink).not.toBeNull()
    expect(logoLink?.className).toMatch(/focus:ring-2/)
    expect(logoLink?.className).toMatch(/focus:ring-primary-emphasis/)
  })
})

describe('Navbar — global search entry (#852)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUnreadCount.mockResolvedValue(0)
  })

  it('renders the Row 1 global search button with an accessible name', () => {
    renderNavbar()
    expect(screen.getByRole('button', { name: /Search \(Cmd\+K\)/ })).toBeInTheDocument()
  })

  it('shows the visible "Search" label and ⌘K hint at lg+', () => {
    renderNavbar()
    const btn = screen.getByRole('button', { name: /Search \(Cmd\+K\)/ })
    // Both the visible label and the shortcut hint render in the DOM; they're
    // hidden below lg via `hidden lg:inline` so jsdom still sees them.
    expect(btn).toHaveTextContent('Search')
    expect(btn).toHaveTextContent('⌘K')
  })

  it('uses the responsive width classes — w-8 square below lg, w-40 at lg+', () => {
    renderNavbar()
    const btn = screen.getByRole('button', { name: /Search \(Cmd\+K\)/ })
    expect(btn.className).toMatch(/\bw-8\b/)
    expect(btn.className).toMatch(/\blg:w-40\b/)
  })

  it('clicking the button dispatches visiban:open-palette', async () => {
    const listener = vi.fn()
    window.addEventListener('visiban:open-palette', listener)
    try {
      renderNavbar()
      await userEvent.setup().click(screen.getByRole('button', { name: /Search \(Cmd\+K\)/ }))
      expect(listener).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('visiban:open-palette', listener)
    }
  })

  it('renders to the left of the notification bell in Row 1', () => {
    renderNavbar()
    const btn = screen.getByRole('button', { name: /Search \(Cmd\+K\)/ })
    const bell = screen.getByTitle('Notifications')
    // Compare document position — search button precedes the bell.
    expect(btn.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
