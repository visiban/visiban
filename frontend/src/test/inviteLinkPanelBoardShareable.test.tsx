import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import InviteLinkPanel from '../components/Group/InviteLinkPanel'
import type { BoardInviteLink, CreatedBoardInviteLink } from '../types'

// #439 — shareable board invite links in Board Settings → Members: the
// "New link" button on the Pending invites heading, the 1/7/30 form with
// board-only roles, the registration notice, the one-time reveal, and the cap.

vi.mock('../api/groups', () => ({
  listInviteLinks: vi.fn(),
  createInviteLink: vi.fn(),
  revokeInviteLink: vi.fn(),
  sendInviteLinkEmail: vi.fn(),
}))
vi.mock('../api/boards', () => ({
  listBoardInviteLinks: vi.fn(),
  createBoardInviteLink: vi.fn(),
  revokeBoardInviteLink: vi.fn(),
  sendBoardInviteEmail: vi.fn(),
}))
vi.mock('../api/auth', () => ({ getSiteConfig: vi.fn() }))

import { createInviteLink } from '../api/groups'
import { createBoardInviteLink, listBoardInviteLinks, revokeBoardInviteLink } from '../api/boards'
import { getSiteConfig } from '../api/auth'

const mockList = listBoardInviteLinks as ReturnType<typeof vi.fn>
const mockCreate = createBoardInviteLink as ReturnType<typeof vi.fn>
const mockGroupCreate = createInviteLink as ReturnType<typeof vi.fn>
const mockGetSiteConfig = getSiteConfig as ReturnType<typeof vi.fn>

const NOTICE =
  "New users can't sign up from an invite link on this site. Only people who already have an account can join with it."
const CAP = 'Maximum of 5 active invite links reached. Revoke a link to create a new one.'

function config(mode: 'open' | 'invite_only' | 'closed' = 'open', emailAvailable = true) {
  return {
    registration_open: mode === 'open',
    registration_mode: mode,
    demo_mode: false,
    demo_login: null,
    invite_email_available: emailAvailable,
  }
}

function link(overrides: Partial<BoardInviteLink> = {}): BoardInviteLink {
  return {
    id: 1,
    prefix: 'vbnb_ab1',
    name: '',
    role: 'member',
    delivery: 'link',
    created_at: '2026-10-01T12:00:00Z',
    created_by_username: 'alice',
    expires_at: '2026-10-08T12:00:00Z',
    is_expired: false,
    single_use: false,
    used_at: null,
    status: 'pending',
    can_register: true,
    use_count: 0,
    ...overrides,
  }
}

function created(overrides: Partial<CreatedBoardInviteLink> = {}): CreatedBoardInviteLink {
  return { ...link({ id: 77, prefix: 'vbnb_new', created_at: '2026-10-07T12:00:00Z' }), token: 'vbnb_newtoken123', ...overrides }
}

function renderBoard() {
  return render(
    <InviteLinkPanel
      scope={{ kind: 'board', id: 9 }}
      variant="embedded"
      allowShareableLinks
      escapePriority={49}
    />,
  )
}

