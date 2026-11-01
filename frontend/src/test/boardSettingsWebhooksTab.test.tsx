import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardSettingsWebhooksTab from '../components/Board/BoardSettingsWebhooksTab'
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

const STATUS: WebhookStatus = {
  enabled: true,
  dispatcher_last_run_at: minsAgo(1),
  dispatcher_stale: false,
  subscribable_event_types: ['board.updated', 'card.created', 'card.moved', 'column.created'],
}

function sub(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: 1,
    board: 3,
    name: 'Deploys',
    url_display: 'https://hooks.example.com/…',
    url_host: 'hooks.example.com',
    event_types: [],
    enabled: true,
    disabled_reason: null,
    disabled_at: null,
    last_delivered_event_id: 10,
    consecutive_failures: 0,
    failing_since: null,
    next_attempt_at: null,
    last_attempt_at: null,
    last_success_at: minsAgo(5),
    last_error_code: '',
    last_status_code: null,
    created_by: { id: 7, username: 'maya', display_name: 'Maya', avatar_url: '' },
    configured_by: { id: 7, username: 'maya', display_name: 'Maya', avatar_url: '' },
    created_at: minsAgo(60),
    updated_at: minsAgo(5),
    configured_at: minsAgo(60),
    secret_rotated_at: null,
    ...overrides,
  }
}

const axiosError = (status: number, code?: string) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status, data: code ? { code, detail: 'x' } : {} } })

async function renderTab(props: { focusFirstStopped?: boolean } = {}) {
  render(<BoardSettingsWebhooksTab boardId={3} {...props} />)
  await waitFor(() => expect(screen.queryByLabelText('Loading webhooks')).not.toBeInTheDocument())
}

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

describe('BoardSettingsWebhooksTab — load states', () => {
  it('shows a spinner, then the empty state with the dispatcher line', async () => {
    render(<BoardSettingsWebhooksTab boardId={3} />)
    expect(screen.getByRole('status', { name: 'Loading webhooks' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('No webhooks yet.')).toBeInTheDocument())
    expect(screen.getByText('Dispatcher last ran 1 m ago.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'How to verify signatures' })).toHaveAttribute('rel', 'noopener noreferrer')
    expect(m.status).toHaveBeenCalledWith(3)
    expect(m.list).toHaveBeenCalledWith(3)
  })

  it('feature off: callout only, the list is never fetched', async () => {
    m.status.mockResolvedValue({ ...STATUS, enabled: false })
    await renderTab()
    expect(screen.getByRole('note')).toHaveTextContent('Webhooks are turned off on this server')
    expect(screen.getByRole('link', { name: 'How to set up webhooks' })).toHaveAttribute('target', '_blank')
    expect(m.list).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'New webhook' })).not.toBeInTheDocument()
  })

  it('a 403 webhooks_disabled on load is the same callout', async () => {
    m.status.mockRejectedValue(axiosError(403, 'webhooks_disabled'))
    await renderTab()
    expect(screen.getByRole('note')).toHaveTextContent('WEBHOOKS_ENABLED')
  })

  it('a load failure offers Retry', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.status.mockRejectedValueOnce(axiosError(500))
    await renderTab()
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load webhooks.')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('No webhooks yet.')).toBeInTheDocument())
    expect(m.status).toHaveBeenCalledTimes(2)
  })

  it('stale dispatcher that never ran', async () => {
    m.status.mockResolvedValue({ ...STATUS, dispatcher_stale: true, dispatcher_last_run_at: null })
    await renderTab()
    expect(screen.getByRole('group', { name: /has never run on this server/ })).toBeInTheDocument()
    expect(screen.queryByText(/^Dispatcher last ran/)).not.toBeInTheDocument()
  })

  it('stale dispatcher that ran a while ago', async () => {
    m.status.mockResolvedValue({ ...STATUS, dispatcher_stale: true, dispatcher_last_run_at: minsAgo(120) })
    await renderTab()
    expect(screen.getByText(/last ran 2 h ago\. Events are queued but not being delivered/)).toBeInTheDocument()
  })
})

