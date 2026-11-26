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
import { getCurrentUser, getVersion, updateCurrentUser, logout, login, register, getAuthProviders, changePassword, getSiteConfig, resetSiteConfigShare, listTokens, createToken, revokeToken, getAdminInviteLinks, getAdminInviteLinksPage, createAdminInviteLink, revokeAdminInviteLink, getAdminBoardInviteLinks, revokeAdminBoardInviteLink, deactivateAdminUser, clearAdminUserLockout, getAdminUsers, verifyEmail, cancelPendingEmailChange, resendPendingEmailConfirmation, listConnectedAccounts, disconnectAccount, dismissPendingConnect, completeTour, resetTour, updateDefaultBoard, searchUsers,
  requestPasswordReset, confirmPasswordReset, chooseUsername, getAdminSettings, patchAdminSettings, getAdminEmailSettings, patchAdminEmailSettings, sendAdminTestEmail, createAdminUser, patchAdminUser, sendAdminInviteEmail,
} from '../api/auth'

const mockGet = client.get as ReturnType<typeof vi.fn>
const mockPost = client.post as ReturnType<typeof vi.fn>
const mockPatch = client.patch as ReturnType<typeof vi.fn>
const mockDelete = client.delete as ReturnType<typeof vi.fn>

describe('auth API', () => {
  beforeEach(() => { vi.clearAllMocks(); resetSiteConfigShare() })

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

  it('changePassword passes through the optional replacement key', async () => {
    mockPost.mockResolvedValue({ data: { detail: 'ok', key: 'abc' } })
    const result = await changePassword('old', 'new')
    expect(result.key).toBe('abc')
  })

  it('getSiteConfig calls GET /api/auth/site-config/', async () => {
    mockGet.mockResolvedValue({ data: { registration_open: false, demo_mode: false, demo_login: null, demo_reset_schedule: null, demo_next_reset_at: null, invite_email_available: false } })
    const result = await getSiteConfig()
    expect(mockGet).toHaveBeenCalledWith('/api/v1/auth/site-config/')
    expect(result).toEqual({ registration_open: false, demo_mode: false, demo_login: null, demo_reset_schedule: null, demo_next_reset_at: null, invite_email_available: false })
  })

  it('listTokens calls GET /api/auth/tokens/', async () => {
    const tokens = [{ id: 1, name: 'ci', prefix: 'vbn_1234', created_at: '2026-01-01T00:00:00Z', last_used_at: null, expires_at: null }]
    mockGet.mockResolvedValue({ data: tokens })
    const result = await listTokens()
    expect(mockGet).toHaveBeenCalledWith('/api/v1/auth/tokens/')
    expect(result).toEqual(tokens)
  })

  it('createToken calls POST /api/auth/tokens/ with name', async () => {
    const created = { id: 1, name: 'ci', prefix: 'vbn_1234', created_at: '2026-01-01T00:00:00Z', last_used_at: null, expires_at: null, scopes: ['read', 'write'] as const, token: 'vbn_abc123' }
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

  it('createToken omits scopes entirely when not supplied', async () => {
    // The key is that `scopes` is ABSENT, not `undefined` — the backend
    // distinguishes "omitted" (apply the default) from an explicit value.
    mockPost.mockResolvedValue({ data: {} })
    await createToken('ci')
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('scopes')
  })

  it('createToken passes scopes when provided', async () => {
    mockPost.mockResolvedValue({ data: {} })
    await createToken('agent', undefined, ['mcp:read'])
    expect(mockPost).toHaveBeenCalledWith('/api/v1/auth/tokens/', {
      name: 'agent',
      expires_at: undefined,
      scopes: ['mcp:read'],
    })
  })

  it('revokeToken calls DELETE /api/auth/tokens/:id/', async () => {
    mockDelete.mockResolvedValue({})
    await revokeToken(42)
    expect(mockDelete).toHaveBeenCalledWith('/api/v1/auth/tokens/42/')
  })
})

describe('pending email change API (#1293)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('cancelPendingEmailChange calls DELETE /api/v1/auth/me/pending-email/ and resolves with no body (204, #2005)', async () => {
    mockDelete.mockResolvedValue({ status: 204, data: '' })
    const result = await cancelPendingEmailChange()
    expect(mockDelete).toHaveBeenCalledWith('/api/v1/auth/me/pending-email/')
    expect(result).toBeUndefined()
  })

  it('listConnectedAccounts calls GET /api/v1/auth/me/connected-accounts/', async () => {
    const rows = [{ provider: 'google', connected: false, email: null, connected_at: null }]
    mockGet.mockResolvedValue({ data: rows })
    const result = await listConnectedAccounts()
    expect(mockGet).toHaveBeenCalledWith('/api/v1/auth/me/connected-accounts/')
    expect(result).toEqual(rows)
  })

  it('disconnectAccount calls DELETE on the provider and resolves with no body (204, #2005)', async () => {
    mockDelete.mockResolvedValue({ status: 204, data: '' })
    const result = await disconnectAccount('github')
    expect(mockDelete).toHaveBeenCalledWith('/api/v1/auth/me/connected-accounts/github/')
    expect(result).toBeUndefined()
  })

  it('dismissPendingConnect calls DELETE /api/v1/auth/me/pending-connect/ and resolves with no body (204, #2005)', async () => {
    mockDelete.mockResolvedValue({ status: 204, data: '' })
    const result = await dismissPendingConnect()
    expect(mockDelete).toHaveBeenCalledWith('/api/v1/auth/me/pending-connect/')
    expect(result).toBeUndefined()
  })

  it('resendPendingEmailConfirmation calls POST /api/v1/auth/me/pending-email/resend/ with no body', async () => {
    mockPost.mockResolvedValue({ data: { detail: 'Confirmation email sent.' } })
    const result = await resendPendingEmailConfirmation()
    expect(mockPost).toHaveBeenCalledWith('/api/v1/auth/me/pending-email/resend/')
    expect(result).toEqual({ detail: 'Confirmation email sent.' })
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

  it('getAdminInviteLinksPage reads X-Total-Count and X-Truncated (#2254)', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 1 }], headers: { 'x-total-count': '73', 'x-truncated': 'true' } })
    expect(await getAdminInviteLinksPage()).toEqual({ links: [{ id: 1 }], total: 73, truncated: true })
    expect(mockGet).toHaveBeenCalledWith('/api/v1/admin/invite-links/')
  })

  it('getAdminInviteLinksPage falls back to the array length when headers are absent (#2254)', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 1 }, { id: 2 }], headers: {} })
    expect(await getAdminInviteLinksPage()).toEqual({ links: [{ id: 1 }, { id: 2 }], total: 2, truncated: false })
  })

  it('createAdminInviteLink calls POST /api/admin/invite-links/ with payload', async () => {
    const created = { id: 1, prefix: 'vbnl_ab', raw_token: 'vbnl_abc123', status: 'pending', single_use: true, expires_at: null, used_at: null, revoked_at: null, created_at: '2026-03-27T00:00:00Z', created_by_username: 'admin' }
    mockPost.mockResolvedValue({ data: created })
    const result = await createAdminInviteLink({ expires_in_days: 7, single_use: true })
    expect(mockPost).toHaveBeenCalledWith('/api/v1/admin/invite-links/', { expires_in_days: 7, single_use: true })
    expect(result).toEqual(created)
  })

  it('getAdminBoardInviteLinks passes status and offset as query params (#439)', async () => {
    const page = { count: 0, offset: 0, page_size: 50, results: [] }
    mockGet.mockResolvedValue({ data: page })
    expect(await getAdminBoardInviteLinks({ status: 'expired', offset: 50 })).toEqual(page)
    expect(mockGet).toHaveBeenCalledWith('/api/v1/admin/board-invite-links/', { params: { status: 'expired', offset: 50 } })
  })

  it('revokeAdminBoardInviteLink calls DELETE /api/v1/admin/board-invite-links/:id/ (#439)', async () => {
    mockDelete.mockResolvedValue({ data: '', status: 204 })
    expect(await revokeAdminBoardInviteLink(4)).toBeUndefined()
    expect(mockDelete).toHaveBeenCalledWith('/api/v1/admin/board-invite-links/4/')
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

  it('clearAdminUserLockout calls POST /api/admin/users/:id/clear-lockout/', async () => {
    const user = { id: 5, username: 'bob', is_active: true }
    mockPost.mockResolvedValue({ data: user })
    const result = await clearAdminUserLockout(5)
    expect(mockPost).toHaveBeenCalledWith('/api/v1/admin/users/5/clear-lockout/', {})
    expect(result).toEqual(user)
  })

  it('getAdminUsers sends a status filter but leaves out "all", the server default (#2501)', async () => {
    const page = { count: 0, offset: 0, page_size: 50, results: [], counts: { all: 0, active: 0, deactivated: 0, admins: 0 } }
    mockGet.mockResolvedValue({ data: page })
    expect(await getAdminUsers({ search: 'jo', offset: 50, status: 'deactivated' })).toEqual(page)
    expect(mockGet).toHaveBeenLastCalledWith('/api/v1/admin/users/', { params: { search: 'jo', offset: 50, status: 'deactivated' } })
    await getAdminUsers({ offset: 0, status: 'all' })
    expect(mockGet).toHaveBeenLastCalledWith('/api/v1/admin/users/', { params: { offset: 0 } })
    await getAdminUsers()
    expect(mockGet).toHaveBeenLastCalledWith('/api/v1/admin/users/', { params: {} })
  })
})

