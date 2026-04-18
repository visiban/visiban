import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import { ThemeProvider, useTheme } from '../context/ThemeContext'
import type { ThemePreference } from '../context/ThemeContext'
import { ThemeServerSync } from '../context/ThemeServerSync'
import type { User } from '../types'

vi.mock('../api/auth', () => ({
  updateCurrentUser: vi.fn(),
}))

import { updateCurrentUser } from '../api/auth'

const mockUpdateCurrentUser = updateCurrentUser as ReturnType<typeof vi.fn>

const STORAGE_KEY = 'visiban-theme'
const SYNC_SENTINEL_KEY = 'visiban-theme-synced'

function makeMatchMedia(prefersDark = true) {
  return {
    matches: prefersDark,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

function makeUser(theme?: ThemePreference): User {
  return {
    id: 1,
    username: 'jdoe',
    email: 'j@example.com',
    first_name: 'Jane',
    last_name: 'Doe',
    avatar_url: '',
    display_name: 'Jane Doe',
    is_site_admin: false,
    must_change_password: false,
    must_change_username: false,
    ...(theme !== undefined ? { theme } : {}),
  }
}

// Component that forces a preference change from within the provider,
// used to exercise the in-session propagation path.
function ChangeTheme({ to }: { to: ThemePreference }) {
  const { setPreference } = useTheme()
  return (
    <button data-testid="change" onClick={() => setPreference(to)}>
      change
    </button>
  )
}

describe('ThemeServerSync', () => {
  beforeEach(() => {
    localStorage.clear()
    mockUpdateCurrentUser.mockReset()
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue(makeMatchMedia(true)),
    })
  })

  afterEach(() => {
    localStorage.clear()
  })

  // --------------------------------------------------------------------------
  // First-login client-wins behaviour
  // --------------------------------------------------------------------------

  describe('first-login client-wins', () => {
    it('PATCHes the server with the local value when no sentinel is set', async () => {
      localStorage.setItem(STORAGE_KEY, 'light')
      const user = makeUser('system')
      mockUpdateCurrentUser.mockResolvedValue({ ...user, theme: 'light' })
      const onUserUpdated = vi.fn()

      render(
        <ThemeProvider>
          <ThemeServerSync user={user} onUserUpdated={onUserUpdated} />
        </ThemeProvider>
      )

      await waitFor(() => {
        expect(mockUpdateCurrentUser).toHaveBeenCalledWith({ theme: 'light' })
      })
      expect(localStorage.getItem(SYNC_SENTINEL_KEY)).toBe('1')
    })

    it('does not PATCH when local and server values already match', async () => {
      localStorage.setItem(STORAGE_KEY, 'dark')
      const user = makeUser('dark')
      const onUserUpdated = vi.fn()

      render(
        <ThemeProvider>
          <ThemeServerSync user={user} onUserUpdated={onUserUpdated} />
        </ThemeProvider>
      )

      // Allow any async effects to flush
      await act(async () => {
        await Promise.resolve()
      })
      expect(mockUpdateCurrentUser).not.toHaveBeenCalled()
      expect(localStorage.getItem(SYNC_SENTINEL_KEY)).toBe('1')
    })

    it('calls onUserUpdated with the PATCH response', async () => {
      localStorage.setItem(STORAGE_KEY, 'light')
      const user = makeUser('system')
      const updated = { ...user, theme: 'light' as const }
      mockUpdateCurrentUser.mockResolvedValue(updated)
      const onUserUpdated = vi.fn()

      render(
        <ThemeProvider>
          <ThemeServerSync user={user} onUserUpdated={onUserUpdated} />
        </ThemeProvider>
      )

      await waitFor(() => {
        expect(onUserUpdated).toHaveBeenCalledWith(updated)
      })
    })
  })

  // --------------------------------------------------------------------------
  // Subsequent-load server-wins behaviour
  // --------------------------------------------------------------------------

  describe('subsequent-load server-wins', () => {
    it('overwrites local preference when sentinel is present and values differ', async () => {
      localStorage.setItem(STORAGE_KEY, 'dark')
      localStorage.setItem(SYNC_SENTINEL_KEY, '1')
      const user = makeUser('light')
      const onUserUpdated = vi.fn()

      render(
        <ThemeProvider>
          <ThemeServerSync user={user} onUserUpdated={onUserUpdated} />
        </ThemeProvider>
      )

      await waitFor(() => {
        expect(localStorage.getItem(STORAGE_KEY)).toBe('light')
      })
      // Server-wins must not fire a PATCH back to the server.
      expect(mockUpdateCurrentUser).not.toHaveBeenCalled()
    })

    it('does nothing when sentinel is present and values already match', async () => {
      localStorage.setItem(STORAGE_KEY, 'dark')
      localStorage.setItem(SYNC_SENTINEL_KEY, '1')
      const user = makeUser('dark')
      const onUserUpdated = vi.fn()

      render(
        <ThemeProvider>
          <ThemeServerSync user={user} onUserUpdated={onUserUpdated} />
        </ThemeProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })
      expect(mockUpdateCurrentUser).not.toHaveBeenCalled()
      expect(localStorage.getItem(STORAGE_KEY)).toBe('dark')
    })
  })

  // --------------------------------------------------------------------------
  // In-session propagation
  // --------------------------------------------------------------------------

  describe('in-session changes', () => {
    it('PATCHes the server when setPreference is called', async () => {
      localStorage.setItem(STORAGE_KEY, 'dark')
      localStorage.setItem(SYNC_SENTINEL_KEY, '1')
      const user = makeUser('dark')
      mockUpdateCurrentUser.mockResolvedValue({ ...user, theme: 'light' })
      const onUserUpdated = vi.fn()

      const { getByTestId } = render(
        <ThemeProvider>
          <ThemeServerSync user={user} onUserUpdated={onUserUpdated} />
          <ChangeTheme to="light" />
        </ThemeProvider>
      )

      await act(async () => {
        getByTestId('change').click()
      })

      await waitFor(() => {
        expect(mockUpdateCurrentUser).toHaveBeenCalledWith({ theme: 'light' })
      })
    })

    it('does not re-PATCH when the server-wins branch updates the preference', async () => {
      // Sentinel present, local differs from server — the effect should pull
      // server value down via setPreference without bouncing it back up.
      localStorage.setItem(STORAGE_KEY, 'dark')
      localStorage.setItem(SYNC_SENTINEL_KEY, '1')
      const user = makeUser('light')
      const onUserUpdated = vi.fn()

      render(
        <ThemeProvider>
          <ThemeServerSync user={user} onUserUpdated={onUserUpdated} />
        </ThemeProvider>
      )

      await waitFor(() => {
        expect(localStorage.getItem(STORAGE_KEY)).toBe('light')
      })
      expect(mockUpdateCurrentUser).not.toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------------------
  // Failure handling
  // --------------------------------------------------------------------------

  describe('PATCH failures', () => {
    it('swallows errors without breaking the context', async () => {
      localStorage.setItem(STORAGE_KEY, 'light')
      const user = makeUser('system')
      mockUpdateCurrentUser.mockRejectedValue(new Error('network'))
      const onUserUpdated = vi.fn()

      expect(() =>
        render(
          <ThemeProvider>
            <ThemeServerSync user={user} onUserUpdated={onUserUpdated} />
          </ThemeProvider>
        )
      ).not.toThrow()

      await waitFor(() => {
        expect(mockUpdateCurrentUser).toHaveBeenCalled()
      })
      expect(onUserUpdated).not.toHaveBeenCalled()
    })
  })
})
