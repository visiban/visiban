import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AdminPage from '../pages/AdminPage'
import type { User } from '../types'

// The real Navbar renders here (adminPage.test.tsx mocks it), so this sees the shell's
// breadcrumb h1 next to the page body and proves Site admin has exactly one h1 (#2476).
const { mockPatch, mockCreateLink } = vi.hoisted(() => ({ mockPatch: vi.fn(), mockCreateLink: vi.fn() }))
vi.mock('../api/notifications', () => ({
  getUnreadCount: vi.fn().mockResolvedValue(0),
  listNotifications: vi.fn().mockResolvedValue([]),
  markAllRead: vi.fn(),
  markRead: vi.fn(),
}))
vi.mock('../api/auth', () => ({
  getVersion: vi.fn().mockResolvedValue('0.3.0'),
  getAdminSettings: vi.fn().mockResolvedValue({ registration_mode: 'open', uploads_enabled: true, maintenance_mode: false, maintenance_message: '' }),
  patchAdminSettings: (...a: unknown[]) => mockPatch(...a),
  createAdminInviteLink: (...a: unknown[]) => mockCreateLink(...a),
  getAdminUsers: vi.fn().mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] }),
  getAdminInviteLinksPage: vi.fn().mockResolvedValue({ links: [], total: 0, truncated: false }),
  getAdminInviteLinks: vi.fn().mockResolvedValue([]),
  getAdminEmailSettings: vi.fn().mockResolvedValue({}),
  getAdminBoardInviteLinks: vi.fn().mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] }),
  getSiteConfig: vi.fn().mockResolvedValue({ registration_open: true, registration_mode: 'open', demo_mode: false, demo_login: null, invite_email_available: true }),
}))

const user = {
  id: 1, username: 'admin', email: 'a@example.com', first_name: 'A', last_name: 'U',
  avatar_url: '', display_name: 'Admin User', is_site_admin: true, must_change_password: false, must_change_username: false,
} as User


function renderAt(tab: string) {
  return render(
    <MemoryRouter initialEntries={[`/admin?tab=${tab}`]}>
      <AdminPage user={user} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
    </MemoryRouter>,
  )
}

describe('Site admin ux-review fixes (#2476)', () => {
  it('outline: one h1, one page h2, every section heading is an h3', async () => {
    for (const [tab, name] of [['general', 'General'], ['email', 'Email'], ['users', 'Users'], ['invite_links', 'Invite links'], ['board_invites', 'Board invites']]) {
      const { unmount } = renderAt(tab)
      await screen.findByRole('heading', { level: 3, name })
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
      expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1)
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Site administration')
      unmount()
    }
  })

  it('General says switches save on change (spec copy)', async () => {
    renderAt('general')
    expect(await screen.findByText('Switches save as soon as you change them.')).toBeInTheDocument()
  })

  it('invite links empty state heading is an h3', async () => {
    renderAt('invite_links')
    expect(await screen.findByRole('heading', { level: 3, name: 'No invite links yet.' })).toBeInTheDocument()
  })

  it('controls stay enabled and keep focus while a save is in flight', async () => {
    let resolve!: (v: unknown) => void
    mockPatch.mockReturnValue(new Promise((r) => { resolve = r }))
    renderAt('general')
    const sw = await screen.findByRole('switch', { name: 'File uploads' })
    sw.focus()
    fireEvent.click(sw)
    expect(sw).not.toBeDisabled()
    expect(sw).toHaveAttribute('aria-busy', 'true')
    expect(document.activeElement).toBe(sw)
    const radio = screen.getByRole('radio', { name: /Closed/ })
    expect(radio).not.toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Maintenance mode' })).not.toBeDisabled()
    expect(screen.getByLabelText(/Message/)).not.toBeDisabled()
    await act(async () => { resolve({ registration_mode: 'open', uploads_enabled: false, maintenance_mode: false, maintenance_message: '' }) })
    expect(document.activeElement).toBe(sw)
  })

  it('the saved status line sits right after the heading, before the cards', async () => {
    mockPatch.mockResolvedValue({ registration_mode: 'open', uploads_enabled: false, maintenance_mode: false, maintenance_message: '' })
    renderAt('general')
    fireEvent.click(await screen.findByRole('switch', { name: 'File uploads' }))
    const saved = await screen.findByText('Settings saved.')
    const status = saved.closest('[role="status"]') as HTMLElement
    const card = screen.getByText('Registration')
    expect(status.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('opening the New link form focuses its first field; the token reveal is a status', async () => {
    mockCreateLink.mockResolvedValue({
      id: 1, prefix: 'vbnl_ab', status: 'pending', single_use: false, expires_at: null,
      created_at: '2026-01-01T00:00:00Z', use_count: 0, created_by_username: 'admin', raw_token: 'vbnl_tok',
    })
    renderAt('invite_links')
    fireEvent.click(await screen.findByRole('button', { name: 'New link' }))
    expect(document.activeElement).toBe(screen.getByLabelText('Expires after'))
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))
    const reveal = await screen.findByText(/Copy this link now/)
    expect(reveal.closest('[role="status"]')).not.toBeNull()
  })

  it('phone touch targets: AddUser checkbox row carries the 44px phone class', async () => {
    renderAt('users')
    fireEvent.click(await screen.findByRole('button', { name: 'Add user' }))
    const row = screen.getByLabelText('Force password reset on first login').closest('label') as HTMLElement
    expect(row.className).toContain('max-sm:min-h-11')
  })
})
