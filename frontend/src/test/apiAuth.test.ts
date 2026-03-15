import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
}))

import client from '../api/client'
import { getCurrentUser, getVersion, updateCurrentUser, logout, login, register, getAuthProviders, changePassword, getSiteConfig } from '../api/auth'

const mockGet = client.get as ReturnType<typeof vi.fn>
const mockPost = client.post as ReturnType<typeof vi.fn>
const mockPatch = client.patch as ReturnType<typeof vi.fn>

describe('auth API', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('getCurrentUser calls GET /api/auth/user/', async () => {
    const user = { id: 1, username: 'jdoe' }
    mockGet.mockResolvedValue({ data: user })
    const result = await getCurrentUser()
    expect(mockGet).toHaveBeenCalledWith('/api/auth/user/')
    expect(result).toEqual(user)
  })

  it('getVersion calls GET /api/version/', async () => {
    mockGet.mockResolvedValue({ data: { version: '1.0.0' } })
    const result = await getVersion()
    expect(mockGet).toHaveBeenCalledWith('/api/version/')
    expect(result).toBe('1.0.0')
  })

  it('updateCurrentUser calls PATCH /api/auth/user/', async () => {
    const updated = { id: 1, username: 'jdoe', display_name: 'J' }
    mockPatch.mockResolvedValue({ data: updated })
    const result = await updateCurrentUser({ display_name: 'J' })
    expect(mockPatch).toHaveBeenCalledWith('/api/auth/user/', { display_name: 'J' })
    expect(result).toEqual(updated)
  })

  it('logout calls POST /api/auth/logout/', async () => {
    mockPost.mockResolvedValue({})
    await logout()
    expect(mockPost).toHaveBeenCalledWith('/api/auth/logout/')
  })

  it('login calls POST /api/auth/login/', async () => {
    mockPost.mockResolvedValue({ data: {} })
    await login('user', 'pass')
    expect(mockPost).toHaveBeenCalledWith('/api/auth/login/', { username: 'user', password: 'pass' })
  })

  it('register calls POST /api/auth/registration/', async () => {
    mockPost.mockResolvedValue({ data: {} })
    await register('a@b.com', 'pass1', 'pass1')
    expect(mockPost).toHaveBeenCalledWith('/api/auth/registration/', { email: 'a@b.com', password1: 'pass1', password2: 'pass1' })
  })

  it('getAuthProviders calls GET /api/auth/providers/', async () => {
    const providers = { google: true, github: false, gitlab: false }
    mockGet.mockResolvedValue({ data: providers })
    const result = await getAuthProviders()
    expect(mockGet).toHaveBeenCalledWith('/api/auth/providers/')
    expect(result).toEqual(providers)
  })

  it('changePassword calls POST /api/auth/change-password/', async () => {
    mockPost.mockResolvedValue({ data: { detail: 'ok' } })
    const result = await changePassword('old', 'new')
    expect(mockPost).toHaveBeenCalledWith('/api/auth/change-password/', { current_password: 'old', new_password: 'new' })
    expect(result).toEqual({ detail: 'ok' })
  })

  it('getSiteConfig calls GET /api/auth/site-config/', async () => {
    mockGet.mockResolvedValue({ data: { registration_open: false } })
    const result = await getSiteConfig()
    expect(mockGet).toHaveBeenCalledWith('/api/auth/site-config/')
    expect(result).toEqual({ registration_open: false })
  })
})
