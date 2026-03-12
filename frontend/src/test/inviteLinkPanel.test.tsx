import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import InviteLinkPanel from '../components/Group/InviteLinkPanel'

vi.mock('../api/groups', () => ({
  createInviteLink: vi.fn(),
  revokeInviteLink: vi.fn(),
}))

import { createInviteLink } from '../api/groups'

const mockCreateInviteLink = createInviteLink as ReturnType<typeof vi.fn>

describe('InviteLinkPanel', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders generate button', () => {
    render(<InviteLinkPanel groupId={1} />)
    expect(screen.getByText('Invite link')).toBeInTheDocument()
    expect(screen.getByText('Generate invite link')).toBeInTheDocument()
  })

  it('shows generated link', async () => {
    mockCreateInviteLink.mockResolvedValue({ id: 1, token: 'abc123', is_active: true, created_at: '', name: '', role: 'member', expires_at: null, is_expired: false })
    render(<InviteLinkPanel groupId={1} />)

    await userEvent.setup().click(screen.getByText('Generate invite link'))
    expect(await screen.findByDisplayValue(/\/join\/abc123/)).toBeInTheDocument()
    expect(screen.getByText('Copy')).toBeInTheDocument()
    expect(screen.getByText('Revoke link')).toBeInTheDocument()
  })
})
