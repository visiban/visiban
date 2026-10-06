import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import InviteLinkPanel from '../components/Group/InviteLinkPanel'
import type { BoardInviteLink, GroupInviteLink } from '../types'

// #1444 — the generalized InviteLinkPanel on a board (embedded in Board
// Settings → Members), plus the #1421 revoke fixes that apply to groups too.

vi.mock('../api/groups', () => ({
  listInviteLinks: vi.fn(),
  createInviteLink: vi.fn(),
  revokeInviteLink: vi.fn(),
  sendInviteLinkEmail: vi.fn(),
}))
vi.mock('../api/boards', () => ({
  listBoardInviteLinks: vi.fn(),
  revokeBoardInviteLink: vi.fn(),
  sendBoardInviteEmail: vi.fn(),
}))
vi.mock('../api/auth', () => ({ getSiteConfig: vi.fn() }))

import { listInviteLinks, revokeInviteLink } from '../api/groups'
import { listBoardInviteLinks, revokeBoardInviteLink, sendBoardInviteEmail } from '../api/boards'
import { getSiteConfig } from '../api/auth'

const mockList = listBoardInviteLinks as ReturnType<typeof vi.fn>
const mockRevoke = revokeBoardInviteLink as ReturnType<typeof vi.fn>
const mockSend = sendBoardInviteEmail as ReturnType<typeof vi.fn>
const mockGroupList = listInviteLinks as ReturnType<typeof vi.fn>
const mockGroupRevoke = revokeInviteLink as ReturnType<typeof vi.fn>
const mockGetSiteConfig = getSiteConfig as ReturnType<typeof vi.fn>

const siteConfig = {
  registration_open: true,
  registration_mode: 'open',
  demo_mode: false,
  demo_login: null,
  invite_email_available: true,
}

function invite(overrides: Partial<BoardInviteLink> = {}): BoardInviteLink {
  return {
    id: 1,
    prefix: 'vbnb_ab1',
    name: '',
    role: 'member',
    delivery: 'email',
    created_at: '2026-10-01T12:00:00Z',
    created_by_username: 'alice',
    expires_at: '2026-10-08T12:00:00Z',
    is_expired: false,
    single_use: true,
    used_at: null,
    status: 'pending',
    can_register: true,
    ...overrides,
  }
}

function renderBoard(extra: Partial<React.ComponentProps<typeof InviteLinkPanel>> = {}) {
  return render(
    <InviteLinkPanel
      scope={{ kind: 'board', id: 9 }}
      variant="embedded"
      allowShareableLinks={false}
      escapePriority={49}
      {...extra}
    />,
  )
}

