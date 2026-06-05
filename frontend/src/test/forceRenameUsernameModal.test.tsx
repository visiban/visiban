import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ForceRenameUsernameModal from '../components/Auth/ForceRenameUsernameModal'
import type { User } from '../types'

vi.mock('../api/auth', () => ({
  chooseUsername: vi.fn(),
}))

import { chooseUsername } from '../api/auth'
const mockChooseUsername = chooseUsername as ReturnType<typeof vi.fn>

const baseUser: User = {
  id: 1,
  username: '_rename_1',
  email: 'test@example.com',
  first_name: '',
  last_name: '',
  avatar_url: '',
  display_name: '',
  is_site_admin: false,
  must_change_password: false,
  must_change_username: true,
}

describe('ForceRenameUsernameModal', () => {
  let onChanged: Mock<(updatedUser: User) => void>

  beforeEach(() => {
    onChanged = vi.fn<(updatedUser: User) => void>()
    vi.clearAllMocks()
  })

  it('renders modal with title and explanation', () => {
    render(<ForceRenameUsernameModal user={baseUser} onChanged={onChanged} />)
    expect(screen.getByText('Choose a username')).toBeTruthy()
    expect(screen.getByText(/auto-generated/)).toBeTruthy()
  })

  it('shows previous username', () => {
    render(<ForceRenameUsernameModal user={baseUser} onChanged={onChanged} />)
    expect(screen.getByText('_rename_1')).toBeTruthy()
  })

  it('shows suggestion chips from email', () => {
    render(<ForceRenameUsernameModal user={baseUser} onChanged={onChanged} />)
    expect(screen.getByText('test')).toBeTruthy()
  })

  it('clicking suggestion fills the input', async () => {
    const user = userEvent.setup()
    render(<ForceRenameUsernameModal user={baseUser} onChanged={onChanged} />)
    await user.click(screen.getByText('test'))
    const input = screen.getByPlaceholderText('Pick a username') as HTMLInputElement
    expect(input.value).toBe('test')
  })

  it('submits valid username successfully', async () => {
    const user = userEvent.setup()
    const updatedUser = { ...baseUser, username: 'newname', must_change_username: false }
    mockChooseUsername.mockResolvedValue(updatedUser)

    render(<ForceRenameUsernameModal user={baseUser} onChanged={onChanged} />)
    const input = screen.getByPlaceholderText('Pick a username')
    await user.type(input, 'newname')
    await user.click(screen.getByText('Set username'))

    await waitFor(() => {
      expect(mockChooseUsername).toHaveBeenCalledWith('newname')
      expect(onChanged).toHaveBeenCalled()
    })
  })

  it('shows server error on failure', async () => {
    const user = userEvent.setup()
    mockChooseUsername.mockRejectedValue({
      response: { data: { detail: 'That username is already taken.' } },
    })

    render(<ForceRenameUsernameModal user={baseUser} onChanged={onChanged} />)
    const input = screen.getByPlaceholderText('Pick a username')
    await user.type(input, 'taken')
    await user.click(screen.getByText('Set username'))

    await waitFor(() => {
      expect(screen.getByText('That username is already taken.')).toBeTruthy()
    })
  })

  it('shows client-side error for invalid characters', async () => {
    const user = userEvent.setup()
    render(<ForceRenameUsernameModal user={baseUser} onChanged={onChanged} />)
    const input = screen.getByPlaceholderText('Pick a username')
    await user.type(input, 'bad name!')
    await user.click(screen.getByText('Set username'))
    expect(screen.getByText(/may only contain/)).toBeTruthy()
    expect(mockChooseUsername).not.toHaveBeenCalled()
  })
})