describe('me/ patch helpers', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('completeTour PATCHes has_completed_tour true and returns user', async () => {
    const user = { id: 1, has_completed_tour: true }
    mockPatch.mockResolvedValue({ data: user })
    const result = await completeTour()
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/auth/me/', { has_completed_tour: true })
    expect(result).toEqual(user)
  })

  it('resetTour PATCHes has_completed_tour false and returns undefined', async () => {
    mockPatch.mockResolvedValue({ data: { has_completed_tour: false } })
    const result = await resetTour()
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/auth/me/', { has_completed_tour: false })
    expect(result).toBeUndefined()
  })

  it('updateDefaultBoard PATCHes default_board_id with a numeric id', async () => {
    const user = { id: 1, default_board_id: 42 }
    mockPatch.mockResolvedValue({ data: user })
    const result = await updateDefaultBoard(42)
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/auth/me/', { default_board_id: 42 })
    expect(result).toEqual(user)
  })

  it('updateDefaultBoard PATCHes default_board_id with null to clear', async () => {
    const user = { id: 1, default_board_id: null }
    mockPatch.mockResolvedValue({ data: user })
    await updateDefaultBoard(null)
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/auth/me/', { default_board_id: null })
  })
})

describe('searchUsers', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('calls GET /api/v1/users/ with encoded search param', async () => {
    const users = [{ id: 1, username: 'alice' }]
    mockGet.mockResolvedValue({ data: users })
    const result = await searchUsers('alice')
    expect(mockGet).toHaveBeenCalledWith('/api/v1/users/?search=alice')
    expect(result).toEqual(users)
  })

  it('URL-encodes the query string', async () => {
    mockGet.mockResolvedValue({ data: [] })
    await searchUsers('first last')
    expect(mockGet).toHaveBeenCalledWith('/api/v1/users/?search=first%20last')
  })
})