describe('InviteLinkPanel — board scope (#1444)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockList.mockResolvedValue([])
    mockGetSiteConfig.mockResolvedValue(siteConfig)
  })

  it('embedded: no card chrome, no "Invite links" heading, no New link, no divider', async () => {
    const { container } = renderBoard()
    expect(await screen.findByText('Pending invites')).toBeInTheDocument()
    expect(screen.queryByText('Invite links')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New link' })).not.toBeInTheDocument()
    expect(container.firstElementChild).not.toHaveClass('border')
    await screen.findByText('Invite by email')
    expect(screen.queryByText('or create a shareable link')).not.toBeInTheDocument()
    expect(mockList).toHaveBeenCalledWith(9)
  })

  it('shows the honesty line and the empty state', async () => {
    renderBoard()
    expect(await screen.findByText('No pending invites.')).toBeInTheDocument()
    expect(
      screen.getByText("Visiban doesn't keep the email address an invite was sent to. Tell invites apart by when they were sent."),
    ).toBeInTheDocument()
  })

  it('shows a spinner while loading', () => {
    mockList.mockReturnValue(new Promise(() => {}))
    const { container } = renderBoard()
    expect(container.querySelector('.animate-spin')).toBeInTheDocument()
  })

  it('load failure shows the error and Try again refetches', async () => {
    mockList.mockRejectedValueOnce(new Error('boom'))
    renderBoard()
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load invites.')
    mockList.mockResolvedValueOnce([invite()])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Emailed invite')).toBeInTheDocument()
  })

  it('lists pending invites newest first with role, expiry and the meta line', async () => {
    mockList.mockResolvedValue([
      invite({ id: 1, prefix: 'vbnb_old', created_at: '2026-09-01T12:00:00Z', role: 'viewer' }),
      invite({ id: 2, prefix: 'vbnb_new', created_at: '2026-10-02T12:00:00Z', created_by_username: null }),
    ])
    renderBoard()
    await screen.findAllByText('Emailed invite')
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('vbnb_new')
    expect(rows[1]).toHaveTextContent('vbnb_old')
    expect(within(rows[1]).getByText('Viewer')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Sent Sep 1 by alice')).toBeInTheDocument()
    // A deleted sender drops "by …".
    expect(within(rows[0]).getByText('Sent Oct 2')).toBeInTheDocument()
    expect(within(rows[0]).queryByText('Pending')).not.toBeInTheDocument()
  })

  it('labels a shareable link by name and says "Created"', async () => {
    mockList.mockResolvedValue([invite({ delivery: 'link', name: '', single_use: false })])
    renderBoard()
    expect(await screen.findByText('Invite link')).toBeInTheDocument()
    expect(screen.getByText('Created Oct 1 by alice')).toBeInTheDocument()
  })

  it('pill "Existing accounts only" only on pending invites that cannot register', async () => {
    mockList.mockResolvedValue([
      invite({ id: 1, can_register: false }),
      invite({ id: 2, prefix: 'vbnb_ok1', can_register: true }),
    ])
    renderBoard()
    const pill = await screen.findByText('Existing accounts only')
    expect(pill).toHaveAttribute('title', "New people can't create an account from this invite on this site.")
    expect(screen.getAllByText('Existing accounts only')).toHaveLength(1)
  })

  it('past invites sit behind a collapsed toggle', async () => {
    mockList.mockResolvedValue([
      invite({ id: 1 }),
      invite({ id: 2, prefix: 'vbnb_usd', status: 'used', used_at: '2026-10-03T00:00:00Z', can_register: false }),
      invite({ id: 3, prefix: 'vbnb_rev', status: 'revoked' }),
    ])
    const user = userEvent.setup()
    renderBoard()
    const toggle = await screen.findByRole('button', { name: 'Show past invites (2)' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('vbnb_usd…')).not.toBeInTheDocument()
    await user.click(toggle)
    expect(screen.getByRole('button', { name: 'Hide past invites' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('vbnb_usd…')).toBeInTheDocument()
    expect(screen.getByText('Used')).toBeInTheDocument()
    expect(screen.getByText('Revoked')).toBeInTheDocument()
    // Terminal rows: no Revoke, no "Existing accounts only" pill.
    expect(screen.getAllByRole('button', { name: /^Revoke invite/ })).toHaveLength(1)
    expect(screen.queryByText('Existing accounts only')).not.toBeInTheDocument()
  })

  it('no toggle when there are no past invites; toggle still shows with no pending', async () => {
    mockList.mockResolvedValue([invite({ status: 'expired', is_expired: true })])
    renderBoard()
    expect(await screen.findByText('No pending invites.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show past invites (1)' })).toBeInTheDocument()
  })

  it('revoke: emailed prompt, Confirm revokes and the row moves to past', async () => {
    mockList.mockResolvedValue([invite()])
    mockRevoke.mockResolvedValue({})
    const user = userEvent.setup()
    renderBoard()
    await user.click(await screen.findByRole('button', { name: 'Revoke invite vbnb_ab1' }))
    const prompt = screen.getByText('Revoke this invite? The person it was emailed to will no longer be able to join.')
    expect(prompt.parentElement).toHaveAttribute('role', 'status')
    expect(prompt.parentElement).toHaveAttribute('aria-live', 'polite')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(mockRevoke).toHaveBeenCalledWith(9, 1)
    expect(await screen.findByRole('button', { name: 'Show past invites (1)' })).toBeInTheDocument()
  })

  it('revoke in flight disables both buttons and ignores a second click', async () => {
    mockList.mockResolvedValue([invite()])
    let resolve!: () => void
    mockRevoke.mockReturnValue(new Promise<void>((r) => { resolve = r }))
    const user = userEvent.setup()
    renderBoard()
    await user.click(await screen.findByRole('button', { name: 'Revoke invite vbnb_ab1' }))
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    await user.click(confirm)
    expect(confirm).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    fireEvent.click(confirm)
    expect(mockRevoke).toHaveBeenCalledTimes(1)
    resolve()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument())
  })

  it('revoke 400 says the invite was already used and refetches', async () => {
    mockList.mockResolvedValueOnce([invite()])
    mockList.mockResolvedValueOnce([invite({ status: 'used', used_at: '2026-10-03T00:00:00Z' })])
    mockRevoke.mockRejectedValue({ response: { status: 400 } })
    const user = userEvent.setup()
    renderBoard()
    await user.click(await screen.findByRole('button', { name: 'Revoke invite vbnb_ab1' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    const msg = await screen.findByText("This invite was already used, so it can't be revoked.")
    expect(msg).toHaveClass('text-xs', 'text-danger', 'mt-1')
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Used')).toBeInTheDocument()
  })

  it('other revoke failures keep the prompt with buttons re-enabled', async () => {
    mockList.mockResolvedValue([invite()])
    mockRevoke.mockRejectedValue({ response: { status: 500 } })
    const user = userEvent.setup()
    renderBoard()
    await user.click(await screen.findByRole('button', { name: 'Revoke invite vbnb_ab1' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('Could not revoke invite.')).toHaveClass('text-danger')
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('Escape at priority 49 cancels the prompt before a modal at 40 closes', async () => {
    mockList.mockResolvedValue([invite()])
    const modalClose = vi.fn()
    const { useEscapeStack } = await import('../hooks/useEscapeStack')
    function Modal() {
      useEscapeStack(() => { modalClose() }, 40)
      return <InviteLinkPanel scope={{ kind: 'board', id: 9 }} variant="embedded" allowShareableLinks={false} escapePriority={49} />
    }
    const user = userEvent.setup()
    render(<Modal />)
    await user.click(await screen.findByRole('button', { name: 'Revoke invite vbnb_ab1' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    expect(modalClose).not.toHaveBeenCalled()
    expect(mockRevoke).not.toHaveBeenCalled()
  })

  it('refetches when reloadSignal changes', async () => {
    const { rerender } = renderBoard({ reloadSignal: 0 })
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1))
    rerender(<InviteLinkPanel scope={{ kind: 'board', id: 9 }} variant="embedded" allowShareableLinks={false} reloadSignal={1} />)
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
  })

  it('sends through the board API and refetches after a send', async () => {
    mockSend.mockResolvedValue({ detail: 'Invite sent', sent_to: 'sam@example.com' })
    const user = userEvent.setup()
    renderBoard()
    const input = await screen.findByRole('textbox', { name: 'Email address' })
    await user.type(input, 'sam@example.com')
    await user.click(screen.getByRole('button', { name: 'Send invite' }))
    await waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith(9, { email: 'sam@example.com', role: 'member', expiry_days: 7 }),
    )
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
  })

  it('forwards email availability to the host', async () => {
    const onEmailAvailabilityChange = vi.fn()
    renderBoard({ onEmailAvailabilityChange })
    await waitFor(() => expect(onEmailAvailabilityChange).toHaveBeenCalledWith(true))
  })
})

describe('InviteLinkPanel — group revoke fixes (#1421)', () => {
  const groupLink: GroupInviteLink = {
    id: 5,
    prefix: 'vbng_xx1',
    name: 'Team link',
    role: 'member',
    expires_at: null,
    is_active: true,
    is_expired: false,
    created_at: '',
    single_use: false,
    status: 'pending',
    used_at: null,
    created_by_username: null,
    delivery: 'link',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSiteConfig.mockResolvedValue(siteConfig)
  })

  it('keeps the group prompt copy and Revoke accessible name', async () => {
    mockGroupList.mockResolvedValue([groupLink])
    const user = userEvent.setup()
    render(<InviteLinkPanel scope={{ kind: 'group', id: 3 }} />)
    await user.click(await screen.findByRole('button', { name: 'Revoke' }))
    expect(screen.getByText('Revoke this invite link? Anyone holding it will no longer be able to join.')).toBeInTheDocument()
  })

  it('a 400 on revoke reports the invite as already used and refetches', async () => {
    mockGroupList.mockResolvedValue([groupLink])
    mockGroupRevoke.mockRejectedValue({ response: { status: 400 } })
    const user = userEvent.setup()
    render(<InviteLinkPanel scope={{ kind: 'group', id: 3 }} />)
    await user.click(await screen.findByRole('button', { name: 'Revoke' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText("This invite was already used, so it can't be revoked.")).toBeInTheDocument()
    await waitFor(() => expect(mockGroupList).toHaveBeenCalledTimes(2))
  })

  it('a network failure on revoke no longer leaves an unhandled rejection', async () => {
    mockGroupList.mockResolvedValue([groupLink])
    mockGroupRevoke.mockRejectedValue(new Error('offline'))
    const user = userEvent.setup()
    render(<InviteLinkPanel scope={{ kind: 'group', id: 3 }} />)
    await user.click(await screen.findByRole('button', { name: 'Revoke' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('Could not revoke invite.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled()
  })
})