describe('BoardSettingsWebhooksTab — rows', () => {
  it('renders status pills, URL, summary and detail per state', async () => {
    m.list.mockResolvedValue([
      sub({ id: 1 }),
      sub({ id: 2, name: '', event_types: ['card.moved', 'card.created', 'column.created'], consecutive_failures: 3, last_error_code: 'http_error', last_status_code: 302, last_success_at: null }),
      sub({ id: 3, enabled: false, disabled_reason: 'manual', disabled_at: minsAgo(10), configured_by: null }),
      sub({ id: 4, enabled: false, disabled_reason: 'failures', disabled_at: minsAgo(10), last_error_code: 'timeout' }),
      sub({ id: 5, enabled: false, disabled_reason: 'secret_unavailable', disabled_at: minsAgo(10) }),
    ])
    await renderTab()
    const row = (id: number) => within(screen.getByTestId(`webhook-row-${id}`))
    expect(row(1).getByText('Active')).toBeInTheDocument()
    expect(row(1).getByText('https://hooks.example.com/…')).toBeInTheDocument()
    expect(row(1).getByText('All events · Last delivered 5 m ago · Set up by Maya')).toBeInTheDocument()

    expect(row(2).getByText('hooks.example.com')).toBeInTheDocument() // empty name falls back to host
    expect(row(2).getByText('Failing')).toBeInTheDocument()
    expect(row(2).getByText(/3 events: card\.moved, card\.created \+1 · Never delivered/)).toBeInTheDocument()
    expect(row(2).getByText(/3 deliveries in a row failed\. The receiver answered HTTP 302 \(redirects are not followed\)\./)).toBeInTheDocument()

    expect(row(3).getByText('Disabled')).toBeInTheDocument()
    expect(row(3).getByText(/Set up by a former member/)).toBeInTheDocument()
    expect(row(3).getByText('Turned off by a board admin 10 m ago.')).toBeInTheDocument()
    expect(row(3).getByRole('button', { name: /^Re-enable/ })).toBeInTheDocument()
    expect(row(3).queryByRole('button', { name: /^Disable/ })).not.toBeInTheDocument()

    expect(row(4).getByText('Stopped')).toBeInTheDocument()
    expect(row(4).getByText(/Last error: The receiver did not respond in time\./)).toBeInTheDocument()

    expect(row(5).getByText(/Delete it and create a new one\./)).toBeInTheDocument()
    expect(row(5).queryByRole('button', { name: /^Re-enable/ })).not.toBeInTheDocument()
    expect(row(5).queryByRole('button', { name: /^Rotate secret/ })).not.toBeInTheDocument()
    expect(row(5).getByRole('button', { name: 'Delete Deploys' })).toBeInTheDocument()

    // Action order for an enabled row.
    const labels = row(1).getAllByRole('button').map((b) => b.textContent)
    expect(labels).toEqual(['Send test', 'Edit', 'Disable', 'Rotate secret', 'Delete'])
  })
})

