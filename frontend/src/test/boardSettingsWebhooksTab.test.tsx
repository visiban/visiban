import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardSettingsWebhooksTab, { type WebhookCloseGuard } from '../components/Board/BoardSettingsWebhooksTab'
import { CREATE_UNCONFIRMED_COPY, FORM_GENERIC_COPY, ROTATE_UNCONFIRMED_COPY, SESSION_REQUIRED_COPY } from '../constants/webhooks'
import type { WebhookStatus, WebhookSubscription } from '../types'

vi.mock('../api/webhooks', () => ({
  getWebhookStatus: vi.fn(),
  listWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  disableWebhook: vi.fn(),
  reenableWebhook: vi.fn(),
  rotateWebhookSecret: vi.fn(),
  testWebhook: vi.fn(),
}))

import {
  getWebhookStatus, listWebhooks, createWebhook, updateWebhook, deleteWebhook,
  disableWebhook, reenableWebhook, rotateWebhookSecret, testWebhook,
} from '../api/webhooks'
import { announced } from './confirmAnnouncer'

const m = {
  status: getWebhookStatus as ReturnType<typeof vi.fn>,
  list: listWebhooks as ReturnType<typeof vi.fn>,
  create: createWebhook as ReturnType<typeof vi.fn>,
  update: updateWebhook as ReturnType<typeof vi.fn>,
  del: deleteWebhook as ReturnType<typeof vi.fn>,
  disable: disableWebhook as ReturnType<typeof vi.fn>,
  reenable: reenableWebhook as ReturnType<typeof vi.fn>,
  rotate: rotateWebhookSecret as ReturnType<typeof vi.fn>,
  test: testWebhook as ReturnType<typeof vi.fn>,
}

const NOW = Date.parse('2026-11-01T12:00:00Z')
const minsAgo = (n: number) => new Date(NOW - n * 60_000).toISOString()
const KEEP_OLD = 'Keep old secret for 24 hours'
const REVOKE_OLD = 'Revoke old secret now'
const NEUTRAL = "Visiban can't send to this address. If it should be allowed, ask your Visiban operator."

const STATUS: WebhookStatus = {
  enabled: true,
  dispatcher_last_run_at: minsAgo(1),
  dispatcher_stale: false,
  subscribable_event_types: ['board.updated', 'card.created', 'card.moved', 'custom_field.created', 'swimlane_custom_field.updated'],
  disable_after_failures: 20,
  test_timeout_seconds: 10,
}

const maya = { id: 7, username: 'maya', display_name: 'Maya Kim', avatar_url: '', is_site_admin: false }
const alex = { id: 8, username: 'alex', display_name: 'Alex Reed', avatar_url: '', is_site_admin: false }
// A site admin (#2068): the creator/owner name carries "(site admin)".
const dana = { id: 9, username: 'dana', display_name: 'Dana Soto', avatar_url: '', is_site_admin: true }

function sub(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: 1, board: 3, name: '', url_display: 'hooks.zapier.com/…/k3f9', url_host: 'hooks.zapier.com',
    event_types: [], enabled: true, disabled_reason: null, disabled_at: null, last_delivered_event_id: 10,
    consecutive_failures: 0, failing_since: null, next_attempt_at: null, last_attempt_at: null,
    last_success_at: minsAgo(5), last_error_code: '', last_status_code: null,
    created_by: maya, configured_by: maya, created_at: minsAgo(60), updated_at: minsAgo(5),
    configured_at: minsAgo(60), secret_rotated_at: null, previous_secret_expires_at: null,
    ...overrides,
  }
}

const axiosError = (status: number, code?: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status, data: code ? { code, detail: 'x', ...extra } : {} } })

type TabProps = Partial<Parameters<typeof BoardSettingsWebhooksTab>[0]>

async function renderTab(props: TabProps = {}) {
  render(<BoardSettingsWebhooksTab boardId={3} {...props} />)
  await waitFor(() => expect(screen.queryByLabelText('Loading webhooks')).not.toBeInTheDocument())
}

async function openDetail(user: ReturnType<typeof userEvent.setup>, host = 'hooks.zapier.com') {
  await user.click(screen.getByRole('button', { name: (name) => name.startsWith(`Manage webhook ${host}`) }))
}

const setup = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
  Object.values(m).forEach((fn) => fn.mockReset())
  m.status.mockResolvedValue(STATUS)
  m.list.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Webhooks tab — load states', () => {
  it('spinner, then the empty state', async () => {
    render(<BoardSettingsWebhooksTab boardId={3} />)
    expect(screen.getByRole('status', { name: 'Loading webhooks' })).toBeInTheDocument()
    expect(await screen.findByText('No webhooks yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add webhook' })).toBeInTheDocument()
    // Operator information stays out of the healthy state (only a stale dispatcher is shown).
    expect(screen.queryByText(/Dispatcher last ran/)).not.toBeInTheDocument()
  })

  it('feature off: a note and no button that implies an admin can turn it on', async () => {
    m.status.mockResolvedValue({ ...STATUS, enabled: false })
    await renderTab()
    expect(screen.getByRole('note')).toHaveTextContent('Webhooks are turned off on this Visiban server')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(m.list).not.toHaveBeenCalled()
  })

  it('a webhooks_disabled answer on load is the same note', async () => {
    m.status.mockRejectedValue(axiosError(403, 'webhooks_disabled'))
    await renderTab()
    expect(screen.getByRole('note')).toHaveTextContent('WEBHOOKS_ENABLED')
  })

  it('a load failure offers Retry', async () => {
    const user = setup()
    m.status.mockRejectedValueOnce(axiosError(500))
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No webhooks yet')).toBeInTheDocument()
  })

  it('stale dispatcher, never ran and ran long ago', async () => {
    m.status.mockResolvedValue({ ...STATUS, dispatcher_stale: true, dispatcher_last_run_at: null })
    await renderTab()
    expect(screen.getByRole('group', { name: /has never run/ })).toBeInTheDocument()
  })
})

