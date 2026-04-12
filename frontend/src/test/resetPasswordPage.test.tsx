import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ResetPasswordPage from '../pages/ResetPasswordPage'

vi.mock('../api/auth', () => ({
  confirmPasswordReset: vi.fn(),
}))

import { confirmPasswordReset } from '../api/auth'
const mockConfirm = confirmPasswordReset as ReturnType<typeof vi.fn>

function renderPage(uid = 'abc', token = 'tok-en123') {
  return render(
    <MemoryRouter initialEntries={[`/reset-password/${uid}/${token}`]}>
      <Routes>
        <Route path="/reset-password/:uid/:token" element={<ResetPasswordPage />} />
        <Route path="/forgot-password" element={<div>forgot-password-page</div>} />
        <Route path="/" element={<div>login-page</div>} />
      </Routes>
    </MemoryRouter>
  )
}

function renderPageNoParams() {
  return render(
    <MemoryRouter initialEntries={['/reset-password']}>
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/forgot-password" element={<div>forgot-password-page</div>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the password form when uid and token are present', () => {
    renderPage()
    expect(screen.getByLabelText('New password')).toBeInTheDocument()
    expect(screen.getByLabelText('Confirm new password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set new password' })).toBeInTheDocument()
  })

  it('shows expired-token state immediately when params are missing', () => {
    renderPageNoParams()
    expect(screen.getByText('Link expired or invalid')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Request a new link' })).toBeInTheDocument()
  })

  it('shows an error when passwords do not match', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('New password'), 'Password123')
    await user.type(screen.getByLabelText('Confirm new password'), 'Different123')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Passwords do not match')
    expect(mockConfirm).not.toHaveBeenCalled()
  })

  it('shows an error when password is too short', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('New password'), 'short')
    await user.type(screen.getByLabelText('Confirm new password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(screen.getByRole('alert')).toHaveTextContent('at least 8 characters')
    expect(mockConfirm).not.toHaveBeenCalled()
  })

  it('shows success state on valid submission', async () => {
    mockConfirm.mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('New password'), 'NewPass9876')
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPass9876')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    await waitFor(() => {
      expect(screen.getByText('Password updated')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(mockConfirm).toHaveBeenCalledWith('abc', 'tok-en123', 'NewPass9876', 'NewPass9876')
  })

  it('shows token-invalid state and "Request a new link" CTA on token error', async () => {
    mockConfirm.mockRejectedValue({
      response: { data: { token: ['Invalid token.'] } },
    })
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('New password'), 'NewPass9876')
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPass9876')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    await waitFor(() => {
      expect(screen.getByText('Link expired or invalid')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Request a new link' })).toBeInTheDocument()
  })

  it('"Request a new link" navigates to /forgot-password', async () => {
    mockConfirm.mockRejectedValue({
      response: { data: { token: ['Invalid token.'] } },
    })
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('New password'), 'NewPass9876')
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPass9876')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Request a new link' })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: 'Request a new link' }))
    expect(screen.getByText('forgot-password-page')).toBeInTheDocument()
  })

  it('shows a generic error message on non-token API failure', async () => {
    mockConfirm.mockRejectedValue(new Error('Network error'))
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('New password'), 'NewPass9876')
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPass9876')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong')
    })
    // Form remains interactive — no token-invalid state
    expect(screen.queryByText('Link expired or invalid')).not.toBeInTheDocument()
  })
})
