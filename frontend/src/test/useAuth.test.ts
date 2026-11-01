import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useAuth } from '../hooks/useAuth'

// Mock the auth API
vi.mock('../api/auth', () => ({
  getCurrentUser: vi.fn(),
  logout: vi.fn(),
}))

import { getCurrentUser, logout } from '../api/auth'

const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>
const mockLogout = logout as ReturnType<typeof vi.fn>

const fakeUser = {
  id: 1,
  username: 'testuser',
  email: 'test@example.com',
  first_name: 'Test',
  last_name: 'User',
  avatar_url: '',
  display_name: 'Test User',
  is_site_admin: false,
  must_change_password: false, must_change_username: false,
}

describe('useAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts with loading=true and user=null', () => {
    mockGetCurrentUser.mockReturnValue(new Promise(() => {})) // never resolves
    const { result } = renderHook(() => useAuth())
    expect(result.current.loading).toBe(true)
    expect(result.current.user).toBeNull()
  })

  it('sets user after getCurrentUser resolves', async () => {
    mockGetCurrentUser.mockResolvedValue(fakeUser)
    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.user).toEqual(fakeUser)
  })

  it('sets user to null when getCurrentUser fails', async () => {
    mockGetCurrentUser.mockRejectedValue(new Error('Unauthorized'))
    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.user).toBeNull()
  })

  it('logout calls API and clears user', async () => {
    mockGetCurrentUser.mockResolvedValue(fakeUser)
    mockLogout.mockResolvedValue(undefined)
    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(result.current.user).toEqual(fakeUser)
    })

    await act(async () => {
      await result.current.logout()
    })
    expect(mockLogout).toHaveBeenCalledOnce()
    expect(result.current.user).toBeNull()
  })

  it('updateUser sets user directly', async () => {
    mockGetCurrentUser.mockResolvedValue(fakeUser)
    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(result.current.user).toEqual(fakeUser)
    })

    const updatedUser = { ...fakeUser, display_name: 'Updated' }
    act(() => {
      result.current.updateUser(updatedUser)
    })
    expect(result.current.user).toEqual(updatedUser)
  })
})

describe('useAuth — current-user resync on tab focus (#783)', () => {
  let origVisibilityState: PropertyDescriptor | undefined

  function setVisibility(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', {
      value: state,
      writable: true,
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    origVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  })

  afterEach(() => {
    if (origVisibilityState) {
      Object.defineProperty(document, 'visibilityState', origVisibilityState)
    }
  })

  it('does NOT refetch while signed out, preserving a pending invite join', async () => {
    // Regression guard: an unauthenticated GET /auth/user/ 401s, the response
    // interceptor fires auth:sessionExpired, and its handler clears
    // pendingJoinToken/returnTo — which would silently break the invite-link
    // flow for anyone who alt-tabs on the login page.
    mockGetCurrentUser.mockRejectedValue(new Error('401'))
    renderHook(() => useAuth())
    await waitFor(() => expect(mockGetCurrentUser).toHaveBeenCalledTimes(1))

    sessionStorage.setItem('pendingJoinToken', 'vbnl_token')
    sessionStorage.setItem('returnTo', '/join/vbnl_token')

    setVisibility('visible')

    expect(mockGetCurrentUser).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('pendingJoinToken')).toBe('vbnl_token')
    expect(sessionStorage.getItem('returnTo')).toBe('/join/vbnl_token')
    sessionStorage.clear()
  })
})

describe('useAuth — logout (#1179)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
  })

  it('a deliberate logout forgets the stashed reset instant', async () => {
    sessionStorage.setItem('demo_next_reset_at', '2026-09-27T13:00:00Z')
    mockGetCurrentUser.mockResolvedValue(fakeUser)
    mockLogout.mockResolvedValue(undefined)
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.user).not.toBeNull())
    await act(async () => { await result.current.logout() })
    expect(sessionStorage.getItem('demo_next_reset_at')).toBeNull()
  })

})

describe('useAuth — recent-boards cleared on sign-out (#1955)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('user:prefs:recent-boards:1', JSON.stringify([{ id: 5, name: 'Secret' }]))
    localStorage.setItem('user:prefs:recent-boards', JSON.stringify([{ id: 6, name: 'Legacy' }]))
    localStorage.setItem('user:prefs:theme', 'dark')
  })

  it('logout clears recent-boards but leaves harmless prefs', async () => {
    mockGetCurrentUser.mockResolvedValue(fakeUser)
    mockLogout.mockResolvedValue(undefined)
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.user).toEqual(fakeUser))
    await act(async () => { await result.current.logout() })
    expect(localStorage.getItem('user:prefs:recent-boards:1')).toBeNull()
    expect(localStorage.getItem('user:prefs:recent-boards')).toBeNull()
    expect(localStorage.getItem('user:prefs:theme')).toBe('dark')
  })

  it('auth:sessionExpired clears recent-boards', async () => {
    mockGetCurrentUser.mockResolvedValue(fakeUser)
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.user).toEqual(fakeUser))
    act(() => { window.dispatchEvent(new Event('auth:sessionExpired')) })
    expect(localStorage.getItem('user:prefs:recent-boards:1')).toBeNull()
    expect(localStorage.getItem('user:prefs:recent-boards')).toBeNull()
    expect(localStorage.getItem('user:prefs:theme')).toBe('dark')
    expect(result.current.user).toBeNull()
  })
})
