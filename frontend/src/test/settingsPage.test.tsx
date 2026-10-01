import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import SettingsPage from '../pages/SettingsPage'
import type { User } from '../types'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

vi.mock('../components/Layout/Navbar', () => ({
  default: () => <div data-testid="navbar" />,
}))

const mockUpdateCurrentUser = vi.fn()
const mockChangePassword = vi.fn()
const mockResetTour = vi.fn()
const mockCancelPendingEmailChange = vi.fn()
const mockResendPendingEmailConfirmation = vi.fn()
const NO_PROVIDERS = { google: false, github: false, gitlab: false, oidc: false, oidc_name: null }
const mockGetAuthProviders = vi.fn(() => Promise.resolve(NO_PROVIDERS))
const mockListConnectedAccounts = vi.fn(() => Promise.resolve([] as unknown[]))
const mockDisconnectAccount = vi.fn()
const mockStartProviderConnect = vi.fn()

vi.mock('../api/auth', () => ({
  updateCurrentUser: (...args: unknown[]) => mockUpdateCurrentUser(...args),
  changePassword: (...args: unknown[]) => mockChangePassword(...args),
  resetTour: (...args: unknown[]) => mockResetTour(...args),
  cancelPendingEmailChange: (...args: unknown[]) => mockCancelPendingEmailChange(...args),
  resendPendingEmailConfirmation: (...args: unknown[]) => mockResendPendingEmailConfirmation(...args),
  getAuthProviders: () => mockGetAuthProviders(),
  listConnectedAccounts: () => mockListConnectedAccounts(),
  disconnectAccount: (...args: unknown[]) => mockDisconnectAccount(...args),
}))

vi.mock('../utils/oauth', () => ({
  startProviderConnect: (...args: unknown[]) => mockStartProviderConnect(...args),
}))

const mockSetPreference = vi.fn()

vi.mock('../context/ThemeContext', () => ({
  useTheme: () => ({ preference: 'dark', setPreference: mockSetPreference }),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  has_usable_password: true,
}

function renderSettings(user: User = fakeUser, locationState?: object) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/settings', state: locationState }]}>
      <SettingsPage user={user} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
    </MemoryRouter>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the Settings heading', () => {
    renderSettings()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('renders the navbar', () => {
    renderSettings()
    expect(screen.getByTestId('navbar')).toBeInTheDocument()
  })

  it('default tab is Profile and profile form renders', () => {
    renderSettings()
    // "Profile" appears as both a tab button and an h2 heading
    expect(screen.getAllByText('Profile').length).toBeGreaterThanOrEqual(1)
    // Profile form fields
    expect(screen.getByPlaceholderText('How you appear on the board')).toBeInTheDocument()
    expect(screen.getByDisplayValue('jdoe')).toBeInTheDocument()
    expect(screen.getByDisplayValue('j@example.com')).toBeInTheDocument()
  })

  it('tab navigation: clicking Security shows security form', async () => {
    const user = userEvent.setup()
    renderSettings()
    // Click the Security tab in the sidebar nav
    const securityTab = screen.getAllByText('Security')[0]
    await user.click(securityTab)
    expect(screen.getByText('New password')).toBeInTheDocument()
    expect(screen.getByText('Confirm new password')).toBeInTheDocument()
  })

  it('tab navigation: clicking Notifications shows notification toggles', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('Notifications'))
    expect(screen.getByText(/Choose which events notify you in the app/)).toBeInTheDocument()
  })

  it('tab navigation: clicking Appearance shows theme options', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('Appearance'))
    expect(screen.getByText('Theme')).toBeInTheDocument()
    expect(screen.getByText('System')).toBeInTheDocument()
    expect(screen.getByText('Dark')).toBeInTheDocument()
  })

})

// ---------------------------------------------------------------------------
// ProfileTab
// ---------------------------------------------------------------------------

