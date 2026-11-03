import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getWebhookStatus,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  disableWebhook,
  reenableWebhook,
  rotateWebhookSecret,
  testWebhook,
} from '../api/webhooks'
import client from '../api/client'
import {
  ADDRESS_REFUSED_COPY,
  disabledReasonCopy,
  eventsSummary,
  groupEventTypes,
  reenableConfirmCopy,
  testResultCopy,
  urlErrorFromResponse,
  urlShapeError,
  webhookPosition,
  webhookRowStatus,
} from '../constants/webhooks'

vi.mock('../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

const c = client as unknown as Record<'get' | 'post' | 'patch' | 'delete', ReturnType<typeof vi.fn>>

describe('api/webhooks (#863)', () => {
  beforeEach(() => {
    Object.values(c).forEach((fn) => fn.mockReset().mockResolvedValue({ data: { ok: true } }))
  })

  it('hits one URL per API row', async () => {
    await getWebhookStatus(3)
    expect(c.get).toHaveBeenLastCalledWith('/api/v1/boards/3/webhooks/status/')
    await listWebhooks(3)
    expect(c.get).toHaveBeenLastCalledWith('/api/v1/boards/3/webhooks/')
    await createWebhook(3, { url: 'https://x.example/', event_types: [] })
    expect(c.post).toHaveBeenLastCalledWith('/api/v1/boards/3/webhooks/', { url: 'https://x.example/', event_types: [] })
    await updateWebhook(3, 9, { name: 'n' })
    expect(c.patch).toHaveBeenLastCalledWith('/api/v1/boards/3/webhooks/9/', { name: 'n' })
    await deleteWebhook(3, 9)
    expect(c.delete).toHaveBeenLastCalledWith('/api/v1/boards/3/webhooks/9/')
    await disableWebhook(3, 9)
    expect(c.post).toHaveBeenLastCalledWith('/api/v1/boards/3/webhooks/9/disable/')
    await reenableWebhook(3, 9, 'latest')
    expect(c.post).toHaveBeenLastCalledWith('/api/v1/boards/3/webhooks/9/reenable/', { resume_from: 'latest' })
    await reenableWebhook(3, 9, 'cursor', 'pw')
    expect(c.post).toHaveBeenLastCalledWith('/api/v1/boards/3/webhooks/9/reenable/', { resume_from: 'cursor', current_password: 'pw' })
    // Bare means revoke: the safe answer for a caller that names no overlap.
    await rotateWebhookSecret(3, 9)
    expect(c.post).toHaveBeenLastCalledWith('/api/v1/boards/3/webhooks/9/rotate/', { overlap_seconds: 0 })
    await rotateWebhookSecret(3, 9, 86400)
    expect(c.post).toHaveBeenLastCalledWith('/api/v1/boards/3/webhooks/9/rotate/', { overlap_seconds: 86400 })
    expect(await testWebhook(3, 9)).toEqual({ ok: true })
    expect(c.post).toHaveBeenLastCalledWith('/api/v1/boards/3/webhooks/9/test/')
  })
})

describe('constants/webhooks (#863, Part 8)', () => {
  it('derives the row status', () => {
    expect(webhookRowStatus({ enabled: true, consecutive_failures: 0 })).toBe('active')
    expect(webhookRowStatus({ enabled: true, consecutive_failures: 2 })).toBe('failing')
    expect(webhookRowStatus({ enabled: false, consecutive_failures: 0 })).toBe('disabled')
  })

  it('checks only the URL shape client-side', () => {
    expect(urlShapeError('hooks.example.com')).toBe('format')
    expect(urlShapeError('ftp://hooks.example.com/')).toBe('format')
    expect(urlShapeError('https://u:p@hooks.example.com/')).toBe('creds')
    // http and every address rule are the server's call.
    expect(urlShapeError('http://n8n.lan/hook')).toBeNull()
    expect(urlShapeError('https://10.0.0.1/hook')).toBeNull()
  })

  it('maps server URL refusals: one neutral message for every address rule', () => {
    expect(urlErrorFromResponse({ code: 'url_not_allowed' })).toBe(ADDRESS_REFUSED_COPY)
    expect(ADDRESS_REFUSED_COPY).toBe("Visiban can't send to this address. If it should be allowed, ask your Visiban operator.")
    expect(urlErrorFromResponse({ code: 'invalid_url', reason: 'http' })).toMatch(/Use an https:\/\/ address/)
    expect(urlErrorFromResponse({ code: 'invalid_url', reason: 'creds' })).toMatch(/Remove the user name/)
    expect(urlErrorFromResponse({ code: 'invalid_url', reason: 'weird' })).toMatch(/Enter a full address/)
    expect(urlErrorFromResponse({ code: 'limit_reached' })).toBeNull()
  })

  it('maps test results onto Part 8 copy', () => {
    expect(testResultCopy({ ok: true, code: null, status_code: 200, latency_ms: 340 })).toEqual({
      tone: 'ok', headline: 'Test event delivered.', remedy: 'The receiver answered 200 OK in 340 ms.',
    })
    expect(testResultCopy({ ok: false, code: 'http_error', status_code: 401, latency_ms: 5 }).remedy).toMatch(/X-Visiban-Signature/)
    expect(testResultCopy({ ok: false, code: 'http_error', status_code: 302, latency_ms: 5 }).remedy).toMatch(/doesn't follow redirects/)
    expect(testResultCopy({ ok: false, code: 'http_error', status_code: 599, latency_ms: 5 }).headline).toMatch(/answered 599/)
    expect(testResultCopy({ ok: false, code: 'timeout', status_code: null, latency_ms: null }, 7).headline).toMatch(/within 7 seconds/)
    expect(testResultCopy({ ok: false, code: 'connection_failed', status_code: null, latency_ms: null }).headline).toContain(ADDRESS_REFUSED_COPY)
    expect(testResultCopy({ ok: false, code: 'tls_error', status_code: null, latency_ms: null }).headline).toMatch(/TLS/)
    expect(testResultCopy({ ok: false, code: 'secret_unavailable', status_code: null, latency_ms: null }).remedy).toMatch(/Delete it/)
    expect(testResultCopy({ ok: false, code: 'new_code', status_code: null, latency_ms: null }).headline).toBe('Test event failed.')
    expect(testResultCopy('rate_limited').tone).toBe('warn')
  })

  it('names a webhook by its list position', () => {
    const subs = [{ id: 7 }, { id: 3 }, { id: 9 }]
    expect(webhookPosition(subs, 7)).toBe('Webhook 1 of 3')
    expect(webhookPosition(subs, 3)).toBe('Webhook 2 of 3')
    expect(webhookPosition(subs, 9)).toBe('Webhook 3 of 3')
  })

  it('maps disabled reasons and the turn-on confirm', () => {
    const owner = { id: 2, username: 'alex', display_name: 'Alex Reed', avatar_url: '' }
    expect(disabledReasonCopy({ disabled_reason: 'failures', configured_by: owner }, 20)?.body).toMatch(/after 20 failed deliveries/)
    expect(disabledReasonCopy({ disabled_reason: 'failures', configured_by: owner }, null)?.body).toMatch(/repeated failed deliveries/)
    expect(disabledReasonCopy({ disabled_reason: 'creator_lost_access', configured_by: owner }, 20)?.body).toMatch(/^Alex Reed is no longer/)
    expect(disabledReasonCopy({ disabled_reason: 'creator_lost_access', configured_by: null }, 20)?.action).toBe('Take over and turn on…')
    expect(disabledReasonCopy({ disabled_reason: 'cursor_expired', configured_by: owner }, 20)?.action).toBe('Turn on from now')
    // Definite since the expiry check reads the prune record (#2058), not a scan-gap estimate.
    const expired = disabledReasonCopy({ disabled_reason: 'cursor_expired', configured_by: owner }, 20)?.body
    expect(expired).toMatch(/^This board's history cleanup removed events it had not sent yet/)
    expect(expired).toMatch(/were not delivered and won't be/)
    expect(expired).not.toMatch(/can't confirm|may have/)
    expect(disabledReasonCopy({ disabled_reason: 'secret_unavailable', configured_by: owner }, 20)?.action).toBe('')
    expect(disabledReasonCopy({ disabled_reason: 'manual', configured_by: owner }, 20)).toBeNull()
    expect(reenableConfirmCopy({ disabled_reason: 'failures' })).toMatch(/resumes to this address/)
    expect(reenableConfirmCopy({ disabled_reason: 'cursor_expired' })).toMatch(/gap won't be sent/)
    expect(reenableConfirmCopy({ disabled_reason: 'creator_lost_access' })).toMatch(/Take it over/)
  })

  it('summarizes event types', () => {
    expect(eventsSummary([])).toBe('All events')
    expect(eventsSummary(['card.moved'])).toBe('1 event type')
    expect(eventsSummary(['card.moved', 'card.created'])).toBe('2 event types')
  })

  it('groups event types in the Part 8 order, with an Other bucket', () => {
    expect(groupEventTypes(['board.updated', 'card.created', 'custom_field.created', 'invite_link.created', 'swimlane_custom_field.updated', 'widget.made'])).toEqual([
      { label: 'Cards', types: ['card.created'] },
      { label: 'Card fields', types: ['custom_field.created'] },
      { label: 'Swimlane fields', types: ['swimlane_custom_field.updated'] },
      { label: 'Board', types: ['board.updated', 'invite_link.created'] },
      { label: 'Other', types: ['widget.made'] },
    ])
  })
})
