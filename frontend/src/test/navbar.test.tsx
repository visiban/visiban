import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import Navbar from '../components/Layout/Navbar'
import { NavDrawerContext } from '../contexts/ShellNavContext'
import type { User } from '../types'

vi.mock('../api/notifications', () => ({
  listNotifications: vi.fn().mockResolvedValue([]),
  getUnreadCount: vi.fn().mockResolvedValue(0),
  markAllRead: vi.fn().mockResolvedValue(undefined),
  markRead: vi.fn().mockResolvedValue(undefined),
}))

import { getUnreadCount, listNotifications, markAllRead, markRead } from '../api/notifications'
import { flagsWrapper } from './instanceFlagsWrapper'
import type { InstanceFlags } from '../contexts/InstanceFlagsContext'

const mockGetUnreadCount = getUnreadCount as ReturnType<typeof vi.fn>
const mockListNotifications = listNotifications as ReturnType<typeof vi.fn>
const mockMarkAllRead = markAllRead as ReturnType<typeof vi.fn>
const mockMarkRead = markRead as ReturnType<typeof vi.fn>

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

function renderNavbar(props: Partial<React.ComponentProps<typeof Navbar>> = {}, flags: Partial<InstanceFlags> = {}) {
  return render(
    <MemoryRouter>
      <Navbar
        user={fakeUser}
        onLogout={vi.fn()}
        onUserUpdated={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
    { wrapper: flagsWrapper(flags) }
  )
}

// Test-only marker that renders the current route so a test can assert a
// navigate() call actually landed, rather than trusting a mocked useNavigate
// was merely called with the right string.
function LocationDisplay() {
  const location = useLocation()
  return <div data-testid="location-display">{location.pathname}{location.search}</div>
}

function renderNavbarWithRoutes(props: Partial<React.ComponentProps<typeof Navbar>> = {}, flags: Partial<InstanceFlags> = {}) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Navbar
        user={fakeUser}
        onLogout={vi.fn()}
        onUserUpdated={vi.fn()}
        {...props}
      />
      <Routes>
        <Route path="*" element={<LocationDisplay />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: flagsWrapper(flags) }
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

  it('renders no home logo link: Home is the breadcrumb root (#2473)', () => {
    renderNavbar()
    expect(screen.queryByAltText('Visiban')).toBeNull()
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
    expect(nav.textContent).toBe('Home/Solo Board')
  })

  it('renders only the Home crumb on pages with no breadcrumb prop (#2473)', () => {
    renderNavbar()
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(nav.textContent).toBe('Home')
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

})

describe('Navbar — global search entry (#852 / #869)', () => {
  // #869 — the visible label and accessible name adapt per route via
  // useNavbarSearchLabel so the copy matches what the palette can do on
  // that surface. On the Dashboard / Group routes, the copy is "Jump to
  // board". On the Settings / Admin routes, it's "Jump to…". On a board
  // route, it's "Search cards". MemoryRouter defaults to "/" ⇒ dashboard.

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUnreadCount.mockResolvedValue(0)
  })

  function renderNavbarAt(initialRoute: string) {
    return render(
      <MemoryRouter initialEntries={[initialRoute]}>
        <Navbar user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
      </MemoryRouter>
    )
  }

  it('renders the Row 1 global search button on the Dashboard with the Jump-to-board label', () => {
    renderNavbarAt('/')
    expect(screen.getByRole('button', { name: /Jump to a board or action \(Cmd\+K\)/ })).toBeInTheDocument()
  })

  it('adapts the label to "Search cards" on a board route', () => {
    renderNavbarAt('/boards/42')
    expect(screen.getByRole('button', { name: /Search cards \(Cmd\+K\)/ })).toBeInTheDocument()
  })

  it('adapts the label to "Jump to…" on Settings (palette acts only as a nav surface there)', () => {
    renderNavbarAt('/settings')
    expect(screen.getByRole('button', { name: /Jump to a board or action \(Cmd\+K\)/ })).toBeInTheDocument()
  })

  it('shows the visible placeholder label and ⌘K hint at lg+', () => {
    renderNavbarAt('/')
    const btn = screen.getByRole('button', { name: /Jump to a board or action \(Cmd\+K\)/ })
    // Both the visible label and the shortcut hint render in the DOM; they're
    // hidden below lg via `hidden lg:inline` so jsdom still sees them.
    expect(btn).toHaveTextContent('Jump to a board or action')
    expect(btn).toHaveTextContent('⌘K')
  })

  it('is a 38px field on wider screens and a 44px icon button on phones (#2473)', () => {
    renderNavbarAt('/')
    const btn = screen.getByRole('button', { name: /Jump to a board or action \(Cmd\+K\)/ })
    expect(btn.className).toMatch(/h-\[38px\]/)
    expect(btn.className).toMatch(/max-sm:w-11/)
    expect(btn.className).toMatch(/max-sm:h-11/)
  })

  it('clicking the button dispatches visiban:open-palette', async () => {
    const listener = vi.fn()
    window.addEventListener('visiban:open-palette', listener)
    try {
      renderNavbarAt('/')
      await userEvent.setup().click(screen.getByRole('button', { name: /Jump to a board or action \(Cmd\+K\)/ }))
      expect(listener).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('visiban:open-palette', listener)
    }
  })

  it('renders to the left of the notification bell in Row 1', () => {
    renderNavbarAt('/')
    const btn = screen.getByRole('button', { name: /Jump to a board or action \(Cmd\+K\)/ })
    const bell = screen.getByTitle('Notifications')
    // Compare document position — search button precedes the bell.
    expect(btn.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('Navbar — hosted demo (#1193)', () => {
  const demoUser: User = fakeUser

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUnreadCount.mockResolvedValue(0)
    mockListNotifications.mockResolvedValue([
      { id: 1, verb: 'moved a card', actor: null, card_id: 5, card_title: 'Card', board_id: 9, board_name: 'Board', action_type: 'card_moved', mention_source: null, read: false, created_at: new Date().toISOString() },
    ])
  })

  it('"Mark all read" is aria-disabled, keyboard-reachable, explains why, and does not call the API', async () => {
    const user = userEvent.setup()
    renderNavbar({ user: demoUser }, { demo_mode: true })
    await user.click(screen.getByTitle('Notifications'))
    const markAll = await screen.findByRole('button', { name: /Mark all read/ })
    expect(markAll).toHaveAttribute('aria-disabled', 'true')
    expect(markAll).not.toBeDisabled()
    expect(markAll).toHaveAccessibleName("Mark all read. This is a shared demo — notifications can't be marked read here.")
    markAll.focus()
    expect(markAll).toHaveFocus()
    await user.click(markAll)
    expect(mockMarkAllRead).not.toHaveBeenCalled()
  })

  it('clicking an unread notification still navigates but skips the mark-read call (background save, not a control the visitor clicked)', async () => {
    const user = userEvent.setup()
    renderNavbarWithRoutes({ user: demoUser }, { demo_mode: true })
    expect(screen.getByTestId('location-display')).toHaveTextContent('/')
    await user.click(screen.getByTitle('Notifications'))
    const item = await screen.findByText('moved a card')
    await user.click(item)
    // The click's primary purpose — navigating to the related card — must
    // still happen; aria-disabling the row would have blocked it too. Only
    // the mark-read side effect is skipped.
    expect(screen.getByTestId('location-display')).toHaveTextContent('/boards/9?card=5')
    expect(mockMarkRead).not.toHaveBeenCalled()
  })

  it('outside demo mode, clicking an unread notification still calls markRead (no regression)', async () => {
    const user = userEvent.setup()
    renderNavbar({ user: fakeUser })
    await user.click(screen.getByTitle('Notifications'))
    const item = await screen.findByText('moved a card')
    await user.click(item)
    expect(mockMarkRead).toHaveBeenCalledWith([1])
  })
})

describe('Navbar menu button and breadcrumb (#2473)', () => {
  it('renders no menu button outside the shell', () => {
    renderNavbar()
    expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull()
  })

  it('carries the menu button, registers with the shell and unregisters on unmount', async () => {
    const user = userEvent.setup()
    const unregister = vi.fn()
    const value = { open: false, setOpen: vi.fn(), toggle: vi.fn(), menuButtonRef: { current: null }, registerHeader: vi.fn(() => unregister) }
    const view = render(
      <MemoryRouter>
        <NavDrawerContext.Provider value={value}>
          <Navbar user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
        </NavDrawerContext.Provider>
      </MemoryRouter>,
      { wrapper: flagsWrapper({}) },
    )
    expect(value.registerHeader).toHaveBeenCalledTimes(1)
    const menu = screen.getByRole('button', { name: 'Open navigation' })
    expect(menu).toHaveAttribute('aria-expanded', 'false')
    expect(menu).toHaveAttribute('aria-keyshortcuts', '[')
    expect(menu).toHaveAttribute('title', 'Menu  [')
    expect(value.menuButtonRef.current).toBe(menu)
    await user.click(menu)
    expect(value.toggle).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(unregister).toHaveBeenCalledTimes(1)
  })

  it('with no crumbs, Home is the page h1 and there is no home logo link', () => {
    renderNavbar()
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Visiban' })).toBeNull()
  })

  it('roots every breadcrumb at Home and makes the last crumb the only h1', () => {
    render(
      <MemoryRouter>
        <Navbar user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} breadcrumb={[{ label: 'Team', href: '/groups/2' }, { label: 'Settings' }]} />
      </MemoryRouter>,
      { wrapper: flagsWrapper({}) },
    )
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/')
    expect(within(nav).getByRole('link', { name: 'Team' })).toHaveAttribute('href', '/groups/2')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
  })

  it('renders the page primary action in the header', () => {
    render(
      <MemoryRouter>
        <Navbar user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} primaryAction={<button type="button">New board</button>} />
      </MemoryRouter>,
      { wrapper: flagsWrapper({}) },
    )
    expect(screen.getByRole('button', { name: 'New board' })).toBeInTheDocument()
  })

  it('g then u in a text field does not open the account menu', () => {
    render(
      <MemoryRouter>
        <input aria-label="Field" />
        <Navbar user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
      </MemoryRouter>,
      { wrapper: flagsWrapper({}) },
    )
    const field = screen.getByRole('textbox', { name: 'Field' })
    fireEvent.keyDown(field, { key: 'g' })
    fireEvent.keyDown(field, { key: 'u' })
    expect(screen.queryByRole('menu', { name: 'Account menu' })).toBeNull()
    fireEvent.keyDown(document.body, { key: 'g' })
    fireEvent.keyDown(document.body, { key: 'u' })
    expect(screen.getByRole('menu', { name: 'Account menu' })).toBeInTheDocument()
  })
})