describe('getSiteConfig request sharing (#1913)', () => {
  beforeEach(() => { vi.clearAllMocks(); resetSiteConfigShare(); vi.useRealTimers() })

  it('calls within the window share one request (login page + app bootstrap)', async () => {
    mockGet.mockResolvedValue({ data: { registration_open: true } })
    const [a, b] = await Promise.all([getSiteConfig(), getSiteConfig()])
    await getSiteConfig()
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })

  it('fresh bypasses the shared request', async () => {
    mockGet.mockResolvedValue({ data: { registration_open: true } })
    await getSiteConfig()
    await getSiteConfig({ fresh: true })
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('requests again once the window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      mockGet.mockResolvedValue({ data: { registration_open: true } })
      await getSiteConfig()
      vi.setSystemTime(Date.now() + 6_000)
      await getSiteConfig()
      expect(mockGet).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not replay a failed request to the next caller', async () => {
    mockGet.mockRejectedValueOnce(new Error('network'))
    await expect(getSiteConfig()).rejects.toThrow('network')
    mockGet.mockResolvedValue({ data: { registration_open: true } })
    await expect(getSiteConfig()).resolves.toEqual({ registration_open: true })
    expect(mockGet).toHaveBeenCalledTimes(2)
  })
})

// #1759: request shape for wrappers that were only ever mocked by component tests.
// URLs and body keys are the backend's (accounts/urls.py, visiban/urls.py, serializers).
describe('password reset and username API (#1759)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('requestPasswordReset POSTs the email and resolves with nothing', async () => {
    mockPost.mockResolvedValue({ data: { detail: 'sent' } })
    await expect(requestPasswordReset('a@b.co')).resolves.toBeUndefined()
    expect(mockPost).toHaveBeenCalledWith('/api/v1/auth/password/reset/', { email: 'a@b.co' })
  })

  it('confirmPasswordReset POSTs uid, token and both passwords under the dj-rest-auth keys', async () => {
    mockPost.mockResolvedValue({ data: {} })
    await expect(confirmPasswordReset('MQ', 'tok-1', 'first-pass', 'second-pass')).resolves.toBeUndefined()
    expect(mockPost).toHaveBeenCalledWith('/api/v1/auth/password/reset/confirm/', {
      uid: 'MQ', token: 'tok-1', new_password1: 'first-pass', new_password2: 'second-pass',
    })
  })

  it('chooseUsername POSTs the username and returns the user', async () => {
    mockPost.mockResolvedValue({ data: { id: 1, username: 'newname' } })
    await expect(chooseUsername('newname')).resolves.toEqual({ id: 1, username: 'newname' })
    expect(mockPost).toHaveBeenCalledWith('/api/v1/auth/choose-username/', { username: 'newname' })
  })
})

