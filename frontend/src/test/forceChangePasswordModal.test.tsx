import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ForceChangePasswordModal from '../components/Auth/ForceChangePasswordModal'
import type { User } from '../types'

vi.mock('../api/auth', () => ({
  changePassword: vi.fn(),
}))

import { changePassword } from '../api/auth'
const mockChangePassword = changePassword as ReturnType<typeof vi.fn>

const baseUser: User = {
  id: 1,
  username: 'alice',
  email: 'alice@example.com',
  first_name: '',
  last_name: '',
  avatar_url: '',
  display_name: '',
  is_site_admin: false,
  must_change_password: true,
  must_change_username: false,
}

describe('ForceChangePasswordModal', () => {
  let onChanged: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onChanged = vi.fn()
    vi.clearAllMocks()
  })

  it('renders modal with title and explanation', () => {
    render(<ForceChangePasswordModal user={baseUser} onChanged={onChanged} />)
    expect(screen.getByText('Change your password')).toBeTruthy()
    expect(screen.getByText(/temporary password/)).toBeTruthy()
  })

  it('renders temporary password, new password, and confirm fields', () => {
    render(<ForceChangePasswordModal user={baseUser} onChanged={onChanged} />)
    expect(screen.getByLabelText(/^temporary password/i)).toBeTruthy()
    expect(screen.getByLabelText(/^new password/i)).toBeTruthy()
    expect(screen.getByLabelText(/^confirm/i)).toBeTruthy()
  })

  it('shows client-side error when passwords do not match', async () => {
    const user = userEvent.setup()
    render(<ForceChangePasswordModal user={baseUser} onChanged={onChanged} />)

    await user.type(screen.getByLabelText(/^temporary password/i),'oldpassword123')
    await user.type(screen.getByLabelText(/^new password/i),'newpassword12345')
    await user.type(screen.getByLabelText(/^confirm/i),'doesnotmatch')
    await user.click(screen.getByRole('button', { name: /set new password/i }))

    expect(screen.getByText('Passwords do not match.')).toBeTruthy()
    expect(mockChangePassword).not.toHaveBeenCalled()
  })

  it('shows client-side error when new password is too short', async () => {
    const user = userEvent.setup()
    render(<ForceChangePasswordModal user={baseUser} onChanged={onChanged} />)

    await user.type(screen.getByLabelText(/^temporary password/i),'oldpassword123')
    await user.type(screen.getByLabelText(/^new password/i),'short')
    await user.type(screen.getByLabelText(/^confirm/i),'short')
    await user.click(screen.getByRole('button', { name: /set new password/i }))

    expect(screen.getByText(/at least 12 characters/)).toBeTruthy()
    expect(mockChangePassword).not.toHaveBeenCalled()
  })

  it('calls changePassword and invokes onChanged on success', async () => {
    const user = userEvent.setup()
    const updatedUser = { ...baseUser, must_change_password: false }
    mockChangePassword.mockResolvedValue(undefined)

    render(<ForceChangePasswordModal user={baseUser} onChanged={onChanged} />)

    await user.type(screen.getByLabelText(/^temporary password/i),'oldpassword123')
    await user.type(screen.getByLabelText(/^new password/i),'newpassword12345')
    await user.type(screen.getByLabelText(/^confirm/i),'newpassword12345')
    await user.click(screen.getByRole('button', { name: /set new password/i }))

    await waitFor(() => {
      expect(mockChangePassword).toHaveBeenCalledWith('oldpassword123', 'newpassword12345')
      expect(onChanged).toHaveBeenCalledWith(updatedUser)
    })
  })

  it('shows server error on API failure', async () => {
    const user = userEvent.setup()
    mockChangePassword.mockRejectedValue({
      response: { data: { detail: 'Current password is incorrect.' } },
    })

    render(<ForceChangePasswordModal user={baseUser} onChanged={onChanged} />)

    await user.type(screen.getByLabelText(/^temporary password/i),'wrongpassword1')
    await user.type(screen.getByLabelText(/^new password/i),'newpassword12345')
    await user.type(screen.getByLabelText(/^confirm/i),'newpassword12345')
    await user.click(screen.getByRole('button', { name: /set new password/i }))

    await waitFor(() => {
      expect(screen.getByText('Current password is incorrect.')).toBeTruthy()
    })
  })

  it('shows fallback error message when API returns no detail', async () => {
    const user = userEvent.setup()
    mockChangePassword.mockRejectedValue(new Error('Network error'))

    render(<ForceChangePasswordModal user={baseUser} onChanged={onChanged} />)

    await user.type(screen.getByLabelText(/^temporary password/i),'oldpassword123')
    await user.type(screen.getByLabelText(/^new password/i),'newpassword12345')
    await user.type(screen.getByLabelText(/^confirm/i),'newpassword12345')
    await user.click(screen.getByRole('button', { name: /set new password/i }))

    await waitFor(() => {
      expect(screen.getByText('Failed to change password.')).toBeTruthy()
    })
  })
})
