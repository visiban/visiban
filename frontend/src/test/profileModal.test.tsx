import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProfileModal from '../components/Auth/ProfileModal'
import type { User } from '../types'

vi.mock('../api/auth', () => ({
  updateCurrentUser: vi.fn(),
}))

import { updateCurrentUser } from '../api/auth'

const mockUpdateCurrentUser = updateCurrentUser as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1,
  username: 'jdoe',
  email: 'j@example.com',
  first_name: 'Jane',
  last_name: 'Doe',
  avatar_url: '',
  display_name: 'Jane Doe',
  is_site_admin: false,
  must_change_password: false, must_change_username: false,
}

describe('ProfileModal', () => {
  const onClose = vi.fn()
  const onUpdated = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders profile form with user data', () => {
    render(<ProfileModal user={fakeUser} onClose={onClose} onUpdated={onUpdated} />)
    expect(screen.getByText('Your profile')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Jane Doe')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Jane')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Doe')).toBeInTheDocument()
    expect(screen.getByDisplayValue('jdoe')).toBeInTheDocument()
    expect(screen.getByDisplayValue('j@example.com')).toBeInTheDocument()
  })

  it('renders save and cancel buttons', () => {
    render(<ProfileModal user={fakeUser} onClose={onClose} onUpdated={onUpdated} />)
    expect(screen.getByText('Save changes')).toBeInTheDocument()
    expect(screen.getByText('Cancel')).toBeInTheDocument()
  })

  it('calls onClose when cancel is clicked', async () => {
    render(<ProfileModal user={fakeUser} onClose={onClose} onUpdated={onUpdated} />)
    await userEvent.setup().click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose on close button click', async () => {
    render(<ProfileModal user={fakeUser} onClose={onClose} onUpdated={onUpdated} />)
    await userEvent.setup().click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('submits form and calls onUpdated', async () => {
    const updatedUser = { ...fakeUser, display_name: 'Jane Updated' }
    mockUpdateCurrentUser.mockResolvedValue(updatedUser)

    render(<ProfileModal user={fakeUser} onClose={onClose} onUpdated={onUpdated} />)
    await userEvent.setup().click(screen.getByText('Save changes'))

    expect(mockUpdateCurrentUser).toHaveBeenCalled()
  })

  it('shows error on save failure', async () => {
    mockUpdateCurrentUser.mockRejectedValue(new Error('fail'))

    render(<ProfileModal user={fakeUser} onClose={onClose} onUpdated={onUpdated} />)
    await userEvent.setup().click(screen.getByText('Save changes'))

    expect(await screen.findByText('Failed to save changes. Please try again.')).toBeInTheDocument()
  })
})
