import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRef } from 'react'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EmailInviteForm from '../components/Common/EmailInviteForm'
import type { EmailInviteFormHandle } from '../components/Common/EmailInviteForm'
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

async function renderForm(surface: 'group' | 'site' | 'board' = 'group', extra: Partial<React.ComponentProps<typeof EmailInviteForm>> = {}) {
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

  it('429 rounds Retry-After up to whole minutes', async () => {
    send.mockRejectedValueOnce(httpError(429, {}, { 'retry-after': '61' }))
    await renderForm()
    await submit()
    expect(await screen.findByText("You've sent a lot of invites. Try again in 2 minutes.")).toBeInTheDocument()
  })

  it('429 without a Retry-After header falls back to "a few minutes"', async () => {
    send.mockRejectedValueOnce(httpError(429, {}))
    await renderForm()
    await submit()
    expect(await screen.findByText("You've sent a lot of invites. Try again in a few minutes.")).toBeInTheDocument()
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
    expect(await screen.findByText(/Email invites aren't available\./)).toHaveClass('text-fg-muted')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Settings → Email' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('site admins on a demo site see a neutral line with no Settings link', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, demo_mode: true, invite_email_available: false })
    render(<EmailInviteForm surface="site" send={send} onOpenEmailSettings={vi.fn()} />)
    expect(await screen.findByText('Email invites are disabled on this demo site.')).toHaveClass('text-fg-muted')
    expect(screen.queryByRole('button', { name: 'Settings → Email' })).not.toBeInTheDocument()
    expect(screen.queryByText(/set up/)).not.toBeInTheDocument()
  })

  it('renders nothing when site-config fails to load', async () => {
    mockGetSiteConfig.mockRejectedValue(new Error('network'))
    const { container } = render(<EmailInviteForm surface="site" send={send} />)
    await waitFor(() => expect(mockGetSiteConfig).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('group surface warns permanently on a closed site', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, registration_mode: 'closed', registration_open: false })
    await renderForm('group')
    expect(screen.getByText(/New users can't sign up on this site\. Only people who already have an account can join from this invite\./)).toHaveClass('text-warning')
  })

  it('site admin on an invite-only site sees the hint, not the warning (#1445)', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, registration_mode: 'invite_only', registration_open: false })
    await renderForm('group', { senderIsSiteAdmin: true })
    expect(screen.queryByText(/New users can't sign up/)).not.toBeInTheDocument()
    expect(screen.getByText('New people can join this site only from invites you email, not from a shareable link.')).toHaveClass('text-fg-muted')
  })

  it('non-site-admin on an invite-only site sees the sign-up warning (#1445)', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, registration_mode: 'invite_only', registration_open: false })
    await renderForm('group')
    expect(screen.getByText(/New users can't sign up on this site\./)).toHaveClass('text-warning')
    expect(screen.queryByText(/only from invites you email/)).not.toBeInTheDocument()
  })

  it('site admin on a closed site still sees the sign-up warning (#1445)', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, registration_mode: 'closed', registration_open: false })
    await renderForm('group', { senderIsSiteAdmin: true })
    expect(screen.getByText(/New users can't sign up on this site\./)).toHaveClass('text-warning')
    expect(screen.queryByText(/only from invites you email/)).not.toBeInTheDocument()
  })

  it('no sign-up warning on an open site, nor on the site surface', async () => {
    await renderForm('group')
    expect(screen.queryByText(/New users can't sign up/)).not.toBeInTheDocument()
    expect(screen.queryByText(/only from invites you email/)).not.toBeInTheDocument()
  })

  it('site surface never shows the sign-up warning', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, registration_mode: 'closed' })
    await renderForm('site')
    expect(screen.queryByText(/New users can't sign up/)).not.toBeInTheDocument()
  })
})

