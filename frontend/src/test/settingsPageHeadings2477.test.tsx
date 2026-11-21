import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import SettingsPage from '../pages/SettingsPage'
import type { User } from '../types'

// The real Navbar renders here (settingsPage.test.tsx mocks it), so this sees the shell's
// breadcrumb h1 next to the page body and proves Settings has exactly one h1 (#2477).
vi.mock('../api/notifications', () => ({
  getUnreadCount: vi.fn().mockResolvedValue(0),
  listNotifications: vi.fn().mockResolvedValue([]),
  markAllRead: vi.fn(),
  markRead: vi.fn(),
}))
vi.mock('../api/auth', () => ({
  getVersion: vi.fn().mockResolvedValue('0.3.0'),
  updateCurrentUser: vi.fn(),
  changePassword: vi.fn(),
  listTokens: vi.fn().mockResolvedValue([]),
  createToken: vi.fn(),
  revokeToken: vi.fn(),
  resetTour: vi.fn(),
  cancelPendingEmailChange: vi.fn(),
  resendPendingEmailConfirmation: vi.fn(),
  getCurrentUser: vi.fn(),
  getAuthProviders: vi.fn().mockResolvedValue({ google: false, github: false, gitlab: false, oidc: false, oidc_name: null }),
  listConnectedAccounts: vi.fn().mockResolvedValue([]),
  disconnectAccount: vi.fn(),
}))

const user = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane', last_name: 'Doe',
  avatar_url: '', display_name: 'Jane Doe', is_site_admin: false, must_change_password: false, must_change_username: false,
  has_usable_password: true,
} as User

vi.stubGlobal('__APP_VERSION__', 'test')

describe('Settings heading structure (#2477)', () => {
  it.each(['profile', 'security', 'access-tokens', 'notifications', 'appearance', 'behavior', 'about'])(
    'the shell header owns the only h1 ("Settings") on ?tab=%s; the page heading is an h2',
    async (tab) => {
      render(
        <MemoryRouter initialEntries={[`/settings?tab=${tab}`]}>
          <SettingsPage user={user} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
        </MemoryRouter>,
      )
      await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Your settings' })).toBeInTheDocument())
      const h1s = screen.getAllByRole('heading', { level: 1 })
      expect(h1s).toHaveLength(1)
      expect(h1s[0]).toHaveTextContent('Settings')
    },
  )
})
