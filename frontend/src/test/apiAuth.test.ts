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
import { getCurrentUser, getVersion, updateCurrentUser, logout, login, register, getAuthProviders, changePassword, getSiteConfig, listTokens, createToken, revokeToken, getAdminInviteLinks, createAdminInviteLink, revokeAdminInviteLink, deactivateAdminUser, verifyEmail } from '../api/auth'

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
    expect(mockGet).toHaveBeenCalledWith('/api/v1/auth/user/')
    expect(result).toEqual(user)
  })

  it('getVersion calls GET /api/version/', async () => {
    mockGet.mockResolvedValue({ data: { version: '1.0.0' } })
    const result = await getVersion()
    expect(mockGet).toHaveBeenCalledWith('/api/v1/version/')
    expect(result).toBe('1.0.0')
  })

  it('updateCurrentUser calls PATCH /api/auth/user/', async () => {
    const updated = { id: 1, username: 'jdoe', display_name: 'J' }
    mockPatch.mockResolvedValue({ data: updated })
    const result = await updateCurrentUser({ display_name: 'J' })
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/auth/user/', { display_name: 'J' })
    expect(result).toEqual(updated)
  })

  it('logout calls POST /api/auth/logout/', async () => {
    mockPost.mockResolvedValue({})
    await logout()
    expect(mockPost).toHaveBeenCalledWith('/api/v1/auth/logout/')
  })

  it('login calls POST /api/auth/login/', async () => {
    mockPost.mockResolvedValue({ data: {} })
    await login('user', 'pass')
    expect(mockPost).toHaveBeenCalledWith('/api/v1/auth/login/', { username: 'user', password: 'pass' })
  })

  it('register calls POST /api/auth/registration/', async () => {
    mockPost.mockResolvedValue({ data: {} })
    await register('a@b.com', 'pass1', 'pass1')
    expect(mockPost).toHaveBeenCalledWith('/api/v1/auth/registration/', { email: 'a@b.com', password1: 'pass1', password2: 'pass1' })
  })

  it('getAuthProviders calls GET /api/auth/providers/', async () => {
    const providers = { google: true, github: false, gitlab: false, oidc: false, oidc_name: null }
    mockGet.mockResolvedValue({ data: providers })
    const result = await getAuthProviders()
    expect(mockGet).toHaveBeenCalledWith('/api/v1/auth/providers/')
    expect(result).toEqual(providers)
  })

  it('changePassword calls POST /api/auth/change-password/', async () => {
    mockPost.mockResolvedValue({ data: { detail: 'ok' } })
    const result = await changePassword('old', 'new')
    expect(mockPost).toHaveBeenCalledWith('/api/v1/auth/change-password/', { current_password: 'old', new_password: 'new' })
    expect(result).toEqual({ detail: 'ok' })
  })

  it('getSiteConfig calls GET /api/auth/site-config/', async () => {
    mockGet.mockResolvedValue({ data: { registration_open: false } })
    const result = await getSiteConfig()
    expect(mockGet).toHaveBeenCalledWith('/api/v1/auth/site-config/')
    expect(result).toEqual({ registration_open: false })
  })

  it('listTokens calls GET /api/auth/tokens/', async () => {
    const tokens = [{ id: 1, name: 'ci', prefix: 'vbn_1234', created_at: '2026-01-01T00:00:00Z', last_used_at: null, expires_at: null }]
    mockGet.mockResolvedValue({ data: tokens })
    const result = await listTokens()
    expect(mockGet).toHaveBeenCalledWith('/api/v1/auth/tokens/')
    expect(result).toEqual(tokens)
  })

  it('createToken calls POST /api/auth/tokens/ with name', async () => {
    const created = { id: 1, name: 'ci', prefix: 'vbn_1234', created_at: '2026-01-01T00:00:00Z', last_used_at: null, expires_at: null, token: 'vbn_abc123' }
    mockPost.mockResolvedValue({ data: created })
    const result = await createToken('ci')
    expect(mockPost).toHaveBeenCalledWith('/api/v1/auth/tokens/', { name: 'ci', expires_at: undefined })
    expect(result).toEqual(created)
  })

  it('createToken passes expires_at when provided', async () => {
    mockPost.mockResolvedValue({ data: {} })
    await createToken('ci', '2027-01-01T00:00:00Z')
    expect(mockPost).toHaveBeenCalledWith('/api/v1/auth/tokens/', { name: 'ci', expires_at: '2027-01-01T00:00:00Z' })
  })

  it('revokeToken calls DELETE /api/auth/tokens/:id/', async () => {
    mockDelete.mockResolvedValue({})
    await revokeToken(42)
    expect(mockDelete).toHaveBeenCalledWith('/api/v1/auth/tokens/42/')
  })
})