describe('BoardSettingsWebhooksTab — create', () => {
  it('creates, reveals URL and secret once, guards Escape, then forgets them', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    m.create.mockResolvedValue({ ...sub({ id: 9, name: 'Zap' }), url: 'https://hooks.example.com/secret/path', secret: 'whsec_abc' })
    await renderTab()

    await user.click(screen.getByRole('button', { name: 'New webhook' }))
    expect(screen.getByLabelText('Name (optional)')).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'New webhook' })).not.toBeInTheDocument()
    const createBtn = screen.getByRole('button', { name: 'Create webhook' })
    expect(createBtn).toBeDisabled()

    await user.type(screen.getByLabelText('Name (optional)'), 'Zap')
    await user.type(screen.getByLabelText('Payload URL'), 'https://hooks.example.com/secret/path')
    await user.click(screen.getByLabelText('Only selected events'))
    await user.click(screen.getByRole('button', { name: 'Create webhook' }))
    expect(screen.getByText('Choose at least one event, or pick All events.')).toBeInTheDocument()
    expect(m.create).not.toHaveBeenCalled()

    await user.click(screen.getByRole('checkbox', { name: 'card.moved' }))
    expect(screen.getByRole('group', { name: 'Cards' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create webhook' }))
    expect(m.create).toHaveBeenCalledWith(3, { name: 'Zap', url: 'https://hooks.example.com/secret/path', event_types: ['card.moved'] })

    const reveal = await screen.findByTestId('webhook-secret-reveal')
    expect(within(reveal).getByText('whsec_abc')).toBeInTheDocument()
    expect(within(reveal).getByText('https://hooks.example.com/secret/path')).toBeInTheDocument()
    expect(within(reveal).getByRole('button', { name: 'Copy secret' })).toHaveFocus()
    await user.click(within(reveal).getByRole('button', { name: 'Copy secret' }))
    expect(writeText).toHaveBeenCalledWith('whsec_abc')
    await user.click(within(reveal).getByRole('button', { name: 'Copy URL' }))
    expect(writeText).toHaveBeenCalledWith('https://hooks.example.com/secret/path')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(await within(reveal).findByText('Copy the secret, then choose Done.')).toBeInTheDocument()
    expect(screen.getByTestId('webhook-secret-reveal')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Done, hide the webhook secret' }))
    expect(screen.queryByText('whsec_abc')).not.toBeInTheDocument()
    expect(screen.queryByText('https://hooks.example.com/secret/path')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send test to Zap' })).toHaveFocus())
  })

  it.each([
    ['url_not_allowed', 400, /WEBHOOK_ALLOWED_PRIVATE_TARGETS/, 'url'],
    ['invalid_url', 400, /Enter a full https:\/\/ URL/, 'url'],
    ['limit_reached', 400, /reached a webhook limit/, 'form'],
    ['session_required', 403, /signed-in browser session/, 'form'],
    [undefined, 429, /Too many webhook changes/, 'form'],
    [undefined, 500, /Couldn't save the webhook/, 'form'],
  ])('maps %s (%i) to its slot', async (code, httpStatus, text, slot) => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.create.mockRejectedValue(axiosError(httpStatus, code))
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'New webhook' }))
    await user.type(screen.getByLabelText('Payload URL'), 'https://x.example/')
    await user.click(screen.getByRole('button', { name: 'Create webhook' }))
    const msg = await screen.findByText(text)
    const urlInput = screen.getByLabelText('Payload URL')
    if (slot === 'url') {
      expect(urlInput).toHaveAttribute('aria-invalid', 'true')
      expect(urlInput).toHaveFocus()
      expect(urlInput.getAttribute('aria-describedby')).toBe(msg.id)
    } else {
      expect(urlInput).not.toHaveAttribute('aria-invalid')
    }
  })

  it('an event-type error lands on the events fieldset', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.create.mockRejectedValue(axiosError(400, 'invalid_event_types'))
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'New webhook' }))
    await user.type(screen.getByLabelText('Payload URL'), 'https://x.example/')
    await user.click(screen.getByRole('button', { name: 'Create webhook' }))
    expect(await screen.findByText(/Close and reopen this tab/)).toBeInTheDocument()
  })

  it('Escape cancels the form and returns focus to New webhook', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'New webhook' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByLabelText('Payload URL')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: 'New webhook' })).toHaveFocus())
  })

  it('Cancel closes the form', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'New webhook' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Payload URL')).not.toBeInTheDocument()
  })

  it('a webhooks_disabled answer swaps the whole tab to the callout', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.create.mockRejectedValue(axiosError(403, 'webhooks_disabled'))
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'New webhook' }))
    await user.type(screen.getByLabelText('Payload URL'), 'https://x.example/')
    await user.click(screen.getByRole('button', { name: 'Create webhook' }))
    expect(await screen.findByRole('note')).toHaveTextContent('turned off on this server')
  })
})

