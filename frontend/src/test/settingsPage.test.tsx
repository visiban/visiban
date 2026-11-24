import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { useState } from 'react'
import SettingsPage from '../pages/SettingsPage'
import type { User } from '../types'
import { announced } from './confirmAnnouncer'

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
const mockGetCurrentUser = vi.fn()
const mockResendPendingEmailConfirmation = vi.fn()
const NO_PROVIDERS = { google: false, github: false, gitlab: false, oidc: false, oidc_name: null }
const mockGetAuthProviders = vi.fn(() => Promise.resolve(NO_PROVIDERS))
const mockListConnectedAccounts = vi.fn(() => Promise.resolve([] as unknown[]))
const mockDisconnectAccount = vi.fn()
const mockStartProviderConnect = vi.fn()

vi.mock('../api/auth', () => ({
  getTokenPolicy: () => Promise.resolve({ max_lifetime_days: null, default_lifetime_days: null, hard_max_lifetime_days: 365, max_tokens: 10 }),
  updateCurrentUser: (...args: unknown[]) => mockUpdateCurrentUser(...args),
  changePassword: (...args: unknown[]) => mockChangePassword(...args),
  resetTour: (...args: unknown[]) => mockResetTour(...args),
  cancelPendingEmailChange: (...args: unknown[]) => mockCancelPendingEmailChange(...args),
  getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
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


// Section nav button (the name also appears as the page's section heading and the phone select).
function navBtn(name: string) {
  return within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name })
}

// Profile saves from a sticky Save bar that only shows while the form has unsaved changes
// (#2477), so every save first edits a field (a fresh value each time) and returns the button.
let editCount = 0
function saveBtn() {
  editCount += 1
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: `Doe-${editCount}` } })
  return screen.getByRole('button', { name: 'Save profile' })
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

  it('renders the page heading as an h2 (the shell header owns the h1) and groups the nav (#2477)', () => {
    renderSettings()
    expect(screen.getByRole('heading', { level: 2, name: 'Your settings' })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    expect(within(nav).getByText('Account')).toBeInTheDocument()
    expect(within(nav).getByText('Preferences')).toBeInTheDocument()
    expect(within(nav).getByText('Visiban')).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Access tokens' })).toBeInTheDocument()
  })

  it('every old tab id still deep-links its section, and Find a setting filters the nav (#2477)', async () => {
    vi.stubGlobal('__APP_VERSION__', 'test')
    const ids: Array<[string, string]> = [
      ['profile', 'Profile'], ['security', 'Security'], ['access-tokens', 'Access tokens'],
      ['notifications', 'Notifications'], ['appearance', 'Appearance'], ['behavior', 'Behavior'], ['about', 'About'],
    ]
    for (const [id, label] of ids) {
      const { unmount } = render(
        <MemoryRouter initialEntries={[`/settings?tab=${id}`]}>
          <SettingsPage user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
        </MemoryRouter>,
      )
      const nav = screen.getByRole('navigation', { name: 'Settings sections' })
      expect(within(nav).getByRole('button', { name: label })).toHaveAttribute('aria-current', 'page')
      expect(screen.getByRole('heading', { level: 3, name: label })).toBeInTheDocument()
      unmount()
    }
    renderSettings()
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a setting' }), 'theme')
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    expect(within(nav).getByRole('button', { name: 'Appearance' })).toBeInTheDocument()
    expect(within(nav).queryByRole('button', { name: 'Profile' })).not.toBeInTheDocument()
  })

  it('the OAuth return (?connected=) lands on Security and then drops the params (#2477)', () => {
    render(
      <MemoryRouter initialEntries={['/settings?connected=github']}>
        <SettingsPage user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
      </MemoryRouter>,
    )
    expect(mockNavigate).toHaveBeenCalledWith('?tab=security', expect.objectContaining({ replace: true }))
  })

  it('sidebar tabs carry a focus ring and mark the active tab with aria-current (#439)', () => {
    renderSettings()
    const nav = screen.getByRole('navigation')
    const profile = within(nav).getByRole('button', { name: 'Profile' })
    const behavior = within(nav).getByRole('button', { name: 'Behavior' })
    expect(profile).toHaveAttribute('aria-current', 'page')
    expect(behavior).not.toHaveAttribute('aria-current')
    expect(behavior).toHaveAttribute('type', 'button')
    expect(behavior).toHaveClass('focus:ring-2', 'focus:ring-primary-emphasis')
    fireEvent.click(behavior)
    expect(behavior).toHaveAttribute('aria-current', 'page')
    expect(profile).not.toHaveAttribute('aria-current')
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

  it('?tab=security opens the Security tab; an unknown tab falls back to Profile (#1740)', () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/settings?tab=security']}>
        <SettingsPage user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
      </MemoryRouter>,
    )
    expect(screen.getByText('New password')).toBeInTheDocument()
    unmount()
    render(
      <MemoryRouter initialEntries={['/settings?tab=bogus']}>
        <SettingsPage user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
      </MemoryRouter>,
    )
    expect(screen.getByPlaceholderText('How you appear on the board')).toBeInTheDocument()
  })

  it('tab navigation: clicking Security shows security form', async () => {
    const user = userEvent.setup()
    renderSettings()
    // Click the Security tab in the sidebar nav
    await user.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Security' }))
    expect(screen.getByText('New password')).toBeInTheDocument()
    expect(screen.getByText('Confirm new password')).toBeInTheDocument()
  })

  it('tab navigation: clicking Notifications shows notification toggles', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Notifications' }))
    expect(screen.getByText(/Choose which events notify you in the app/)).toBeInTheDocument()
  })

  it('tab navigation: clicking Appearance shows theme options', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Appearance' }))
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
    await user.click(saveBtn())
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
    await user.click(saveBtn())
    await waitFor(() => expect(screen.getByText('Changes saved.')).toBeInTheDocument())
  })

  it('navigates to "/" after the saved flash', async () => {
    vi.useFakeTimers()
    mockUpdateCurrentUser.mockResolvedValueOnce(fakeUser)
    renderSettings()
    // Use fireEvent (synchronous) so we don't depend on userEvent's internal timers
    await act(async () => {
      fireEvent.click(saveBtn())
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
      fireEvent.click(saveBtn())
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
      fireEvent.click(saveBtn())
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => { vi.advanceTimersByTime(1500) })
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
  })

  it('Escape navigates to "/" when there is no browser history and no "from" state (#1374)', () => {
    renderSettings()
    fireEvent.keyDown(document, { key: 'Escape' })
    // JSDOM has no real history, so history.length === 1 → navigate(from ?? "/")
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
  })

  it('Escape navigates back to "from" location state when there is no browser history (#1374)', () => {
    const fromLocation = { pathname: '/boards/1', search: '', hash: '', state: null, key: 'abc' }
    renderSettings(fakeUser, { from: fromLocation })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(mockNavigate).toHaveBeenCalledWith(fromLocation, { replace: true })
  })

  it('Escape navigates back when browser history has previous entries (#1374)', () => {
    const historySpy = vi.spyOn(window.history, 'length', 'get').mockReturnValue(2)
    try {
      renderSettings()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(mockNavigate).toHaveBeenCalledWith(-1)
    } finally {
      historySpy.mockRestore()
    }
  })

  it('shows error message on save failure', async () => {
    mockUpdateCurrentUser.mockRejectedValueOnce(new Error('Server error'))
    const user = userEvent.setup()
    renderSettings()
    await user.click(saveBtn())
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
      fireEvent.click(saveBtn())
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
    await user.click(saveBtn())
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
    await user.type(screen.getByLabelText('Current password'), 'my-password')
    await user.click(saveBtn())
    await waitFor(() => expect(mockUpdateCurrentUser).toHaveBeenCalledTimes(1))
    expect(mockUpdateCurrentUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'other@example.com' }),
    )
  })

  it('asks for the current password only once the email is edited, and sends it', async () => {
    mockUpdateCurrentUser.mockResolvedValueOnce(fakeUser)
    const user = userEvent.setup()
    renderSettings()
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
    const emailInput = screen.getByDisplayValue('j@example.com')
    await user.clear(emailInput)
    await user.type(emailInput, 'other@example.com')
    const password = screen.getByLabelText('Current password')
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toBeRequired()
    expect(password).toHaveAccessibleDescription("Required to change your email address, to confirm it's you.")
    await user.type(password, 'my-password')
    await user.click(saveBtn())
    await waitFor(() => expect(mockUpdateCurrentUser).toHaveBeenCalledTimes(1))
    expect(mockUpdateCurrentUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'other@example.com', current_password: 'my-password' }),
    )
  })

  it('hides the password field again when the email is put back', async () => {
    const user = userEvent.setup()
    renderSettings()
    const emailInput = screen.getByDisplayValue('j@example.com')
    await user.type(emailInput, 'x')
    expect(screen.getByLabelText('Current password')).toBeInTheDocument()
    await user.type(emailInput, '{Backspace}')
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
  })

  it('never sends current_password with an unrelated save', async () => {
    mockUpdateCurrentUser.mockResolvedValueOnce(fakeUser)
    const user = userEvent.setup()
    renderSettings()
    await user.click(saveBtn())
    await waitFor(() => expect(mockUpdateCurrentUser).toHaveBeenCalledTimes(1))
    expect(mockUpdateCurrentUser.mock.calls[0][0]).not.toHaveProperty('current_password')
  })

  it('does not ask an account without a password', async () => {
    mockUpdateCurrentUser.mockResolvedValueOnce(fakeUser)
    const user = userEvent.setup()
    renderSettings({ ...fakeUser, has_usable_password: false })
    const emailInput = screen.getByDisplayValue('j@example.com')
    await user.clear(emailInput)
    await user.type(emailInput, 'other@example.com')
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
    await user.click(saveBtn())
    await waitFor(() => expect(mockUpdateCurrentUser).toHaveBeenCalledTimes(1))
    expect(mockUpdateCurrentUser.mock.calls[0][0]).not.toHaveProperty('current_password')
  })

  it('asks an account without a password to sign in again when the session is too old (#1932)', async () => {
    mockUpdateCurrentUser.mockRejectedValueOnce({
      response: { status: 403, data: { detail: 'x', code: 'recent_login_required' } },
    })
    const user = userEvent.setup()
    renderSettings({ ...fakeUser, has_usable_password: false })
    const emailInput = screen.getByDisplayValue('j@example.com')
    await user.clear(emailInput)
    await user.type(emailInput, 'other@example.com')
    await user.click(saveBtn())
    expect(
      await screen.findByText(/To change your email address, sign out, sign in again with your sign-in provider/),
    ).toBeInTheDocument()
    expect(screen.queryByText('Failed to save changes. Please try again.')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
  })

  it("shows the server's current_password error", async () => {
    mockUpdateCurrentUser.mockRejectedValueOnce({
      response: {
        status: 400,
        data: { current_password: ['Your current password was entered incorrectly. Please enter it again.'] },
      },
    })
    const user = userEvent.setup()
    renderSettings()
    const emailInput = screen.getByDisplayValue('j@example.com')
    await user.clear(emailInput)
    await user.type(emailInput, 'other@example.com')
    await user.type(screen.getByLabelText('Current password'), 'wrong')
    await user.click(saveBtn())
    const password = screen.getByLabelText('Current password')
    // Tied to the field: helper slot, aria-invalid, focus; not the status line.
    await waitFor(() =>
      expect(password).toHaveAccessibleDescription(
        'Your current password was entered incorrectly. Please enter it again.',
      ),
    )
    expect(password).toHaveAttribute('aria-invalid', 'true')
    expect(password).toHaveFocus()
    expect(password).toHaveValue('')
    expect(
      screen.getAllByText('Your current password was entered incorrectly. Please enter it again.'),
    ).toHaveLength(1)
    expect(screen.getByText('Your current password was entered incorrectly. Please enter it again.'))
      .toHaveClass('text-danger')
  })

  it('clears the password on any failed save and refocuses the field', async () => {
    mockUpdateCurrentUser.mockRejectedValueOnce({ response: { status: 500, data: {} } })
    const user = userEvent.setup()
    renderSettings()
    const emailInput = screen.getByDisplayValue('j@example.com')
    await user.clear(emailInput)
    await user.type(emailInput, 'other@example.com')
    await user.type(screen.getByLabelText('Current password'), 'my-password')
    await user.click(saveBtn())
    expect(await screen.findByText('Failed to save changes. Please try again.')).toBeInTheDocument()
    const password = screen.getByLabelText('Current password')
    expect(password).toHaveValue('')
    expect(password).toHaveFocus()
    expect(password).not.toHaveAttribute('aria-invalid')
  })

  it('does not bring the password back pre-filled after the email is reverted', async () => {
    const user = userEvent.setup()
    renderSettings()
    const emailInput = screen.getByDisplayValue('j@example.com')
    await user.type(emailInput, 'x')
    await user.type(screen.getByLabelText('Current password'), 'my-password')
    await user.type(emailInput, '{Backspace}')
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
    await user.type(emailInput, 'y')
    expect(screen.getByLabelText('Current password')).toHaveValue('')
  })

  it('shows the password field when the server asks for it, even if has_usable_password is stale', async () => {
    mockUpdateCurrentUser
      .mockRejectedValueOnce({
        response: {
          status: 400,
          data: { current_password: ['Enter your current password to change your email address.'] },
        },
      })
      .mockResolvedValueOnce(fakeUser)
    const user = userEvent.setup()
    renderSettings({ ...fakeUser, has_usable_password: false })
    const emailInput = screen.getByDisplayValue('j@example.com')
    await user.clear(emailInput)
    await user.type(emailInput, 'other@example.com')
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
    await user.click(saveBtn())
    const password = await screen.findByLabelText('Current password')
    await waitFor(() => expect(password).toHaveFocus())
    expect(password).toHaveAccessibleDescription(
      'Enter your current password to change your email address.',
    )
    await user.type(password, 'my-password')
    await user.click(saveBtn())
    await waitFor(() => expect(mockUpdateCurrentUser).toHaveBeenCalledTimes(2))
    expect(mockUpdateCurrentUser.mock.calls[1][0]).toEqual(
      expect.objectContaining({ email: 'other@example.com', current_password: 'my-password' }),
    )
  })

  it('shows the pending-confirmation notice on load', () => {
    renderSettings({ ...fakeUser, pending_email: 'new@example.com' })
    expect(screen.getByText(/we sent a link to new@example\.com/)).toBeInTheDocument()
  })

  it('shows no "Email change pending" card when nothing is pending', () => {
    renderSettings({ ...fakeUser, pending_email: null })
    expect(screen.queryByTestId('pending-email-note')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Email change pending' })).not.toBeInTheDocument()
    expect(screen.queryByText(/we sent a link to/)).not.toBeInTheDocument()
  })

  it('an "Email change pending" card names the new address while a change is pending', () => {
    renderSettings({ ...fakeUser, pending_email: 'new@example.com' })
    expect(screen.getByRole('heading', { name: 'Email change pending' })).toBeInTheDocument()
    expect(screen.getByTestId('pending-email-note')).toHaveTextContent(/new@example\.com/)
    expect(screen.getByDisplayValue('j@example.com')).toBeInTheDocument()
  })

  it('announces the save result through a polite, atomic live region', async () => {
    mockUpdateCurrentUser.mockResolvedValueOnce(fakeUser)
    const user = userEvent.setup()
    renderSettings()
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveAttribute('aria-atomic', 'true')
    await user.click(saveBtn())
    await waitFor(() => expect(status).toHaveTextContent('Changes saved.'))
  })

  it('shows the server username error on a taken username', async () => {
    mockUpdateCurrentUser.mockRejectedValueOnce({
      response: { status: 400, data: { username: ['That username is already taken.'] } },
    })
    const user = userEvent.setup()
    renderSettings()
    await user.click(saveBtn())
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
    await user.click(saveBtn())
    expect(await screen.findByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true')
    resolveUpdate(fakeUser)
    await waitFor(() => expect(saveBtn()).toBeInTheDocument())
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

  it('shows Resend and Cancel change only while a change is pending', () => {
    const { unmount } = renderSettings({ ...fakeUser, pending_email: null })
    expect(screen.queryByRole('button', { name: 'Resend' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel change' })).not.toBeInTheDocument()
    unmount()
    renderPending()
    expect(screen.getByRole('button', { name: 'Resend' })).toHaveAttribute('type', 'button')
    expect(screen.getByRole('button', { name: 'Cancel change' })).toHaveAttribute('type', 'button')
  })

  it('keeps the actions out of the email input accessible name', () => {
    renderPending()
    expect(screen.getByRole('textbox', { name: 'Email address' })).toHaveValue('j@example.com')
  })

  it('both actions are described by the pending note', () => {
    renderPending()
    for (const name of ['Resend', 'Cancel change']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-describedby', 'pending-email-note')
    }
  })

  it('Resend calls the API and announces success in the live region', async () => {
    mockResendPendingEmailConfirmation.mockResolvedValueOnce({ detail: 'Confirmation email sent.' })
    const user = userEvent.setup()
    renderPending()
    await user.click(screen.getByRole('button', { name: 'Resend' }))
    expect(mockResendPendingEmailConfirmation).toHaveBeenCalledTimes(1)
    const status = screen.getByRole('status')
    await waitFor(() =>
      expect(status).toHaveTextContent('We sent a new confirmation link to new@example.com.'),
    )
    expect(status.querySelector('.text-success')).not.toBeNull()
    // Still pending: the note and actions stay.
    expect(screen.getByRole('button', { name: 'Resend' })).toBeEnabled()
    expect(mockUpdateCurrentUser).not.toHaveBeenCalled()
  })

  it('shows the server cooldown message as a warning on 429', async () => {
    mockResendPendingEmailConfirmation.mockRejectedValueOnce({
      response: { status: 429, data: { detail: 'A confirmation email was sent to this address a moment ago.' } },
    })
    const user = userEvent.setup()
    renderPending()
    await user.click(screen.getByRole('button', { name: 'Resend' }))
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
    await user.click(screen.getByRole('button', { name: 'Resend' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/no email change waiting for confirmation anymore/),
    )
    expect(screen.queryByRole('button', { name: 'Resend' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('pending-email-note')).not.toBeInTheDocument()
  })

  it('shows a generic error when resend fails otherwise', async () => {
    mockResendPendingEmailConfirmation.mockRejectedValueOnce(new Error('network'))
    const user = userEvent.setup()
    renderPending()
    await user.click(screen.getByRole('button', { name: 'Resend' }))
    await waitFor(() =>
      expect(screen.getByText("Couldn't resend the link. Please try again.")).toHaveClass('text-danger'),
    )
  })

  it('disables both actions and Save while a resend is in flight', async () => {
    let resolve!: (v: { detail: string }) => void
    mockResendPendingEmailConfirmation.mockReturnValueOnce(new Promise((res) => { resolve = res }))
    const user = userEvent.setup()
    renderPending()
    await user.click(screen.getByRole('button', { name: 'Resend' }))
    expect(await screen.findByRole('button', { name: 'Sending…' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Cancel change' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Doe-resend' } })
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true')
    resolve({ detail: 'ok' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resend' })).toBeEnabled())
  })

  it('the post-save navigation timer does not fire after the page unmounts', async () => {
    // Regression: the 1.5 s "return after save" timer outlived the page, so a
    // save in one test navigated during a later one (and, in the app, could
    // navigate a user who had already left Settings).
    vi.useFakeTimers()
    mockUpdateCurrentUser.mockResolvedValueOnce({ ...fakeUser, pending_email: null })
    const { unmount } = renderSettings()
    fireEvent.click(saveBtn())
    await act(async () => { await Promise.resolve() })
    expect(mockUpdateCurrentUser).toHaveBeenCalled()
    unmount()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(mockNavigate).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('Cancel change withdraws the change, clears the note and moves focus to the field', async () => {
    // #2005: the DELETE answers 204 with no body; the page refetches the user.
    mockCancelPendingEmailChange.mockResolvedValueOnce(undefined)
    mockGetCurrentUser.mockResolvedValueOnce({ ...fakeUser, pending_email: null })
    const user = userEvent.setup()
    const onUserUpdated = renderPending()
    await user.click(screen.getByRole('button', { name: 'Cancel change' }))
    expect(mockCancelPendingEmailChange).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(mockGetCurrentUser).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        "Email change canceled. Your email address hasn't changed.",
      ),
    )
    expect(onUserUpdated).toHaveBeenCalledWith(expect.objectContaining({ pending_email: null }))
    expect(screen.queryByTestId('pending-email-note')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel change' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Email address' })).toHaveFocus()
    // Cancelling is not a save: the page does not navigate away.
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('still reports a successful cancel when the follow-up profile refetch fails', async () => {
    // The 204 means the change is withdrawn; a lost refetch must not claim
    // otherwise. The page clears pending_email locally instead (#2005).
    mockCancelPendingEmailChange.mockResolvedValueOnce(undefined)
    mockGetCurrentUser.mockRejectedValueOnce(new Error('network'))
    const user = userEvent.setup()
    const onUserUpdated = renderPending()
    await user.click(screen.getByRole('button', { name: 'Cancel change' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        "Email change canceled. Your email address hasn't changed.",
      ),
    )
    expect(onUserUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ email: fakeUser.email, pending_email: null }),
    )
    expect(screen.queryByTestId('pending-email-note')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel change' })).not.toBeInTheDocument()
  })

  it('keeps the pending change and shows an error when cancel fails', async () => {
    mockCancelPendingEmailChange.mockRejectedValueOnce(new Error('network'))
    const user = userEvent.setup()
    renderPending()
    await user.click(screen.getByRole('button', { name: 'Cancel change' }))
    await waitFor(() =>
      expect(screen.getByText("Couldn't cancel the email change. Please try again.")).toHaveClass('text-danger'),
    )
    expect(mockGetCurrentUser).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending-email-note')).toHaveTextContent(/new@example\.com/)
    expect(screen.getByRole('button', { name: 'Cancel change' })).toBeEnabled()
  })

  it('a later save replaces an action result instead of coexisting with it', async () => {
    mockResendPendingEmailConfirmation.mockResolvedValueOnce({ detail: 'ok' })
    mockUpdateCurrentUser.mockResolvedValueOnce(pendingUser)
    const user = userEvent.setup()
    renderPending()
    await user.click(screen.getByRole('button', { name: 'Resend' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/We sent a new confirmation link/))
    await user.click(saveBtn())
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
    await user.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Security' }))
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

  it('shows a wait message when the change is rate limited', async () => {
    mockChangePassword.mockRejectedValueOnce({ response: { status: 429 } })
    const user = await openSecurityTab()
    await user.type(screen.getByLabelText('Current password'), 'OldPassword1!')
    await user.type(screen.getByLabelText('New password'), 'NewPassword123!')
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPassword123!')
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    await waitFor(
      () =>
        expect(
          screen.getByText('Too many attempts. Please wait before trying again.'),
        ).toBeInTheDocument(),
      { timeout: 10000 },
    )
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
    await user.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Security' }))
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

  it('asks the user to sign in again when the session is too old to set a first password', async () => {
    mockChangePassword.mockRejectedValueOnce({
      response: { status: 403, data: { detail: 'x', code: 'recent_login_required' } },
    })
    const user = await openSecurityTabForSocial()
    await user.type(screen.getByLabelText('New password'), 'NewPassword123!')
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPassword123!')
    await user.click(screen.getByRole('button', { name: 'Set password' }))
    await waitFor(() =>
      expect(screen.getByText(/sign out, sign in again with your sign-in provider/i)).toBeInTheDocument(),
    )
    expect(screen.queryByText('Failed to set password. Please try again.')).not.toBeInTheDocument()
  }, 15000)

  it('keeps the generic message for any other 403', async () => {
    mockChangePassword.mockRejectedValueOnce({ response: { status: 403, data: { detail: 'x' } } })
    const user = await openSecurityTabForSocial()
    await user.type(screen.getByLabelText('New password'), 'NewPassword123!')
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPassword123!')
    await user.click(screen.getByRole('button', { name: 'Set password' }))
    await waitFor(() =>
      expect(screen.getByText('Failed to set password. Please try again.')).toBeInTheDocument(),
    )
  }, 15000)

  it('updates the shared user after a first password is set, so other tabs see it', async () => {
    mockChangePassword.mockResolvedValueOnce({ detail: 'ok' })
    const onUserUpdated = vi.fn()
    const user = userEvent.setup()
    function Harness() {
      const [current, setCurrent] = useState<User>(socialUser)
      return (
        <SettingsPage
          user={current}
          onLogout={vi.fn()}
          onUserUpdated={(u) => { onUserUpdated(u); setCurrent(u) }}
        />
      )
    }
    render(<MemoryRouter><Harness /></MemoryRouter>)
    await user.click(navBtn('Security'))
    await user.type(screen.getByLabelText('New password'), 'NewPassword123!')
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPassword123!')
    await user.click(screen.getByRole('button', { name: 'Set password' }))
    await waitFor(() =>
      expect(onUserUpdated).toHaveBeenCalledWith(expect.objectContaining({ has_usable_password: true })),
    )
    // The success message keeps the wording of what just happened.
    expect(screen.getByText('Password set successfully.')).toBeInTheDocument()
    // Profile now asks for the password when the email is edited.
    await user.click(navBtn('Profile'))
    const emailInput = screen.getByDisplayValue('j@example.com')
    await user.type(emailInput, 'x')
    expect(screen.getByLabelText('Current password')).toBeInTheDocument()
  }, 15000)

  it('a password change on a password account does not touch the shared user', async () => {
    mockChangePassword.mockResolvedValueOnce({ detail: 'ok' })
    const onUserUpdated = vi.fn()
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <SettingsPage user={fakeUser} onLogout={vi.fn()} onUserUpdated={onUserUpdated} />
      </MemoryRouter>,
    )
    await user.click(navBtn('Security'))
    await user.type(screen.getByLabelText('Current password'), 'OldPassword1!')
    await user.type(screen.getByLabelText('New password'), 'NewPassword123!')
    await user.type(screen.getByLabelText('Confirm new password'), 'NewPassword123!')
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    await waitFor(() => expect(screen.getByText('Password changed successfully.')).toBeInTheDocument())
    expect(onUserUpdated).not.toHaveBeenCalled()
  }, 15000)
})

// ---------------------------------------------------------------------------
// SecurityTab — connected accounts (#1314)
// ---------------------------------------------------------------------------

describe('SecurityTab — connected accounts', () => {
  const PROVIDERS = { google: true, github: true, gitlab: false, oidc: false, oidc_name: null }

  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks keeps queued mockImplementationOnce values; drop any a
    // previous test left unconsumed so they cannot leak into this one.
    mockListConnectedAccounts.mockReset()
    mockGetAuthProviders.mockImplementation(() => Promise.resolve(PROVIDERS))
    mockListConnectedAccounts.mockImplementation(() => Promise.resolve([
      { provider: 'google', connected: true, email: 'jane@gmail.com', connected_at: '2026-09-30T00:00:00Z' },
      { provider: 'github', connected: false, email: null, connected_at: null },
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
    if (!url.includes('connect')) await ue.click(navBtn('Security'))
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
    await ue.click(navBtn('Security'))
    await waitFor(() => expect(mockGetAuthProviders).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId('connected-accounts')).not.toBeInTheDocument())
  })

  it('Connect starts the provider round trip and shows Connecting…', async () => {
    const ue = await open()
    await ue.click(screen.getByTestId('connect-github'))
    expect(mockStartProviderConnect).toHaveBeenCalledWith('github')
    expect(screen.getByTestId('connect-github')).toHaveTextContent('Connecting…')
    expect(screen.getByTestId('connect-github')).toHaveAttribute('aria-busy', 'true')
  })

  it('Disconnect asks for inline confirmation, then disconnects', async () => {
    // #2005: the DELETE answers 204 with no body; the section refetches the list.
    mockDisconnectAccount.mockResolvedValue(undefined)
    const ue = await open()
    expect(mockListConnectedAccounts).toHaveBeenCalledTimes(1)
    mockListConnectedAccounts.mockImplementationOnce(() => Promise.resolve([
      { provider: 'google', connected: false, email: null, connected_at: null },
      { provider: 'github', connected: false, email: null, connected_at: null },
    ]))
    await ue.click(screen.getByTestId('disconnect-google'))
    expect(screen.getByText(/You will no longer be able to sign in with it/)).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Disconnect' })).toHaveTextContent('Disconnect Google? You will no longer')
    expect(announced()).toBe('Disconnect Google? You will no longer be able to sign in with it.')
    expect(mockDisconnectAccount).not.toHaveBeenCalled()
    await ue.click(screen.getByTestId('confirm-disconnect-google'))
    expect(mockDisconnectAccount).toHaveBeenCalledWith('google')
    await waitFor(() =>
      expect(screen.getByTestId('connected-account-google')).toHaveTextContent('Not connected'),
    )
    expect(mockListConnectedAccounts).toHaveBeenCalledTimes(2)
  })

  it('still shows the disconnect when the follow-up list refetch fails (#2005)', async () => {
    mockDisconnectAccount.mockResolvedValue(undefined)
    // Two connected providers, so the fallback must change only the one disconnected.
    mockListConnectedAccounts.mockImplementationOnce(() => Promise.resolve([
      { provider: 'google', connected: true, email: 'jane@gmail.com', connected_at: '2026-09-30T00:00:00Z' },
      { provider: 'github', connected: true, email: 'jane@github.example', connected_at: '2026-09-30T00:00:00Z' },
    ]))
    const ue = await open()
    expect(screen.getByTestId('connected-account-github')).toHaveTextContent('jane@github.example')
    mockListConnectedAccounts.mockImplementationOnce(() => Promise.reject(new Error('network')))
    await ue.click(screen.getByTestId('disconnect-google'))
    await ue.click(screen.getByTestId('confirm-disconnect-google'))
    await waitFor(() =>
      expect(screen.getByTestId('connected-account-google')).toHaveTextContent('Not connected'),
    )
    expect(screen.getByTestId('connected-account-google')).not.toHaveTextContent('jane@gmail.com')
    // Only the disconnected row changes, and the refusal path is not taken.
    const github = screen.getByTestId('connected-account-github')
    expect(github).toHaveTextContent('jane@github.example')
    expect(github).not.toHaveTextContent('Not connected')
    expect(screen.queryByText(/Failed to disconnect/)).not.toBeInTheDocument()
    expect(screen.queryByText('Failed to load connected accounts.')).not.toBeInTheDocument()
  })

  it('Cancel backs out of the disconnect confirmation', async () => {
    const ue = await open()
    await ue.click(screen.getByTestId('disconnect-google'))
    await ue.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(/You will no longer be able to sign in with it/)).not.toBeInTheDocument()
    expect(mockDisconnectAccount).not.toHaveBeenCalled()
  })

  it('Cancel and Escape on the disconnect confirm return focus to the Disconnect trigger (#1367)', async () => {
    const ue = await open()
    await ue.click(screen.getByTestId('disconnect-google'))
    await ue.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('disconnect-google')).toHaveFocus()

    await ue.click(screen.getByTestId('disconnect-google'))
    screen.getByTestId('confirm-disconnect-google').focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('confirm-disconnect-google')).not.toBeInTheDocument()
    expect(screen.getByTestId('disconnect-google')).toHaveFocus()
  })

  it('Escape cancels the disconnect confirm and does not navigate (#1366)', async () => {
    const ue = await open()
    await ue.click(screen.getByTestId('disconnect-google'))
    expect(screen.getByTestId('confirm-disconnect-google')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('confirm-disconnect-google')).not.toBeInTheDocument()
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(mockDisconnectAccount).not.toHaveBeenCalled()
    // With no confirm open, Escape falls through to the page-level handler.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(mockNavigate).toHaveBeenCalled()
  })

  it('a second Confirm click while a disconnect is pending sends one request (#1435)', async () => {
    mockDisconnectAccount.mockReturnValue(new Promise(() => {}))
    const ue = await open()
    await ue.click(screen.getByTestId('disconnect-google'))
    await ue.click(screen.getByTestId('confirm-disconnect-google'))
    const confirm = screen.getByTestId('confirm-disconnect-google')
    expect(confirm).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(confirm)
    expect(mockDisconnectAccount).toHaveBeenCalledTimes(1)
  })

  it('Escape is inert while a disconnect is in flight (#1366)', async () => {
    mockDisconnectAccount.mockReturnValue(new Promise(() => {}))
    const ue = await open()
    await ue.click(screen.getByTestId('disconnect-google'))
    await ue.click(screen.getByTestId('confirm-disconnect-google'))
    expect(screen.getByTestId('confirm-disconnect-google')).toHaveTextContent('Disconnecting…')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByTestId('confirm-disconnect-google')).toBeInTheDocument()
  })

  it('the shared confirm sentence names the provider; its action sits in a Disconnect group (#1366, #2477)', async () => {
    const ue = await open()
    await ue.click(screen.getByTestId('disconnect-google'))
    const group = screen.getByRole('group', { name: 'Disconnect' })
    expect(group).toHaveTextContent('Disconnect Google?')
    expect(within(group).getByRole('button', { name: 'Disconnect' })).toBe(screen.getByTestId('confirm-disconnect-google'))
  })

  it('names the provider on the Disconnect trigger (#1366)', async () => {
    await open()
    expect(screen.getByRole('button', { name: 'Disconnect Google' })).toBe(screen.getByTestId('disconnect-google'))
  })

  it('guards the only sign-in method with aria-disabled and a described hint', async () => {
    const ue = await open({ ...fakeUser, has_usable_password: false })
    const button = screen.getByTestId('disconnect-google')
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toBeDisabled() // stays focusable
    expect(button).toHaveAttribute('aria-describedby', 'disconnect-hint-google')
    expect(document.getElementById('disconnect-hint-google')).toHaveTextContent("You can't disconnect your only way to sign in; set a password first.")
    await ue.click(button)
    expect(screen.queryByText(/You will no longer be able to sign in with it/)).not.toBeInTheDocument()
  })

  it('no guard when the user also has a password', async () => {
    await open()
    expect(screen.getByTestId('disconnect-google')).toHaveAttribute('aria-disabled', 'false')
    expect(screen.queryByText("You can't disconnect your only way to sign in; set a password first.")).not.toBeInTheDocument()
  })

  it('shows a server refusal in the row', async () => {
    mockDisconnectAccount.mockRejectedValue({ response: { data: { detail: 'Your account has no password set up.' } } })
    const ue = await open()
    await ue.click(screen.getByTestId('disconnect-google'))
    await ue.click(screen.getByTestId('confirm-disconnect-google'))
    expect(await screen.findByText('Your account has no password set up.')).toBeInTheDocument()
    // A refused disconnect does not refetch the list (only the initial load ran).
    expect(mockListConnectedAccounts).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('connected-account-google')).toHaveTextContent('jane@gmail.com')
  })

  it('a failed disconnect with no server detail uses the inline-confirm failure voice (#1436)', async () => {
    mockDisconnectAccount.mockRejectedValue(new Error('500'))
    const ue = await open()
    await ue.click(screen.getByTestId('disconnect-google'))
    await ue.click(screen.getByTestId('confirm-disconnect-google'))
    expect(await screen.findByText(/^Failed to disconnect .+\. Please try again\.$/)).toBeInTheDocument()
  })

  it('a failed list load shows an error with Retry, not "Not connected" rows', async () => {
    mockListConnectedAccounts.mockImplementationOnce(() => Promise.reject(new Error('500')))
    const ue = userEvent.setup()
    renderSettings()
    await ue.click(navBtn('Security'))
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
    expect(mockNavigate).toHaveBeenCalledWith('?tab=security', expect.objectContaining({ replace: true }))
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
    await user.click(navBtn('Appearance'))
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
    await user.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Notifications' }))
    expect(screen.getByText(/Choose which events notify you in the app/)).toBeInTheDocument()
    expect(screen.getByText('Card assigned to me')).toBeInTheDocument()
  })

  it('shows the Notifications section heading at h3 under the page h2', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(navBtn('Notifications'))
    expect(screen.getByRole('heading', { level: 3, name: 'Notifications' })).toBeInTheDocument()
    expect(screen.getByText('In-app')).toBeInTheDocument()
    expect(screen.getByText('Email')).toBeInTheDocument()
  })

  it('renders every notification preference row', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(navBtn('Notifications'))
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
    await user.click(navBtn('Notifications'))
    await user.click(screen.getByRole('switch', { name: 'Due date approaching, in-app' }))
    expect(mockUpdateCurrentUser).toHaveBeenCalledWith({ notif_due_soon: true })
  })

  it('renders an in-app and an email switch for every event that supports email', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(navBtn('Notifications'))
    for (const label of [
      'Card assigned to me',
      'Someone @mentions me',
      'Due date approaching',
      'Card I\u2019m watching is moved',
      'Comment on a watched card',
    ]) {
      expect(screen.getByRole('switch', { name: `${label}, in-app` })).toBeInTheDocument()
      expect(screen.getByRole('switch', { name: `${label}, email` })).toBeInTheDocument()
    }
  })

  it('an event with no email delivery has only the in-app switch', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(navBtn('Notifications'))
    expect(screen.getByRole('switch', { name: 'Card has gone stale, in-app' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Card has gone stale, email' })).not.toBeInTheDocument()
  })

  it('email switch sends the email_notif_* field', async () => {
    const user = userEvent.setup()
    mockUpdateCurrentUser.mockResolvedValueOnce({ ...fakeUser, email_notif_card_assigned: true })
    renderSettings()
    await user.click(navBtn('Notifications'))
    await user.click(screen.getByRole('switch', { name: 'Card assigned to me, email' }))
    expect(mockUpdateCurrentUser).toHaveBeenCalledWith({ email_notif_card_assigned: true })
  })

  it('comment-on-watched-card email switch sends email_notif_comment_added (#1295)', async () => {
    const user = userEvent.setup()
    mockUpdateCurrentUser.mockResolvedValueOnce({
      ...fakeUser, notif_comment_added: true, email_notif_comment_added: true,
    })
    renderSettings({ ...fakeUser, notif_comment_added: true, email_notif_comment_added: false })
    await user.click(navBtn('Notifications'))
    const emailToggle = screen.getByRole('switch', { name: 'Comment on a watched card, email' })
    expect(emailToggle).toHaveAttribute('aria-checked', 'false')
    expect(emailToggle).not.toBeDisabled()
    await user.click(emailToggle)
    expect(mockUpdateCurrentUser).toHaveBeenCalledWith({ email_notif_comment_added: true })
  })

  it('the email switch is off, disabled and explained while in-app is off; a stored email choice is kept', async () => {
    const user = userEvent.setup()
    // notif_card_moved defaults to false: with no in-app notification there is nothing to email.
    renderSettings({ ...fakeUser, notif_card_moved: false, email_notif_card_moved: true })
    await user.click(navBtn('Notifications'))
    const emailToggle = screen.getByRole('switch', { name: 'Card I\u2019m watching is moved, email' })
    expect(emailToggle).toBeDisabled()
    expect(emailToggle).toHaveAttribute('aria-checked', 'false')
    expect(emailToggle).toHaveAccessibleDescription(/Turn on in-app to get email\./)
    await user.click(emailToggle)
    expect(mockUpdateCurrentUser).not.toHaveBeenCalled()
  })

  it('the email switch is enabled once in-app is on and reads as on when set', async () => {
    renderSettings({ ...fakeUser, notif_card_assigned: true, email_notif_card_assigned: true })
    await userEvent.click(navBtn('Notifications'))
    const emailToggle = screen.getByRole('switch', { name: 'Card assigned to me, email' })
    expect(emailToggle).not.toBeDisabled()
    expect(emailToggle).toHaveAttribute('aria-checked', 'true')
  })

  it('a switch whose save is in flight is aria-busy, not disabled, and ignores a second change', async () => {
    const user = userEvent.setup()
    let resolveUpdate!: (u: User) => void
    mockUpdateCurrentUser.mockReturnValueOnce(new Promise<User>((r) => { resolveUpdate = r }))
    renderSettings()
    await user.click(navBtn('Notifications'))
    const sw = screen.getByRole('switch', { name: 'Due date approaching, in-app' })
    await user.click(sw)
    expect(sw).toHaveAttribute('aria-busy', 'true')
    expect(sw).not.toBeDisabled()
    await user.click(sw)
    expect(mockUpdateCurrentUser).toHaveBeenCalledTimes(1)
    resolveUpdate({ ...fakeUser, notif_due_soon: true })
    await waitFor(() => expect(sw).not.toHaveAttribute('aria-busy'))
  })

  it('shows error message when save fails', async () => {
    const user = userEvent.setup()
    mockUpdateCurrentUser.mockRejectedValueOnce(new Error('network'))
    renderSettings()
    await user.click(navBtn('Notifications'))
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
    await user.click(navBtn('Behavior'))
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
    await user.click(navBtn('Behavior'))
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
    expect(await screen.findByRole('button', { name: 'Restarting…' })).toHaveAttribute('aria-busy', 'true')
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
    await user.click(navBtn('Behavior'))
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

describe('SettingsPage leave guard and phone layout (#2477)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('asks before switching sections with unsaved Profile edits; Cancel keeps them', async () => {
    const ue = userEvent.setup()
    renderSettings()
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Changed' } })
    await ue.click(navBtn('Notifications'))
    const group = screen.getByRole('group', { name: 'Discard' })
    expect(group).toHaveTextContent(/unsaved profile changes will be discarded/)
    await ue.click(within(group).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'Discard' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Last name')).toHaveValue('Changed')
  })

  it('Discard switches section and drops the edits', async () => {
    const ue = userEvent.setup()
    renderSettings()
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Changed' } })
    await ue.click(navBtn('Appearance'))
    await ue.click(screen.getByTestId('leave-discard'))
    expect(screen.queryByRole('group', { name: 'Discard' })).not.toBeInTheDocument()
    expect(navBtn('Appearance')).toHaveAttribute('aria-current', 'page')
    await ue.click(navBtn('Profile'))
    expect(screen.getByLabelText('Last name')).not.toHaveValue('Changed')
  })

  it('switches freely when nothing is unsaved', async () => {
    const ue = userEvent.setup()
    renderSettings()
    await ue.click(navBtn('Appearance'))
    expect(screen.queryByRole('group', { name: 'Discard' })).not.toBeInTheDocument()
    expect(navBtn('Appearance')).toHaveAttribute('aria-current', 'page')
  })

  it('Escape with unsaved edits asks first instead of navigating', async () => {
    renderSettings()
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Changed' } })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(await screen.findByRole('group', { name: 'Discard' })).toBeInTheDocument()
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
