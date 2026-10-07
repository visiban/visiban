import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import InviteLinkPanel from '../components/Group/InviteLinkPanel'
import type { GroupInviteLink } from '../types'

vi.mock('../api/groups', () => ({
  listInviteLinks: vi.fn(),
  createInviteLink: vi.fn(),
  revokeInviteLink: vi.fn(),
  sendInviteLinkEmail: vi.fn(),
}))

vi.mock('../api/auth', () => ({ getSiteConfig: vi.fn() }))

import { listInviteLinks, createInviteLink, revokeInviteLink, sendInviteLinkEmail } from '../api/groups'
import { getSiteConfig } from '../api/auth'

const mockListInviteLinks = listInviteLinks as ReturnType<typeof vi.fn>
const mockRevokeInviteLink = revokeInviteLink as ReturnType<typeof vi.fn>
const mockCreateInviteLink = createInviteLink as ReturnType<typeof vi.fn>
const mockSendInviteLinkEmail = sendInviteLinkEmail as ReturnType<typeof vi.fn>
const mockGetSiteConfig = getSiteConfig as ReturnType<typeof vi.fn>

const siteConfig = {
  registration_open: true,
  registration_mode: 'open',
  demo_mode: false,
  demo_login: null,
  invite_email_available: true,
}

/** Simulates a creation response — includes raw token for one-time reveal */
const fakeCreatedLink: GroupInviteLink = {
  id: 1,
  prefix: 'abc1',
  token: 'abc123',
  name: 'Test link',
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

/** Simulates a list response — no raw token, only prefix */
const fakeExistingLink: GroupInviteLink = {
  id: 2,
  prefix: 'xyz9',
  name: 'Existing link',
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

/** A consumed single-use link returned by the list endpoint */
const fakeUsedLink: GroupInviteLink = {
  id: 3,
  prefix: 'use1',
  name: 'One-time link',
  role: 'member',
  expires_at: null,
  is_active: true,
  is_expired: false,
  created_at: '',
  single_use: true,
  status: 'used',
  used_at: '2026-04-14T18:00:00Z',
  created_by_username: null,
  delivery: 'link',
}

/** An expired link — use status: 'expired' to ensure isTerminal is true */
const fakeExpiredLink: GroupInviteLink = {
  id: 4,
  prefix: 'exp1',
  name: 'Expired link',
  role: 'member',
  expires_at: '2026-01-01T00:00:00Z',
  is_active: false,
  is_expired: true,
  created_at: '',
  single_use: false,
  status: 'expired',
  used_at: null,
  created_by_username: null,
  delivery: 'link',
}

describe('InviteLinkPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListInviteLinks.mockResolvedValue([])
    mockGetSiteConfig.mockResolvedValue(siteConfig)
  })

  it('renders the Invite by email section above the list and sends for this group', async () => {
    mockSendInviteLinkEmail.mockResolvedValue({ detail: 'Invite sent', sent_to: 'sam@example.com' })
    render(<InviteLinkPanel scope={{ kind: "group", id: 7 }} />)
    const input = await screen.findByRole('textbox', { name: 'Email address' })
    await userEvent.setup().type(input, 'sam@example.com{Enter}')
    await waitFor(() =>
      expect(mockSendInviteLinkEmail).toHaveBeenCalledWith(7, { email: 'sam@example.com', role: 'member' })
    )
    expect(await screen.findByText('Invite sent to sam@example.com.')).toBeInTheDocument()
    // Initial load plus the refetch after the send.
    await waitFor(() => expect(mockListInviteLinks).toHaveBeenCalledTimes(2))
  })

  it('passes the site-admin flag to the email form on an invite-only site (#1445)', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...siteConfig, registration_mode: 'invite_only', registration_open: false })
    const { unmount } = render(<InviteLinkPanel scope={{ kind: "group", id: 7 }} isSiteAdmin />)
    expect(await screen.findByText(/only from invites you email/)).toBeInTheDocument()
    unmount()
    render(<InviteLinkPanel scope={{ kind: "group", id: 7 }} />)
    expect(await screen.findByText(/New users can't sign up on this site\./)).toBeInTheDocument()
  })

  it('hides the Invite by email section when email is unavailable', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...siteConfig, invite_email_available: false })
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await screen.findByText('No invite links.')
    expect(screen.queryByText('Invite by email')).not.toBeInTheDocument()
  })

  it('shows an Emailed badge on emailed links and never a token reveal', async () => {
    mockListInviteLinks.mockResolvedValue([
      { ...fakeExistingLink, id: 9, prefix: 'eml1', name: 'Emailed one', delivery: 'email', single_use: true },
    ])
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    expect(await screen.findByText('Emailed')).toBeInTheDocument()
    expect(screen.queryByText(/Copy this link now/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Revoke/ })).toBeInTheDocument()
  })

  it('does not badge shareable links as Emailed', async () => {
    mockListInviteLinks.mockResolvedValue([fakeExistingLink])
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await screen.findByText('xyz9…')
    expect(screen.queryByText('Emailed')).not.toBeInTheDocument()
  })

  it('a refetch (socket echo) keeps the one-time token of a link still being revealed', async () => {
    mockCreateInviteLink.mockResolvedValue(fakeCreatedLink)
    const { rerender } = render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} reloadSignal={0} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await user.click(await screen.findByRole('button', { name: 'Create link' }))
    expect(await screen.findByText(/\/join\/abc123/)).toBeInTheDocument()
    mockListInviteLinks.mockResolvedValue([{ ...fakeCreatedLink, token: undefined }])
    rerender(<InviteLinkPanel scope={{ kind: "group", id: 1 }} reloadSignal={1} />)
    await waitFor(() => expect(mockListInviteLinks).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/\/join\/abc123/)).toBeInTheDocument()
  })

  it('renders generate button', async () => {
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    expect(await screen.findByText('Invite links')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'New link' })).toBeInTheDocument()
  })

  it('shows generated link in one-time reveal mode', async () => {
    mockCreateInviteLink.mockResolvedValue(fakeCreatedLink)
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)

    await userEvent.setup().click(await screen.findByRole('button', { name: 'New link' }))
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Create link' }))
    expect(await screen.findByText(/\/join\/abc123/)).toBeInTheDocument()
    expect(await screen.findByText(/Copy this link now/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Done' })).toBeInTheDocument()
  })

  it('shows empty state when no links', async () => {
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    expect(await screen.findByText('No invite links.')).toBeInTheDocument()
  })

  it('renders existing links with prefix only', async () => {
    mockListInviteLinks.mockResolvedValue([fakeExistingLink])
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    expect(await screen.findByText('xyz9…')).toBeInTheDocument()
    expect(await screen.findByText('Existing link')).toBeInTheDocument()
  })

  it('shows single-use toggle in create form', async () => {
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'New link' }))
    expect(screen.getByText('Single use')).toBeInTheDocument()
    expect(screen.getByText('Link expires after one person joins.')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeInTheDocument()
  })

  it('single-use toggle is unchecked by default', async () => {
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'New link' }))
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('passes single_use=true to createInviteLink when toggle is checked', async () => {
    mockCreateInviteLink.mockResolvedValue({ ...fakeCreatedLink, single_use: true })
    const user = userEvent.setup()
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    expect(mockCreateInviteLink).toHaveBeenCalledWith(1, expect.objectContaining({ single_use: true }))
  })

  it('passes single_use=false when toggle is not checked', async () => {
    mockCreateInviteLink.mockResolvedValue(fakeCreatedLink)
    const user = userEvent.setup()
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    expect(mockCreateInviteLink).toHaveBeenCalledWith(1, expect.objectContaining({ single_use: false }))
  })

  it('shows "Used" badge for a consumed single-use link', async () => {
    mockListInviteLinks.mockResolvedValue([fakeUsedLink])
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    expect(await screen.findByText('Used')).toBeInTheDocument()
  })

  it('shows used_at date for a consumed link', async () => {
    mockListInviteLinks.mockResolvedValue([fakeUsedLink])
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    // Apr 14 formatted as "Used Apr 14"
    expect(await screen.findByText(/Used Apr 14/)).toBeInTheDocument()
  })

  it('does not show revoke button for a consumed single-use link', async () => {
    mockListInviteLinks.mockResolvedValue([fakeUsedLink])
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await screen.findByText('Used')
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument()
  })

  it('shows "1-use" indicator for a pending single-use link', async () => {
    const pendingSingleUse: GroupInviteLink = {
      ...fakeExistingLink,
      id: 10,
      single_use: true,
      status: 'pending',
      used_at: null,
    }
    mockListInviteLinks.mockResolvedValue([pendingSingleUse])
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    expect(await screen.findByText('1-use')).toBeInTheDocument()
  })

  it('revoking a link shows Revoked status badge rather than removing the row', async () => {
    mockListInviteLinks.mockResolvedValue([fakeExistingLink])
    mockRevokeInviteLink.mockResolvedValue({})
    const user = userEvent.setup()
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    // Confirm the link is visible
    expect(await screen.findByText('Existing link')).toBeInTheDocument()
    // Click Revoke to enter confirm mode, then confirm
    await user.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(screen.getByText(/Anyone holding it will no longer be able to join/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    // The row should still be visible showing the Revoked badge
    expect(await screen.findByText('Revoked')).toBeInTheDocument()
    expect(screen.getByText('Existing link')).toBeInTheDocument()
    // The revoke button should no longer be visible for a revoked row
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument()
  })

  it('refetches links when reloadSignal changes (invite_link.revoked convergence)', async () => {
    mockListInviteLinks.mockResolvedValue([fakeExistingLink])
    const { rerender } = render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} reloadSignal={0} />)
    expect(await screen.findByText('Existing link')).toBeInTheDocument()
    expect(mockListInviteLinks).toHaveBeenCalledTimes(1)
    // Parent bumps the signal when an invite_link.revoked socket event arrives.
    rerender(<InviteLinkPanel scope={{ kind: "group", id: 1 }} reloadSignal={1} />)
    await waitFor(() => expect(mockListInviteLinks).toHaveBeenCalledTimes(2))
  })

  it('under StrictMode fetches only from the mount effect (2), then once per reloadSignal bump (#1479)', async () => {
    vi.mocked(listInviteLinks).mockResolvedValue([])
    const el = (signal: number) => (
      <StrictMode>
        <InviteLinkPanel scope={{ kind: "group", id: 1 }} reloadSignal={signal} />
      </StrictMode>
    )
    const { rerender } = render(el(0))
    await waitFor(() => expect(listInviteLinks).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 20))
    expect(listInviteLinks).toHaveBeenCalledTimes(2)

    rerender(el(1))
    await waitFor(() => expect(listInviteLinks).toHaveBeenCalledTimes(3))
    await new Promise((r) => setTimeout(r, 20))
    expect(listInviteLinks).toHaveBeenCalledTimes(3)
  })

  it('does not double-fetch on mount when reloadSignal is provided', async () => {
    mockListInviteLinks.mockResolvedValue([])
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} reloadSignal={0} />)
    expect(await screen.findByText('No invite links.')).toBeInTheDocument()
    // The mount fetch fires once; the reloadSignal effect must skip its initial run.
    expect(mockListInviteLinks).toHaveBeenCalledTimes(1)
  })

  it('resets single-use toggle on cancel', async () => {
    const user = userEvent.setup()
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await user.click(screen.getByRole('switch')) // check it
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    // Re-open form — toggle should be unchecked again
    await user.click(screen.getByRole('button', { name: 'New link' }))
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  // --- New scenarios for #391 ---

  it('inline revoke confirmation cancel dismisses dialog without calling revokeInviteLink', async () => {
    mockListInviteLinks.mockResolvedValue([fakeExistingLink])
    const user = userEvent.setup()
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await screen.findByText('Existing link')
    // Enter confirm mode
    await user.click(screen.getByRole('button', { name: 'Revoke' }))
    // Cancel — the Cancel button appears in the inline confirm row
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    // API must not have been called
    expect(mockRevokeInviteLink).not.toHaveBeenCalled()
    // The original Revoke trigger should be visible again
    expect(await screen.findByRole('button', { name: 'Revoke' })).toBeInTheDocument()
  })

  it('Cancel on the revoke confirm returns focus to the Revoke trigger (#1367)', async () => {
    mockListInviteLinks.mockResolvedValue([fakeExistingLink])
    const user = userEvent.setup()
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await screen.findByText('Existing link')
    await user.click(screen.getByRole('button', { name: 'Revoke' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Revoke' })).toHaveFocus()
  })

  it('Escape on the revoke confirm returns focus to the Revoke trigger (#1367)', async () => {
    mockListInviteLinks.mockResolvedValue([fakeExistingLink])
    const user = userEvent.setup()
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await screen.findByText('Existing link')
    await user.click(screen.getByRole('button', { name: 'Revoke' }))
    // Move focus onto the prompt, as a keyboard user tabbing into it would.
    screen.getByRole('button', { name: 'Cancel' }).focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Revoke' })).toHaveFocus()
  })

  it('shows createError UI when createInviteLink rejects', async () => {
    mockCreateInviteLink.mockRejectedValue(new Error('server error'))
    const user = userEvent.setup()
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    // The component renders createError as a danger span
    expect(await screen.findByText(/server error|Failed to create/i)).toBeInTheDocument()
  })

  it('hides creation form when MAX_LINKS (5) active links exist', async () => {
    const activeLinks: GroupInviteLink[] = Array.from({ length: 5 }, (_, i) => ({
      ...fakeExistingLink,
      id: 100 + i,
      prefix: `lnk${i}`,
      name: `Link ${i}`,
      is_active: true,
      used_at: null,
    }))
    mockListInviteLinks.mockResolvedValue(activeLinks)
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await screen.findByText('Link 0')
    // The "New link" button should not be visible because the limit is reached
    expect(screen.queryByRole('button', { name: 'New link' })).not.toBeInTheDocument()
    // The limit message should be shown
    expect(screen.getByText(/Maximum of 5 active invite links reached/)).toBeInTheDocument()
  })

  it('emailed links do not count against the 5 shareable-link cap (#731)', async () => {
    const emailedLinks: GroupInviteLink[] = Array.from({ length: 5 }, (_, i) => ({
      ...fakeExistingLink,
      id: 200 + i,
      prefix: `eml${i}`,
      name: `Emailed ${i}`,
      is_active: true,
      used_at: null,
      single_use: true,
      delivery: 'email',
    }))
    mockListInviteLinks.mockResolvedValue(emailedLinks)
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await screen.findByText('Emailed 0')
    expect(screen.getByRole('button', { name: 'New link' })).toBeInTheDocument()
    expect(screen.queryByText(/Maximum of 5 active invite links reached/)).not.toBeInTheDocument()
  })

  it('5 shareable links still hit the cap when emailed links are also present (#731)', async () => {
    const mixed: GroupInviteLink[] = Array.from({ length: 7 }, (_, i) => ({
      ...fakeExistingLink,
      id: 300 + i,
      prefix: `mix${i}`,
      name: `Mixed ${i}`,
      is_active: true,
      used_at: null,
      delivery: i < 5 ? 'link' : 'email',
    }))
    mockListInviteLinks.mockResolvedValue(mixed)
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await screen.findByText('Mixed 0')
    expect(screen.queryByRole('button', { name: 'New link' })).not.toBeInTheDocument()
  })

  it('Done button collapses the one-time reveal and clears the token from the UI', async () => {
    mockCreateInviteLink.mockResolvedValue(fakeCreatedLink)
    const user = userEvent.setup()
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    // Reveal is shown
    expect(await screen.findByText(/\/join\/abc123/)).toBeInTheDocument()
    // Click Done
    await user.click(screen.getByRole('button', { name: 'Done' }))
    // Token URL should no longer be visible
    expect(screen.queryByText(/\/join\/abc123/)).not.toBeInTheDocument()
    // Copy this link now notice gone
    expect(screen.queryByText(/Copy this link now/)).not.toBeInTheDocument()
  })

  it('Copy button is present after generating a link', async () => {
    // Verifies that the one-time reveal mode renders a Copy button that is clickable.
    // Full clipboard integration testing would require a browser environment
    // (navigator.clipboard is a secure context API not available in jsdom).
    mockCreateInviteLink.mockResolvedValue(fakeCreatedLink)
    const user = userEvent.setup()
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    const copyBtn = await screen.findByRole('button', { name: 'Copy' })
    // The button must be reachable and functional
    expect(copyBtn).toBeInTheDocument()
    expect(copyBtn).not.toBeDisabled()
    // After clicking, the button shows a "Copied!" confirmation
    await user.click(copyBtn)
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument()
  })

  it('role dropdown in creation form renders correctly with default "member" selected', async () => {
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'New link' }))
    // The role SelectDropdown should show the current role label
    const combos = screen.getAllByRole('combobox')
    // At least one combobox showing "Member"
    expect(combos.some((c) => c.textContent?.includes('Member'))).toBe(true)
  })

  it('expiry dropdown in creation form renders correctly', async () => {
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'New link' }))
    const combos = screen.getAllByRole('combobox')
    // An expiry combobox should be present (shows e.g. "7 days")
    expect(combos.length).toBeGreaterThanOrEqual(2)
  })

  it('expired link displays "Expired" status label', async () => {
    mockListInviteLinks.mockResolvedValue([fakeExpiredLink])
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    expect(await screen.findByText('Expired link')).toBeInTheDocument()
    // "Expired" appears in both the status badge and the expiry field
    const expiredLabels = screen.getAllByText('Expired')
    expect(expiredLabels.length).toBeGreaterThanOrEqual(1)
  })

  it('expired link shows the Expired status badge in the UI', async () => {
    // An expired link is not terminal (used/revoked), so Revoke may still appear
    // if the link is still active on the server. The key signal is the Expired badge.
    mockListInviteLinks.mockResolvedValue([fakeExpiredLink])
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await screen.findByText('Expired link')
    // The Expired status label should be shown (may appear in badge and expiry field)
    const expiredLabels = screen.getAllByText('Expired')
    expect(expiredLabels.length).toBeGreaterThanOrEqual(1)
  })

  it('Escape cancels the revoke prompt without calling the API or reaching lower-priority handlers (#1238)', async () => {
    mockListInviteLinks.mockResolvedValue([fakeExistingLink])
    const pageEscape = vi.fn()
    // Stand-in for GroupDetail's priority-0 Escape-to-navigate handler.
    const { useEscapeStack } = await import('../hooks/useEscapeStack')
    function Host() {
      useEscapeStack(() => { pageEscape() }, 0)
      return <InviteLinkPanel scope={{ kind: "group", id: 1 }} />
    }
    const user = userEvent.setup()
    render(<Host />)
    await user.click(await screen.findByRole('button', { name: 'Revoke' }))
    expect(screen.getByText(/Anyone holding it will no longer be able to join/)).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText(/Anyone holding it will no longer be able to join/)).not.toBeInTheDocument()
    expect(pageEscape).not.toHaveBeenCalled()
    expect(mockRevokeInviteLink).not.toHaveBeenCalled()
    // With nothing pending, Escape falls through to the page handler.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(pageEscape).toHaveBeenCalledTimes(1)
  })

  // ----------------------------------------------------------------
  // Load failure and copy failure — rejection paths (#1375)
  // ----------------------------------------------------------------

  it('shows a load error and a retry button when the initial list fetch fails', async () => {
    mockListInviteLinks.mockRejectedValueOnce(new Error('network error'))
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load invite links.')
    // The empty-state message must not render in its place — they're mutually exclusive.
    expect(screen.queryByText('No invite links.')).not.toBeInTheDocument()

    mockListInviteLinks.mockResolvedValueOnce([fakeExistingLink])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Existing link')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('refetching after reloadSignal clears a stale load error on success', async () => {
    mockListInviteLinks.mockRejectedValueOnce(new Error('network error'))
    const { rerender } = render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} reloadSignal={0} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load invite links.')

    mockListInviteLinks.mockResolvedValueOnce([fakeExistingLink])
    rerender(<InviteLinkPanel scope={{ kind: "group", id: 1 }} reloadSignal={1} />)
    expect(await screen.findByText('Existing link')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows a failure label on the Copy button when the clipboard write rejects, without a false "Copied!"', async () => {
    mockCreateInviteLink.mockResolvedValue(fakeCreatedLink)
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'))
    const user = userEvent.setup()
    render(<InviteLinkPanel scope={{ kind: "group", id: 1 }} />)
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    const copyBtn = await screen.findByRole('button', { name: 'Copy' })

    await user.click(copyBtn)

    expect(await screen.findByRole('button', { name: 'Failed — try again' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copied!' })).not.toBeInTheDocument()
  })
})
