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
      expect.stringMatching(/Profile & preferences/),
      expect.stringMatching(/Keyboard shortcuts/),
      expect.stringMatching(/Help & docs/),
      expect.stringMatching(/Sign out/),
    ])
    // Sign out MUST be the terminal destructive action.
    expect(items[items.length - 1]).toHaveTextContent(/Sign out/)
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

  it('the Keyboard shortcuts item is disabled outside board pages', async () => {
    renderNavbar({}, '/settings')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Account menu for Jane Doe/ }))
    const item = await screen.findByRole('menuitem', { name: /Keyboard shortcuts/ })
    expect(item).toBeDisabled()
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

  it('the Sign out item uses the danger treatment', async () => {
    renderNavbar()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Account menu for Jane Doe/ }))
    const signOut = await screen.findByRole('menuitem', { name: /Sign out/ })
    expect(signOut.className).toContain('text-danger')
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
