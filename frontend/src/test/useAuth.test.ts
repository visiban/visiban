import { describe, it, expect, vi, beforeEach } from 'vitest'
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
  must_change_password: false,
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
