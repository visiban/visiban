import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

vi.mock('../api/auth', () => ({
  verifyEmail: vi.fn(),
}))

import { verifyEmail } from '../api/auth'
import ConfirmEmailPage from '../pages/ConfirmEmailPage'

const mockVerifyEmail = verifyEmail as ReturnType<typeof vi.fn>

function renderPage(key = 'Mg:1uABcd-validkey') {
  return render(
    <MemoryRouter initialEntries={[`/confirm-email/${key}`]}>
      <Routes>
        <Route path="/confirm-email/:key" element={<ConfirmEmailPage />} />
        <Route path="/" element={<div>login-page</div>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('ConfirmEmailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows a loading/verifying state on mount before the API resolves', () => {
    // Never resolve — stays in flight
    mockVerifyEmail.mockReturnValue(new Promise(() => {}))
    renderPage()
    expect(screen.getByText('Verifying your email\u2026')).toBeInTheDocument()
    // Success and error content must not be visible during loading
    expect(screen.queryByText('Email verified')).not.toBeInTheDocument()
    expect(screen.queryByText('Link expired or invalid')).not.toBeInTheDocument()
  })

  it('shows the success heading and sign-in button when verification succeeds', async () => {
    mockVerifyEmail.mockResolvedValue(undefined)
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Email verified')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByText(/Your email address has been confirmed/)).toBeInTheDocument()
  })

  it('shows a countdown and navigates to / after the timer fires', async () => {
    // Fake timers only for this test — avoids breaking waitFor's internal polling.
    // Use await act(async () => {}) to flush microtasks (promise resolution + React
    // state update) before advancing timers; runAllTimersAsync is intentionally
    // avoided here because the setInterval has no natural end until countdown hits 0,
    // which would trigger Vitest's infinite-loop guard.
    vi.useFakeTimers()
    try {
      mockVerifyEmail.mockResolvedValue(undefined)
      renderPage()

      // Flush the resolved promise microtask and React re-render
      await act(async () => {})

      expect(screen.getByText('Email verified')).toBeInTheDocument()

      // Advance past the full 3-second countdown
      await act(async () => { vi.advanceTimersByTime(3000) })

      expect(screen.getByText('login-page')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('navigates to / immediately when the "Sign in" button is clicked', async () => {
    const user = userEvent.setup()
    mockVerifyEmail.mockResolvedValue(undefined)
    renderPage()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(screen.getByText('login-page')).toBeInTheDocument()
  })

  it('shows the error heading and "Go to sign in" button when verification fails', async () => {
    mockVerifyEmail.mockRejectedValue(new Error('Invalid or expired key'))
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Link expired or invalid')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Go to sign in' })).toBeInTheDocument()
    expect(screen.getByText(/This confirmation link has expired/)).toBeInTheDocument()
  })

  // #1293: a valid key for an address another account already verified.
  it('shows the in-use state (not the expired-link one) on a 409 email_in_use', async () => {
    mockVerifyEmail.mockRejectedValue({ response: { status: 409, data: { code: 'email_in_use' } } })
    renderPage()

    const heading = await screen.findByRole('heading', { name: 'Email address already in use' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.getByText(/already belongs to another account/)).toBeInTheDocument()
    expect(screen.queryByText('Link expired or invalid')).not.toBeInTheDocument()
    expect(screen.queryByText('Email verified')).not.toBeInTheDocument()
  })

  function renderInUse(isAuthenticated: boolean) {
    mockVerifyEmail.mockRejectedValue({ response: { status: 409, data: { code: 'email_in_use' } } })
    return render(
      <MemoryRouter initialEntries={['/confirm-email/k']}>
        <Routes>
          <Route path="/confirm-email/:key" element={<ConfirmEmailPage isAuthenticated={isAuthenticated} />} />
          <Route path="/settings" element={<div>settings-page</div>} />
          <Route path="/" element={<div>login-page</div>} />
        </Routes>
      </MemoryRouter>
    )
  }

  it('signed in (email change): in-use state points to Settings', async () => {
    const user = userEvent.setup()
    renderInUse(true)
    await user.click(await screen.findByRole('button', { name: 'Go to Settings' }))
    expect(screen.getByText('settings-page')).toBeInTheDocument()
  })

  it('signed in: in-use copy is about changing the address, not signing up', async () => {
    renderInUse(true)
    expect(await screen.findByText(/If you were changing your email address/)).toBeInTheDocument()
    expect(screen.queryByText(/If you were signing up/)).not.toBeInTheDocument()
  })

  it('signed out (signup): in-use state offers sign in, never Settings', async () => {
    const user = userEvent.setup()
    renderInUse(false)
    expect(await screen.findByText(/If you were signing up, sign up again with a different email address/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Go to Settings' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Go to sign in' }))
    expect(screen.getByText('login-page')).toBeInTheDocument()
  })

  it('defaults to the signed-out in-use copy when isAuthenticated is omitted', async () => {
    mockVerifyEmail.mockRejectedValue({ response: { status: 409, data: { code: 'email_in_use' } } })
    renderPage()
    expect(await screen.findByRole('button', { name: 'Go to sign in' })).toBeInTheDocument()
  })

  it('treats any other 409 as the generic error', async () => {
    mockVerifyEmail.mockRejectedValue({ response: { status: 409, data: {} } })
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('Link expired or invalid')).toBeInTheDocument()
    })
  })

  it('"Go to sign in" button navigates to / on error state', async () => {
    const user = userEvent.setup()
    mockVerifyEmail.mockRejectedValue(new Error('bad key'))
    renderPage()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Go to sign in' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Go to sign in' }))

    expect(screen.getByText('login-page')).toBeInTheDocument()
  })

  it('calls verifyEmail exactly once (hasFired ref prevents double-invoke within a single instance)', async () => {
    mockVerifyEmail.mockResolvedValue(undefined)

    render(
      <MemoryRouter initialEntries={['/confirm-email/test-key-123']}>
        <Routes>
          <Route path="/confirm-email/:key" element={<ConfirmEmailPage />} />
          <Route path="/" element={<div>login-page</div>} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('Email verified')).toBeInTheDocument()
    })

    // A single component instance must only call verifyEmail once regardless
    // of how many times the effect body runs (React StrictMode fires it twice)
    expect(mockVerifyEmail).toHaveBeenCalledTimes(1)
    expect(mockVerifyEmail).toHaveBeenCalledWith('test-key-123')
  })

  it('passes the key from the URL to verifyEmail', async () => {
    mockVerifyEmail.mockResolvedValue(undefined)
    renderPage('Mg:1uABcd-specifickey')

    await waitFor(() => {
      expect(mockVerifyEmail).toHaveBeenCalledWith('Mg:1uABcd-specifickey')
    })
  })

  it('displays the Visiban wordmark', () => {
    mockVerifyEmail.mockReturnValue(new Promise(() => {}))
    renderPage()
    expect(screen.getByAltText('Visiban')).toBeInTheDocument()
  })

  it('countdown text is visible during success state', async () => {
    vi.useFakeTimers()
    try {
      mockVerifyEmail.mockResolvedValue(undefined)
      renderPage()

      await act(async () => { await vi.runAllTimersAsync() })

      expect(screen.getByText(/Redirecting in/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('countdown decrements each second', async () => {
    vi.useFakeTimers()
    try {
      mockVerifyEmail.mockResolvedValue(undefined)
      renderPage()

      await act(async () => { await vi.runAllTimersAsync() })

      expect(screen.getByText('Redirecting in 3s\u2026')).toBeInTheDocument()

      await act(async () => { vi.advanceTimersByTime(1000) })

      expect(screen.getByText('Redirecting in 2s\u2026')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