describe('InviteLinkPanel — board shareable links (#439)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockList.mockResolvedValue([])
    mockGetSiteConfig.mockResolvedValue(config())
  })

  it('puts New link on the Pending invites heading row, with the divider and the helper line', async () => {
    renderBoard()
    const button = await screen.findByRole('button', { name: 'New link' })
    expect(button.parentElement).toHaveTextContent('Pending invites')
    expect(await screen.findByText('or create a shareable link')).toBeInTheDocument()
    expect(
      screen.getByText('Anyone with an invite link can join this board after signing in. To let people view without signing in, use the Sharing tab.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Invite links')).not.toBeInTheDocument()
  })

  it('offers only member/collaborator/viewer and 1/7/30 days (no Never), defaulting to Member and 7 days', async () => {
    const user = userEvent.setup()
    renderBoard()
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    const form = screen.getByText('New invite link').parentElement as HTMLElement
    const [roleCombo, expiryCombo] = within(form).getAllByRole('combobox')
    expect(roleCombo).toHaveTextContent('Member')
    expect(expiryCombo).toHaveTextContent('7 days')

    await user.click(roleCombo)
    const roles = screen.getAllByRole('option').map((o) => o.textContent)
    expect(roles).toEqual(['Member', 'Collaborator', 'Viewer'])
    await user.click(screen.getByRole('option', { name: 'Viewer' }))

    await user.click(expiryCombo)
    const expiries = screen.getAllByRole('option').map((o) => o.textContent)
    expect(expiries).toEqual(['1 day', '7 days', '30 days'])
    await user.click(screen.getByRole('option', { name: '30 days' }))

    mockCreate.mockResolvedValue(created({ role: 'viewer' }))
    await user.type(within(form).getByLabelText('Name (optional)'), '  Contractors ')
    await user.click(within(form).getByRole('button', { name: 'Create link' }))
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(9, {
        name: 'Contractors',
        role: 'viewer',
        expiry_days: 30,
        single_use: false,
      }),
    )
    expect(mockGroupCreate).not.toHaveBeenCalled()
  })

  it('reveals the join URL once, copies it, and Done leaves only the prefix', async () => {
    const user = userEvent.setup()
    mockCreate.mockResolvedValue(created())
    mockList.mockResolvedValue([link({ id: 3, prefix: 'vbnb_old', created_at: '2026-09-01T12:00:00Z' })])
    renderBoard()
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await user.click(screen.getByRole('button', { name: 'Create link' }))

    expect(await screen.findByText("Copy this link now — it won't be shown again.")).toBeInTheDocument()
    const url = `${window.location.origin}/join/vbnb_newtoken123`
    expect(screen.getByText(url)).toBeInTheDocument()
    // The new link is listed first, and the form closed.
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent(url)
    expect(screen.queryByText('New invite link')).not.toBeInTheDocument()

    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValueOnce(undefined)
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith(url)
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByText(url)).not.toBeInTheDocument()
    expect(screen.getByText('vbnb_new…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Revoke invite vbnb_new' })).toBeInTheDocument()
  })

  it('a refetch while revealing keeps the one-time token', async () => {
    const user = userEvent.setup()
    mockCreate.mockResolvedValue(created())
    const { rerender } = renderBoard()
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    await screen.findByText("Copy this link now — it won't be shown again.")
    mockList.mockResolvedValue([link({ id: 77, prefix: 'vbnb_new' })])
    rerender(
      <InviteLinkPanel scope={{ kind: 'board', id: 9 }} variant="embedded" allowShareableLinks escapePriority={49} reloadSignal={1} />,
    )
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
    expect(screen.getByText(`${window.location.origin}/join/vbnb_newtoken123`)).toBeInTheDocument()
  })

  it.each([
    ['invite_only' as const, true],
    ['closed' as const, true],
    ['open' as const, false],
  ])('registration notice on a %s site: %s', async (mode, shown) => {
    mockGetSiteConfig.mockResolvedValue(config(mode))
    const user = userEvent.setup()
    renderBoard()
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    if (shown) {
      expect(await screen.findByText(NOTICE)).toBeInTheDocument()
    } else {
      await waitFor(() => expect(mockGetSiteConfig).toHaveBeenCalled())
      expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
    }
  })

  it('no notice when the site config cannot be read', async () => {
    mockGetSiteConfig.mockRejectedValue(new Error('down'))
    const user = userEvent.setup()
    renderBoard()
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
  })

  it('shows the server error in the form slot (e.g. the cap was reached elsewhere)', async () => {
    mockCreate.mockRejectedValue({ response: { status: 400, data: { detail: CAP } } })
    const user = userEvent.setup()
    renderBoard()
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    expect(await screen.findByText(CAP)).toHaveClass('text-danger')
    // Cancel closes the form and clears the error.
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(CAP)).not.toBeInTheDocument()
  })

  it('falls back to a generic error when the server gives no detail', async () => {
    mockCreate.mockRejectedValue(new Error('network'))
    const user = userEvent.setup()
    renderBoard()
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    expect(await screen.findByText('Failed to create invite link.')).toBeInTheDocument()
  })

  it('at 5 active links hides New link and warns; emailed and dead links do not count', async () => {
    const five = [1, 2, 3, 4, 5].map((id) => link({ id, prefix: `vbnb_l${id}` }))
    mockList.mockResolvedValue(five)
    const { unmount } = renderBoard()
    expect(await screen.findByText(CAP)).toHaveClass('text-warning')
    expect(screen.queryByRole('button', { name: 'New link' })).not.toBeInTheDocument()
    unmount()

    mockList.mockResolvedValue([
      ...five.slice(0, 4),
      link({ id: 6, delivery: 'email', single_use: true }),
      link({ id: 7, status: 'revoked' }),
      link({ id: 8, status: 'expired', is_expired: true }),
      link({ id: 9, single_use: true, status: 'used', used_at: '2026-10-02T12:00:00Z' }),
    ])
    renderBoard()
    expect(await screen.findByRole('button', { name: 'New link' })).toBeInTheDocument()
    expect(screen.queryByText(CAP)).not.toBeInTheDocument()
  })

  it('marks pending single-use links "1-use" and names them', async () => {
    mockList.mockResolvedValue([
      link({ id: 1, name: 'Design crew', single_use: true }),
      link({ id: 2, prefix: 'vbnb_mul' }),
    ])
    renderBoard()
    const named = (await screen.findByText('Design crew')).closest('li') as HTMLElement
    expect(within(named).getByText('1-use')).toBeInTheDocument()
    const unnamed = screen.getByText('Invite link').closest('li') as HTMLElement
    expect(within(unnamed).queryByText('1-use')).not.toBeInTheDocument()
    expect(within(unnamed).getByText('Created Oct 1 by alice')).toBeInTheDocument()
  })

  it('stays visible when email is unavailable, since links can still be created', async () => {
    mockGetSiteConfig.mockResolvedValue(config('open', false))
    renderBoard()
    expect(await screen.findByRole('button', { name: 'New link' })).toBeInTheDocument()
    expect(await screen.findByText('No pending invites.')).toBeInTheDocument()
    expect(screen.queryByText('Invite by email')).not.toBeInTheDocument()
  })

  it('names the form pickers "Role" and "Expires"', async () => {
    const user = userEvent.setup()
    renderBoard()
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    expect(screen.getByRole('combobox', { name: 'Role: Member' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Expires: 7 days' })).toBeInTheDocument()
  })

  it('moves focus: New link → Name, Cancel → New link, create → Copy', async () => {
    const user = userEvent.setup()
    mockCreate.mockResolvedValue(created())
    renderBoard()
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await waitFor(() => expect(screen.getByLabelText('Name (optional)')).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'New link' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'New link' }))
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy' })).toHaveFocus())
  })

  it('a revoke that removes its own trigger moves focus to the Pending invites heading', async () => {
    const user = userEvent.setup()
    mockList.mockResolvedValue([link()])
    ;(revokeBoardInviteLink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    renderBoard()
    await user.click(await screen.findByRole('button', { name: 'Revoke invite vbnb_ab1' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Pending invites' })).toHaveFocus())
  })

  it('a 400 with field errors shows the first field message', async () => {
    const user = userEvent.setup()
    mockCreate.mockRejectedValue({ response: { status: 400, data: { expiry_days: ['"2" is not a valid choice.'] } } })
    renderBoard()
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    expect(await screen.findByText('"2" is not a valid choice.')).toHaveClass('text-danger')
  })

  it('"Existing accounts only" matches its row neighbors (rounded, semibold)', async () => {
    mockList.mockResolvedValue([link({ can_register: false })])
    renderBoard()
    expect(await screen.findByText('Existing accounts only')).toHaveClass('rounded', 'font-semibold', 'px-1.5')
  })
})

