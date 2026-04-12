import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import ForgotPasswordPage from '../pages/ForgotPasswordPage'

vi.mock('../api/auth', () => ({
  requestPasswordReset: vi.fn(),
}))

import { requestPasswordReset } from '../api/auth'
const mockRequest = requestPasswordReset as ReturnType<typeof vi.fn>

function renderPage() {
  return render(
    <MemoryRouter>
      <ForgotPasswordPage />
    </MemoryRouter>
  )
}

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the email input and submit button', () => {
    renderPage()
    expect(screen.getByLabelText('Email address')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeInTheDocument()
    expect(screen.getByText('← Back to sign in')).toBeInTheDocument()
  })

  it('shows confirmation regardless of whether the email is registered', async () => {
    mockRequest.mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('Email address'), 'anyone@example.com')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))

    await waitFor(() => {
      expect(screen.getByText('Check your email')).toBeInTheDocument()
    })
    expect(screen.getByText(/anyone@example.com/)).toBeInTheDocument()
    expect(mockRequest).toHaveBeenCalledWith('anyone@example.com')
  })

  it('shows the same confirmation even when the API would return an error', async () => {
    // The endpoint always returns 200; this covers a network failure path
    mockRequest.mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('Email address'), 'nobody@example.com')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))

    await waitFor(() => {
      expect(screen.getByText('Check your email')).toBeInTheDocument()
    })
    // No "email not found" message ever shown
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument()
  })

  it('shows an error message on network failure', async () => {
    mockRequest.mockRejectedValue(new Error('Network error'))
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('Email address'), 'test@example.com')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong')
    })
    // Form is still interactive after an error
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeInTheDocument()
    expect(screen.queryByText('Check your email')).not.toBeInTheDocument()
  })

  it('disables the submit button while submitting', async () => {
    let resolve!: () => void
    mockRequest.mockReturnValue(new Promise<void>((r) => { resolve = r }))
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('Email address'), 'test@example.com')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))

    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()
    resolve()
  })

  it('confirmation state shows "Back to sign in" button', async () => {
    mockRequest.mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('Email address'), 'test@example.com')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeInTheDocument()
    })
  })
})