describe('ProfileTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.clearAllTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('filling and submitting form calls updateCurrentUser', async () => {
    const updatedUser = { ...fakeUser, display_name: 'Updated Name' }
    mockUpdateCurrentUser.mockResolvedValueOnce(updatedUser)
    const onUserUpdated = vi.fn()
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <SettingsPage user={fakeUser} onLogout={vi.fn()} onUserUpdated={onUserUpdated} />
      </MemoryRouter>,
    )
    const displayNameInput = screen.getByPlaceholderText('How you appear on the board')
    await user.clear(displayNameInput)
    await user.type(displayNameInput, 'Updated Name')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mockUpdateCurrentUser).toHaveBeenCalledTimes(1))
    expect(mockUpdateCurrentUser).toHaveBeenCalledWith(
      expect.objectContaining({ display_name: 'Updated Name' }),
    )
    expect(onUserUpdated).toHaveBeenCalledWith(updatedUser)
  })

  it('shows success message after save', async () => {
    mockUpdateCurrentUser.mockResolvedValueOnce(fakeUser)
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.getByText('Changes saved.')).toBeInTheDocument())
  })

  it('navigates to "/" after the saved flash', async () => {
    vi.useFakeTimers()
    mockUpdateCurrentUser.mockResolvedValueOnce(fakeUser)
    renderSettings()
    // Use fireEvent (synchronous) so we don't depend on userEvent's internal timers
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
      // Flush the resolved promise from mockUpdateCurrentUser
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText('Changes saved.')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
  })

  it('navigates back to "from" location state after save', async () => {
    vi.useFakeTimers()
    mockUpdateCurrentUser.mockResolvedValueOnce(fakeUser)
    const fromLocation = { pathname: '/boards/1', search: '', hash: '', state: null, key: 'abc' }
    renderSettings(fakeUser, { from: fromLocation })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => { vi.advanceTimersByTime(1500) })
    expect(mockNavigate).toHaveBeenCalledWith(fromLocation, { replace: true })
  })

  it('falls back to "/" when no "from" state is present', async () => {
    vi.useFakeTimers()
    mockUpdateCurrentUser.mockResolvedValueOnce(fakeUser)
    renderSettings(fakeUser) // no location state
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => { vi.advanceTimersByTime(1500) })
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
  })

  it('shows error message on save failure', async () => {
    mockUpdateCurrentUser.mockRejectedValueOnce(new Error('Server error'))
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(screen.getByText('Failed to save changes. Please try again.')).toBeInTheDocument(),
    )
  })

  // #1273: EMAIL_VERIFICATION=mandatory holds a new address until confirmed.
  it('shows a pending-confirmation notice and stays on the page when the email change is pending', async () => {
    vi.useFakeTimers()
    mockUpdateCurrentUser.mockResolvedValueOnce({ ...fakeUser, pending_email: 'new@example.com' })
    renderSettings()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText(/we sent a link to new@example\.com/)).toBeInTheDocument()
    // The field shows the address still in effect, not the pending one.
    expect(screen.getByDisplayValue('j@example.com')).toBeInTheDocument()
    // State-specific result copy replaces the generic one; never both.
    expect(
      screen.getByText('Profile updated. Check your inbox to confirm your new email address.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Changes saved.')).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1500) })
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('omits an unchanged email from the save, so a pending change is not withdrawn', async () => {
    mockUpdateCurrentUser.mockResolvedValueOnce(fakeUser)
    const user = userEvent.setup()
    renderSettings({ ...fakeUser, pending_email: 'new@example.com' })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mockUpdateCurrentUser).toHaveBeenCalledTimes(1))
    expect(mockUpdateCurrentUser.mock.calls[0][0]).not.toHaveProperty('email')
  })

  it('sends the email when it was edited', async () => {
    mockUpdateCurrentUser.mockResolvedValueOnce(fakeUser)
    const user = userEvent.setup()
    renderSettings()
    const emailInput = screen.getByDisplayValue('j@example.com')
    await user.clear(emailInput)
    await user.type(emailInput, 'other@example.com')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mockUpdateCurrentUser).toHaveBeenCalledTimes(1))
    expect(mockUpdateCurrentUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'other@example.com' }),
    )
  })

  it('shows the pending-confirmation notice on load', () => {
    renderSettings({ ...fakeUser, pending_email: 'new@example.com' })
    expect(screen.getByText(/we sent a link to new@example\.com/)).toBeInTheDocument()
  })

  it('reserves the pending-note slot and keeps aria-describedby stable when nothing is pending', () => {
    renderSettings({ ...fakeUser, pending_email: null })
    const note = screen.getByTestId('pending-email-note')
    expect(note).toBeInTheDocument()
    expect(note).toBeEmptyDOMElement()
    expect(note).toHaveAttribute('id', 'pending-email-note')
    expect(screen.getByDisplayValue('j@example.com')).toHaveAttribute(
      'aria-describedby',
      'pending-email-note',
    )
    expect(screen.queryByText(/we sent a link to/)).not.toBeInTheDocument()
  })

  it('aria-describedby points at the same note id while a change is pending', () => {
    renderSettings({ ...fakeUser, pending_email: 'new@example.com' })
    expect(screen.getByDisplayValue('j@example.com')).toHaveAttribute(
      'aria-describedby',
      'pending-email-note',
    )
    expect(screen.getByTestId('pending-email-note')).toHaveTextContent(/new@example\.com/)
  })

  it('announces the save result through a polite, atomic live region', async () => {
    mockUpdateCurrentUser.mockResolvedValueOnce(fakeUser)
    const user = userEvent.setup()
    renderSettings()
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveAttribute('aria-atomic', 'true')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(status).toHaveTextContent('Changes saved.'))
  })

  it('shows the server username error on a taken username', async () => {
    mockUpdateCurrentUser.mockRejectedValueOnce({
      response: { status: 400, data: { username: ['That username is already taken.'] } },
    })
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(screen.getByText('That username is already taken.')).toBeInTheDocument(),
    )
  })

  it('shows "Saving…" button text while saving', async () => {
    let resolveUpdate!: (value: User) => void
    mockUpdateCurrentUser.mockReturnValueOnce(
      new Promise<User>((res) => { resolveUpdate = res }),
    )
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled()
    resolveUpdate(fakeUser)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument())
  })
})