describe('EmailInviteForm — board surface (#1444)', () => {
  const BOARD_ROLES = [
    { value: 'member' as const, label: 'Member' },
    { value: 'collaborator' as const, label: 'Collaborator' },
    { value: 'viewer' as const, label: 'Viewer' },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSiteConfig.mockResolvedValue(baseConfig)
  })

  it('offers Member/Collaborator/Viewer only, defaulting to Member', async () => {
    const user = userEvent.setup()
    await renderForm('board', { roleOptions: BOARD_ROLES, showLinkDivider: false })
    await user.click(screen.getByText('Member'))
    expect(await screen.findByText('Viewer')).toBeInTheDocument()
    expect(screen.getByText('Collaborator')).toBeInTheDocument()
    expect(screen.queryByText('Admin')).not.toBeInTheDocument()
  })

  it('has an Expires picker defaulting to 7 days, reflected in the helper text', async () => {
    const user = userEvent.setup()
    await renderForm('board', { roleOptions: BOARD_ROLES, showLinkDivider: false })
    expect(screen.getByRole('status')).toHaveTextContent('Sends a single-use invite that expires in 7 days.')
    await user.click(screen.getByText('7 days'))
    await user.click(await screen.findByText('1 day'))
    expect(screen.getByRole('status')).toHaveTextContent('Sends a single-use invite that expires in 1 day.')
  })

  it('sends email, role and expiry_days', async () => {
    send.mockResolvedValue({ detail: 'Invite sent', sent_to: 'sam@example.com' })
    const user = userEvent.setup()
    await renderForm('board', { roleOptions: BOARD_ROLES, showLinkDivider: false })
    await user.click(screen.getByText('Member'))
    await user.click(await screen.findByText('Collaborator'))
    await user.click(screen.getByText('7 days'))
    await user.click(await screen.findByText('30 days'))
    await submit()
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ email: 'sam@example.com', role: 'collaborator', expiry_days: 30 }),
    )
    expect(await screen.findByText('Invite sent to sam@example.com.')).toHaveClass('text-success')
  })

  it('hides the shareable-link divider when showLinkDivider is false', async () => {
    await renderForm('board', { roleOptions: BOARD_ROLES, showLinkDivider: false })
    expect(screen.queryByText('or create a shareable link')).not.toBeInTheDocument()
  })

  it('still shows the divider on the group surface by default', async () => {
    await renderForm('group')
    expect(screen.getByText('or create a shareable link')).toBeInTheDocument()
  })

  it('warns on a closed site and for a non-site-admin on an invite-only site', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, registration_mode: 'closed' })
    await renderForm('board', { roleOptions: BOARD_ROLES })
    expect(
      screen.getByText("New users can't sign up on this site. Only people who already have an account can join from this invite."),
    ).toHaveClass('text-warning')
  })

  it('site admin on an invite-only site sees the muted note', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, registration_mode: 'invite_only' })
    await renderForm('board', { roleOptions: BOARD_ROLES, senderIsSiteAdmin: true })
    expect(screen.getByText(/only from invites you email/)).toHaveClass('text-fg-muted')
    expect(screen.queryByText(/New users can't sign up/)).not.toBeInTheDocument()
  })

  it('renders nothing and reports unavailable when email is unavailable', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, invite_email_available: false })
    const onAvailabilityChange = vi.fn()
    const { container } = render(
      <EmailInviteForm surface="board" send={send} onAvailabilityChange={onAvailabilityChange} />,
    )
    await waitFor(() => expect(onAvailabilityChange).toHaveBeenCalledWith(false))
    expect(container).toBeEmptyDOMElement()
  })

  it('reports availability once site-config resolves', async () => {
    const onAvailabilityChange = vi.fn()
    render(<EmailInviteForm surface="board" send={send} onAvailabilityChange={onAvailabilityChange} />)
    await waitFor(() => expect(onAvailabilityChange).toHaveBeenCalledWith(true))
    expect(onAvailabilityChange).toHaveBeenCalledTimes(1)
  })

  it('reports unavailable when site-config fails to load', async () => {
    mockGetSiteConfig.mockRejectedValue(new Error('boom'))
    const onAvailabilityChange = vi.fn()
    render(<EmailInviteForm surface="board" send={send} onAvailabilityChange={onAvailabilityChange} />)
    await waitFor(() => expect(onAvailabilityChange).toHaveBeenCalledWith(false))
  })

  it('prefill handle fills the address, scrolls into view and focuses Send invite', async () => {
    const ref = createRef<EmailInviteFormHandle>()
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(<EmailInviteForm ref={ref} surface="board" send={send} roleOptions={BOARD_ROLES} />)
    await screen.findByRole('textbox', { name: 'Email address' })
    act(() => ref.current!.prefill('new@example.com'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send invite' })).toHaveFocus())
    expect(screen.getByRole('textbox', { name: 'Email address' })).toHaveValue('new@example.com')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('Escape in an open picker closes only the picker', async () => {
    const user = userEvent.setup()
    const outer = vi.fn()
    await renderForm('board', { roleOptions: BOARD_ROLES })
    document.addEventListener('keydown', outer)
    await user.click(screen.getByText('7 days'))
    expect(await screen.findByText('30 days')).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('30 days')).not.toBeInTheDocument())
    document.removeEventListener('keydown', outer)
  })
})
