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

describe('useAuth — maintenance mode (#783)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('flips the in-memory user into maintenance mode on the event', async () => {
    // The session bootstrapped before the operator turned maintenance mode on,
    // so the cached user still says it is off and no banner is showing.
    mockGetCurrentUser.mockResolvedValue({ ...fakeUser, maintenance_mode: false })
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.user).not.toBeNull())
    expect(result.current.user?.maintenance_mode).toBe(false)

    act(() => {
      window.dispatchEvent(
        new CustomEvent('auth:maintenanceBlocked', { detail: { message: 'Back by 14:00 UTC.' } }),
      )
    })

    expect(result.current.user?.maintenance_mode).toBe(true)
    expect(result.current.user?.maintenance_message).toBe('Back by 14:00 UTC.')
  })

  it('leaves an already-flagged user untouched', async () => {
    // Guards against a rejected-write storm overwriting the notice repeatedly.
    mockGetCurrentUser.mockResolvedValue({
      ...fakeUser,
      maintenance_mode: true,
      maintenance_message: 'Original notice.',
    })
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.user).not.toBeNull())

    act(() => {
      window.dispatchEvent(
        new CustomEvent('auth:maintenanceBlocked', { detail: { message: 'Different notice.' } }),
      )
    })

    expect(result.current.user?.maintenance_message).toBe('Original notice.')
  })

  it('does nothing when there is no signed-in user', async () => {
    mockGetCurrentUser.mockRejectedValue(new Error('401'))
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      window.dispatchEvent(
        new CustomEvent('auth:maintenanceBlocked', { detail: { message: 'Notice.' } }),
      )
    })

    expect(result.current.user).toBeNull()
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

  it('only merges the maintenance fields, never the whole user', async () => {
    // A wholesale replace would revert an optimistic profile edit whose PATCH
    // is still in flight when a tab focus lands.
    mockGetCurrentUser.mockResolvedValue({ ...fakeUser, maintenance_mode: false })
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.user).not.toBeNull())

    act(() => {
      result.current.updateUser((u) => (u ? { ...u, display_name: 'Optimistic' } : u))
    })

    mockGetCurrentUser.mockResolvedValue({
      ...fakeUser,
      display_name: 'Stale From Server',
      maintenance_mode: true,
      maintenance_message: 'Back soon.',
    })
    setVisibility('visible')

    await waitFor(() => expect(result.current.user?.maintenance_mode).toBe(true))
    expect(result.current.user?.display_name).toBe('Optimistic')
    expect(result.current.user?.maintenance_message).toBe('Back soon.')
  })

  it('refetches the current user when the tab becomes visible', async () => {
    // This is what lets the maintenance banner disappear once an admin turns
    // maintenance mode back off — nothing pushes that state to an open tab.
    mockGetCurrentUser.mockResolvedValue(fakeUser)
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.user).not.toBeNull())

    setVisibility('visible')
    await waitFor(() => expect(mockGetCurrentUser).toHaveBeenCalledTimes(2))
  })

  it('throttles rapid tab switching to a single refetch', async () => {
    // Without the shared throttle every alt-tab would fire a request, and this
    // hook is mounted at the app root for the whole session.
    mockGetCurrentUser.mockResolvedValue(fakeUser)
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.user).not.toBeNull())

    setVisibility('visible')
    setVisibility('hidden')
    setVisibility('visible')
    setVisibility('hidden')
    setVisibility('visible')

    await waitFor(() => expect(mockGetCurrentUser).toHaveBeenCalledTimes(2))
    expect(mockGetCurrentUser).toHaveBeenCalledTimes(2)
  })

  it('ignores the event when the tab is being hidden', async () => {
    mockGetCurrentUser.mockResolvedValue(fakeUser)
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.user).not.toBeNull())

    setVisibility('hidden')
    expect(mockGetCurrentUser).toHaveBeenCalledTimes(1)
  })

  it('a failed refetch does not sign the user out', async () => {
    mockGetCurrentUser.mockResolvedValue(fakeUser)
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.user).not.toBeNull())

    mockGetCurrentUser.mockRejectedValueOnce(new Error('network'))
    setVisibility('visible')
    await waitFor(() => expect(mockGetCurrentUser).toHaveBeenCalledTimes(2))

    expect(result.current.user).not.toBeNull()
  })
})
