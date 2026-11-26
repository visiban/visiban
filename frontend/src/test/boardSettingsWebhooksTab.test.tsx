import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within, act, fireEvent, cleanup } from '@testing-library/react'
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
    // The tab lives in the settings modal; stand one in around it.
    render(<div role="dialog" tabIndex={-1}><BoardSettingsWebhooksTab boardId={3} /></div>)
    await user.click(await screen.findByRole('button', { name: 'Retry' }))
    // The settings dialog outlives the swapped tab body (#2575).
    expect(screen.getByRole('dialog')).toHaveFocus()
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
    expect(announced()).toBe("Close without storing the secret? You'd have to rotate it to get a new one.")
    expect(screen.getByText(/Close without storing the secret\?/).closest('[aria-live], [role="status"]')).toBeNull()
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
    // The announcer is the only live region for the question (#2232): not the wrapper.
    expect(screen.getByText(/Turn off this webhook\?/).closest('[aria-live], [role="status"]')).toBeNull()
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
    expect(announced()).toMatch(/^Sending resumes to this address, starting with the events it missed/)
    expect(screen.getByText(/^Sending resumes to this address/).closest('[aria-live], [role="status"], [role="alert"]')).toBeNull()
    // The confirm replaced its trigger, so focus moves into it.
    expect(screen.getByRole('button', { name: 'Turn on' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(m.reenable).toHaveBeenCalledWith(3, 1, 'cursor', undefined)
    expect(await screen.findByText('Webhook 1 of 1 is on.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'hooks.zapier.com/…/k3f9' })).toHaveFocus())
  })

  it('re-enable focuses the heading in the same update that closes the confirm (#2608)', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'failures', disabled_at: minsAgo(3) })])
    let answer!: (s: WebhookSubscription) => void
    m.reenable.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Turn on again' }))
    await user.click(screen.getByRole('button', { name: 'Turn on' }))
    answer(sub())
    let focused: Element | null = null
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull()
      focused = document.activeElement
    })
    expect(focused).toBe(screen.getByRole('heading', { name: 'hooks.zapier.com/…/k3f9' }))
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
    expect(announced()).toBe(screen.getByText(/Events from the gap won't be sent/).textContent)
    await user.click(screen.getByRole('button', { name: 'Turn on from now' }))
    expect(m.reenable).toHaveBeenLastCalledWith(3, 1, 'latest', undefined)

    await user.click(screen.getByRole('button', { name: '← All webhooks' }))
    await openDetail(user, 'b.example')
    await user.click(screen.getByRole('button', { name: 'Turn on again' }))
    await user.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/can only resume with new events/)
    // After the server's 409 the visible prompt swaps to the expired copy; the announcement follows it.
    expect(announced()).toBe(screen.getByText(/Events from the gap won't be sent/).textContent)
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
    expect(announced()).toBe('Rotate the secret? Choose what happens to the current one.')
    expect(screen.getByText(/Rotate the secret\? Choose what happens/).closest('[aria-live], [role="status"], [role="alert"]')).toBeNull()
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
    expect(announced()).toBe("Delete this webhook? Visiban stops sending to this address, and its secret is destroyed. This can't be undone.")
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
      // The failure slot is mounted with the prompt, empty; the same element then takes the message (#2232).
      const question = screen.getByText(/^(Delete|Turn off) this webhook\?/)
      const slot = question.parentElement!.querySelector('[role="alert"]') as HTMLElement
      expect(slot).toHaveTextContent('')
      expect(question.closest('[aria-live], [role="status"], [role="alert"]')).toBeNull()
      await user.click(screen.getByRole('button', { name: /^Confirm:/ }))
      expect(await screen.findByText(text)).toBe(slot)
      expect(question.closest('[aria-live], [role="status"], [role="alert"]')).toBeNull()
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
    const slot = await screen.findByText(ROTATE_UNCONFIRMED_COPY)
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    expect(screen.getByRole('button', { name: 'Rotating…' })).toBeInTheDocument()
    // The slot stays mounted and empties (#2232), so the next failure lands in an existing region.
    expect(slot).toBeInTheDocument()
    expect(slot).toHaveTextContent('')
    expect(screen.queryByText(ROTATE_UNCONFIRMED_COPY)).not.toBeInTheDocument()
  })

  it('a turn-on failure lands in a slot mounted, empty, with the prompt (#2232)', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'failures' })])
    m.reenable.mockRejectedValue(axiosError(500))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Turn on again' }))
    const reenable = screen.getByRole('group', { name: /^Sending resumes to this address/ })
    const reenableSlot = within(reenable).getByRole('alert')
    expect(reenableSlot).toHaveTextContent('')
    await user.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(await screen.findByText('Failed to turn on the webhook. Please try again.')).toBe(reenableSlot)
    expect(screen.getByText(/^Sending resumes to this address/).closest('[aria-live], [role="status"], [role="alert"]')).toBeNull()
  })

  it('a rotate failure lands in a slot mounted, empty, with the prompt (#2232)', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.rotate.mockRejectedValue(axiosError(429))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    const rotate = screen.getByRole('group', { name: /^Rotate the secret\?/ })
    const rotateSlot = within(rotate).getByRole('alert')
    expect(rotateSlot).toHaveTextContent('')
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    expect(await screen.findByText('Failed to rotate the secret. Please try again.')).toBe(rotateSlot)
    expect(screen.getByText(/^Rotate the secret\?/).closest('[aria-live], [role="status"], [role="alert"]')).toBeNull()
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
      const refusal = (await screen.findByText(PENDING)).closest('[role="alert"]')
      expect(refusal).not.toBeNull()

      const back = screen.getByRole('button', { name: '← All webhooks' })
      await user.click(back)
      // A new alert each time, or a second refusal would be announced to nobody.
      expect(screen.getByText(PENDING).closest('[role="alert"]')).not.toBe(refusal)
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

  it('a double click on Confirm sends one turn off, and Cancel waits for it (#1435)', async () => {
    const user = setup()
    let finish: (value: unknown) => void = () => {}
    m.list.mockResolvedValue([sub()])
    m.disable.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Turn off' }))
    const confirm = screen.getByRole('button', { name: /^Confirm: Turn off this webhook/ })
    await user.click(confirm)
    expect(confirm).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    fireEvent.click(confirm)
    expect(m.disable).toHaveBeenCalledTimes(1)
    finish(sub({ enabled: false, disabled_reason: 'manual', disabled_at: minsAgo(0) }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Turn on again' })).toBeInTheDocument())
  })

  it('a double click on Confirm sends one delete (#1435)', async () => {
    const user = setup()
    let finish: (value: unknown) => void = () => {}
    m.list.mockResolvedValue([sub()])
    m.del.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Delete webhook' }))
    const confirm = screen.getByRole('button', { name: /^Confirm: Delete this webhook/ })
    await user.click(confirm)
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(m.del).toHaveBeenCalledTimes(1)
    finish({})
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Webhooks' })).toBeInTheDocument())
  })

  it('a double click on Turn on sends one re-enable (#1435)', async () => {
    const user = setup()
    let finish: (value: unknown) => void = () => {}
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'failures', disabled_at: minsAgo(3) })])
    m.reenable.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await renderTab()
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Turn on again' }))
    const confirm = screen.getByRole('button', { name: 'Turn on' })
    await user.click(confirm)
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(m.reenable).toHaveBeenCalledTimes(1)
    finish(sub())
    await screen.findByText('Webhook 1 of 1 is on.')
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

describe('a create or rotate that never answers (#2127)', () => {
  const PENDING = /Wait for the new secret/
  const STUCK_ROTATE = /the rotation may still go through/
  const LEFT_ROTATE = /A secret rotation you didn't wait for may have gone through/
  const LEFT_CREATE = /A webhook you didn't wait for may have been created/

  beforeEach(() => { window.sessionStorage.clear() })

  async function hungRotate(props: TabProps = {}) {
    const user = setup()
    let guard: WebhookCloseGuard | null = null
    let finish: (value: unknown) => void = () => {}
    m.list.mockResolvedValue([sub()])
    m.rotate.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await renderTab({ registerCloseGuard: (g) => { guard = g }, ...props })
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    return { user, guard: () => guard!, finish: (v: unknown) => finish(v) }
  }

  it('stays locked until the bound, then offers Leave anyway, which takes the last refused way out', async () => {
    const { user, guard } = await hungRotate()
    const proceed = vi.fn()
    act(() => { expect(guard()(proceed)).toBe(true) })
    expect(await screen.findByText(PENDING)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Leave anyway' })).not.toBeInTheDocument()

    await act(async () => { vi.advanceTimersByTime(20_000) })
    const stuck = screen.getByText(STUCK_ROTATE).closest('[role="alert"]')
    expect(stuck).not.toBeNull()
    // The way out sits beside the alert, never inside it (#1772), described by it.
    const leave = screen.getByRole('button', { name: 'Leave anyway' })
    expect(stuck!.contains(leave)).toBe(false)
    expect(leave).toHaveAttribute('aria-describedby', stuck!.id)
    expect(screen.queryByText(PENDING)).not.toBeInTheDocument()
    // Still locked: the bound only offers a way out, it does not take one.
    const later = vi.fn()
    act(() => { expect(guard()(later)).toBe(true) })

    m.list.mockResolvedValue([sub({ previous_secret_expires_at: '2026-11-02T12:00:00Z', secret_rotated_at: minsAgo(0) })])
    await user.click(screen.getByRole('button', { name: 'Leave anyway' }))
    // The way out the user tried last is the one taken.
    expect(later).toHaveBeenCalledTimes(1)
    expect(proceed).not.toHaveBeenCalled()
    // Told a rotation may have landed, and the server was re-read.
    expect(screen.getByTestId('webhook-left-pending')).toHaveTextContent(LEFT_ROTATE)
    // Announced through the always-mounted slot, not a region that mounts with its text (#1421).
    expect(screen.getByTestId('webhook-left-pending')).not.toHaveAttribute('role')
    expect(screen.getByTestId('webhook-notice-live')).toHaveTextContent(LEFT_ROTATE)
    await waitFor(() => expect(m.list).toHaveBeenCalledTimes(2))
    // Unlocked: nothing is refused any more.
    expect(guard()(vi.fn())).toBe(false)
    expect(screen.queryByRole('button', { name: 'Rotating…' })).not.toBeInTheDocument()
  })

  it('rotate: Leave anyway with no refused way out puts focus on the status heading', async () => {
    const { user } = await hungRotate()
    await act(async () => { vi.advanceTimersByTime(20_000) })
    const before = screen.getByTestId('webhook-notice-live')
    expect(before).toHaveTextContent('')
    await user.click(screen.getByRole('button', { name: 'Leave anyway' }))
    await waitFor(() => expect(document.querySelector('[data-webhook-status-heading]')).toHaveFocus())
    // The same always-mounted node, now holding the sentence.
    expect(screen.getByTestId('webhook-notice-live')).toBe(before)
    expect(before).toHaveTextContent(LEFT_ROTATE)
  })

  it('the bound passing scrolls the banner into view', async () => {
    const scroll = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scroll
    try {
      await hungRotate()
      expect(scroll).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(20_000) })
      expect(scroll).toHaveBeenCalled()
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('an answer while Leave anyway has focus does not drop focus to the page', async () => {
    const { finish } = await hungRotate()
    await act(async () => { vi.advanceTimersByTime(20_000) })
    act(() => { screen.getByRole('button', { name: 'Leave anyway' }).focus() })
    finish({ ...sub(), secret: 'whsec_now' })
    await screen.findByTestId('webhook-secret-reveal')
    expect(screen.queryByRole('button', { name: 'Leave anyway' })).not.toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
  })

  it('Dismiss returns focus to the view heading', async () => {
    const { user } = await hungRotate()
    await act(async () => { vi.advanceTimersByTime(20_000) })
    await user.click(screen.getByRole('button', { name: 'Leave anyway' }))
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('webhook-left-pending')).not.toBeInTheDocument()
    await waitFor(() => expect(document.querySelector('[data-webhook-status-heading]')).toHaveFocus())
    expect(screen.getByTestId('webhook-notice-live')).toHaveTextContent('')
  })

  it('the warning survives leaving the tab and a reload, the list is re-read on return, and Dismiss clears it', async () => {
    const { user } = await hungRotate()
    await act(async () => { vi.advanceTimersByTime(20_000) })
    await user.click(screen.getByRole('button', { name: 'Leave anyway' }))
    screen.getByTestId('webhook-left-pending')
    // Remount (Board settings closed and opened again, or a reload).
    cleanup()
    m.list.mockClear()
    await renderTab()
    expect(m.list).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('webhook-left-pending')).toHaveTextContent(LEFT_ROTATE)
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('webhook-left-pending')).not.toBeInTheDocument()
    expect(window.sessionStorage.getItem('visiban.webhooks.leftPending.3')).toBeNull()
  })

  it('a late answer while still on the webhook shows its secret and drops the warning', async () => {
    const { user, finish } = await hungRotate()
    await act(async () => { vi.advanceTimersByTime(20_000) })
    await user.click(screen.getByRole('button', { name: 'Leave anyway' }))
    finish({ ...sub(), secret: 'whsec_late' })
    const reveal = await screen.findByTestId('webhook-secret-reveal')
    expect(within(reveal).getByRole('textbox')).toHaveValue('whsec_late')
    expect(screen.queryByTestId('webhook-left-pending')).not.toBeInTheDocument()
  })

  it('a late answer after the user moved on never pulls them back', async () => {
    const { user, finish } = await hungRotate()
    await act(async () => { vi.advanceTimersByTime(20_000) })
    await user.click(screen.getByRole('button', { name: 'Leave anyway' }))
    await user.click(screen.getByRole('button', { name: '← All webhooks' }))
    expect(await screen.findByRole('heading', { name: 'Webhooks' })).toBeInTheDocument()
    finish({ ...sub(), secret: 'whsec_late' })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('webhook-secret-reveal')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Webhooks' })).toBeInTheDocument()
    expect(screen.getByTestId('webhook-left-pending')).toHaveTextContent(LEFT_ROTATE)
  })

  it('create: Leave anyway goes back to the list and warns a webhook may exist', async () => {
    const user = setup()
    let guard: WebhookCloseGuard | null = null
    m.list.mockResolvedValue([sub()])
    m.create.mockReturnValue(new Promise(() => {}))
    await renderTab({ registerCloseGuard: (g) => { guard = g } })
    await user.click(screen.getByRole('button', { name: 'Add webhook' }))
    await user.type(screen.getByLabelText('Endpoint URL'), 'https://hooks.example.com/abcd')
    await user.click(screen.getByRole('button', { name: 'Create webhook' }))
    await act(async () => { vi.advanceTimersByTime(20_000) })
    expect(screen.getByText(/the webhook may still be created/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Leave anyway' }))
    expect(await screen.findByRole('heading', { name: 'Webhooks' })).toBeInTheDocument()
    expect(screen.getByTestId('webhook-left-pending')).toHaveTextContent(LEFT_CREATE)
    expect(guard!(vi.fn())).toBe(false)
  })

  it('a request that answers before the bound never offers Leave anyway', async () => {
    const { finish } = await hungRotate()
    finish({ ...sub(), secret: 'whsec_quick' })
    await screen.findByTestId('webhook-secret-reveal')
    await act(async () => { vi.advanceTimersByTime(20_000) })
    expect(screen.queryByRole('button', { name: 'Leave anyway' })).not.toBeInTheDocument()
  })
})

const MEMBERS = [{ user: { id: 8, display_name: 'Maya' } }]

describe('live updates across admin sessions (#2057)', () => {
  const change = (seq: number, over: Partial<{ id: number; status: 'active' | 'failing' | 'disabled' | 'deleted'; changed_by: number | null; consecutive_failures: number }> = {}) => ({
    id: 1, status: 'disabled' as const, reason_code: 'manual', consecutive_failures: 0, changed_by: 8, at: minsAgo(0), seq, ...over,
  })

  it('a frame refetches the list in place, tags the row for 30 s and announces it politely', async () => {
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} />)
    await screen.findByText('Webhooks')
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'manual' })])
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} remoteChange={change(1)} />)
    await act(async () => { vi.advanceTimersByTime(400) })
    await waitFor(() => expect(m.list).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId('webhook-changed-1')).toHaveTextContent('Changed just now · by Maya')
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(screen.getByText('Webhook 1 of 1 is turned off.')).toBeInTheDocument()
    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(screen.queryByTestId('webhook-changed-1')).not.toBeInTheDocument()
  })

  it('frames close together share one list read and one announcement', async () => {
    m.list.mockResolvedValue([sub(), sub({ id: 2, url_display: 'b.example.com/…/x', url_host: 'b.example.com' })])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} />)
    await screen.findByText('Webhooks')
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} remoteChange={change(1)} />)
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} remoteChange={change(2, { id: 2, changed_by: null })} />)
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(m.list).toHaveBeenCalledTimes(2)
    expect(screen.getByText('2 webhooks were changed elsewhere.')).toBeInTheDocument()
  })

  it("this user's own change refetches without the elsewhere tag", async () => {
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={8} />)
    await screen.findByText('Webhooks')
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={8} remoteChange={change(1)} />)
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(m.list).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('webhook-changed-1')).not.toBeInTheDocument()
  })

  it('a frame from before the tab opened is already in its first load', async () => {
    m.list.mockResolvedValue([sub()])
    render(<BoardSettingsWebhooksTab boardId={3} remoteChange={change(4)} />)
    await screen.findByText('Webhooks')
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(m.list).toHaveBeenCalledTimes(1)
  })

  it('window focus refetches', async () => {
    m.list.mockResolvedValue([sub()])
    await renderTab()
    act(() => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(m.list).toHaveBeenCalledTimes(2)
  })

  it('the open webhook deleted elsewhere: a banner that takes focus, announced, with only Back to all webhooks', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} />)
    await screen.findByText('Webhooks')
    await openDetail(user)
    const slot = screen.getByTestId('webhook-notice-live')
    m.list.mockResolvedValue([])
    rerender(<BoardSettingsWebhooksTab boardId={3} remoteChange={change(1, { status: 'deleted' })} />)
    await act(async () => { vi.advanceTimersByTime(400) })
    const sentence = await screen.findByText('This webhook was deleted elsewhere.', { selector: 'p[tabindex="-1"]' })
    // The banner replacing the vanished detail takes focus.
    await waitFor(() => expect(sentence).toHaveFocus())
    // Announced through the slot that was already mounted, not a region mounting with its text.
    expect(sentence.closest('[role="status"]')).toBeNull()
    expect(screen.getByTestId('webhook-notice-live')).toBe(slot)
    expect(slot).toHaveTextContent('This webhook was deleted elsewhere.')
    const banner = sentence.parentElement as HTMLElement
    expect(within(banner).getAllByRole('button').map((b) => b.textContent)).toEqual(['Back to all webhooks'])
    await user.click(screen.getByRole('button', { name: 'Back to all webhooks' }))
    expect(screen.getByRole('heading', { name: 'Webhooks' })).toHaveFocus()
    // Cleared on the way out, so the next deletion is announced again.
    expect(slot).toHaveTextContent('')
  })

  it('a deletion elsewhere does not take focus from outside the tab', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    try {
      const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} />)
      await screen.findByText('Webhooks')
      await openDetail(user)
      act(() => { outside.focus() })
      m.list.mockResolvedValue([])
      rerender(<BoardSettingsWebhooksTab boardId={3} remoteChange={change(1, { status: 'deleted' })} />)
      await act(async () => { vi.advanceTimersByTime(400) })
      await screen.findByText('This webhook was deleted elsewhere.', { selector: 'p[tabindex="-1"]' })
      expect(outside).toHaveFocus()
    } finally {
      outside.remove()
    }
  })

  it('a socket reconnect refetches the list; one from before the tab opened does not', async () => {
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} reconnectSignal={2} />)
    await screen.findByText('Webhooks')
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(m.list).toHaveBeenCalledTimes(1)
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'manual' })])
    rerender(<BoardSettingsWebhooksTab boardId={3} reconnectSignal={3} />)
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(m.list).toHaveBeenCalledTimes(2)
    // A quiet re-read: no "changed elsewhere" tag or announcement.
    expect(screen.queryByTestId('webhook-changed-1')).not.toBeInTheDocument()
  })

  it('the announcer clears between batches, so the same count is read again', async () => {
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} />)
    await screen.findByText('Webhooks')
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} remoteChange={change(1)} />)
    await act(async () => { vi.advanceTimersByTime(2500) })
    const region = screen.getByText('Webhook 1 of 1 is turned off.')
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} remoteChange={change(2)} />)
    expect(region).toHaveTextContent('')
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(region).toHaveTextContent('Webhook 1 of 1 is turned off.')
  })

  it('the changed tag sits on the metadata line, not beside the address', async () => {
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} />)
    await screen.findByText('Webhooks')
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} remoteChange={change(1)} />)
    await act(async () => { vi.advanceTimersByTime(400) })
    const tag = await screen.findByTestId('webhook-changed-1')
    expect(tag.closest('p')).toHaveTextContent('#1')
  })

  it('an open confirm and an unstored secret are not disturbed by a refetch', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.rotate.mockResolvedValue({ ...sub(), secret: 'whsec_keep' })
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} />)
    await screen.findByText('Webhooks')
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    await screen.findByTestId('webhook-secret-reveal')
    rerender(<BoardSettingsWebhooksTab boardId={3} remoteChange={change(1, { status: 'active' })} />)
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(within(screen.getByTestId('webhook-secret-reveal')).getByRole('textbox')).toHaveValue('whsec_keep')
  })

  // ── #2403: the rest of 1.3 UI spec Part 9 ──────────────────────────────────
  it('the changed tag falls back to "by another admin" for an unknown id, shows no raw id, and names no one for the dispatcher', async () => {
    m.list.mockResolvedValue([sub(), sub({ id: 2, url_display: 'b.example.com/…/x', url_host: 'b.example.com' })])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} />)
    await screen.findByText('Webhooks')
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} remoteChange={change(1, { changed_by: 99 })} />)
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} remoteChange={change(2, { id: 2, changed_by: null })} />)
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(await screen.findByTestId('webhook-changed-1')).toHaveTextContent('Changed just now · by another admin')
    expect(screen.getByTestId('webhook-changed-1')).not.toHaveTextContent('99')
    expect(screen.getByTestId('webhook-changed-2').textContent).toBe('Changed just now')
  })

  it('announcements name the new status, without the host', async () => {
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} />)
    await screen.findByText('Webhooks')
    m.list.mockResolvedValue([sub({ consecutive_failures: 3 })])
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} remoteChange={change(1, { status: 'failing', consecutive_failures: 3 })} />)
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(screen.getByText('Webhook 1 of 1 is failing: 3 deliveries in a row.')).toBeInTheDocument()
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} remoteChange={change(2, { status: 'active' })} />)
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(screen.getByText('Webhook 1 of 1 is on.')).toBeInTheDocument()
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} remoteChange={change(3, { status: 'deleted' })} />)
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(screen.getByText('A webhook was deleted elsewhere.')).toBeInTheDocument()
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} remoteChange={change(4, { id: 50 })} />)
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(screen.getByText('A webhook was changed elsewhere.')).toBeInTheDocument()
  })

  it('a single failure reads "1 delivery"; a failing frame with no count still names the status', async () => {
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} />)
    await screen.findByText('Webhooks')
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} remoteChange={change(1, { status: 'failing', consecutive_failures: 1 })} />)
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(screen.getByText('Webhook 1 of 1 is failing: 1 delivery in a row.')).toBeInTheDocument()
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} remoteChange={change(2, { status: 'failing', consecutive_failures: 0 })} />)
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(screen.getByText('Webhook 1 of 1 is failing.')).toBeInTheDocument()
  })

  it('shows "Live updates paused · Updated N min ago" with Refresh while the socket is down, and clears on reconnect', async () => {
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} socketStatus="connected" />)
    await screen.findByText('Webhooks')
    expect(screen.queryByTestId('webhooks-paused')).not.toBeInTheDocument()
    rerender(<BoardSettingsWebhooksTab boardId={3} socketStatus="reconnecting" />)
    expect(screen.getByTestId('webhooks-paused')).toHaveTextContent('Live updates paused · Updated just now')
    expect(screen.getByTestId('webhook-state-live')).toHaveTextContent('Live updates paused.')
    await act(async () => { vi.advanceTimersByTime(5 * 60_000) })
    // The clock ticks every 30 s, so the label lags by up to one tick.
    expect(screen.getByTestId('webhooks-paused')).toHaveTextContent(/Updated [45] min ago/)
    await act(async () => { screen.getByRole('button', { name: 'Refresh' }).click() })
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(m.list).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('webhooks-paused')).toHaveTextContent('Updated just now')
    rerender(<BoardSettingsWebhooksTab boardId={3} socketStatus="connected" />)
    expect(screen.queryByTestId('webhooks-paused')).not.toBeInTheDocument()
    expect(screen.getByTestId('webhook-state-live')).toHaveTextContent('')
  })

  it('"failed" also pauses; "connecting" does not', async () => {
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} socketStatus="connecting" />)
    await screen.findByText('Webhooks')
    expect(screen.queryByTestId('webhooks-paused')).not.toBeInTheDocument()
    rerender(<BoardSettingsWebhooksTab boardId={3} socketStatus="failed" />)
    expect(screen.getByTestId('webhooks-paused')).toBeInTheDocument()
  })

  it('after a reconnect, says how many webhooks changed while away, and Dismiss clears it', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub(), sub({ id: 2, url_display: 'b.example.com/…/x', url_host: 'b.example.com' })])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} reconnectSignal={1} />)
    await screen.findByText('Webhooks')
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'manual' }), sub({ id: 3, url_display: 'c.example.com/…/y', url_host: 'c.example.com' })])
    rerender(<BoardSettingsWebhooksTab boardId={3} reconnectSignal={2} />)
    await act(async () => { vi.advanceTimersByTime(400) })
    // One turned off, one removed, one added.
    expect(await screen.findByTestId('webhooks-away')).toHaveTextContent('3 webhooks changed while you were away')
    await act(async () => { vi.advanceTimersByTime(100) })
    expect(screen.getByTestId('webhook-state-live')).toHaveTextContent('3 webhooks changed while you were away')
    await user.click(within(screen.getByTestId('webhooks-away')).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('webhooks-away')).not.toBeInTheDocument()
    expect(screen.getByTestId('webhook-state-live')).toHaveTextContent('')
  })

  it('a reconnect that changed nothing shows no banner; one change reads in the singular', async () => {
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} reconnectSignal={1} />)
    await screen.findByText('Webhooks')
    rerender(<BoardSettingsWebhooksTab boardId={3} reconnectSignal={2} />)
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(m.list).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('webhooks-away')).not.toBeInTheDocument()
    m.list.mockResolvedValue([sub({ consecutive_failures: 2 })])
    rerender(<BoardSettingsWebhooksTab boardId={3} reconnectSignal={3} />)
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(await screen.findByTestId('webhooks-away')).toHaveTextContent('1 webhook changed while you were away')
  })

  it('an open detail view gets a banner for a non-delete change, naming who and the new status; Dismiss clears it', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} />)
    await screen.findByText('Webhooks')
    await openDetail(user)
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'manual' })])
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} remoteChange={change(1)} />)
    const banner = await screen.findByTestId('webhook-changed-detail')
    await act(async () => { vi.advanceTimersByTime(100) })
    expect(banner).toHaveTextContent('This webhook was changed elsewhere by Maya. It is now turned off.')
    // No live role of its own: it is announced through the always-mounted slot.
    expect(banner).not.toHaveAttribute('role')
    expect(screen.getByTestId('webhook-state-live')).toHaveTextContent('It is now turned off.')
    await user.click(within(banner).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('webhook-changed-detail')).not.toBeInTheDocument()
    // The dismissed button unmounted: focus moves to the view's heading, not <body>.
    expect(document.activeElement).not.toBe(document.body)
    expect(screen.getByTestId('webhook-state-live')).toHaveTextContent('')
  })

  it('the detail banner is not raised for this user\'s own change, another webhook, or a deletion', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub(), sub({ id: 2, url_display: 'b.example.com/…/x', url_host: 'b.example.com' })])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={8} />)
    await screen.findByText('Webhooks')
    await openDetail(user)
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={8} remoteChange={change(1)} />)
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} remoteChange={change(2, { id: 2 })} />)
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} remoteChange={change(3, { status: 'deleted' })} />)
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(screen.queryByTestId('webhook-changed-detail')).not.toBeInTheDocument()
  })

  it('going back to the list drops the detail banner', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} />)
    await screen.findByText('Webhooks')
    await openDetail(user)
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} remoteChange={change(1, { status: 'active' })} />)
    expect(await screen.findByTestId('webhook-changed-detail')).toHaveTextContent('It is now on.')
    await user.click(screen.getByRole('button', { name: /All webhooks/ }))
    await openDetail(user)
    expect(screen.queryByTestId('webhook-changed-detail')).not.toBeInTheDocument()
  })

  it('paused, away and detail banners never disturb an open create form', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} reconnectSignal={1} socketStatus="connected" />)
    await screen.findByText('Webhooks')
    await user.click(screen.getByRole('button', { name: 'Add webhook' }))
    const input = await screen.findByLabelText(/Endpoint URL/i)
    await user.type(input, 'https://hooks.example.com/x')
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'manual' })])
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} reconnectSignal={1} socketStatus="reconnecting" remoteChange={change(1)} />)
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} reconnectSignal={2} socketStatus="connected" remoteChange={change(1)} />)
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(screen.getByLabelText(/Endpoint URL/i)).toHaveValue('https://hooks.example.com/x')
  })

  it('an open confirm survives a detail-change banner', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} />)
    await screen.findByText('Webhooks')
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} remoteChange={change(1, { status: 'active' })} />)
    await screen.findByTestId('webhook-changed-detail')
    expect(screen.getByRole('button', { name: KEEP_OLD })).toBeInTheDocument()
  })

  it('a pending detail announcement cannot overwrite the paused copy; the later state wins', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} socketStatus="connected" />)
    await screen.findByText('Webhooks')
    await openDetail(user)
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} socketStatus="connected" remoteChange={change(1)} />)
    // Within the 50 ms announce delay the socket drops.
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} socketStatus="reconnecting" remoteChange={change(1)} />)
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(screen.getByTestId('webhook-state-live')).toHaveTextContent('Live updates paused.')
  })

  it('a change announced through the detail banner is not spoken a second time', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} />)
    await screen.findByText('Webhooks')
    await openDetail(user)
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'manual' })])
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} remoteChange={change(1)} />)
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(screen.getByTestId('webhook-state-live')).toHaveTextContent('It is now turned off.')
    expect(screen.queryByText('Webhook 1 of 1 is turned off.')).not.toBeInTheDocument()
  })

  it('an unacknowledged secret reveal survives pause, away and detail banners', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    m.rotate.mockResolvedValue({ ...sub(), secret: 'whsec_keep' })
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} reconnectSignal={1} socketStatus="connected" />)
    await screen.findByText('Webhooks')
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Rotate secret…' }))
    await user.click(screen.getByRole('button', { name: KEEP_OLD }))
    await screen.findByTestId('webhook-secret-reveal')
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} reconnectSignal={1} socketStatus="reconnecting" remoteChange={change(1, { status: 'active' })} />)
    m.list.mockResolvedValue([sub({ consecutive_failures: 1 })])
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} reconnectSignal={2} socketStatus="connected" remoteChange={change(1, { status: 'active' })} />)
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(within(screen.getByTestId('webhook-secret-reveal')).getByRole('textbox')).toHaveValue('whsec_keep')
  })

  it('the state slot is cleared, then rewritten, so an identical announcement is read again (#2403)', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} />)
    await screen.findByText('Webhooks')
    await openDetail(user)
    const slot = screen.getByTestId('webhook-state-live')
    const seen: string[] = []
    const observer = new MutationObserver(() => seen.push(slot.textContent ?? ''))
    observer.observe(slot, { childList: true, characterData: true, subtree: true })
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} remoteChange={change(1)} />)
    await act(async () => { vi.advanceTimersByTime(100) })
    expect(slot).toHaveTextContent('It is now turned off.')
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} remoteChange={change(2)} />)
    // Cleared at once; the same sentence lands only after the delay.
    expect(slot).toHaveTextContent('')
    await act(async () => { vi.advanceTimersByTime(100) })
    expect(slot).toHaveTextContent('It is now turned off.')
    await act(async () => { await Promise.resolve() })
    observer.disconnect()
    expect(seen.filter((t) => t === '')).toHaveLength(1)
  })

  it('opening the tab already paused: the state slot is mounted empty while loading, then holds the paused copy', async () => {
    let finish: (v: WebhookSubscription[]) => void = () => undefined
    m.list.mockReturnValue(new Promise<WebhookSubscription[]>((resolve) => { finish = resolve }))
    render(<BoardSettingsWebhooksTab boardId={3} socketStatus="failed" />)
    await screen.findByLabelText('Loading webhooks')
    const loadingSlot = screen.getByTestId('webhook-state-live')
    expect(loadingSlot).toHaveAttribute('role', 'status')
    await waitFor(() => expect(m.list).toHaveBeenCalled())
    await act(async () => { finish([sub()]) })
    await screen.findByText('Webhooks')
    await waitFor(() => expect(screen.getByTestId('webhook-state-live')).toHaveTextContent('Live updates paused.'))
  })

  it('Refresh had focus when the connection came back: focus moves to the heading, not <body>', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} socketStatus="reconnecting" />)
    await screen.findByText('Webhooks')
    const refresh = within(screen.getByTestId('webhooks-paused')).getByRole('button', { name: 'Refresh' })
    await user.click(refresh)
    act(() => { refresh.focus() })
    expect(refresh).toHaveFocus()
    rerender(<BoardSettingsWebhooksTab boardId={3} socketStatus="connected" />)
    expect(screen.queryByTestId('webhooks-paused')).not.toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
    expect(screen.getByRole('heading', { name: 'Webhooks' })).toHaveFocus()
  })

  it('each reconnect diff stands alone: an old away count does not return', async () => {
    m.list.mockResolvedValue([sub(), sub({ id: 2, url_display: 'b.example.com/…/x', url_host: 'b.example.com' })])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} reconnectSignal={1} socketStatus="connected" />)
    await screen.findByText('Webhooks')
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'manual' }), sub({ id: 2, enabled: false, disabled_reason: 'manual', url_display: 'b.example.com/…/x', url_host: 'b.example.com' })])
    rerender(<BoardSettingsWebhooksTab boardId={3} reconnectSignal={2} socketStatus="connected" />)
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(await screen.findByTestId('webhooks-away')).toHaveTextContent('2 webhooks changed')
    rerender(<BoardSettingsWebhooksTab boardId={3} reconnectSignal={2} socketStatus="reconnecting" />)
    // Same list on the next reconnect: nothing changed while away this time.
    rerender(<BoardSettingsWebhooksTab boardId={3} reconnectSignal={3} socketStatus="connected" />)
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(screen.queryByTestId('webhooks-away')).not.toBeInTheDocument()
  })

  it('a reconnect read that resolves after the connection dropped again cannot overwrite the paused copy', async () => {
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} reconnectSignal={1} socketStatus="connected" />)
    await screen.findByText('Webhooks')
    let finish: (v: WebhookSubscription[]) => void = () => undefined
    m.list.mockReturnValue(new Promise<WebhookSubscription[]>((resolve) => { finish = resolve }))
    rerender(<BoardSettingsWebhooksTab boardId={3} reconnectSignal={2} socketStatus="connected" />)
    await act(async () => { vi.advanceTimersByTime(400) })
    rerender(<BoardSettingsWebhooksTab boardId={3} reconnectSignal={2} socketStatus="reconnecting" />)
    await act(async () => { finish([sub({ enabled: false, disabled_reason: 'manual' })]) })
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(screen.getByTestId('webhook-state-live')).toHaveTextContent('Live updates paused.')
    expect(screen.queryByTestId('webhooks-away')).not.toBeInTheDocument()
  })

  it('this user\'s own change to the open webhook clears an earlier detail banner', async () => {
    const user = setup()
    m.list.mockResolvedValue([sub()])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} />)
    await screen.findByText('Webhooks')
    await openDetail(user)
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} remoteChange={change(1)} />)
    expect(await screen.findByTestId('webhook-changed-detail')).toHaveTextContent('It is now turned off.')
    rerender(<BoardSettingsWebhooksTab boardId={3} currentUserId={7} members={MEMBERS} remoteChange={change(2, { status: 'active', changed_by: 7 })} />)
    await waitFor(() => expect(screen.queryByTestId('webhook-changed-detail')).not.toBeInTheDocument())
  })

  it('a webhook that only keeps failing is not "changed while you were away"', async () => {
    m.list.mockResolvedValue([sub({ consecutive_failures: 3 })])
    const { rerender } = render(<BoardSettingsWebhooksTab boardId={3} reconnectSignal={1} />)
    await screen.findByText('Webhooks')
    m.list.mockResolvedValue([sub({ consecutive_failures: 7 })])
    rerender(<BoardSettingsWebhooksTab boardId={3} reconnectSignal={2} />)
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(m.list).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('webhooks-away')).not.toBeInTheDocument()
  })

})
