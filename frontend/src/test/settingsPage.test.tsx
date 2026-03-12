import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

function renderSettings(user: User = fakeUser) {
  return render(
    <MemoryRouter>
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

  it('tab navigation: clicking Notifications shows coming soon', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('Notifications'))
    expect(screen.getByText('This section is coming soon.')).toBeInTheDocument()
  })

  it('tab navigation: clicking Appearance shows theme options', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('Appearance'))
    expect(screen.getByText('Theme')).toBeInTheDocument()
    expect(screen.getByText('System')).toBeInTheDocument()
    expect(screen.getByText('Dark')).toBeInTheDocument()
  })

  it('Back to Dashboard button navigates to "/"', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('← Dashboard'))
    expect(mockNavigate).toHaveBeenCalledWith('/')
  })
})

// ---------------------------------------------------------------------------
// ProfileTab
// ---------------------------------------------------------------------------

describe('ProfileTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
// ComingSoonTab (Notifications)
// ---------------------------------------------------------------------------

describe('ComingSoonTab — Notifications', () => {
  it('shows "coming soon" message', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('Notifications'))
    expect(screen.getByText('This section is coming soon.')).toBeInTheDocument()
  })

  it('shows the Notifications heading', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('Notifications'))
    // There's an h2 with "Notifications" in the content area
    const headings = screen.getAllByText('Notifications')
    // At least one is an h2
    const h2 = headings.find((el) => el.tagName === 'H2')
    expect(h2).toBeInTheDocument()
  })
})
