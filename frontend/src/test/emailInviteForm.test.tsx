import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EmailInviteForm from '../components/Common/EmailInviteForm'
import type { SiteConfig } from '../types'

vi.mock('../api/auth', () => ({ getSiteConfig: vi.fn() }))
import { getSiteConfig } from '../api/auth'
const mockGetSiteConfig = getSiteConfig as ReturnType<typeof vi.fn>

const baseConfig: SiteConfig = {
  registration_open: true,
  registration_mode: 'open',
  demo_mode: false,
  demo_login: null,
  invite_email_available: true,
}

const HELPER = 'Sends a single-use link that expires in 7 days.'
const send = vi.fn()

function httpError(status: number, data: object = {}, headers: Record<string, string> = {}) {
  return { response: { status, data, headers } }
}

async function renderForm(surface: 'group' | 'site' = 'group', extra: Partial<React.ComponentProps<typeof EmailInviteForm>> = {}) {
  render(<EmailInviteForm surface={surface} send={send} {...extra} />)
  return screen.findByRole('textbox', { name: 'Email address' })
}

async function submit(address = 'sam@example.com') {
  const user = userEvent.setup()
  const input = screen.getByRole('textbox', { name: 'Email address' })
  await user.type(input, address)
  await user.click(screen.getByRole('button', { name: 'Send invite' }))
}