describe('BoardSettingsWebhooksTab — row actions', () => {
  it('edit sends only changed keys and reports success', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.list.mockResolvedValue([sub({ event_types: ['card.moved'] })])
    m.update.mockResolvedValue(sub({ name: 'Renamed', event_types: ['card.moved'] }))
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Edit Deploys' }))
    expect(screen.getByLabelText('Payload URL')).toHaveAttribute('placeholder', 'Leave blank to keep https://hooks.example.com/…')
    expect(screen.getByText(/Changing the URL makes you this webhook's owner/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'card.moved' })).toBeChecked()
    const name = screen.getByLabelText('Name (optional)')
    await user.clear(name)
    await user.type(name, 'Renamed')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(m.update).toHaveBeenCalledWith(3, 1, { name: 'Renamed' })
    expect(await screen.findByText('Webhook updated.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit Renamed' })).toHaveFocus())
  })

  it('edit with nothing changed just closes', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.list.mockResolvedValue([sub()])
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Edit Deploys' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(m.update).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Payload URL')).not.toBeInTheDocument()
  })

  it('edit can change the URL and switch to all events', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.list.mockResolvedValue([sub({ event_types: ['card.moved'] })])
    m.update.mockResolvedValue(sub())
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Edit Deploys' }))
    await user.type(screen.getByLabelText('Payload URL'), 'https://new.example/h')
    await user.click(screen.getByLabelText(/All events/))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(m.update).toHaveBeenCalledWith(3, 1, { url: 'https://new.example/h', event_types: [] })
  })

  it('send test: success, failure with remedy, and throttled', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.list.mockResolvedValue([sub()])
    m.test
      .mockResolvedValueOnce({ ok: true, code: null, status_code: 204 })
      .mockResolvedValueOnce({ ok: false, code: 'connection_failed', status_code: null })
      .mockRejectedValueOnce(axiosError(429))
    await renderTab()
    const btn = () => screen.getByRole('button', { name: 'Send test to Deploys' })
    await user.click(btn())
    expect(await screen.findByText('Test event delivered (HTTP 204).')).toHaveClass('text-success')
    await user.click(btn())
    expect(await screen.findByText('Could not connect to the receiver.')).toHaveClass('text-danger')
    expect(screen.getByText(/returns a 2xx/)).toBeInTheDocument()
    await user.click(btn())
    expect(await screen.findByText('Too many tests. Try again later.')).toHaveClass('text-warning')
  })

  it('disable updates the row without a confirm', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.list.mockResolvedValue([sub()])
    m.disable.mockResolvedValue(sub({ enabled: false, disabled_reason: 'manual', disabled_at: minsAgo(0) }))
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Disable Deploys' }))
    expect(await screen.findByText('Webhook disabled.')).toBeInTheDocument()
    expect(screen.getByText('Disabled')).toBeInTheDocument()
  })

  it('a failed disable says so on the row', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.list.mockResolvedValue([sub()])
    m.disable.mockRejectedValue(axiosError(500))
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Disable Deploys' }))
    expect(await screen.findByText("Couldn't disable the webhook. Try again.")).toBeInTheDocument()
  })

  it('re-enable: choose where to resume', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'failures', disabled_at: minsAgo(3) })])
    m.reenable.mockResolvedValue(sub())
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Re-enable Deploys' }))
    expect(screen.getByRole('radio', { name: 'Send the events it missed' })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: 'Skip to new events only' }))
    await user.click(within(screen.getByRole('group', { name: 'Re-enable Deploys' })).getByRole('button', { name: 'Re-enable Deploys' }))
    expect(m.reenable).toHaveBeenCalledWith(3, 1, 'latest')
    expect(await screen.findByText('Webhook re-enabled.')).toBeInTheDocument()
  })

  it('re-enable: a 409 cursor_expired swaps to new-events-only', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'manual', disabled_at: minsAgo(3) })])
    m.reenable.mockRejectedValueOnce(axiosError(409, 'cursor_expired')).mockResolvedValueOnce(sub())
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Re-enable Deploys' }))
    await user.click(within(screen.getByRole('group', { name: 'Re-enable Deploys' })).getByRole('button', { name: 'Re-enable Deploys' }))
    expect(m.reenable).toHaveBeenLastCalledWith(3, 1, 'cursor')
    const expiredBtn = await screen.findByRole('button', { name: 'Re-enable Deploys with new events only' })
    expect(screen.getByText('The events it missed are gone, so it resumes with new events only.')).toBeInTheDocument()
    await user.click(expiredBtn)
    expect(m.reenable).toHaveBeenLastCalledWith(3, 1, 'latest')
  })

  it('re-enable on a cursor_expired row offers no choice', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'cursor_expired', disabled_at: minsAgo(3) })])
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Re-enable Deploys' }))
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Re-enable Deploys with new events only' })).toBeInTheDocument()
  })

  it('re-enable errors stay inside the prompt; Escape closes it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.list.mockResolvedValue([sub({ enabled: false, disabled_reason: 'manual', disabled_at: minsAgo(3) })])
    m.reenable.mockRejectedValue(axiosError(403, 'session_required'))
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Re-enable Deploys' }))
    await user.click(within(screen.getByRole('group', { name: 'Re-enable Deploys' })).getByRole('button', { name: 'Re-enable Deploys' }))
    expect(await screen.findByText(/signed-in browser session/)).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Re-enable Deploys' })).not.toBeInTheDocument())
  })

  it('rotate: confirm, then reveal the new secret only', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.list.mockResolvedValue([sub()])
    m.rotate.mockResolvedValue({ ...sub({ secret_rotated_at: minsAgo(0) }), secret: 'whsec_new' })
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Rotate secret for Deploys' }))
    expect(screen.getByText(/The current secret stops working immediately/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm: rotate secret for Deploys' }))
    const reveal = await screen.findByTestId('webhook-secret-reveal')
    expect(within(reveal).getByText('whsec_new')).toBeInTheDocument()
    expect(within(reveal).getByText(/The old secret has already stopped working/)).toBeInTheDocument()
    expect(within(reveal).queryByText('Payload URL')).not.toBeInTheDocument()
    await user.click(within(reveal).getByRole('button', { name: 'Done, hide the webhook secret' }))
    expect(screen.queryByText('whsec_new')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rotate secret for Deploys' })).toHaveFocus())
  })

  it('rotate failure stays inside the confirm', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.list.mockResolvedValue([sub()])
    m.rotate.mockRejectedValue(axiosError(500))
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Rotate secret for Deploys' }))
    await user.click(screen.getByRole('button', { name: 'Confirm: rotate secret for Deploys' }))
    expect(await screen.findByText("Couldn't rotate the secret. Try again.")).toBeInTheDocument()
  })

  it('delete: confirm removes the row and focuses the heading; Cancel and Escape return focus', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.list.mockResolvedValue([sub()])
    m.del.mockResolvedValue({})
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Delete Deploys' }))
    expect(screen.getByText(/Delete Deploys\? Visiban stops sending events to this URL/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel deleting Deploys' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete Deploys' })).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Delete Deploys' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm: delete Deploys' })).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Delete Deploys' }))
    await user.click(screen.getByRole('button', { name: 'Confirm: delete Deploys' }))
    expect(m.del).toHaveBeenCalledWith(3, 1)
    expect(await screen.findByText('Webhook deleted.')).toBeInTheDocument()
    expect(screen.queryByTestId('webhook-row-1')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Webhooks' })).toHaveFocus())
  })

  it('delete failure stays inside the confirm', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    m.list.mockResolvedValue([sub()])
    m.del.mockRejectedValue(axiosError(500))
    await renderTab()
    await user.click(screen.getByRole('button', { name: 'Delete Deploys' }))
    await user.click(screen.getByRole('button', { name: 'Confirm: delete Deploys' }))
    expect(await screen.findByText("Couldn't delete the webhook. Try again.")).toBeInTheDocument()
  })
})

describe('BoardSettingsWebhooksTab — deep link', () => {
  it('focuses and highlights the first Stopped row, then clears the highlight', async () => {
    m.list.mockResolvedValue([
      sub({ id: 1 }),
      sub({ id: 2, name: 'Broken', enabled: false, disabled_reason: 'failures', disabled_at: minsAgo(1) }),
    ])
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    await renderTab({ focusFirstStopped: true })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Re-enable Broken' })).toHaveFocus())
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(screen.getByTestId('webhook-row-2')).toHaveClass('ring-2')
    await act(async () => { vi.advanceTimersByTime(1600) })
    expect(screen.getByTestId('webhook-row-2')).not.toHaveClass('ring-2')
  })

  it('focuses the heading when nothing is stopped', async () => {
    m.list.mockResolvedValue([sub({ id: 1 })])
    await renderTab({ focusFirstStopped: true })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Webhooks' })).toHaveFocus())
  })
})
