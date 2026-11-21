import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect, useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Navbar from '../components/Layout/Navbar'
import KeyboardShortcutsOverlay from '../components/Board/KeyboardShortcutsOverlay'
import { ThemeProvider } from '../context/ThemeContext'
import type { User } from '../types'

vi.mock('../api/notifications', () => ({
  listNotifications: vi.fn().mockResolvedValue([]),
  getUnreadCount: vi.fn().mockResolvedValue(0),
  markAllRead: vi.fn().mockResolvedValue(undefined),
  markRead: vi.fn().mockResolvedValue(undefined),
}))

const fakeUser: User = {
  id: 1,
  username: 'jdoe',
  email: 'jane@example.com',
  first_name: 'Jane',
  last_name: 'Doe',
  avatar_url: '',
  display_name: 'Jane Doe',
  is_site_admin: false,
  must_change_password: false,
  must_change_username: false,
}

function renderNavbar(overrides: Partial<React.ComponentProps<typeof Navbar>> = {}, route = '/boards/1') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Navbar
        user={fakeUser}
        onLogout={vi.fn()}
        onUserUpdated={vi.fn()}
        {...overrides}
      />
    </MemoryRouter>
  )
}

describe('UserMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the avatar trigger with an accessible aria-label and collapsed aria-expanded', () => {
    renderNavbar()
    const trigger = screen.getByRole('button', { name: /Account menu for Jane Doe/ })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens the menu on trigger click and shows the correct items in the correct order with Sign out last', async () => {
    renderNavbar()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Account menu for Jane Doe/ }))

    const menu = await screen.findByRole('menu', { name: 'Account menu' })
    expect(menu).toBeInTheDocument()
    const items = screen.getAllByRole('menuitem')
    expect(items.map((i) => i.textContent?.trim())).toEqual([
      expect.stringMatching(/Profile & settings/),
      expect.stringMatching(/Keyboard shortcuts/),
      expect.stringMatching(/Help & docs/),
      expect.stringMatching(/Sign out/),
    ])
    // Sign out is last; the theme group sits just above it (#2473).
    expect(items[items.length - 1]).toHaveTextContent(/Sign out/)
    // No emoji icons anywhere in the menu (#2473).
    expect(menu.textContent).not.toMatch(/[\u2699\u2328\u2753\u{1F6AA}]/u)
    // Every item is at least 40px tall and uses the shared focus ring.
    for (const item of items) {
      expect(item.className).toMatch(/\bmin-h-10\b/)
      expect(item.className).toMatch(/focus:ring-primary-emphasis/)
    }
  })

  it('renders the header row with display name and email (non-interactive)', async () => {
    renderNavbar()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Account menu for Jane Doe/ }))

    const menu = await screen.findByRole('menu', { name: 'Account menu' })
    expect(menu).toHaveTextContent('Jane Doe')
    expect(menu).toHaveTextContent('jane@example.com')
  })

  it('omits the email line when the user has no email', async () => {
    renderNavbar({ user: { ...fakeUser, email: '' } })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Account menu for Jane Doe/ }))

    const menu = await screen.findByRole('menu', { name: 'Account menu' })
    expect(menu).not.toHaveTextContent('@')
  })

  it('closes the menu when Escape is pressed and refocuses the trigger', async () => {
    renderNavbar()
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: /Account menu for Jane Doe/ })
    await user.click(trigger)
    expect(await screen.findByRole('menu', { name: 'Account menu' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: 'Account menu' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes the menu when clicking outside', async () => {
    renderNavbar()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Account menu for Jane Doe/ }))
    expect(await screen.findByRole('menu', { name: 'Account menu' })).toBeInTheDocument()

    await user.click(document.body)
    expect(screen.queryByRole('menu', { name: 'Account menu' })).not.toBeInTheDocument()
  })

  it('`g u` keyboard shortcut opens the menu', async () => {
    renderNavbar()
    const user = userEvent.setup()
    await user.keyboard('g')
    await user.keyboard('u')
    expect(await screen.findByRole('menu', { name: 'Account menu' })).toBeInTheDocument()
  })

  it('an admin sees the Site admin chip and item, after Profile & settings (#2473)', async () => {
    renderNavbar({ user: { ...fakeUser, is_site_admin: true } })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Account menu for Jane Doe/ }))
    const menu = await screen.findByRole('menu', { name: 'Account menu' })
    const items = within(menu).getAllByRole('menuitem')
    expect(items[1]).toHaveTextContent('Site admin')
    expect(items[1]).toHaveAttribute('href', '/admin')
    expect(within(menu).getAllByText('Site admin')).toHaveLength(2)
  })

  it('the theme control is a group of three menuitemradio buttons that apply at once (#2473)', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    })
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/']}>
          <Navbar user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
        </MemoryRouter>
      </ThemeProvider>,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Account menu for Jane Doe/ }))
    const group = await screen.findByRole('group', { name: 'Theme' })
    const radios = within(group).getAllByRole('menuitemradio')
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Dark', 'Light', 'System'])
    for (const r of radios) expect(r.className).toMatch(/\bw-10\b/)
    await user.click(radios[1])
    expect(radios[1]).toHaveAttribute('aria-checked', 'true')
    expect(localStorage.getItem('user:prefs:theme')).toBe('light')
  })

  it('the Help & docs item says it opens in a new tab (#2473)', async () => {
    renderNavbar()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Account menu for Jane Doe/ }))
    expect(await screen.findByRole('menuitem', { name: /Help & docs \(opens in a new tab\)/ })).toBeInTheDocument()
  })

  it('the Keyboard shortcuts item dispatches the window event on board pages', async () => {
    renderNavbar({}, '/boards/42')
    const user = userEvent.setup()
    const listener = vi.fn()
    window.addEventListener('visiban:open-shortcuts', listener)
    try {
      await user.click(screen.getByRole('button', { name: /Account menu for Jane Doe/ }))
      const item = await screen.findByRole('menuitem', { name: /Keyboard shortcuts/ })
      expect(item).not.toBeDisabled()
      await user.click(item)
      expect(listener).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('visiban:open-shortcuts', listener)
    }
  })

  it('the shortcuts overlay it opens traps Tab and returns focus to the account trigger (#1775)', async () => {
    // Stand-in for BoardView's visiban:open-shortcuts listener, with the real overlay.
    function Listener() {
      const [open, setOpen] = useState(false)
      useEffect(() => {
        const h = () => setOpen(true)
        window.addEventListener('visiban:open-shortcuts', h)
        return () => window.removeEventListener('visiban:open-shortcuts', h)
      }, [])
      return open ? <KeyboardShortcutsOverlay onClose={() => setOpen(false)} /> : null
    }
    render(
      <MemoryRouter initialEntries={['/boards/42']}>
        <Navbar user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
        <Listener />
      </MemoryRouter>,
    )
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: /Account menu for Jane Doe/ })
    await user.click(trigger)
    await user.click(await screen.findByRole('menuitem', { name: /Keyboard shortcuts/ }))
    const dialog = await screen.findByRole('dialog', { name: /Keyboard shortcuts/i })
    await user.tab()
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('the Keyboard shortcuts item works off a board too (#2473)', async () => {
    renderNavbar({}, '/settings')
    const user = userEvent.setup()
    const listener = vi.fn()
    window.addEventListener('visiban:open-shortcuts', listener)
    try {
      await user.click(screen.getByRole('button', { name: /Account menu for Jane Doe/ }))
      const item = await screen.findByRole('menuitem', { name: /Keyboard shortcuts/ })
      expect(item).not.toHaveAttribute('aria-disabled')
      expect(item).toHaveAttribute('aria-keyshortcuts', '?')
      await user.click(item)
      expect(listener).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('visiban:open-shortcuts', listener)
    }
  })

  it('the Help & docs item opens docs.visiban.com in a new tab', async () => {
    renderNavbar()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Account menu for Jane Doe/ }))
    const link = await screen.findByRole('menuitem', { name: /Help & docs/ })
    expect(link).toHaveAttribute('href', 'https://docs.visiban.com')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('the Sign out item uses normal text, not the danger treatment (#2473)', async () => {
    renderNavbar()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Account menu for Jane Doe/ }))
    const signOut = await screen.findByRole('menuitem', { name: /Sign out/ })
    expect(signOut.className).not.toContain('text-danger')
    expect(signOut.querySelector('svg')).not.toBeNull()
  })

  it('ignores the `g u` chord while typing in an input', async () => {
    render(
      <MemoryRouter>
        <input data-testid="typing" />
        <Navbar user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
      </MemoryRouter>
    )
    const user = userEvent.setup()
    const input = screen.getByTestId('typing') as HTMLInputElement
    input.focus()
    await user.keyboard('g')
    await user.keyboard('u')
    expect(screen.queryByRole('menu', { name: 'Account menu' })).not.toBeInTheDocument()
  })
})