describe('Webhooks tab — list', () => {
  it('rows show the masked address, a shaped status pill and the summary', async () => {
    m.list.mockResolvedValue([
      sub({ id: 1 }),
      sub({ id: 2, url_display: 'n8n.ops.example/…/b2c1', url_host: 'n8n.ops.example', event_types: ['card.moved', 'card.created'], consecutive_failures: 3, last_error_code: 'http_error', last_status_code: 502, last_attempt_at: minsAgo(2), created_by: alex }),
      sub({ id: 3, url_display: 'relay.example.net/…/9d0e', url_host: 'relay.example.net', enabled: false, disabled_reason: 'cursor_expired', last_error_code: 'timeout', last_attempt_at: minsAgo(30) }),
      sub({ id: 4, url_display: 'old.example/…/aaaa', url_host: 'old.example', enabled: false, disabled_reason: 'manual', created_by: null }),
    ])
    await renderTab()
    const row = (id: number) => within(screen.getByTestId(`webhook-row-${id}`))
    expect(row(1).getByText('hooks.zapier.com/…/k3f9')).toBeInTheDocument()
    expect(row(1).getByText('Active').closest('[data-status]')).toHaveAttribute('data-status', 'active')
    expect(row(1).getByText(/All events · Created by Maya Kim ·/)).toBeInTheDocument()
    expect(row(2).getByText('Failing · 3 failures')).toBeInTheDocument()
    expect(row(2).getByText(/2 event types · Created by Alex Reed/)).toBeInTheDocument()
    expect(row(2).getByText('Last error: HTTP 502 · 2 m ago')).toBeInTheDocument()
    expect(row(3).getByText('Disabled')).toBeInTheDocument()
    expect(row(3).getByText('Turned off because it fell too far behind')).toBeInTheDocument()
    expect(row(4).getByText(/^Turned off by a board admin/)).toBeInTheDocument()
    // Accessible names stay unique when two webhooks share a host.
    expect(row(1).getByRole('button', { name: 'Manage webhook hooks.zapier.com/…/k3f9 (#1)' })).toBeInTheDocument()
    expect(row(4).getByText(/Created by a former member/)).toBeInTheDocument()
    // Pill shapes are SVG, aria-hidden: the word carries the meaning.
    expect(row(2).getByText('Failing · 3 failures').querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('Webhooks tab — create and the acknowledged reveal', () => {
  it('creates, reveals the secret above the list, guards Escape, then forgets it', async () => {
    const user = setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    m.create.mockResolvedValue({ ...sub({ id: 9, url_display: 'hooks.new.example/…/abcd', url_host: 'hooks.new.example' }), url: 'https://hooks.new.example/x/abcd', secret: 'whsec_abc' })
    await renderTab()

    await user.click(screen.getByRole('button', { name: 'Add webhook' }))
    const urlField = screen.getByLabelText('Endpoint URL')
    expect(urlField).toHaveFocus()
    await user.type(urlField, 'https://hooks.new.example/x/abcd')
    await user.click(screen.getByLabelText(/Only these events/))
    for (const legend of ['Cards', 'Card fields', 'Swimlane fields', 'Board']) {
      expect(screen.getByRole('group', { name: legend })).toBeInTheDocument()
    }
    await user.click(screen.getByRole('button', { name: 'Create webhook' }))
    expect(screen.getByText('Choose at least one event, or pick All events.')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'custom_field.created' }))
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create webhook' }))
    expect(m.create).toHaveBeenCalledWith(3, { url: 'https://hooks.new.example/x/abcd', event_types: ['custom_field.created'] })

    const reveal = await screen.findByTestId('webhook-secret-reveal')
    expect(screen.getByText(/^Webhook 1 of \d+ created\. Copy its signing secret now\.$/)).toBeInTheDocument()
    expect(within(reveal).getByRole('button', { name: 'Copy' })).toHaveFocus()
    expect(within(reveal).getByRole('textbox', { name: 'Signing secret' })).toHaveValue('whsec_abc')
    expect(screen.queryByRole('button', { name: 'Add webhook' })).not.toBeInTheDocument()
    await user.click(within(reveal).getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith('whsec_abc')

    const done = within(reveal).getByRole('button', { name: 'Done' })
    expect(done).toHaveAttribute('aria-disabled', 'true')
    await user.click(done)
    expect(screen.getByTestId('webhook-secret-reveal')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(await within(reveal).findByText(/Close without storing the secret\?/)).toBeInTheDocument()
    await user.click(within(reveal).getByRole('button', { name: /Cancel closing/ }))
    expect(within(reveal).getByRole('button', { name: /^Cop(y|ied)$/ })).toHaveFocus()
    expect(within(reveal).queryByText(/Close without storing/)).not.toBeInTheDocument()

    await user.click(within(reveal).getByRole('checkbox', { name: "I've stored this secret somewhere safe" }))
    expect(done).toHaveAttribute('aria-disabled', 'false')
    await user.click(done)
    expect(screen.queryByText('whsec_abc')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('whsec_abc')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add webhook' })).toHaveFocus())
    expect(screen.getByText("Secret hidden. It can't be shown again.")).toBeInTheDocument()
  })

  it('the modal close guard asks first; Confirm closes and drops the secret', async () => {
    const user = setup()
    let guard: WebhookCloseGuard | null = null
    const onRequestClose = vi.fn()
    m.create.mockResolvedValue({ ...sub({ id: 9 }), url: 'https://hooks.zapier.com/k3f9', secret: 'whsec_g' })
    await renderTab({ registerCloseGuard: (g) => { guard = g }, onRequestClose })
    await user.click(screen.getByRole('button', { name: 'Add webhook' }))
    await user.type(screen.getByLabelText('Endpoint URL'), 'https://hooks.zapier.com/k3f9')
    await user.click(screen.getByRole('button', { name: 'Create webhook' }))
    await screen.findByTestId('webhook-secret-reveal')
    const proceed = vi.fn()
    let intercepted = false
    act(() => { intercepted = guard!(proceed) })
    expect(intercepted).toBe(true)
    expect(proceed).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm: close without storing the secret' }))
    expect(proceed).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('webhook-secret-reveal')).not.toBeInTheDocument()
    // Acknowledged or no reveal: the guard lets the modal close.
    expect(guard!(proceed)).toBe(false)

    // Escape twice while unacknowledged: the second closes the prompt again, never the modal.
    m.create.mockResolvedValue({ ...sub({ id: 10 }), url: 'https://hooks.zapier.com/k3f9', secret: 'whsec_h' })
    await user.click(screen.getByRole('button', { name: 'Add webhook' }))
    await user.type(screen.getByLabelText('Endpoint URL'), 'https://hooks.zapier.com/k3f9')
    await user.click(screen.getByRole('button', { name: 'Create webhook' }))
    await screen.findByTestId('webhook-secret-reveal')
    fireEvent.keyDown(document, { key: 'Escape' })
    await user.click(await screen.findByRole('button', { name: 'Confirm: close without storing the secret' }))
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('leaving the list for a detail while a secret is unacknowledged asks first', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub({ id: 1 })])
    m.create.mockResolvedValue({ ...sub({ id: 9, url_host: 'new.example', url_display: 'new.example/…/zzzz' }), url: 'https://new.example/zzzz', secret: 'whsec_n' })
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Add webhook' }))
    await user.type(screen.getByLabelText('Endpoint URL'), 'https://new.example/zzzz')
    await user.click(screen.getByRole('button', { name: 'Create webhook' }))
    await screen.findByTestId('webhook-secret-reveal')
    await openDetail(user)
    expect(screen.getByText(/Close without storing the secret\?/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '← All webhooks' })).not.toBeInTheDocument()
  })

  it.each([
    ['client: no scheme', 'hooks.example.com/x', null, /Enter a full address/],
    ['client: credentials', 'https://u:p@hooks.example.com/', null, /Remove the user name and password/],
    ['server: http', 'http://hooks.example.com/', axiosError(400, 'invalid_url', { reason: 'http' }), /Use an https:\/\/ address/],
    ['server: any address rule', 'https://10.0.0.1/', axiosError(400, 'url_not_allowed'), NEUTRAL],
  ])('URL error (%s) lands in the helper slot and focuses the field', async (_label, url, err, text) => {
    const user = setup()
    if (err) m.create.mockRejectedValue(err)
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Add webhook' }))
    const field = screen.getByLabelText('Endpoint URL')
    await user.type(field, url)
    await user.click(screen.getByRole('button', { name: 'Create webhook' }))
    const msg = await screen.findByText(text)
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveFocus()
    expect(field.getAttribute('aria-describedby')).toBe(msg.id)
    if (!err) expect(m.create).not.toHaveBeenCalled()
  })

  it.each([
    [axiosError(400, 'limit_reached'), /reached a webhook limit/],
    [axiosError(400, 'invalid_event_types'), /can't be sent by webhook/],
    [axiosError(429), /Too many webhook changes/],
    [axiosError(500), /Couldn't confirm the new webhook/],
  ])('form-level failures (%#)', async (err, text) => {
    const user = setup()
    m.create.mockRejectedValue(err)
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Add webhook' }))
    await user.type(screen.getByLabelText('Endpoint URL'), 'https://x.example/')
    await user.click(screen.getByRole('button', { name: 'Create webhook' }))
    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  it('a token-only refusal keeps the form and says what to do', async () => {
    const user = setup()
    m.create.mockRejectedValue(axiosError(403, 'session_required'))
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Add webhook' }))
    await user.type(screen.getByLabelText('Endpoint URL'), 'https://x.example/')
    await user.click(screen.getByRole('button', { name: 'Create webhook' }))
    expect(await screen.findByText(/needs a signed-in browser session\. Sign out, sign in again, then retry/)).toBeInTheDocument()
    expect(screen.getByLabelText('Endpoint URL')).toHaveValue('https://x.example/')
    expect(screen.queryByRole('button', { name: 'Sign in again' })).not.toBeInTheDocument()
  })

  it('Cancel and Back return to the list and focus Add webhook', async () => {
    const user = setup()
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Add webhook' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add webhook' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Add webhook' }))
    await user.click(screen.getByRole('button', { name: '← All webhooks' }))
    expect(screen.getByText('No webhooks yet')).toBeInTheDocument()
  })

  it('a webhooks_disabled answer swaps the tab to the off note', async () => {
    const user = setup()
    m.create.mockRejectedValue(axiosError(403, 'webhooks_disabled'))
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Add webhook' }))
    await user.type(screen.getByLabelText('Endpoint URL'), 'https://x.example/')
    await user.click(screen.getByRole('button', { name: 'Create webhook' }))
    expect(await screen.findByRole('note')).toHaveTextContent('turned off on this Visiban server')
  })
})

describe('Webhooks tab — detail', () => {
  it('labels a site-admin creator and owner "(site admin)" in the row and the detail (#2068)', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub({ created_by: dana, configured_by: maya })])
    await renderTab()
    expect(within(screen.getByTestId('webhook-row-1')).getByText(/Created by Dana Soto \(site admin\) ·/)).toBeInTheDocument()
    await openDetail(user)
    expect(screen.getByText(/^Dana Soto \(site admin\)/)).toBeInTheDocument()
    // The owner is not a site admin: no suffix on that name.
    expect(screen.getByText('Owner now: Maya Kim.')).toBeInTheDocument()
  })

  it('Manage focuses the heading; Back returns focus to that row', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub({ created_by: alex, configured_by: maya })])
    await renderTab()
    await openDetail(user)
    const heading = screen.getByRole('heading', { name: 'hooks.zapier.com/…/k3f9' })
    expect(heading).toHaveFocus()
    expect(screen.getByText('Set. It can\'t be shown again.')).toBeInTheDocument()
    expect(screen.getByText(/Owner now: Maya Kim/)).toBeInTheDocument()
    expect(screen.getByLabelText('Sample payload')).toHaveTextContent('"event": "card.moved"')
    // The card.moved data shape: the card nested under "card" (#1890).
    expect(screen.getByLabelText('Sample payload')).toHaveTextContent('"card": { "id": 392')
    const steps = screen.getByLabelText('Verification steps')
    expect(steps).toHaveTextContent('split on ","')
    expect(steps).toHaveTextContent('accept if any value == expected')
    await user.click(screen.getByRole('button', { name: '← All webhooks' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Manage webhook hooks\.zapier\.com/ })).toHaveFocus())
  })

  it('send test event: delivered with latency, failures with remedies, rate limit warns', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.test
      .mockResolvedValueOnce({ ok: true, code: null, status_code: 200, latency_ms: 340 })
      .mockResolvedValueOnce({ ok: false, code: 'connection_failed', status_code: null, latency_ms: null })
      .mockResolvedValueOnce({ ok: false, code: 'timeout', status_code: null, latency_ms: null })
      .mockRejectedValueOnce(axiosError(429))
    await renderTab()
    await openDetail(user)
    const btn = () => screen.getByRole('button', { name: /Send test event|Sending…/ })
    await user.click(btn())
    expect(await screen.findByText('Test event delivered.')).toHaveClass('text-success-on-tint')
    expect(screen.getByText('The receiver answered 200 OK in 340 ms.')).toBeInTheDocument()
    await user.click(btn())
    expect(await screen.findByText(`Test event not sent: ${NEUTRAL}`)).toHaveClass('text-danger')
    await user.click(btn())
    expect(await screen.findByText('Test event failed: no answer within 10 seconds.')).toBeInTheDocument()
    await user.click(btn())
    expect(await screen.findByText('Wait a moment before sending another test.')).toHaveClass('text-warning-on-tint')
  })

  it('turn off asks first, then focuses Turn on again and announces it', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.disable.mockResolvedValue(sub({ enabled: false, disabled_reason: 'manual', disabled_at: minsAgo(0) }))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(screen.getByText(/Turn off this webhook\? Visiban stops sending to this address/)).toBeInTheDocument()
    expect(announced()).toMatch(/^Turn off this webhook\? Visiban stops sending to this address/)
    await user.click(screen.getByRole('button', { name: /^Confirm: Turn off this webhook/ }))
    expect(m.disable).toHaveBeenCalledWith(3, 1)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Turn on again' })).toHaveFocus())
    expect(screen.getByText('Webhook 1 of 1 turned off.')).toBeInTheDocument()
    expect(screen.getByText(/Turned off by a board admin on/)).toBeInTheDocument()
  })

  it('turn on again after failures confirms, resumes from the cursor, and focuses the heading', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'failures', disabled_at: minsAgo(3) })])
    m.reenable.mockResolvedValue(sub())
    await renderTab()
    await openDetail(user)
    expect(screen.getByText('Turned off after repeated delivery failures')).toBeInTheDocument()
    expect(screen.getByText(/after 20 failed deliveries/)).toBeInTheDocument()
    expect(screen.getByText('Reason code: failures')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Turn on again' }))
    expect(screen.getByText(/Sending resumes to this address, starting with the events it missed/)).toBeInTheDocument()
    // The confirm replaced its trigger, so focus moves into it.
    expect(screen.getByRole('button', { name: 'Turn on' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(m.reenable).toHaveBeenCalledWith(3, 1, 'cursor', undefined)
    expect(await screen.findByText('Webhook 1 of 1 is on.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'hooks.zapier.com/…/k3f9' })).toHaveFocus())
  })

  it('announcements name the position and never the address', async () => {
    const user = setup()
    m.list.mockResolvedValue([
      sub({ id: 1, url_host: 'a.example', url_display: 'a.example/…/aaaa' }),
      sub({ id: 2, url_host: 'hooks.secret.example', url_display: 'hooks.secret.example/…/k3f9' }),
      sub({ id: 3, url_host: 'c.example', url_display: 'c.example/…/cccc' }),
    ])
    m.disable.mockResolvedValue(sub({ id: 2, url_host: 'hooks.secret.example', url_display: 'hooks.secret.example/…/k3f9', enabled: false, disabled_reason: 'manual', disabled_at: minsAgo(0) }))
    await renderTab()
    await openDetail(user, 'hooks.secret.example')
    const liveText = () => Array.from(document.querySelectorAll('[role="status"], [aria-live], [role="alert"]')).map((el) => el.textContent ?? '').join(' | ')

    await user.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(liveText()).toMatch(/Turn off this webhook/)
    expect(liveText()).not.toMatch(/hooks\.secret\.example/)

    await user.click(screen.getByRole('button', { name: /^Confirm: Turn off this webhook/ }))
    expect(await screen.findByText('Webhook 2 of 3 turned off.')).toBeInTheDocument()
    expect(liveText()).not.toMatch(/hooks\.secret\.example/)

    // The turn-on confirm is a live region too.
    await user.click(screen.getByRole('button', { name: 'Turn on again' }))
    expect(liveText()).toMatch(/Sending resumes to this address/)
    expect(liveText()).not.toMatch(/hooks\.secret\.example/)
  })

  it('cursor_expired turns on from now; a server 409 swaps to it too', async () => {
    const user = setup()
    m.list.mockResolvedValue([
      sub({ id: 1, enabled: false, disabled_reason: 'cursor_expired', disabled_at: minsAgo(3) }),
      sub({ id: 2, url_host: 'b.example', url_display: 'b.example/…/bbbb', enabled: false, disabled_reason: 'manual', disabled_at: minsAgo(3) }),
    ])
    m.reenable.mockResolvedValueOnce(sub()).mockRejectedValueOnce(axiosError(409, 'cursor_expired')).mockResolvedValueOnce(sub({ id: 2 }))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Turn on from now' }))
    expect(screen.getByText(/Events from the gap won't be sent/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Turn on from now' }))
    expect(m.reenable).toHaveBeenLastCalledWith(3, 1, 'latest', undefined)

    await user.click(screen.getByRole('button', { name: '← All webhooks' }))
    await openDetail(user, 'b.example')
    await user.click(screen.getByRole('button', { name: 'Turn on again' }))
    await user.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/can only resume with new events/)
    await user.click(screen.getByRole('button', { name: 'Turn on from now' }))
    expect(m.reenable).toHaveBeenLastCalledWith(3, 2, 'latest', undefined)
  })

  it('take over after creator_lost_access needs the current password', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'creator_lost_access', disabled_at: minsAgo(3), configured_by: alex })])
    m.reenable.mockRejectedValueOnce(axiosError(400, 'password_incorrect')).mockResolvedValueOnce(sub())
    await renderTab()
    await openDetail(user)
    expect(screen.getByText(/Alex Reed is no longer an admin of this board/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Take over and turn on…' }))
    const pw = screen.getByLabelText('Current password')
    expect(pw).toHaveFocus()
    expect(screen.getByText(/Take it over: it will send as you/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Take over and turn on' }))
    expect(screen.getByText('Enter your current password.')).toBeInTheDocument()
    expect(m.reenable).not.toHaveBeenCalled()
    await user.type(pw, 'wrong')
    await user.click(screen.getByRole('button', { name: 'Take over and turn on' }))
    expect(await screen.findByText("That password isn't right.")).toBeInTheDocument()
    expect(pw).toHaveAttribute('aria-invalid', 'true')
    expect(pw).toHaveValue('')
    await user.type(pw, 'right')
    await user.click(screen.getByRole('button', { name: 'Take over and turn on' }))
    expect(m.reenable).toHaveBeenLastCalledWith(3, 1, 'cursor', 'right')
  })

  it('an SSO account takes over without a password and is told how to sign in again when it is not recent', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'creator_lost_access', disabled_at: minsAgo(3) })])
    m.reenable.mockRejectedValue(axiosError(403, 'recent_login_required'))
    await renderTab({ currentUserHasPassword: false })
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Take over and turn on…' }))
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Take over and turn on' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Take over and turn on' }))
    expect(m.reenable).toHaveBeenCalledWith(3, 1, 'cursor', undefined)
    expect(await screen.findByRole('alert')).toHaveTextContent(/sign in again with it, then take the webhook over/)
  })

  it('rotate asks first, then shows the new secret through the same reveal', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.rotate.mockResolvedValue({ ...sub({ secret_rotated_at: minsAgo(0) }), secret: 'whsec_new' })
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    expect(screen.getByText(/Rotate the secret\? Choose what happens/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    expect(m.rotate).toHaveBeenCalledWith(3, 1, 86400)
    const reveal = await screen.findByTestId('webhook-secret-reveal')
    expect(within(reveal).getByRole('textbox')).toHaveValue('whsec_new')
    await user.click(within(reveal).getByRole('checkbox'))
    await user.click(within(reveal).getByRole('button', { name: 'Done' }))
    expect(screen.queryByDisplayValue('whsec_new')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'hooks.zapier.com/…/k3f9' })).toHaveFocus())
  })

  it('a rotate reveal left behind on its detail view does not hide Add webhook', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.rotate.mockResolvedValue({ ...sub({ secret_rotated_at: minsAgo(0) }), secret: 'whsec_new' })
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    const reveal = await screen.findByTestId('webhook-secret-reveal')
    await user.click(within(reveal).getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: '← All webhooks' }))
    expect(screen.queryByTestId('webhook-secret-reveal')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add webhook' })).toBeInTheDocument()
  })

  it('a secret_unavailable webhook offers neither Turn on nor Rotate', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'secret_unavailable', disabled_at: minsAgo(3) })])
    await renderTab()
    await openDetail(user)
    expect(screen.getByText(/Delete it and create a new one/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Turn on/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rotate secret…' })).not.toBeInTheDocument()
  })

  it('delete asks first; Escape (52) cancels; success returns to the list and focuses its heading', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.del.mockResolvedValue({})
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Delete webhook' }))
    expect(screen.getByText(/its secret is destroyed\. This can't be undone/)).toBeInTheDocument()
    // The confirm is a live region: it says "this address", never the host.
    const liveText = Array.from(document.querySelectorAll('[role="status"], [aria-live], [role="alert"]')).map((el) => el.textContent ?? '').join(' | ')
    expect(liveText).toMatch(/Visiban stops sending to this address/)
    expect(liveText).not.toMatch(/hooks\.zapier\.com/)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText(/its secret is destroyed/)).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Delete webhook' }))
    await user.click(screen.getByRole('button', { name: /^Confirm: Delete this webhook/ }))
    expect(m.del).toHaveBeenCalledWith(3, 1)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Webhooks' })).toHaveFocus())
    expect(screen.getByText('Webhook 1 of 1 deleted.')).toBeInTheDocument()
  })

  it('Escape cancels the Turn off confirm', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(screen.getByRole('button', { name: /^Confirm:/ })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Confirm:/ })).not.toBeInTheDocument())
  })

  it('Escape cancels the rotate confirm and returns focus to its trigger', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    // The confirm replaced its trigger: focus moves to the primary action.
    expect(screen.getByRole('button', { name: KEEP_OLD })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('button', { name: KEEP_OLD })).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rotate secret…' })).toHaveFocus())
  })

  it('Escape cancels the turn-on confirm (54)', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'failures' })])
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Turn on again' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Turn on' })).not.toBeInTheDocument())
  })

  it('failed confirms keep their message inside the confirm', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.del.mockRejectedValue(axiosError(500))
    m.disable.mockRejectedValue(axiosError(500))
    m.rotate.mockRejectedValue(axiosError(500))
    await renderTab()
    await openDetail(user)
    for (const [trigger, text] of [
      ['Delete webhook', "Failed to delete the webhook. Please try again."],
      ['Turn off', "Failed to turn off the webhook. Please try again."],
    ] as const) {
      await user.click(screen.getByRole('button', { name: trigger }))
      await user.click(screen.getByRole('button', { name: /^Confirm:/ }))
      expect(await screen.findByText(text)).toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByText(text)).not.toBeInTheDocument())
    }
  })

  it('a failed rotate keeps its message and focus inside the confirm', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.rotate.mockRejectedValue(axiosError(500))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    await user.click(screen.getByRole('button', { name: REVOKE_OLD }))
    expect(await screen.findByRole('alert')).toHaveTextContent(ROTATE_UNCONFIRMED_COPY)
    expect(screen.getByRole('button', { name: REVOKE_OLD })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText(ROTATE_UNCONFIRMED_COPY)).not.toBeInTheDocument())
  })

  it('a rotate the server refused says to try again', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.rotate.mockRejectedValue(axiosError(429))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Failed to rotate the secret. Please try again.")
  })

  it('a rotate with no response refetches, so the until line shows a rotation that landed', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.rotate.mockRejectedValue(new Error('Network Error'))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    m.list.mockResolvedValue([sub({ previous_secret_expires_at: new Date(NOW + 86400_000).toISOString() })])
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/may have gone through/)
    expect(screen.getByText(/Old secret still signed until/)).toBeInTheDocument()
    // Retrying now retires the secret the receiver holds: the confirm says so.
    expect(screen.getByText(/older secret from your last rotation stops being signed either way, so update your receiver/)).toBeInTheDocument()
  })

  it('a retried rotate clears the old failure while it runs', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.rotate.mockRejectedValueOnce(axiosError(500)).mockReturnValueOnce(new Promise(() => {}))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    expect(screen.getByRole('button', { name: 'Rotating…' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a webhook deleted elsewhere returns to the list instead of a blank view', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.rotate.mockRejectedValue(axiosError(404))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    m.list.mockResolvedValue([])
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    expect(await screen.findByText('This webhook no longer exists.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Webhooks' })).toHaveFocus()
  })

  it('a refetch that also fails leaves the message and the view alone', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.rotate.mockRejectedValue(axiosError(502))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    m.list.mockRejectedValue(axiosError(502))
    await user.click(screen.getByRole('button', { name: REVOKE_OLD }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/may have gone through/)
    expect(screen.getByRole('heading', { name: 'hooks.zapier.com/…/k3f9' })).toBeInTheDocument()
  })

  it('a feature-off answer to rotate swaps to the off note and refetches nothing', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.rotate.mockRejectedValue(axiosError(403, 'webhooks_disabled'))
    await renderTab()
    await openDetail(user)
    m.list.mockClear()
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    expect(await screen.findByRole('note')).toHaveTextContent('turned off on this Visiban server')
    expect(m.list).not.toHaveBeenCalled()
  })

  describe('while a one-time secret is on its way', () => {
    const PENDING = /Wait for the new secret/

    it('rotate: every way out refuses, says why, and the response still ends in a reveal', async () => {
      const user = setup()
      let guard: WebhookCloseGuard | null = null
      let finish: (value: unknown) => void = () => {}
      m.list.mockResolvedValue([sub()])
      m.rotate.mockReturnValue(new Promise((resolve) => { finish = resolve }))
      await renderTab({ registerCloseGuard: (g) => { guard = g } })
      await openDetail(user)
      await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
      await user.click(screen.getByRole('button', { name: KEEP_OLD }))

      // Close, the backdrop and a tab switch all ask this.
      const proceed = vi.fn()
      act(() => { expect(guard!(proceed)).toBe(true) })
      expect(proceed).not.toHaveBeenCalled()
      const refusal = await screen.findByRole('alert')
      expect(refusal).toHaveTextContent(PENDING)

      const back = screen.getByRole('button', { name: '← All webhooks' })
      await user.click(back)
      // A new alert each time, or a second refusal would be announced to nobody.
      expect(screen.getByRole('alert')).not.toBe(refusal)
      expect(back).toHaveFocus()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.getByRole('button', { name: 'Rotating…' })).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'hooks.zapier.com/…/k3f9' })).toBeInTheDocument()

      finish({ ...sub(), secret: 'whsec_seen' })
      const reveal = await screen.findByTestId('webhook-secret-reveal')
      expect(within(reveal).getByRole('textbox')).toHaveValue('whsec_seen')
      expect(screen.queryByText(PENDING)).not.toBeInTheDocument()
      // The reveal's own guard takes over from here.
      act(() => { expect(guard!(proceed)).toBe(true) })
      expect(await screen.findByText(/Close without storing the secret\?/)).toBeInTheDocument()
      expect(proceed).not.toHaveBeenCalled()
    })

    it('rotate: the guard lets go once a failure is in', async () => {
      const user = setup()
      let guard: WebhookCloseGuard | null = null
      m.list.mockResolvedValue([sub()])
      m.rotate.mockRejectedValue(axiosError(500))
      await renderTab({ registerCloseGuard: (g) => { guard = g } })
      await openDetail(user)
      await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
      await user.click(screen.getByRole('button', { name: KEEP_OLD }))
      await screen.findByRole('alert')
      expect(guard!(vi.fn())).toBe(false)
    })

    it('rotate: another confirm cannot replace the one whose request runs', async () => {
      const user = setup()
      m.list.mockResolvedValue([sub()])
      m.rotate.mockReturnValue(new Promise(() => {}))
      await renderTab()
      await openDetail(user)
      await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
      await user.click(screen.getByRole('button', { name: KEEP_OLD }))
      await user.click(screen.getByRole('button', { name: 'Delete webhook' }))
      await user.click(screen.getByRole('button', { name: 'Turn off' }))
      expect(screen.getByRole('button', { name: 'Rotating…' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /^Confirm:/ })).not.toBeInTheDocument()
    })

    it('create: every way out refuses, and the response still ends in a reveal', async () => {
      const user = setup()
      let guard: WebhookCloseGuard | null = null
      let finish: (value: unknown) => void = () => {}
      m.list.mockResolvedValue([sub()])
      m.create.mockReturnValue(new Promise((resolve) => { finish = resolve }))
      await renderTab({ registerCloseGuard: (g) => { guard = g } })
      await user.click(screen.getByRole('button', { name: 'Add webhook' }))
      await user.type(screen.getByLabelText('Endpoint URL'), 'https://hooks.example.com/abcd')
      await user.click(screen.getByRole('button', { name: 'Create webhook' }))

      const proceed = vi.fn()
      act(() => { expect(guard!(proceed)).toBe(true) })
      expect(proceed).not.toHaveBeenCalled()
      expect(await screen.findByText(PENDING)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: '← All webhooks' }))
      expect(screen.getByRole('heading', { name: 'Add webhook' })).toBeInTheDocument()

      finish({ ...sub({ id: 2 }), url: 'https://hooks.example.com/abcd', secret: 'whsec_created' })
      const reveal = await screen.findByTestId('webhook-secret-reveal')
      expect(within(reveal).getByRole('textbox')).toHaveValue('whsec_created')
    })

    it('create: an unconfirmed failure refetches, so a webhook that landed is there to see', async () => {
      const user = setup()
      m.list.mockResolvedValue([sub()])
      m.create.mockRejectedValue(new Error('Network Error'))
      await renderTab()
      await user.click(screen.getByRole('button', { name: 'Add webhook' }))
      await user.type(screen.getByLabelText('Endpoint URL'), 'https://hooks.example.com/abcd')
      m.list.mockClear()
      m.list.mockResolvedValue([sub(), sub({ id: 2, url_display: 'hooks.example.com/…/abcd', url_host: 'hooks.example.com' })])
      await user.click(screen.getByRole('button', { name: 'Create webhook' }))
      expect(await screen.findByText(CREATE_UNCONFIRMED_COPY)).toBeInTheDocument()
      expect(m.list).toHaveBeenCalledTimes(1)
      await user.click(screen.getByRole('button', { name: '← All webhooks' }))
      expect(await screen.findByRole('button', { name: /^Manage webhook hooks\.example\.com/ })).toBeInTheDocument()
    })

    it('create: a refetch that also fails still shows the unconfirmed message', async () => {
      const user = setup()
      m.list.mockResolvedValue([sub()])
      m.create.mockRejectedValue(axiosError(503))
      await renderTab()
      await user.click(screen.getByRole('button', { name: 'Add webhook' }))
      await user.type(screen.getByLabelText('Endpoint URL'), 'https://hooks.example.com/abcd')
      m.list.mockRejectedValue(axiosError(503))
      await user.click(screen.getByRole('button', { name: 'Create webhook' }))
      expect(await screen.findByText(CREATE_UNCONFIRMED_COPY)).toBeInTheDocument()
    })

    it('create: a refusal refetches nothing and says to try again', async () => {
      const user = setup()
      m.list.mockResolvedValue([sub()])
      m.create.mockRejectedValue(axiosError(400))
      await renderTab()
      await user.click(screen.getByRole('button', { name: 'Add webhook' }))
      await user.type(screen.getByLabelText('Endpoint URL'), 'https://hooks.example.com/abcd')
      m.list.mockClear()
      await user.click(screen.getByRole('button', { name: 'Create webhook' }))
      expect(await screen.findByText(FORM_GENERIC_COPY)).toBeInTheDocument()
      expect(m.list).not.toHaveBeenCalled()
    })

    it('create: the form back button works again once a failure is in', async () => {
      const user = setup()
      m.list.mockResolvedValue([sub()])
      m.create.mockRejectedValue(axiosError(500))
      await renderTab()
      await user.click(screen.getByRole('button', { name: 'Add webhook' }))
      await user.type(screen.getByLabelText('Endpoint URL'), 'https://hooks.example.com/abcd')
      await user.click(screen.getByRole('button', { name: 'Create webhook' }))
      await screen.findByRole('button', { name: 'Create webhook' })
      await user.click(screen.getByRole('button', { name: '← All webhooks' }))
      expect(await screen.findByRole('heading', { name: 'Webhooks' })).toBeInTheDocument()
    })
  })

  describe('Escape while a confirm runs its request', () => {
    it.each([
      ['Turn off', /^Confirm: Turn off/, 'disable'],
      ['Delete webhook', /^Confirm: Delete this webhook/, 'del'],
    ] as const)('%s stays open', async (trigger, confirmName, mock) => {
      const user = setup()
      m.list.mockResolvedValue([sub()])
      m[mock].mockReturnValue(new Promise(() => {}))
      await renderTab()
      await openDetail(user)
      await user.click(screen.getByRole('button', { name: trigger }))
      await user.click(screen.getByRole('button', { name: confirmName }))
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.getByRole('button', { name: confirmName })).toBeInTheDocument()
    })

    it('turn on stays open', async () => {
      const user = setup()
      m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'failures' })])
      m.reenable.mockReturnValue(new Promise(() => {}))
      await renderTab()
      await openDetail(user)
      await user.click(screen.getByRole('button', { name: 'Turn on again' }))
      await user.click(screen.getByRole('button', { name: 'Turn on' }))
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.getByRole('button', { name: 'Turn on' })).toBeInTheDocument()
    })

    it('Escape cancels again after the request fails', async () => {
      const user = setup()
      m.list.mockResolvedValue([sub()])
      m.disable.mockRejectedValue(axiosError(500))
      await renderTab()
      await openDetail(user)
      await user.click(screen.getByRole('button', { name: 'Turn off' }))
      await user.click(screen.getByRole('button', { name: /^Confirm: Turn off/ }))
      await screen.findByText("Failed to turn off the webhook. Please try again.")
      fireEvent.keyDown(document, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('button', { name: /^Confirm: Turn off/ })).not.toBeInTheDocument())
    })
  })

  it('a token on rotate is told it needs a session, inside the confirm', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.rotate.mockRejectedValue(axiosError(403, 'session_required'))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    expect(await screen.findByRole('alert')).toHaveTextContent(SESSION_REQUIRED_COPY)
  })

  it('revoke old rotates with no overlap and opens no until line', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.rotate.mockResolvedValue({ ...sub({ secret_rotated_at: minsAgo(0) }), secret: 'whsec_new' })
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    await user.click(screen.getByRole('button', { name: REVOKE_OLD }))
    expect(m.rotate).toHaveBeenCalledWith(3, 1, 0)
    await screen.findByTestId('webhook-secret-reveal')
    expect(screen.queryByText(/Old secret still signed until/)).not.toBeInTheDocument()
  })

  it('keep old shows the until line from the response', async () => {
    const user = setup()
    const until = new Date(NOW + 86400_000).toISOString()
    m.list.mockResolvedValue([sub()])
    m.rotate.mockResolvedValue({ ...sub({ previous_secret_expires_at: until }), secret: 'whsec_new' })
    await renderTab()
    await openDetail(user)
    expect(screen.queryByText(/Old secret still signed until/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    expect(await screen.findByText(/Old secret still signed until/)).toBeInTheDocument()
  })

  it('the rotate confirm tells a compromised owner what a rotation cannot do', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    expect(screen.getByRole('button', { name: REVOKE_OLD })).toHaveAccessibleDescription(/replace the secret on your receiver/)
    expect(screen.getByRole('button', { name: REVOKE_OLD })).toHaveAccessibleDescription(/can forge requests/)
    expect(screen.getByRole('button', { name: KEEP_OLD })).toHaveAccessibleDescription(/must accept any signature/)
    expect(screen.queryByText(/older secret from your last rotation/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rotate secret…' })).toHaveFocus())
  })

  it('a double click sends one rotation, and Cancel waits for it', async () => {
    const user = setup()
    let finish: (value: unknown) => void = () => {}
    m.list.mockResolvedValue([sub()])
    m.rotate.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    const busy = screen.getByRole('button', { name: 'Rotating…' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).toHaveFocus()
    await user.click(busy)
    await user.click(screen.getByRole('button', { name: REVOKE_OLD }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(m.rotate).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Rotating…' })).toBeInTheDocument()
    finish({ ...sub(), secret: 'whsec_new' })
    await screen.findByTestId('webhook-secret-reveal')
  })

  it('Escape is swallowed while a rotation runs, and works again after it fails', async () => {
    const user = setup()
    let fail: (reason: unknown) => void = () => {}
    m.list.mockResolvedValue([sub()])
    m.rotate.mockReturnValue(new Promise((_, reject) => { fail = reject }))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Rotating…' })).toBeInTheDocument()
    fail(axiosError(500))
    expect(await screen.findByRole('alert')).toHaveTextContent(ROTATE_UNCONFIRMED_COPY)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('button', { name: KEEP_OLD })).not.toBeInTheDocument())
  })

  describe('a rotate and a test send running together', () => {
    it('a test finishing does not re-arm a rotate still running', async () => {
      const user = setup()
      let guard: WebhookCloseGuard | null = null
      let finishTest: (value: unknown) => void = () => {}
      m.list.mockResolvedValue([sub()])
      m.test.mockReturnValue(new Promise((resolve) => { finishTest = resolve }))
      m.rotate.mockReturnValue(new Promise(() => {}))
      await renderTab({ registerCloseGuard: (g) => { guard = g } })
      await openDetail(user)
      await user.click(screen.getByRole('button', { name: 'Send test event' }))
      await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
      await user.click(screen.getByRole('button', { name: KEEP_OLD }))
      await act(async () => { finishTest({ ok: true, code: null, status_code: 200, latency_ms: 5 }) })
      await screen.findByText('Test event delivered.')
      const busy = screen.getByRole('button', { name: 'Rotating…' })
      expect(busy).toHaveAttribute('aria-disabled', 'true')
      await user.click(busy)
      await user.click(screen.getByRole('button', { name: REVOKE_OLD }))
      expect(m.rotate).toHaveBeenCalledTimes(1)
      act(() => { expect(guard!(vi.fn())).toBe(true) })
    })

    it('a test started during a rotate leaves the rotate locked, and the rotate finishes alone', async () => {
      const user = setup()
      let finishRotate: (value: unknown) => void = () => {}
      let finishTest: (value: unknown) => void = () => {}
      m.list.mockResolvedValue([sub()])
      m.rotate.mockReturnValue(new Promise((resolve) => { finishRotate = resolve }))
      m.test.mockReturnValue(new Promise((resolve) => { finishTest = resolve }))
      await renderTab()
      await openDetail(user)
      await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
      await user.click(screen.getByRole('button', { name: KEEP_OLD }))
      await user.click(screen.getByRole('button', { name: 'Send test event' }))
      expect(screen.getByRole('button', { name: 'Sending…' })).toHaveAttribute('aria-disabled', 'true')
      await act(async () => { finishTest({ ok: true, code: null, status_code: 200, latency_ms: 5 }) })
      await screen.findByText('Test event delivered.')
      await user.click(screen.getByRole('button', { name: REVOKE_OLD }))
      expect(m.rotate).toHaveBeenCalledTimes(1)
      await act(async () => { finishRotate({ ...sub(), secret: 'whsec_once' }) })
      expect(within(await screen.findByTestId('webhook-secret-reveal')).getByRole('textbox')).toHaveValue('whsec_once')
    })
  })

  it('revoke old shows its own progress label', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.rotate.mockReturnValue(new Promise(() => {}))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    await user.click(screen.getByRole('button', { name: REVOKE_OLD }))
    expect(screen.getByRole('button', { name: 'Rotating…' })).toHaveAttribute('aria-describedby', expect.stringContaining('rotate-revoke'))
    expect(screen.getByRole('button', { name: KEEP_OLD })).toHaveAttribute('aria-disabled', 'true')
  })

  describe('an open overlap', () => {
    const until = new Date(NOW + 3600_000).toISOString()

    it('names the end of the window, warns the confirm and the address helper', async () => {
      const user = setup()
      m.list.mockResolvedValue([sub({ previous_secret_expires_at: until })])
      await renderTab()
      await openDetail(user)
      expect(screen.getByText(/Old secret still signed until/)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
      expect(screen.getByText(/older secret from your last rotation stops being signed either way/)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      await user.click(screen.getByRole('button', { name: 'Change address…' }))
      expect(screen.getByText(/the secret stays the same, and the old secret stops being signed/)).toBeInTheDocument()
    })

    it('a window already past reads as closed before the server says so', async () => {
      const user = setup()
      m.list.mockResolvedValue([sub({ previous_secret_expires_at: minsAgo(1) })])
      await renderTab()
      await openDetail(user)
      expect(screen.queryByText(/Old secret still signed until/)).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Change address…' }))
      expect(screen.getByText(/the secret stays the same\./)).toBeInTheDocument()
    })
  })

  it('change address: shape check, neutral refusal, success makes you the owner', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.update.mockRejectedValueOnce(axiosError(400, 'url_not_allowed')).mockResolvedValueOnce(sub({ url_display: 'new.example/…/wxyz' }))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Change address…' }))
    const field = screen.getByLabelText('New endpoint URL')
    expect(field).toHaveFocus()
    await user.type(field, 'nope')
    await user.click(screen.getByRole('button', { name: 'Save address' }))
    expect(screen.getByText(/Enter a full address/)).toBeInTheDocument()
    expect(m.update).not.toHaveBeenCalled()
    await user.clear(field)
    await user.type(field, 'https://192.168.0.5/hook')
    await user.click(screen.getByRole('button', { name: 'Save address' }))
    expect(await screen.findByText(NEUTRAL)).toBeInTheDocument()
    await user.clear(field)
    await user.type(field, 'https://new.example/wxyz')
    await user.click(screen.getByRole('button', { name: 'Save address' }))
    expect(m.update).toHaveBeenLastCalledWith(3, 1, { url: 'https://new.example/wxyz' })
    expect(await screen.findByText("Address changed. You're now this webhook's owner.")).toBeInTheDocument()
    expect(screen.queryByLabelText('New endpoint URL')).not.toBeInTheDocument()
  })
})

describe('Webhooks tab — deep link', () => {
  it('focuses and highlights the first webhook turned off automatically', async () => {
    m.list.mockResolvedValue([
      sub({ id: 1 }),
      sub({ id: 2, url_host: 'manual.example', enabled: false, disabled_reason: 'manual' }),
      sub({ id: 3, url_host: 'broken.example', enabled: false, disabled_reason: 'failures' }),
    ])
    Element.prototype.scrollIntoView = vi.fn()
    await renderTab({ focusFirstStopped: true })
    await waitFor(() => expect(screen.getByRole('button', { name: /\(#3\)$/ })).toHaveFocus())
    expect(screen.getByTestId('webhook-row-3')).toHaveClass('ring-2')
    await act(async () => { vi.advanceTimersByTime(1600) })
    expect(screen.getByTestId('webhook-row-3')).not.toHaveClass('ring-2')
  })

  it('focuses the heading when nothing was turned off automatically', async () => {
    m.list.mockResolvedValue([sub({ id: 1 })])
    await renderTab({ focusFirstStopped: true })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Webhooks' })).toHaveFocus())
  })
})

describe('Webhooks tab — ux-review second pass', () => {
  it('deleting a webhook with an unacknowledged rotated secret disarms the guard', async () => {
    const user = setup()
    let guard: WebhookCloseGuard | null = null
    m.list.mockResolvedValue([sub()])
    m.rotate.mockResolvedValue({ ...sub(), secret: 'whsec_r' })
    m.del.mockResolvedValue({})
    await renderTab({ registerCloseGuard: (g) => { guard = g } })
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    await screen.findByTestId('webhook-secret-reveal')
    // Rotating again would overwrite the secret on screen unseen.
    expect(screen.queryByRole('button', { name: 'Rotate secret…' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Delete webhook' }))
    await user.click(screen.getByRole('button', { name: /^Confirm: Delete this webhook/ }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Webhooks' })).toHaveFocus())
    expect(guard!(vi.fn())).toBe(false)
    expect(screen.getByRole('button', { name: 'Add webhook' })).toBeInTheDocument()
  })

  it('an inert Done points at the acknowledgment and explains itself', async () => {
    const user = setup()
    m.create.mockResolvedValue({ ...sub({ id: 9 }), url: 'https://hooks.zapier.com/k3f9', secret: 'whsec_d' })
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Add webhook' }))
    await user.type(screen.getByLabelText('Endpoint URL'), 'https://hooks.zapier.com/k3f9')
    await user.click(screen.getByRole('button', { name: 'Create webhook' }))
    const done = await screen.findByRole('button', { name: 'Done' })
    expect(done).toHaveAccessibleDescription('Tick the box once the secret is stored to finish.')
    await user.click(done)
    expect(screen.getByRole('checkbox', { name: "I've stored this secret somewhere safe" })).toHaveFocus()
  })

  it('a test in flight ignores repeat presses and clears the old result', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    let resolve: (v: unknown) => void = () => {}
    m.test.mockResolvedValueOnce({ ok: true, code: null, status_code: 200, latency_ms: 1 }).mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Send test event' }))
    expect(await screen.findByText('Test event delivered.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Send test event' }))
    expect(screen.queryByText('Test event delivered.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sending…' }))
    expect(m.test).toHaveBeenCalledTimes(2)
    await act(async () => { resolve({ ok: true, code: null, status_code: 204, latency_ms: 2 }) })
    expect(await screen.findByText('Test event delivered.')).toBeInTheDocument()
  })

  it('the address form returns focus to Change address on Save and Cancel', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.update.mockResolvedValue(sub())
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Change address…' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change address…' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Change address…' }))
    await user.type(screen.getByLabelText('New endpoint URL'), 'https://hooks.zapier.com/new1')
    await user.click(screen.getByRole('button', { name: 'Save address' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change address…' })).toHaveFocus())
  })

  it('a feature-off answer while a secret is unacknowledged leaves no armed guard', async () => {
    const user = setup()
    let guard: WebhookCloseGuard | null = null
    m.list.mockResolvedValue([sub()])
    m.rotate.mockResolvedValue({ ...sub(), secret: 'whsec_f' })
    m.test.mockRejectedValue(axiosError(403, 'webhooks_disabled'))
    await renderTab({ registerCloseGuard: (g) => { guard = g } })
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    await screen.findByTestId('webhook-secret-reveal')
    await user.click(screen.getByRole('button', { name: 'Send test event' }))
    expect(await screen.findByRole('note')).toHaveTextContent('turned off on this Visiban server')
    expect(guard!(vi.fn())).toBe(false)
  })

  it('the code samples are keyboard-reachable regions', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    await renderTab()
    await openDetail(user)
    expect(screen.getByRole('region', { name: 'Sample payload' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('region', { name: 'Verification steps' })).toHaveAttribute('tabindex', '0')
  })
})
