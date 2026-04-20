import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import InviteLinkPanel from '../components/Group/InviteLinkPanel'
import type { GroupInviteLink } from '../types'

vi.mock('../api/groups', () => ({
  listInviteLinks: vi.fn(),
  createInviteLink: vi.fn(),
  revokeInviteLink: vi.fn(),
}))

import { listInviteLinks, createInviteLink, revokeInviteLink } from '../api/groups'

const mockListInviteLinks = listInviteLinks as ReturnType<typeof vi.fn>
const mockRevokeInviteLink = revokeInviteLink as ReturnType<typeof vi.fn>
const mockCreateInviteLink = createInviteLink as ReturnType<typeof vi.fn>

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
}

describe('InviteLinkPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListInviteLinks.mockResolvedValue([])
  })

  it('renders generate button', async () => {
    render(<InviteLinkPanel groupId={1} />)
    expect(await screen.findByText('Invite links')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'New link' })).toBeInTheDocument()
  })

  it('shows generated link in one-time reveal mode', async () => {
    mockCreateInviteLink.mockResolvedValue(fakeCreatedLink)
    render(<InviteLinkPanel groupId={1} />)

    await userEvent.setup().click(await screen.findByRole('button', { name: 'New link' }))
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Create link' }))
    expect(await screen.findByText(/\/join\/abc123/)).toBeInTheDocument()
    expect(await screen.findByText(/Copy this link now/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Done' })).toBeInTheDocument()
  })

  it('shows empty state when no links', async () => {
    render(<InviteLinkPanel groupId={1} />)
    expect(await screen.findByText('No invite links.')).toBeInTheDocument()
  })

  it('renders existing links with prefix only', async () => {
    mockListInviteLinks.mockResolvedValue([fakeExistingLink])
    render(<InviteLinkPanel groupId={1} />)
    expect(await screen.findByText('xyz9…')).toBeInTheDocument()
    expect(await screen.findByText('Existing link')).toBeInTheDocument()
  })

  it('shows single-use toggle in create form', async () => {
    render(<InviteLinkPanel groupId={1} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'New link' }))
    expect(screen.getByText('Single use')).toBeInTheDocument()
    expect(screen.getByText('Link expires after one person joins.')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeInTheDocument()
  })

  it('single-use toggle is unchecked by default', async () => {
    render(<InviteLinkPanel groupId={1} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'New link' }))
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('passes single_use=true to createInviteLink when toggle is checked', async () => {
    mockCreateInviteLink.mockResolvedValue({ ...fakeCreatedLink, single_use: true })
    const user = userEvent.setup()
    render(<InviteLinkPanel groupId={1} />)
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    expect(mockCreateInviteLink).toHaveBeenCalledWith(1, expect.objectContaining({ single_use: true }))
  })

  it('passes single_use=false when toggle is not checked', async () => {
    mockCreateInviteLink.mockResolvedValue(fakeCreatedLink)
    const user = userEvent.setup()
    render(<InviteLinkPanel groupId={1} />)
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    expect(mockCreateInviteLink).toHaveBeenCalledWith(1, expect.objectContaining({ single_use: false }))
  })

  it('shows "Used" badge for a consumed single-use link', async () => {
    mockListInviteLinks.mockResolvedValue([fakeUsedLink])
    render(<InviteLinkPanel groupId={1} />)
    expect(await screen.findByText('Used')).toBeInTheDocument()
  })

  it('shows used_at date for a consumed link', async () => {
    mockListInviteLinks.mockResolvedValue([fakeUsedLink])
    render(<InviteLinkPanel groupId={1} />)
    // Apr 14 formatted as "Used Apr 14"
    expect(await screen.findByText(/Used Apr 14/)).toBeInTheDocument()
  })

  it('does not show revoke button for a consumed single-use link', async () => {
    mockListInviteLinks.mockResolvedValue([fakeUsedLink])
    render(<InviteLinkPanel groupId={1} />)
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
    render(<InviteLinkPanel groupId={1} />)
    expect(await screen.findByText('1-use')).toBeInTheDocument()
  })

  it('revoking a link shows Revoked status badge rather than removing the row', async () => {
    mockListInviteLinks.mockResolvedValue([fakeExistingLink])
    mockRevokeInviteLink.mockResolvedValue({})
    const user = userEvent.setup()
    render(<InviteLinkPanel groupId={1} />)
    // Confirm the link is visible
    expect(await screen.findByText('Existing link')).toBeInTheDocument()
    // Click Revoke to enter confirm mode, then confirm
    await user.click(screen.getByRole('button', { name: 'Revoke' }))
    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[0])
    // The row should still be visible showing the Revoked badge
    expect(await screen.findByText('Revoked')).toBeInTheDocument()
    expect(screen.getByText('Existing link')).toBeInTheDocument()
    // The revoke button should no longer be visible for a revoked row
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument()
  })

  it('resets single-use toggle on cancel', async () => {
    const user = userEvent.setup()
    render(<InviteLinkPanel groupId={1} />)
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
    render(<InviteLinkPanel groupId={1} />)
    await screen.findByText('Existing link')
    // Enter confirm mode
    await user.click(screen.getByRole('button', { name: 'Revoke' }))
    // Cancel — the Cancel button appears inline next to the confirm Revoke button
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    // API must not have been called
    expect(mockRevokeInviteLink).not.toHaveBeenCalled()
    // The original Revoke trigger should be visible again
    expect(await screen.findByRole('button', { name: 'Revoke' })).toBeInTheDocument()
  })

  it('shows createError UI when createInviteLink rejects', async () => {
    mockCreateInviteLink.mockRejectedValue(new Error('server error'))
    const user = userEvent.setup()
    render(<InviteLinkPanel groupId={1} />)
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
    render(<InviteLinkPanel groupId={1} />)
    await screen.findByText('Link 0')
    // The "New link" button should not be visible because the limit is reached
    expect(screen.queryByRole('button', { name: 'New link' })).not.toBeInTheDocument()
    // The limit message should be shown
    expect(screen.getByText(/Maximum of 5 active invite links reached/)).toBeInTheDocument()
  })

  it('Done button collapses the one-time reveal and clears the token from the UI', async () => {
    mockCreateInviteLink.mockResolvedValue(fakeCreatedLink)
    const user = userEvent.setup()
    render(<InviteLinkPanel groupId={1} />)
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
    render(<InviteLinkPanel groupId={1} />)
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
    render(<InviteLinkPanel groupId={1} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'New link' }))
    // The role SelectDropdown should show the current role label
    const combos = screen.getAllByRole('combobox')
    // At least one combobox showing "Member"
    expect(combos.some((c) => c.textContent?.includes('Member'))).toBe(true)
  })

  it('expiry dropdown in creation form renders correctly', async () => {
    render(<InviteLinkPanel groupId={1} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'New link' }))
    const combos = screen.getAllByRole('combobox')
    // An expiry combobox should be present (shows e.g. "7 days")
    expect(combos.length).toBeGreaterThanOrEqual(2)
  })

  it('expired link displays "Expired" status label', async () => {
    mockListInviteLinks.mockResolvedValue([fakeExpiredLink])
    render(<InviteLinkPanel groupId={1} />)
    expect(await screen.findByText('Expired link')).toBeInTheDocument()
    // "Expired" appears in both the status badge and the expiry field
    const expiredLabels = screen.getAllByText('Expired')
    expect(expiredLabels.length).toBeGreaterThanOrEqual(1)
  })

  it('expired link shows the Expired status badge in the UI', async () => {
    // An expired link is not terminal (used/revoked), so Revoke may still appear
    // if the link is still active on the server. The key signal is the Expired badge.
    mockListInviteLinks.mockResolvedValue([fakeExpiredLink])
    render(<InviteLinkPanel groupId={1} />)
    await screen.findByText('Expired link')
    // The Expired status label should be shown (may appear in badge and expiry field)
    const expiredLabels = screen.getAllByText('Expired')
    expect(expiredLabels.length).toBeGreaterThanOrEqual(1)
  })
})
