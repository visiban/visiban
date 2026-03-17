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

vi.mock('../api/auth', () => ({
  updateCurrentUser: (...args: unknown[]) => mockUpdateCurrentUser(...args),
  changePassword: (...args: unknown[]) => mockChangePassword(...args),
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
  must_change_password: false,
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
    expect(screen.getByText('Choose which events send you a notification.')).toBeInTheDocument()
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
// SecurityTab
// ---------------------------------------------------------------------------

describe('SecurityTab — password account', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function openSecurityTab() {
    const user = userEvent.setup()
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
    fireEvent.submit(screen.getByRole('button', { name: 'Change password' }).closest('form')!)
    await waitFor(() =>
      expect(screen.getByText('New passwords do not match.')).toBeInTheDocument(),
    )
    expect(mockChangePassword).not.toHaveBeenCalled()
  })

  it('password too short shows error', async () => {
    const user = await openSecurityTab()
    await user.type(screen.getByLabelText('Current password'), 'OldPassword1!')
    await user.type(screen.getByLabelText('New password'), 'short')
    await user.type(screen.getByLabelText('Confirm new password'), 'short')
    fireEvent.submit(screen.getByRole('button', { name: 'Change password' }).closest('form')!)
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
    )
    expect(mockChangePassword).toHaveBeenCalledWith('OldPassword1!', 'NewPassword123!')
  })
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

  it('renders Light theme as coming soon (disabled)', async () => {
    await openAppearanceTab()
    expect(screen.getByText('Light')).toBeInTheDocument()
    expect(screen.getByText('Coming soon')).toBeInTheDocument()
  })

  it('clicking System theme option calls setPreference with "system"', async () => {
    const user = await openAppearanceTab()
    await user.click(screen.getByText('System'))
    expect(mockSetPreference).toHaveBeenCalledWith('system')
  })

  it('clicking Dark theme option calls setPreference with "dark"', async () => {
    const user = await openAppearanceTab()
    await user.click(screen.getByText('Dark'))
    expect(mockSetPreference).toHaveBeenCalledWith('dark')
  })

  it('active theme (dark) shows selected indicator', async () => {
    await openAppearanceTab()
    // The Dark button should have the blue-selected styling
    const darkButton = screen.getByText('Dark').closest('button')
    expect(darkButton?.className).toMatch(/border-blue-500/)
  })
})

// ---------------------------------------------------------------------------
// NotificationsTab
// ---------------------------------------------------------------------------

describe('NotificationsTab', () => {
  it('shows notification preference toggles', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('Notifications'))
    expect(screen.getByText('Choose which events send you a notification.')).toBeInTheDocument()
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

  it('renders all five notification preference rows', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('Notifications'))
    expect(screen.getByText('Card assigned to me')).toBeInTheDocument()
    expect(screen.getByText('Someone @mentions me')).toBeInTheDocument()
    expect(screen.getByText('Due date approaching')).toBeInTheDocument()
    expect(screen.getByText(/Card I.m watching is moved/)).toBeInTheDocument()
    expect(screen.getByText('Comment on a watched card')).toBeInTheDocument()
  })

  it('toggles call updateCurrentUser with the new value', async () => {
    const user = userEvent.setup()
    mockUpdateCurrentUser.mockResolvedValueOnce({ ...fakeUser, notif_due_soon: true })
    renderSettings()
    await user.click(screen.getByText('Notifications'))
    const switches = screen.getAllByRole('switch')
    // notif_due_soon is the 3rd switch (index 2), default false → clicking turns it on
    await user.click(switches[2])
    expect(mockUpdateCurrentUser).toHaveBeenCalledWith({ notif_due_soon: true })
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