// ---------------------------------------------------------------------------
// ProfileTab — resend / cancel a pending email change (#1293)
// ---------------------------------------------------------------------------

describe('ProfileTab — pending email actions', () => {
  const pendingUser: User = { ...fakeUser, pending_email: 'new@example.com' }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  function renderPending(onUserUpdated = vi.fn()) {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <SettingsPage user={pendingUser} onLogout={vi.fn()} onUserUpdated={onUserUpdated} />
      </MemoryRouter>,
    )
    return onUserUpdated
  }

  it('shows Resend link and Cancel change only while a change is pending', () => {
    const { unmount } = renderSettings({ ...fakeUser, pending_email: null })
    expect(screen.queryByRole('button', { name: 'Resend link' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel change' })).not.toBeInTheDocument()
    unmount()
    renderPending()
    expect(screen.getByRole('button', { name: 'Resend link' })).toHaveAttribute('type', 'button')
    expect(screen.getByRole('button', { name: 'Cancel change' })).toHaveAttribute('type', 'button')
  })

  it('keeps the actions out of the email input accessible name', () => {
    renderPending()
    expect(screen.getByRole('textbox', { name: 'Email address' })).toHaveValue('j@example.com')
  })

  it('both actions are described by the pending note', () => {
    renderPending()
    for (const name of ['Resend link', 'Cancel change']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-describedby', 'pending-email-note')
    }
  })

  it('Resend link calls the API and announces success in the live region', async () => {
    mockResendPendingEmailConfirmation.mockResolvedValueOnce({ detail: 'Confirmation email sent.' })
    const user = userEvent.setup()
    renderPending()
    await user.click(screen.getByRole('button', { name: 'Resend link' }))
    expect(mockResendPendingEmailConfirmation).toHaveBeenCalledTimes(1)
    const status = screen.getByRole('status')
    await waitFor(() =>
      expect(status).toHaveTextContent('We sent a new confirmation link to new@example.com.'),
    )
    expect(status.querySelector('.text-success')).not.toBeNull()
    // Still pending: the note and actions stay.
    expect(screen.getByRole('button', { name: 'Resend link' })).toBeEnabled()
    expect(mockUpdateCurrentUser).not.toHaveBeenCalled()
  })

  it('shows the server cooldown message as a warning on 429', async () => {
    mockResendPendingEmailConfirmation.mockRejectedValueOnce({
      response: { status: 429, data: { detail: 'A confirmation email was sent to this address a moment ago.' } },
    })
    const user = userEvent.setup()
    renderPending()
    await user.click(screen.getByRole('button', { name: 'Resend link' }))
    const status = screen.getByRole('status')
    await waitFor(() =>
      expect(status).toHaveTextContent('A confirmation email was sent to this address a moment ago.'),
    )
    expect(status.querySelector('.text-warning')).not.toBeNull()
  })

  it('clears the pending state when the server says nothing is pending (404)', async () => {
    mockResendPendingEmailConfirmation.mockRejectedValueOnce({
      response: { status: 404, data: { detail: 'No email change is waiting for confirmation.' } },
    })
    const user = userEvent.setup()
    renderPending()
    await user.click(screen.getByRole('button', { name: 'Resend link' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/no email change waiting for confirmation anymore/),
    )
    expect(screen.queryByRole('button', { name: 'Resend link' })).not.toBeInTheDocument()
    expect(screen.getByTestId('pending-email-note')).toBeEmptyDOMElement()
  })

  it('shows a generic error when resend fails otherwise', async () => {
    mockResendPendingEmailConfirmation.mockRejectedValueOnce(new Error('network'))
    const user = userEvent.setup()
    renderPending()
    await user.click(screen.getByRole('button', { name: 'Resend link' }))
    await waitFor(() =>
      expect(screen.getByText("Couldn't resend the link. Please try again.")).toHaveClass('text-danger'),
    )
  })

  it('disables both actions and Save while a resend is in flight', async () => {
    let resolve!: (v: { detail: string }) => void
    mockResendPendingEmailConfirmation.mockReturnValueOnce(new Promise((res) => { resolve = res }))
    const user = userEvent.setup()
    renderPending()
    await user.click(screen.getByRole('button', { name: 'Resend link' }))
    expect(await screen.findByRole('button', { name: 'Sending…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel change' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    resolve({ detail: 'ok' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resend link' })).toBeEnabled())
  })

  it('Cancel change withdraws the change, clears the note and moves focus to the field', async () => {
    mockCancelPendingEmailChange.mockResolvedValueOnce({ ...fakeUser, pending_email: null })
    const user = userEvent.setup()
    const onUserUpdated = renderPending()
    await user.click(screen.getByRole('button', { name: 'Cancel change' }))
    expect(mockCancelPendingEmailChange).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        "Email change canceled. Your email address hasn't changed.",
      ),
    )
    expect(onUserUpdated).toHaveBeenCalledWith(expect.objectContaining({ pending_email: null }))
    expect(screen.getByTestId('pending-email-note')).toBeEmptyDOMElement()
    expect(screen.queryByRole('button', { name: 'Cancel change' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Email address' })).toHaveFocus()
    // Cancelling is not a save: the page does not navigate away.
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('keeps the pending change and shows an error when cancel fails', async () => {
    mockCancelPendingEmailChange.mockRejectedValueOnce(new Error('network'))
    const user = userEvent.setup()
    renderPending()
    await user.click(screen.getByRole('button', { name: 'Cancel change' }))
    await waitFor(() =>
      expect(screen.getByText("Couldn't cancel the email change. Please try again.")).toHaveClass('text-danger'),
    )
    expect(screen.getByTestId('pending-email-note')).toHaveTextContent(/new@example\.com/)
    expect(screen.getByRole('button', { name: 'Cancel change' })).toBeEnabled()
  })

  it('a later save replaces an action result instead of coexisting with it', async () => {
    mockResendPendingEmailConfirmation.mockResolvedValueOnce({ detail: 'ok' })
    mockUpdateCurrentUser.mockResolvedValueOnce(pendingUser)
    const user = userEvent.setup()
    renderPending()
    await user.click(screen.getByRole('button', { name: 'Resend link' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/We sent a new confirmation link/))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Profile updated. Check your inbox to confirm your new email address.',
      ),
    )
    expect(screen.getByRole('status')).not.toHaveTextContent(/We sent a new confirmation link/)
  })
})

// ---------------------------------------------------------------------------
// SecurityTab
// ---------------------------------------------------------------------------

describe('SecurityTab — password account', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function openSecurityTab() {
    const user = userEvent.setup({ delay: null })
    renderSettings()
    const securityTab = screen.getAllByText('Security')[0]
    await user.click(securityTab)
    return user
  }

  it('shows Current password field for password accounts', async () => {
    await openSecurityTab()
    expect(screen.getByLabelText('Current password')).toBeInTheDocument()
  })

  it('password mismatch shows error', async () => {
    const user = await openSecurityTab()
    await user.type(screen.getByLabelText('Current password'), 'OldPassword1!')
    await user.type(screen.getByLabelText('New password'), 'NewPassword123!')
    await user.type(screen.getByLabelText('Confirm new password'), 'DifferentPassword!')
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    await waitFor(() =>
      expect(screen.getByText('New passwords do not match.')).toBeInTheDocument(),
    )
    expect(mockChangePassword).not.toHaveBeenCalled()
  }, 15000)

  it('password too short shows error', async () => {
    const user = await openSecurityTab()
    await user.type(screen.getByLabelText('Current password'), 'OldPassword1!')
    await user.type(screen.getByLabelText('New password'), 'short')
    await user.type(screen.getByLabelText('Confirm new password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    await waitFor(() =>
      expect(
        screen.getByText('New password must be at least 12 characters.'),
      ).toBeInTheDocument(),
    )
    expect(mockChangePassword).not.toHaveBeenCalled()
  })

  it('successful submit calls changePassword and shows success message', async () => {
    mockChangePassword.mockResolvedValueOnce({ detail: 'ok' })
    const user = await openSecurityTab()
    await user.type(screen.getByLabelText('Current password'), 'OldPassword1!')
    await user.type(screen.getByLabelText('New password'), 'NewPassword123!')
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPassword123!')
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    await waitFor(() =>
      expect(screen.getByText('Password changed successfully.')).toBeInTheDocument(),
      { timeout: 10000 },
    )
    expect(mockChangePassword).toHaveBeenCalledWith('OldPassword1!', 'NewPassword123!')
  }, 15000)
})

describe('SecurityTab — social account (no usable password)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const socialUser: User = { ...fakeUser, has_usable_password: false }

  async function openSecurityTabForSocial() {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <SettingsPage user={socialUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
      </MemoryRouter>,
    )
    const securityTab = screen.getAllByText('Security')[0]
    await user.click(securityTab)
    return user
  }

  it('hides Current password field for social accounts', async () => {
    await openSecurityTabForSocial()
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
  })

  it('shows social account message', async () => {
    await openSecurityTabForSocial()
    expect(
      screen.getByText(/signed in with a social account/i),
    ).toBeInTheDocument()
  })

  it('shows "Set password" button for social accounts', async () => {
    await openSecurityTabForSocial()
    expect(screen.getByRole('button', { name: 'Set password' })).toBeInTheDocument()
  })

  it('successful submit shows "Password set successfully"', async () => {
    mockChangePassword.mockResolvedValueOnce({ detail: 'ok' })
    const user = await openSecurityTabForSocial()
    await user.type(screen.getByLabelText('New password'), 'NewPassword123!')
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPassword123!')
    await user.click(screen.getByRole('button', { name: 'Set password' }))
    await waitFor(() =>
      expect(screen.getByText('Password set successfully.')).toBeInTheDocument(),
      { timeout: 10000 },
    )
  }, 15000)
})

// ---------------------------------------------------------------------------
// SecurityTab — connected accounts (#1314)
// ---------------------------------------------------------------------------

describe('SecurityTab — connected accounts', () => {
  const PROVIDERS = { google: true, github: true, gitlab: false, oidc: false, oidc_name: null }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAuthProviders.mockImplementation(() => Promise.resolve(PROVIDERS))
    mockListConnectedAccounts.mockImplementation(() => Promise.resolve([
      { provider: 'google', connected: true, email: 'jane@gmail.com', connected_at: '2026-09-30T00:00:00Z' },
      { provider: 'github', connected: false },
    ]))
  })

  afterEach(() => {
    mockGetAuthProviders.mockImplementation(() => Promise.resolve(NO_PROVIDERS))
    mockListConnectedAccounts.mockImplementation(() => Promise.resolve([]))
  })

  async function open(user: User = fakeUser, url = '/settings') {
    const ue = userEvent.setup()
    render(
      <MemoryRouter initialEntries={[url]}>
        <SettingsPage user={user} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
      </MemoryRouter>,
    )
    if (!url.includes('connect')) await ue.click(screen.getAllByText('Security')[0])
    await screen.findByTestId('connected-accounts-list')
    return ue
  }

  it('lists only configured providers with their status', async () => {
    await open()
    expect(screen.getByText('Connected accounts')).toBeInTheDocument()
    const google = screen.getByTestId('connected-account-google')
    expect(google).toHaveTextContent('Google')
    expect(google).toHaveTextContent('Connected')
    expect(google).toHaveTextContent('jane@gmail.com')
    expect(screen.getByTestId('connected-account-github')).toHaveTextContent('Not connected')
    expect(screen.queryByTestId('connected-account-gitlab')).not.toBeInTheDocument()
  })

  it('hides the section when no provider is configured', async () => {
    mockGetAuthProviders.mockImplementation(() => Promise.resolve(NO_PROVIDERS))
    const ue = userEvent.setup()
    renderSettings()
    await ue.click(screen.getAllByText('Security')[0])
    await waitFor(() => expect(mockGetAuthProviders).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId('connected-accounts')).not.toBeInTheDocument())
  })

  it('Connect starts the provider round trip and shows Connecting…', async () => {
    const ue = await open()
    await ue.click(screen.getByTestId('connect-github'))
    expect(mockStartProviderConnect).toHaveBeenCalledWith('github')
    expect(screen.getByTestId('connect-github')).toHaveTextContent('Connecting…')
    expect(screen.getByTestId('connect-github')).toBeDisabled()
  })

  it('Disconnect asks for inline confirmation, then disconnects', async () => {
    mockDisconnectAccount.mockResolvedValue([
      { provider: 'google', connected: false },
      { provider: 'github', connected: false },
    ])
    const ue = await open()
    await ue.click(screen.getByTestId('disconnect-google'))
    expect(screen.getByText('Disconnect?')).toBeInTheDocument()
    expect(mockDisconnectAccount).not.toHaveBeenCalled()
    await ue.click(screen.getByTestId('confirm-disconnect-google'))
    expect(mockDisconnectAccount).toHaveBeenCalledWith('google')
    await waitFor(() =>
      expect(screen.getByTestId('connected-account-google')).toHaveTextContent('Not connected'),
    )
  })

  it('Cancel backs out of the disconnect confirmation', async () => {
    const ue = await open()
    await ue.click(screen.getByTestId('disconnect-google'))
    await ue.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Disconnect?')).not.toBeInTheDocument()
    expect(mockDisconnectAccount).not.toHaveBeenCalled()
  })

  it('guards the only sign-in method with aria-disabled and a described hint', async () => {
    const ue = await open({ ...fakeUser, has_usable_password: false })
    const button = screen.getByTestId('disconnect-google')
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toBeDisabled() // stays focusable
    expect(button).toHaveAttribute('aria-describedby', 'disconnect-hint-google')
    expect(document.getElementById('disconnect-hint-google')).toHaveTextContent('This is your only sign-in method.')
    await ue.click(button)
    expect(screen.queryByText('Disconnect?')).not.toBeInTheDocument()
  })

  it('no guard when the user also has a password', async () => {
    await open()
    expect(screen.getByTestId('disconnect-google')).toHaveAttribute('aria-disabled', 'false')
    expect(screen.queryByText('This is your only sign-in method.')).not.toBeInTheDocument()
  })

  it('shows a server refusal in the row', async () => {
    mockDisconnectAccount.mockRejectedValue({ response: { data: { detail: 'Your account has no password set up.' } } })
    const ue = await open()
    await ue.click(screen.getByTestId('disconnect-google'))
    await ue.click(screen.getByTestId('confirm-disconnect-google'))
    expect(await screen.findByText('Your account has no password set up.')).toBeInTheDocument()
  })

  it('a failed list load shows an error with Retry, not "Not connected" rows', async () => {
    mockListConnectedAccounts.mockImplementationOnce(() => Promise.reject(new Error('500')))
    const ue = userEvent.setup()
    renderSettings()
    await ue.click(screen.getAllByText('Security')[0])
    expect(await screen.findByText('Failed to load connected accounts.')).toBeInTheDocument()
    expect(screen.queryByText('Not connected')).not.toBeInTheDocument()
    await ue.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('connected-accounts-list')).toBeInTheDocument()
  })

  it('?connected=<provider> opens Security and marks the row Connected.', async () => {
    mockListConnectedAccounts.mockImplementation(() => Promise.resolve([
      { provider: 'google', connected: true, email: 'jane@gmail.com', connected_at: '2026-09-30T00:00:00Z' },
      { provider: 'github', connected: true, email: null, connected_at: '2026-09-30T00:00:00Z' },
    ]))
    await open(fakeUser, '/settings?connected=github')
    expect(screen.getByTestId('connected-account-github')).toHaveTextContent('Connected.')
    expect(mockNavigate).toHaveBeenCalledWith('.', expect.objectContaining({ replace: true }))
  })

  it('?connect_error=connect_identity_mismatch explains nothing was connected', async () => {
    await open(fakeUser, '/settings?connect_error=connect_identity_mismatch&provider=github')
    expect(screen.getByTestId('connected-account-github')).toHaveTextContent(
      "That isn't the GitHub account that tried to sign in, so nothing was connected.",
    )
  })

  it('an unknown ?connect_error= code shows fixed copy, never the raw value', async () => {
    await open(fakeUser, '/settings?connect_error=Call%20555-0100%20for%20help&provider=github')
    expect(screen.getByTestId('connected-account-github')).toHaveTextContent("Couldn't connect GitHub. Please try again.")
    expect(screen.queryByText(/555-0100/)).not.toBeInTheDocument()
  })

  it('?connect_error=provider_already_connected shows the taken copy on the row', async () => {
    await open(fakeUser, '/settings?connect_error=provider_already_connected&provider=github')
    expect(screen.getByTestId('connected-account-github')).toHaveTextContent(
      "That GitHub account is taken — it's already connected to a different Visiban account.",
    )
  })
})

// ---------------------------------------------------------------------------
// AppearanceTab
// ---------------------------------------------------------------------------

describe('AppearanceTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function openAppearanceTab() {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('Appearance'))
    return user
  }

  it('renders System and Dark theme options', async () => {
    await openAppearanceTab()
    expect(screen.getByText('System')).toBeInTheDocument()
    expect(screen.getByText('Dark')).toBeInTheDocument()
  })

  it('renders Light theme option', async () => {
    await openAppearanceTab()
    expect(screen.getByText('Light')).toBeInTheDocument()
    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument()
  })

  it('clicking System theme option calls setPreference with "system"', async () => {
    // mock starts with preference='dark'; clicking system fires onChange
    const user = await openAppearanceTab()
    const systemRadio = screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).value === 'system')!
    await user.click(systemRadio)
    expect(mockSetPreference).toHaveBeenCalledWith('system')
  })

  it('active theme (dark) shows selected indicator', async () => {
    await openAppearanceTab()
    // The Dark label should have the blue-selected styling
    const darkLabel = screen.getByText('Dark').closest('label')
    expect(darkLabel?.className).toMatch(/border-primary-emphasis/)
  })

  it('renders native radio inputs for accessibility', async () => {
    await openAppearanceTab()
    const radios = screen.getAllByRole('radio')
    expect(radios.length).toBeGreaterThanOrEqual(2)
    // The active theme (dark) radio should be checked
    const darkRadio = radios.find((r) => (r as HTMLInputElement).value === 'dark')
    expect(darkRadio).toBeChecked()
  })
})

// ---------------------------------------------------------------------------
// NotificationsTab
// ---------------------------------------------------------------------------

describe('NotificationsTab', () => {
  // Unlike every sibling describe block above, this one had no reset —
  // mockUpdateCurrentUser.mock.calls silently accumulated across the whole
  // block. Nothing surfaced it until a test needed to assert zero calls.
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows notification preference toggles', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('Notifications'))
    expect(screen.getByText(/Choose which events notify you in the app/)).toBeInTheDocument()
    expect(screen.getByText('Card assigned to me')).toBeInTheDocument()
  })

  it('shows the Notifications heading', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('Notifications'))
    const headings = screen.getAllByText('Notifications')
    const h2 = headings.find((el) => el.tagName === 'H2')
    expect(h2).toBeInTheDocument()
  })

  it('renders every notification preference row', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('Notifications'))
    expect(screen.getByText('Card assigned to me')).toBeInTheDocument()
    expect(screen.getByText('Someone @mentions me')).toBeInTheDocument()
    expect(screen.getByText('Due date approaching')).toBeInTheDocument()
    expect(screen.getByText(/Card I.m watching is moved/)).toBeInTheDocument()
    expect(screen.getByText('Comment on a watched card')).toBeInTheDocument()
    expect(screen.getByText('Card has gone stale')).toBeInTheDocument()
  })

  it('toggles call updateCurrentUser with the new value', async () => {
    const user = userEvent.setup()
    mockUpdateCurrentUser.mockResolvedValueOnce({ ...fakeUser, notif_due_soon: true })
    renderSettings()
    await user.click(screen.getByText('Notifications'))
    // Looked up by accessible name, not by index: each row now contains a second
    // "Also send by email" switch (#356), so positional indexing silently points
    // at a different preference than the comment claims.
    await user.click(screen.getByRole('switch', { name: 'Due date approaching' }))
    expect(mockUpdateCurrentUser).toHaveBeenCalledWith({ notif_due_soon: true })
  })

  it('renders an email toggle for every event that supports one', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('Notifications'))
    for (const label of [
      'Card assigned to me',
      'Someone @mentions me',
      'Due date approaching',
      'Card I\u2019m watching is moved',
      'Comment on a watched card',
    ]) {
      expect(screen.getByRole('switch', { name: `Also send by email: ${label}` })).toBeInTheDocument()
    }
  })

  it('does not render an email toggle for events with no email delivery', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('Notifications'))
    expect(
      screen.queryByRole('switch', { name: 'Also send by email: Card has gone stale' })
    ).not.toBeInTheDocument()
  })

  it('email toggle sends the email_notif_* field', async () => {
    const user = userEvent.setup()
    mockUpdateCurrentUser.mockResolvedValueOnce({ ...fakeUser, email_notif_card_assigned: true })
    renderSettings()
    await user.click(screen.getByText('Notifications'))
    await user.click(screen.getByRole('switch', { name: 'Also send by email: Card assigned to me' }))
    expect(mockUpdateCurrentUser).toHaveBeenCalledWith({ email_notif_card_assigned: true })
  })

  it('comment-on-watched-card email toggle sends email_notif_comment_added (#1295)', async () => {
    const user = userEvent.setup()
    mockUpdateCurrentUser.mockResolvedValueOnce({
      ...fakeUser, notif_comment_added: true, email_notif_comment_added: true,
    })
    renderSettings({ ...fakeUser, notif_comment_added: true, email_notif_comment_added: false })
    await user.click(screen.getByText('Notifications'))
    const emailToggle = screen.getByRole('switch', {
      name: 'Also send by email: Comment on a watched card',
    })
    expect(emailToggle).toHaveAttribute('aria-checked', 'false')
    expect(emailToggle).not.toHaveAttribute('aria-disabled')
    await user.click(emailToggle)
    expect(mockUpdateCurrentUser).toHaveBeenCalledWith({ email_notif_comment_added: true })
  })

  it('comment-on-watched-card email toggle is inert while the in-app toggle is off', async () => {
    const user = userEvent.setup()
    // notif_comment_added defaults to false, like notif_card_moved.
    renderSettings({ ...fakeUser, notif_comment_added: false })
    await user.click(screen.getByText('Notifications'))
    const emailToggle = screen.getByRole('switch', {
      name: 'Also send by email: Comment on a watched card',
    })
    expect(emailToggle).toHaveAttribute('aria-disabled', 'true')
    await user.click(emailToggle)
    expect(mockUpdateCurrentUser).not.toHaveBeenCalled()
  })

  it('email toggle is disabled and explained when the in-app toggle is off', async () => {
    const user = userEvent.setup()
    // notif_card_moved defaults to false, so its email toggle is inert: with no
    // in-app notification there is no row to email.
    renderSettings({ ...fakeUser, notif_card_moved: false })
    await user.click(screen.getByText('Notifications'))
    const emailToggle = screen.getByRole('switch', {
      name: 'Also send by email: Card I\u2019m watching is moved',
    })
    // aria-disabled, not native disabled (#1159) \u2014 the reason line below must
    // stay reachable by keyboard focus, not only screen-reader browse mode.
    expect(emailToggle).not.toBeDisabled()
    expect(emailToggle).toHaveAttribute('aria-disabled', 'true')
    emailToggle.focus()
    expect(emailToggle).toHaveFocus()
    const reasonId = emailToggle.getAttribute('aria-describedby')
    expect(reasonId).toBeTruthy()
    expect(document.getElementById(reasonId!)?.textContent).toBe(
      'Turn on the in-app notification above to enable email.'
    )
    // Activation is still ignored, by click and by keyboard.
    await user.click(emailToggle)
    expect(mockUpdateCurrentUser).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    expect(mockUpdateCurrentUser).not.toHaveBeenCalled()
  })

  it('a stored-on email preference reads as paused rather than off', async () => {
    const user = userEvent.setup()
    renderSettings({ ...fakeUser, notif_card_moved: false, email_notif_card_moved: true })
    await user.click(screen.getByText('Notifications'))
    const emailToggle = screen.getByRole('switch', {
      name: 'Also send by email: Card I\u2019m watching is moved',
    })
    // The value is kept, not silently cleared — flipping the in-app toggle back
    // on restores it.
    expect(emailToggle).toHaveAttribute('aria-checked', 'true')
    expect(emailToggle).not.toBeDisabled()
    expect(emailToggle).toHaveAttribute('aria-disabled', 'true')
    const reasonId = emailToggle.getAttribute('aria-describedby')
    expect(document.getElementById(reasonId!)?.textContent).toBe(
      'Paused while the in-app notification above is off. Your email setting is kept.'
    )
  })

  it('email toggle is enabled once the in-app toggle is on', async () => {
    const user = userEvent.setup()
    renderSettings({ ...fakeUser, notif_card_assigned: true })
    await user.click(screen.getByText('Notifications'))
    const emailToggle = screen.getByRole('switch', {
      name: 'Also send by email: Card assigned to me',
    })
    expect(emailToggle).not.toBeDisabled()
    expect(emailToggle).not.toHaveAttribute('aria-disabled')
    const reasonId = emailToggle.getAttribute('aria-describedby')
    // Off, so the helper is action-phrased rather than claiming mail is going out.
    expect(document.getElementById(reasonId!)?.textContent).toBe(
      'Email a copy to your account address.'
    )
  })

  it('an enabled email toggle that is on says it is sending', async () => {
    const user = userEvent.setup()
    renderSettings({ ...fakeUser, notif_card_assigned: true, email_notif_card_assigned: true })
    await user.click(screen.getByText('Notifications'))
    const emailToggle = screen.getByRole('switch', {
      name: 'Also send by email: Card assigned to me',
    })
    expect(emailToggle).toHaveAttribute('aria-checked', 'true')
    const reasonId = emailToggle.getAttribute('aria-describedby')
    expect(document.getElementById(reasonId!)?.textContent).toBe(
      'Sends a copy to your account address.'
    )
  })

  it('shows error message when save fails', async () => {
    const user = userEvent.setup()
    mockUpdateCurrentUser.mockRejectedValueOnce(new Error('network'))
    renderSettings()
    await user.click(screen.getByText('Notifications'))
    const switches = screen.getAllByRole('switch')
    await user.click(switches[0])
    expect(await screen.findByText('Failed to save. Please try again.')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// BehaviorTab — restart tour
// ---------------------------------------------------------------------------

describe('BehaviorTab — restart tour', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function openBehaviorTab() {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('Behavior'))
    return user
  }

  it('renders the Restart onboarding tour button', async () => {
    await openBehaviorTab()
    expect(screen.getByRole('button', { name: 'Restart onboarding tour' })).toBeInTheDocument()
  })

  it('clicking the button calls resetTour and onUserUpdated', async () => {
    mockResetTour.mockResolvedValueOnce(undefined)
    const onUserUpdated = vi.fn()
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <SettingsPage user={fakeUser} onLogout={vi.fn()} onUserUpdated={onUserUpdated} />
      </MemoryRouter>,
    )
    await user.click(screen.getByText('Behavior'))
    await user.click(screen.getByRole('button', { name: 'Restart onboarding tour' }))
    await waitFor(() => expect(mockResetTour).toHaveBeenCalledTimes(1))
    expect(onUserUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ has_completed_tour: false }),
    )
  })

  it('shows confirmation message after successful reset', async () => {
    mockResetTour.mockResolvedValueOnce(undefined)
    const user = await openBehaviorTab()
    await user.click(screen.getByRole('button', { name: 'Restart onboarding tour' }))
    await waitFor(() =>
      expect(
        screen.getByText('Tour will restart on your next visit to a board.'),
      ).toBeInTheDocument(),
    )
  })

  it('shows error message when resetTour fails', async () => {
    mockResetTour.mockRejectedValueOnce(new Error('network'))
    const user = await openBehaviorTab()
    await user.click(screen.getByRole('button', { name: 'Restart onboarding tour' }))
    await waitFor(() =>
      expect(
        screen.getByText('Failed to reset tour. Please try again.'),
      ).toBeInTheDocument(),
    )
  })

  it('button shows "Restarting…" while request is in flight', async () => {
    let resolveReset!: () => void
    mockResetTour.mockReturnValueOnce(new Promise<void>((res) => { resolveReset = res }))
    const user = await openBehaviorTab()
    await user.click(screen.getByRole('button', { name: 'Restart onboarding tour' }))
    expect(await screen.findByRole('button', { name: 'Restarting…' })).toBeDisabled()
    resolveReset()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Restart onboarding tour' })).toBeInTheDocument(),
    )
  })

  // Regression: #870 — unmounting while the 4s confirmation fade is pending
  // used to leave the timer alive, firing setResetConfirmed(false) after teardown
  // and failing the `frontend-test` CI job with "window is not defined".
  it('clears the pending confirmation timer on unmount', async () => {
    mockResetTour.mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    const { unmount } = render(
      <MemoryRouter>
        <SettingsPage user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
      </MemoryRouter>,
    )
    await user.click(screen.getByText('Behavior'))
    await user.click(screen.getByRole('button', { name: 'Restart onboarding tour' }))
    await waitFor(() =>
      expect(
        screen.getByText('Tour will restart on your next visit to a board.'),
      ).toBeInTheDocument(),
    )

    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    unmount()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
