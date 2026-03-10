import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import InviteLinkPanel from '../components/Group/InviteLinkPanel'

vi.mock('../api/groups', () => ({
  generateInviteLink: vi.fn(),
  deactivateInviteLink: vi.fn(),
}))

import { generateInviteLink } from '../api/groups'

const mockGenerateInviteLink = generateInviteLink as ReturnType<typeof vi.fn>

describe('InviteLinkPanel', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders generate button', () => {
    render(<InviteLinkPanel groupId={1} />)
    expect(screen.getByText('Invite link')).toBeInTheDocument()
    expect(screen.getByText('Generate invite link')).toBeInTheDocument()
  })

  it('shows generated link', async () => {
    mockGenerateInviteLink.mockResolvedValue({ id: 1, token: 'abc123', is_active: true, created_at: '' })
    render(<InviteLinkPanel groupId={1} />)

    await userEvent.setup().click(screen.getByText('Generate invite link'))
    expect(await screen.findByDisplayValue(/\/join\/abc123/)).toBeInTheDocument()
    expect(screen.getByText('Copy')).toBeInTheDocument()
    expect(screen.getByText('Revoke link')).toBeInTheDocument()
  })
})
