import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AdminPage from '../pages/AdminPage'
import type { User } from '../types'

// The real Navbar renders here (adminPage.test.tsx mocks it), so this sees the shell's
// breadcrumb h1 next to the page body and proves Site admin has exactly one h1 (#2476).
vi.mock('../api/notifications', () => ({
  getUnreadCount: vi.fn().mockResolvedValue(0),
  listNotifications: vi.fn().mockResolvedValue([]),
  markAllRead: vi.fn(),
  markRead: vi.fn(),
}))
vi.mock('../api/auth', () => ({
  getVersion: vi.fn().mockResolvedValue('0.3.0'),
  getAdminSettings: vi.fn().mockResolvedValue({ registration_mode: 'open', uploads_enabled: true, maintenance_mode: false, maintenance_message: '' }),
  patchAdminSettings: vi.fn(),
  getAdminUsers: vi.fn().mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] }),
  getAdminInviteLinksPage: vi.fn().mockResolvedValue({ links: [], total: 0, truncated: false }),
  getAdminInviteLinks: vi.fn().mockResolvedValue([]),
  getAdminEmailSettings: vi.fn().mockResolvedValue({}),
  getAdminBoardInviteLinks: vi.fn().mockResolvedValue([]),
  getSiteConfig: vi.fn().mockResolvedValue({ registration_open: true, registration_mode: 'open', demo_mode: false, demo_login: null, invite_email_available: true }),
}))

const user = {
  id: 1, username: 'admin', email: 'a@example.com', first_name: 'A', last_name: 'U',
  avatar_url: '', display_name: 'Admin User', is_site_admin: true, must_change_password: false, must_change_username: false,
} as User

describe('Site admin heading structure (#2476)', () => {
  it('the shell header owns the only h1 ("Site admin"); the page heading is an h2', async () => {
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <AdminPage user={user} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Site administration' })).toBeInTheDocument())
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
    expect(h1s[0]).toHaveTextContent('Site admin')
  })
})