describe('admin settings, email and user API (#1759)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('getAdminSettings GETs the site settings', async () => {
    mockGet.mockResolvedValue({ data: { uploads_enabled: true } })
    await expect(getAdminSettings()).resolves.toEqual({ uploads_enabled: true })
    expect(mockGet).toHaveBeenCalledWith('/api/v1/admin/settings/')
  })

  it('patchAdminSettings PATCHes only the fields given', async () => {
    mockPatch.mockResolvedValue({ data: { uploads_enabled: false } })
    await expect(patchAdminSettings({ uploads_enabled: false })).resolves.toEqual({ uploads_enabled: false })
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/settings/', { uploads_enabled: false })
  })

  it('getAdminEmailSettings GETs the email settings', async () => {
    mockGet.mockResolvedValue({ data: { config_source: 'env' } })
    await expect(getAdminEmailSettings()).resolves.toEqual({ config_source: 'env' })
    expect(mockGet).toHaveBeenCalledWith('/api/v1/admin/email-settings/')
  })

  it('patchAdminEmailSettings PATCHes the patch body unchanged', async () => {
    const patch = { host: 'smtp.example.com', port: 465, use_tls: false, use_ssl: true }
    mockPatch.mockResolvedValue({ data: { host: 'smtp.example.com' } })
    await expect(patchAdminEmailSettings(patch)).resolves.toEqual({ host: 'smtp.example.com' })
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/email-settings/', patch)
  })

  it('sendAdminTestEmail POSTs an empty body to the test route', async () => {
    const result = { success: true, code: null, sent_to: 'a@b.co' }
    mockPost.mockResolvedValue({ data: result })
    await expect(sendAdminTestEmail()).resolves.toEqual(result)
    expect(mockPost).toHaveBeenCalledWith('/api/v1/admin/email-settings/test/', {})
  })

  it('createAdminUser POSTs the new account', async () => {
    const data = { username: 'bo', email: 'bo@b.co', password: 'long-password', force_password_reset: true }
    mockPost.mockResolvedValue({ data: { id: 9 } })
    await expect(createAdminUser(data)).resolves.toEqual({ id: 9 })
    expect(mockPost).toHaveBeenCalledWith('/api/v1/admin/users/', data)
  })

  it('patchAdminUser PATCHes the one user', async () => {
    mockPatch.mockResolvedValue({ data: { id: 9, is_active: false } })
    await expect(patchAdminUser(9, { is_active: false })).resolves.toEqual({ id: 9, is_active: false })
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/admin/users/9/', { is_active: false })
  })

  it('sendAdminInviteEmail POSTs the address to the send route', async () => {
    mockPost.mockResolvedValue({ data: { detail: 'sent', sent_to: 'a@b.co' } })
    await expect(sendAdminInviteEmail({ email: 'a@b.co' })).resolves.toEqual({ detail: 'sent', sent_to: 'a@b.co' })
    expect(mockPost).toHaveBeenCalledWith('/api/v1/admin/invite-links/send/', { email: 'a@b.co' })
  })
})
