import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
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

    await user.type(screen.getByLabelText('New password'), 'Password1234')
    await user.type(screen.getByLabelText('Confirm new password'), 'Different123')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Passwords do not match')
    expect(mockConfirm).not.toHaveBeenCalled()
  })

  it('shows an error when password is too short', async () => {
    const user = userEvent.setup()
    renderPage()

    // 11 characters: one below the 12-character server policy (#1258).
    await user.type(screen.getByLabelText('New password'), 'Password123')
    await user.type(screen.getByLabelText('Confirm new password'), 'Password123')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(screen.getByRole('alert')).toHaveTextContent('at least 12 characters')
    expect(mockConfirm).not.toHaveBeenCalled()
  })

  it('shows success state on valid submission', async () => {
    mockConfirm.mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('New password'), 'NewPassword9876')
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPassword9876')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    await waitFor(() => {
      expect(screen.getByText('Password updated')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(mockConfirm).toHaveBeenCalledWith('abc', 'tok-en123', 'NewPassword9876', 'NewPassword9876')
  })

  async function reachSuccess() {
    mockConfirm.mockResolvedValue(undefined)
    renderPage()
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewPassword9876' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewPassword9876' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }))
    await act(async () => {})
    expect(screen.getByText('Password updated')).toBeInTheDocument()
  }

  it('announces the redirect and navigates to / after the 5-second countdown (#1374, #2484)', async () => {
    vi.useFakeTimers()
    try {
      await reachSuccess()
      expect(screen.getByRole('status')).toHaveTextContent(/taken to the next page in 5 seconds/)
      expect(screen.getByText('Redirecting in 5s\u2026')).toBeInTheDocument()

      await act(async () => { vi.advanceTimersByTime(4000) })
      expect(screen.queryByText('login-page')).not.toBeInTheDocument()

      await act(async () => { vi.advanceTimersByTime(1000) })
      expect(screen.getByText('login-page')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not navigate while the redirect is paused (WCAG 2.2.1)', async () => {
    vi.useFakeTimers()
    try {
      await reachSuccess()
      fireEvent.click(screen.getByRole('button', { name: 'Pause redirect' }))
      expect(screen.getByRole('status')).toHaveTextContent(/Redirect paused/)

      await act(async () => { vi.advanceTimersByTime(20000) })
      expect(screen.queryByText('login-page')).not.toBeInTheDocument()
      expect(screen.getByText('Password updated')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows token-invalid state and "Request a new link" CTA on token error', async () => {
    mockConfirm.mockRejectedValue({
      response: { data: { token: ['Invalid token.'] } },
    })
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('New password'), 'NewPassword9876')
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPassword9876')
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

    await user.type(screen.getByLabelText('New password'), 'NewPassword9876')
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPassword9876')
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

    await user.type(screen.getByLabelText('New password'), 'NewPassword9876')
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPassword9876')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong')
    })
    // Form remains interactive — no token-invalid state
    expect(screen.queryByText('Link expired or invalid')).not.toBeInTheDocument()
  })

  // #1759: the other shapes a refused link arrives in, and a refusal that is not about the link.
  it.each([
    ['a uid error', { uid: ['Invalid value'] }],
    ['a non-field token error', { non_field_errors: ['This link has expired.'] }],
  ])('treats %s as an invalid link', async (_name, data) => {
    mockConfirm.mockRejectedValue({ response: { data } })
    renderPage()
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewPassword9876' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewPassword9876' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }))
    expect(await screen.findByText('Link expired or invalid')).toBeInTheDocument()
  })

  it('keeps the form for a password refusal that is not about the link', async () => {
    mockConfirm.mockRejectedValue({ response: { data: { new_password2: ['This password is too common.'] } } })
    renderPage()
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewPassword9876' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewPassword9876' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong')
    expect(screen.queryByText('Link expired or invalid')).not.toBeInTheDocument()
    expect(screen.getByLabelText('New password')).toBeInTheDocument()
  })
})
