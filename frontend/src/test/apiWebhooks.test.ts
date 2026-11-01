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
  deliveryErrorCopy,
  disabledReasonCopy,
  eventsSummary,
  groupEventTypes,
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
    await rotateWebhookSecret(3, 9)
    expect(c.post).toHaveBeenLastCalledWith('/api/v1/boards/3/webhooks/9/rotate/')
    expect(await testWebhook(3, 9)).toEqual({ ok: true })
    expect(c.post).toHaveBeenLastCalledWith('/api/v1/boards/3/webhooks/9/test/')
  })
})

describe('constants/webhooks (#863)', () => {
  it('derives the row status', () => {
    expect(webhookRowStatus({ enabled: true, disabled_reason: null, consecutive_failures: 0 })).toBe('active')
    expect(webhookRowStatus({ enabled: true, disabled_reason: null, consecutive_failures: 2 })).toBe('failing')
    expect(webhookRowStatus({ enabled: false, disabled_reason: 'manual', consecutive_failures: 0 })).toBe('disabled')
    expect(webhookRowStatus({ enabled: false, disabled_reason: 'creator_lost_access', consecutive_failures: 0 })).toBe('stopped')
  })

  it('maps delivery error codes', () => {
    expect(deliveryErrorCopy('tls_error', null)).toBe("The receiver's TLS certificate was rejected")
    expect(deliveryErrorCopy('http_error', 500)).toBe('The receiver answered HTTP 500')
    expect(deliveryErrorCopy('http_error', 301)).toBe('The receiver answered HTTP 301 (redirects are not followed)')
    expect(deliveryErrorCopy('http_error', null)).toBe('The receiver answered HTTP error')
    expect(deliveryErrorCopy('something_new', null)).toBe('Delivery failed')
  })

  it('maps disabled reasons, unknown included', () => {
    const base = { last_error_code: '', last_status_code: null }
    expect(disabledReasonCopy({ ...base, disabled_reason: 'creator_lost_access' }, '2 m ago')).toMatch(/no longer administers this board/)
    expect(disabledReasonCopy({ ...base, disabled_reason: 'cursor_expired' }, '2 m ago')).toMatch(/fell too far behind/)
    expect(disabledReasonCopy({ ...base, disabled_reason: null }, '2 m ago')).toBe('Turned off 2 m ago.')
  })

  it('summarizes event types', () => {
    expect(eventsSummary([])).toBe('All events')
    expect(eventsSummary(['card.moved'])).toBe('1 event: card.moved')
    expect(eventsSummary(['card.moved', 'card.created'])).toBe('2 events: card.moved, card.created')
  })

  it('groups event types by prefix with known legends and falls back to the prefix', () => {
    expect(groupEventTypes(['card.created', 'card.moved', 'swimlane_custom_field.created', 'widget.made'])).toEqual([
      { prefix: 'card', label: 'Cards', types: ['card.created', 'card.moved'] },
      { prefix: 'swimlane_custom_field', label: 'Swimlane fields', types: ['swimlane_custom_field.created'] },
      { prefix: 'widget', label: 'widget', types: ['widget.made'] },
    ])
  })
})