describe('EmailInviteForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSiteConfig.mockResolvedValue(baseConfig)
  })
  afterEach(() => { vi.useRealTimers() })

  it('idle: heading, input attributes, helper text in the status slot', async () => {
    const input = await renderForm()
    expect(screen.getByText('Invite by email')).toBeInTheDocument()
    expect(input).toHaveAttribute('type', 'email')
    expect(input).toHaveAttribute('autocomplete', 'off')
    expect(input).toHaveAttribute('placeholder', 'name@example.com')
    const slot = screen.getByRole('status')
    expect(slot).toHaveTextContent(HELPER)
    expect(slot).toHaveAttribute('aria-live', 'polite')
    expect(slot).toHaveAttribute('aria-atomic', 'true')
    expect(input.getAttribute('aria-describedby')).toBe(slot.id)
  })

  it('Send is disabled until the address is valid', async () => {
    const user = userEvent.setup()
    const input = await renderForm()
    const btn = screen.getByRole('button', { name: 'Send invite' })
    expect(btn).toBeDisabled()
    await user.type(input, 'not-an-address')
    expect(btn).toBeDisabled()
    await user.clear(input)
    await user.type(input, 'sam@example.com')
    expect(btn).toBeEnabled()
  })

  it('group surface shows the role picker defaulting to Member', async () => {
    await renderForm('group')
    expect(screen.getByText('Member')).toBeInTheDocument()
  })

  it('site surface has no role picker and sends only the email', async () => {
    send.mockResolvedValue({ detail: 'Invite sent', sent_to: 'sam@example.com' })
    await renderForm('site')
    expect(screen.queryByText('Member')).not.toBeInTheDocument()
    await submit()
    await waitFor(() => expect(send).toHaveBeenCalledWith({ email: 'sam@example.com' }))
  })

  it('group surface sends the selected role', async () => {
    send.mockResolvedValue({ detail: 'Invite sent', sent_to: 'sam@example.com' })
    const user = userEvent.setup()
    await renderForm('group')
    await user.click(screen.getByText('Member'))
    await user.click(await screen.findByText('Viewer'))
    await submit()
    await waitFor(() => expect(send).toHaveBeenCalledWith({ email: 'sam@example.com', role: 'viewer' }))
  })

  it('Enter submits', async () => {
    send.mockResolvedValue({ detail: 'Invite sent', sent_to: 'sam@example.com' })
    const user = userEvent.setup()
    const input = await renderForm()
    await user.type(input, 'sam@example.com{Enter}')
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  })

  it('sending: button reads Sending… and input and button are disabled', async () => {
    let resolve!: (v: unknown) => void
    send.mockReturnValue(new Promise((r) => { resolve = r }))
    const input = await renderForm()
    await submit()
    const btn = screen.getByRole('button', { name: 'Sending…' })
    expect(btn).toBeDisabled()
    expect(input).toBeDisabled()
    await act(async () => { resolve({ detail: 'Invite sent', sent_to: 'sam@example.com' }) })
  })

  it('sent: success line, input cleared and focused, message clears after 5s, onSent called', async () => {
    send.mockResolvedValue({ detail: 'Invite sent', sent_to: 'sam@example.com' })
    const onSent = vi.fn()
    const input = await renderForm('group', { onSent })
    await submit()
    const msg = await screen.findByText('Invite sent to sam@example.com.')
    expect(msg).toHaveClass('text-success')
    expect(input).toHaveValue('')
    await waitFor(() => expect(input).toHaveFocus())
    expect(onSent).toHaveBeenCalledTimes(1)
    await waitFor(
      () => expect(screen.queryByText('Invite sent to sam@example.com.')).not.toBeInTheDocument(),
      { timeout: 6000 },
    )
    expect(screen.getByRole('status')).toHaveTextContent(HELPER)
  }, 10000)

  it('sent with delivery=console adds the development warning', async () => {
    send.mockResolvedValue({ detail: 'Invite sent', sent_to: 'sam@example.com', delivery: 'console' })
    await renderForm()
    await submit()
    const warn = await screen.findByText('Email is printed to the server console in development.')
    expect(warn).toHaveClass('text-warning')
  })

  it('400 shows the invalid-address message', async () => {
    send.mockRejectedValue(httpError(400, { email: ['Enter a valid email address.'] }))
    await renderForm()
    await submit()
    const msg = await screen.findByText('Enter a valid email address.')
    expect(msg).toHaveClass('text-danger')
  })

  it('400 invite_email_cap_reached shows the cap message', async () => {
    send.mockRejectedValue(httpError(400, { code: 'invite_email_cap_reached', detail: 'Maximum of 50 pending emailed invites per group.' }))
    await renderForm()
    await submit()
    expect(await screen.findByText('Maximum of 50 pending emailed invites per group.')).toHaveClass('text-danger')
    expect(screen.queryByText('Enter a valid email address.')).not.toBeInTheDocument()
  })

  it('502 shows the generic message, and the mail-server hint for relay codes', async () => {
    send.mockRejectedValue(httpError(502, { code: 'auth_failed' }))
    await renderForm()
    await submit()
    expect(await screen.findByText('Could not send — check the address and try again.')).toHaveClass('text-danger')
    expect(screen.getByText(/The mail server rejected the message\. A site admin can check Admin → Settings → Email\./)).toHaveClass('text-fg-muted')
  })

  it.each(['config_unusable', 'connection_refused'])('502 %s also shows the mail-server hint', async (code) => {
    send.mockRejectedValue(httpError(502, { code }))
    await renderForm()
    await submit()
    expect(await screen.findByText(/The mail server rejected the message/)).toBeInTheDocument()
  })

  it('502 with an unknown code gets only the generic message', async () => {
    send.mockRejectedValue(httpError(502, { code: 'recipient_refused' }))
    await renderForm()
    await submit()
    expect(await screen.findByText('Could not send — check the address and try again.')).toBeInTheDocument()
    expect(screen.queryByText(/mail server rejected/)).not.toBeInTheDocument()
  })

  it('429 turns Retry-After seconds into minutes', async () => {
    send.mockRejectedValue(httpError(429, {}, { 'retry-after': '600' }))
    await renderForm()
    await submit()
    const msg = await screen.findByText("You've sent a lot of invites. Try again in 10 minutes.")
    expect(msg).toHaveClass('text-warning')
  })

  it('429 rounds up and handles a missing header', async () => {
    send.mockRejectedValueOnce(httpError(429, {}, { 'retry-after': '61' }))
    await renderForm()
    await submit()
    expect(await screen.findByText("You've sent a lot of invites. Try again in 2 minutes.")).toBeInTheDocument()
  })

  it('a failed send keeps the address so the user can retry', async () => {
    send.mockRejectedValue(httpError(502, {}))
    const input = await renderForm()
    await submit()
    await screen.findByText('Could not send — check the address and try again.')
    expect(input).toHaveValue('sam@example.com')
    expect(input).toBeEnabled()
  })

  it('group admins see nothing when email is unavailable', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, invite_email_available: false })
    const { container } = render(<EmailInviteForm surface="group" send={send} />)
    await waitFor(() => expect(mockGetSiteConfig).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('site admins see the muted setup line with a Settings → Email link', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, invite_email_available: false })
    const onOpen = vi.fn()
    render(<EmailInviteForm surface="site" send={send} onOpenEmailSettings={onOpen} />)
    expect(await screen.findByText(/Email isn't set up, so invites can't be sent\./)).toHaveClass('text-fg-muted')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Settings → Email' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when site-config fails to load', async () => {
    mockGetSiteConfig.mockRejectedValue(new Error('network'))
    const { container } = render(<EmailInviteForm surface="site" send={send} />)
    await waitFor(() => expect(mockGetSiteConfig).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it.each(['invite_only', 'closed'] as const)('group surface warns permanently on a %s site', async (mode) => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, registration_mode: mode, registration_open: false })
    await renderForm('group')
    expect(screen.getByText(/New users can't sign up on this site\. Only people who already have an account can join from this invite\./)).toHaveClass('text-warning')
  })

  it('no sign-up warning on an open site, nor on the site surface', async () => {
    await renderForm('group')
    expect(screen.queryByText(/New users can't sign up/)).not.toBeInTheDocument()
  })

  it('site surface never shows the sign-up warning', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, registration_mode: 'closed' })
    await renderForm('site')
    expect(screen.queryByText(/New users can't sign up/)).not.toBeInTheDocument()
  })
})
