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
    expect(screen.getByRole('checkbox')).toBeInTheDocument()
  })

  it('single-use toggle is unchecked by default', async () => {
    render(<InviteLinkPanel groupId={1} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'New link' }))
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  it('passes single_use=true to createInviteLink when toggle is checked', async () => {
    mockCreateInviteLink.mockResolvedValue({ ...fakeCreatedLink, single_use: true })
    const user = userEvent.setup()
    render(<InviteLinkPanel groupId={1} />)
    await user.click(await screen.findByRole('button', { name: 'New link' }))
    await user.click(screen.getByRole('checkbox'))
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
    await user.click(screen.getByRole('checkbox')) // check it
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    // Re-open form — toggle should be unchecked again
    await user.click(screen.getByRole('button', { name: 'New link' }))
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })
})
