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

import { listInviteLinks, createInviteLink } from '../api/groups'

const mockListInviteLinks = listInviteLinks as ReturnType<typeof vi.fn>
const mockCreateInviteLink = createInviteLink as ReturnType<typeof vi.fn>

const fakeLink: GroupInviteLink = {
  id: 1,
  token: 'abc123',
  name: 'Test link',
  role: 'member',
  expires_at: null,
  is_active: true,
  is_expired: false,
  created_at: '',
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

  it('shows generated link', async () => {
    mockCreateInviteLink.mockResolvedValue(fakeLink)
    render(<InviteLinkPanel groupId={1} />)

    await userEvent.setup().click(await screen.findByRole('button', { name: 'New link' }))
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Create link' }))
    expect(await screen.findByDisplayValue(/\/join\/abc123/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Revoke' })).toBeInTheDocument()
  })

  it('shows empty state when no links', async () => {
    render(<InviteLinkPanel groupId={1} />)
    expect(await screen.findByText('No active invite links.')).toBeInTheDocument()
  })

  it('renders existing links', async () => {
    mockListInviteLinks.mockResolvedValue([fakeLink])
    render(<InviteLinkPanel groupId={1} />)
    expect(await screen.findByDisplayValue(/\/join\/abc123/)).toBeInTheDocument()
    expect(await screen.findByText('Test link')).toBeInTheDocument()
  })
})