describe('verifyEmail API', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('calls POST /api/v1/auth/registration/verify-email/ with the key in the body', async () => {
    mockPost.mockResolvedValue({})
    await verifyEmail('test-key-abc123')
    expect(mockPost).toHaveBeenCalledWith(
      '/api/v1/auth/registration/verify-email/',
      { key: 'test-key-abc123' }
    )
  })

  it('returns undefined on a successful response', async () => {
    mockPost.mockResolvedValue({ data: {} })
    const result = await verifyEmail('some-key')
    expect(result).toBeUndefined()
  })

  it('propagates rejection on API failure so callers can show an error state', async () => {
    mockPost.mockRejectedValue(new Error('400 Bad Request'))
    await expect(verifyEmail('bad-key')).rejects.toThrow('400 Bad Request')
  })
})

describe('admin invite link API', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('getAdminInviteLinks calls GET /api/admin/invite-links/', async () => {
    mockGet.mockResolvedValue({ data: [] })
    const result = await getAdminInviteLinks()
    expect(mockGet).toHaveBeenCalledWith('/api/v1/admin/invite-links/')
    expect(result).toEqual([])
  })

  it('createAdminInviteLink calls POST /api/admin/invite-links/ with payload', async () => {
    const created = { id: 1, prefix: 'vbnl_ab', raw_token: 'vbnl_abc123', status: 'pending', single_use: true, expires_at: null, used_at: null, revoked_at: null, created_at: '2026-03-27T00:00:00Z', created_by_username: 'admin' }
    mockPost.mockResolvedValue({ data: created })
    const result = await createAdminInviteLink({ expires_in_days: 7, single_use: true })
    expect(mockPost).toHaveBeenCalledWith('/api/v1/admin/invite-links/', { expires_in_days: 7, single_use: true })
    expect(result).toEqual(created)
  })

  it('revokeAdminInviteLink calls DELETE /api/admin/invite-links/:id/', async () => {
    const revoked = { id: 1, prefix: 'vbnl_ab', status: 'revoked', single_use: false, expires_at: null, used_at: null, revoked_at: '2026-03-27T00:00:00Z', created_at: '2026-03-27T00:00:00Z', created_by_username: 'admin' }
    mockDelete.mockResolvedValue({ data: revoked })
    const result = await revokeAdminInviteLink(1)
    expect(mockDelete).toHaveBeenCalledWith('/api/v1/admin/invite-links/1/')
    expect(result).toEqual(revoked)
  })

  it('deactivateAdminUser calls POST /api/admin/users/:id/deactivate/ with transfers', async () => {
    const user = { id: 5, username: 'bob', is_active: false }
    mockPost.mockResolvedValue({ data: user })
    const transfers = [{ board_id: 10, transfer_to: 3 }]
    const result = await deactivateAdminUser(5, transfers)
    expect(mockPost).toHaveBeenCalledWith('/api/v1/admin/users/5/deactivate/', { transfers })
    expect(result).toEqual(user)
  })

  it('deactivateAdminUser defaults to empty transfers array', async () => {
    mockPost.mockResolvedValue({ data: { id: 5, is_active: false } })
    await deactivateAdminUser(5)
    expect(mockPost).toHaveBeenCalledWith('/api/v1/admin/users/5/deactivate/', { transfers: [] })
  })
})
