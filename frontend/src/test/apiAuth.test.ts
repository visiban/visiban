import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

import client from '../api/client'
import { getCurrentUser, getVersion, updateCurrentUser, logout, login, register, getAuthProviders, changePassword, getSiteConfig, listTokens, createToken, revokeToken } from '../api/auth'

const mockGet = client.get as ReturnType<typeof vi.fn>
const mockPost = client.post as ReturnType<typeof vi.fn>
const mockPatch = client.patch as ReturnType<typeof vi.fn>
const mockDelete = client.delete as ReturnType<typeof vi.fn>

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

  it('listTokens calls GET /api/auth/tokens/', async () => {
    const tokens = [{ id: 1, name: 'ci', prefix: 'vbn_1234', created_at: '2026-01-01T00:00:00Z', last_used_at: null, expires_at: null }]
    mockGet.mockResolvedValue({ data: tokens })
    const result = await listTokens()
    expect(mockGet).toHaveBeenCalledWith('/api/auth/tokens/')
    expect(result).toEqual(tokens)
  })

  it('createToken calls POST /api/auth/tokens/ with name', async () => {
    const created = { id: 1, name: 'ci', prefix: 'vbn_1234', created_at: '2026-01-01T00:00:00Z', last_used_at: null, expires_at: null, token: 'vbn_abc123' }
    mockPost.mockResolvedValue({ data: created })
    const result = await createToken('ci')
    expect(mockPost).toHaveBeenCalledWith('/api/auth/tokens/', { name: 'ci', expires_at: undefined })
    expect(result).toEqual(created)
  })

  it('createToken passes expires_at when provided', async () => {
    mockPost.mockResolvedValue({ data: {} })
    await createToken('ci', '2027-01-01T00:00:00Z')
    expect(mockPost).toHaveBeenCalledWith('/api/auth/tokens/', { name: 'ci', expires_at: '2027-01-01T00:00:00Z' })
  })

  it('revokeToken calls DELETE /api/auth/tokens/:id/', async () => {
    mockDelete.mockResolvedValue({})
    await revokeToken(42)
    expect(mockDelete).toHaveBeenCalledWith('/api/auth/tokens/42/')
  })
})
