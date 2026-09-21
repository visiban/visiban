import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AdminPage from '../pages/AdminPage'
import type { User, AdminUser, SiteSettings, SiteEmailSettings } from '../types'

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

vi.mock('../components/Common/Avatar', () => ({
  default: ({ user }: { user: { username: string } }) => (
    <div data-testid={`avatar-${user.username}`} />
  ),
}))

const mockGetAdminSettings = vi.fn()
const mockPatchAdminSettings = vi.fn()
const mockGetAdminUsers = vi.fn()
const mockCreateAdminUser = vi.fn()
const mockPatchAdminUser = vi.fn()
const mockGetAdminInviteLinks = vi.fn()
const mockCreateAdminInviteLink = vi.fn()
const mockDeactivateAdminUser = vi.fn()
const mockRevokeAdminInviteLink = vi.fn()
const mockGetAdminEmailSettings = vi.fn()
const mockPatchAdminEmailSettings = vi.fn()
const mockSendAdminTestEmail = vi.fn()

vi.mock('../api/auth', () => ({
  getAdminSettings: (...args: unknown[]) => mockGetAdminSettings(...args),
  patchAdminSettings: (...args: unknown[]) => mockPatchAdminSettings(...args),
  getAdminUsers: (...args: unknown[]) => mockGetAdminUsers(...args),
  createAdminUser: (...args: unknown[]) => mockCreateAdminUser(...args),
  patchAdminUser: (...args: unknown[]) => mockPatchAdminUser(...args),
  getAdminInviteLinks: (...args: unknown[]) => mockGetAdminInviteLinks(...args),
  createAdminInviteLink: (...args: unknown[]) => mockCreateAdminInviteLink(...args),
  deactivateAdminUser: (...args: unknown[]) => mockDeactivateAdminUser(...args),
  revokeAdminInviteLink: (...args: unknown[]) => mockRevokeAdminInviteLink(...args),
  getAdminEmailSettings: (...args: unknown[]) => mockGetAdminEmailSettings(...args),
  patchAdminEmailSettings: (...args: unknown[]) => mockPatchAdminEmailSettings(...args),
  sendAdminTestEmail: (...args: unknown[]) => mockSendAdminTestEmail(...args),
  // Keep other auth exports as no-ops to avoid errors from other tests
  getCurrentUser: vi.fn(),
  getVersion: vi.fn(),
  updateCurrentUser: vi.fn(),
  logout: vi.fn(),
  login: vi.fn(),
  register: vi.fn(),
  getAuthProviders: vi.fn(),
  getSiteConfig: vi.fn(),
  changePassword: vi.fn(),
  searchUsers: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const adminUser: User = {
  id: 1,
  username: 'admin',
  email: 'admin@example.com',
  first_name: 'Admin',
  last_name: 'User',
  avatar_url: '',
  display_name: 'Admin User',
  is_site_admin: true,
  can_access_all_content: false,
  must_change_password: false,
  must_change_username: false,
}

const regularUser: User = {
  ...adminUser,
  id: 2,
  username: 'regular',
  is_site_admin: false,
  can_access_all_content: false,
}

const fakeSettings: SiteSettings = {
  registration_mode: 'open',
  uploads_enabled: true,
  maintenance_mode: false,
  maintenance_message: '',
}

const fakeEmailSettings: SiteEmailSettings = {
  config_source: 'env',
  host: '',
  port: 587,
  username: '',
  use_tls: true,
  use_ssl: false,
  from_email: '',
  timeout: 10,
  password_set: false,
  password_decryptable: true,
  effective_source: 'env',
  effective_host: 'smtp.env.example',
  effective_port: 587,
  effective_from_email: 'env@example.com',
  effective_use_tls: true,
}

const fakeAdminUsers: AdminUser[] = [
  {
    id: 1,
    username: 'admin',
    email: 'admin@example.com',
    display_name: 'Admin User',
    first_name: 'Admin',
    last_name: 'User',
    avatar_url: '',
    is_active: true,
    is_site_admin: true,
    can_access_all_content: false,
    must_change_password: false,
    date_joined: '2024-01-01T00:00:00Z',
    owned_boards: [],
  },
  {
    id: 3,
    username: 'alice',
    email: 'alice@example.com',
    display_name: 'Alice',
    first_name: 'Alice',
    last_name: '',
    avatar_url: '',
    is_active: true,
    is_site_admin: false,
    can_access_all_content: false,
    must_change_password: false,
    date_joined: '2024-02-01T00:00:00Z',
    owned_boards: [],
  },
]

function renderAdminPage(user: User = adminUser) {
  return render(
    <MemoryRouter>
      <AdminPage user={user} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
    </MemoryRouter>
  )
}

// ---------------------------------------------------------------------------
// Tests: access control
// ---------------------------------------------------------------------------

describe('AdminPage — access control', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAdminSettings.mockResolvedValue(fakeSettings)
    mockGetAdminUsers.mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] })
    mockGetAdminInviteLinks.mockResolvedValue([])
    mockGetAdminEmailSettings.mockResolvedValue(fakeEmailSettings)
  })

  it('redirects non-admins to /', () => {
    renderAdminPage(regularUser)
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
  })

  it('renders the page for site admins', async () => {
    renderAdminPage(adminUser)
    await waitFor(() => {
      expect(screen.getByText('Site Administration')).toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// Tests: Settings tab
// ---------------------------------------------------------------------------

describe('AdminPage — Settings tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAdminSettings.mockResolvedValue(fakeSettings)
    mockGetAdminUsers.mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] })
    mockGetAdminInviteLinks.mockResolvedValue([])
    mockGetAdminEmailSettings.mockResolvedValue(fakeEmailSettings)
  })

  it('shows registration mode options', async () => {
    renderAdminPage()
    await waitFor(() => {
      expect(screen.getByText('Open')).toBeInTheDocument()
      expect(screen.getByText('Invite-only')).toBeInTheDocument()
      expect(screen.getByText('Closed')).toBeInTheDocument()
    })
  })

  it('calls patchAdminSettings when mode is changed', async () => {
    // Spread the full fixture: the mock is untyped (bare vi.fn()), so a partial
    // object here silently sets every other setting to undefined once
    // SettingsTab does setSettings(updated).
    mockPatchAdminSettings.mockResolvedValue({ ...fakeSettings, registration_mode: 'closed' })
    renderAdminPage()
    await waitFor(() => screen.getByText('Closed'))
    fireEvent.click(screen.getByText('Closed'))
    await waitFor(() => {
      expect(mockPatchAdminSettings).toHaveBeenCalledWith({ registration_mode: 'closed' })
    })
  })

  it('shows error when settings fail to load', async () => {
    mockGetAdminSettings.mockRejectedValue(new Error('Network error'))
    renderAdminPage()
    await waitFor(() => {
      expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument()
    })
  })

  it('renders native radio inputs for registration mode', async () => {
    renderAdminPage()
    await waitFor(() => screen.getByText('Open'))
    const radios = screen.getAllByRole('radio')
    const openRadio = radios.find((r) => (r as HTMLInputElement).value === 'open')
    expect(openRadio).toBeChecked()
  })
})

// ---------------------------------------------------------------------------
// Tests: Users tab
// ---------------------------------------------------------------------------

describe('AdminPage — Users tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAdminSettings.mockResolvedValue(fakeSettings)
    mockGetAdminUsers.mockResolvedValue({
      count: fakeAdminUsers.length,
      offset: 0,
      page_size: 50,
      results: fakeAdminUsers,
    })
    mockGetAdminInviteLinks.mockResolvedValue([])
    mockGetAdminEmailSettings.mockResolvedValue(fakeEmailSettings)
  })

  it('shows users table after switching to Users tab', async () => {
    renderAdminPage()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => {
      // username rendered as "@alice" in the table row
      expect(screen.getByText('@alice')).toBeInTheDocument()
    })
  })

  it('shows Add User button', async () => {
    renderAdminPage()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => {
      expect(screen.getByText('+ Add User')).toBeInTheDocument()
    })
  })

  it('opens add user modal on Add User click', async () => {
    renderAdminPage()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('+ Add User'))
    fireEvent.click(screen.getByText('+ Add User'))
    expect(screen.getByText('Add User')).toBeInTheDocument()
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument()
  })

  it('creates user and updates list', async () => {
    const newUser: AdminUser = {
      id: 99,
      username: 'newguy',
      email: 'newguy@example.com',
      display_name: 'New Guy',
      first_name: 'New',
      last_name: 'Guy',
      avatar_url: '',
      is_active: true,
      is_site_admin: false,
      can_access_all_content: false,
      must_change_password: true,
      date_joined: '2024-03-01T00:00:00Z',
      owned_boards: [],
    }
    mockCreateAdminUser.mockResolvedValue(newUser)
    renderAdminPage()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('+ Add User'))
    fireEvent.click(screen.getByText('+ Add User'))

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'newguy' } })
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'newguy@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'SecurePass123!' } })
    fireEvent.click(screen.getByText('Create user'))

    await waitFor(() => {
      expect(mockCreateAdminUser).toHaveBeenCalledWith({
        username: 'newguy',
        email: 'newguy@example.com',
        password: 'SecurePass123!',
        force_password_reset: true,
      })
    })
  })

  it('shows error for short password in add modal', async () => {
    renderAdminPage()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('+ Add User'))
    fireEvent.click(screen.getByText('+ Add User'))

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'newguy' } })
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'newguy@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } })
    fireEvent.click(screen.getByText('Create user'))

    await waitFor(() => {
      expect(screen.getByText(/at least 12 characters/i)).toBeInTheDocument()
    })
    expect(mockCreateAdminUser).not.toHaveBeenCalled()
  })

  it('calls patchAdminUser on force reset click', async () => {
    mockPatchAdminUser.mockResolvedValue({ ...fakeAdminUsers[1], must_change_password: true })
    renderAdminPage()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getAllByText('Force reset'))
    const resetBtns = screen.getAllByText('Force reset')
    fireEvent.click(resetBtns[0])
    await waitFor(() => {
      expect(mockPatchAdminUser).toHaveBeenCalledWith(
        expect.any(Number),
        { must_change_password: true }
      )
    })
  })
})

// ---------------------------------------------------------------------------
// Tests: Invite Links tab
// ---------------------------------------------------------------------------

describe('AdminPage — Invite Links tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAdminSettings.mockResolvedValue(fakeSettings)
    mockGetAdminUsers.mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] })
    mockGetAdminInviteLinks.mockResolvedValue([])

    Object.defineProperty(window, 'location', {
      value: { ...window.location, origin: 'https://visiban.example.com' },
      writable: true,
    })

    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('shows full join URL (not raw token) after creating a link', async () => {
    const rawToken = 'vbnl_abc123def456'
    mockCreateAdminInviteLink.mockResolvedValue({
      id: 1,
      prefix: 'vbnl_ab',
      status: 'pending',
      single_use: false,
      expires_at: null,
      use_count: 0,
      created_by_username: 'admin',
      raw_token: rawToken,
    })

    renderAdminPage()
    await waitFor(() => screen.getByText('Invite Links'))
    fireEvent.click(screen.getByText('Invite Links'))
    await waitFor(() => screen.getByText('Create link'))
    fireEvent.click(screen.getByText('Create link'))

    await waitFor(() => {
      expect(screen.getByText('https://visiban.example.com/join/vbnl_abc123def456')).toBeInTheDocument()
    })
    expect(screen.queryByText(rawToken)).not.toBeInTheDocument()
  })

  it('copies full join URL to clipboard (not raw token)', async () => {
    const rawToken = 'vbnl_abc123def456'
    mockCreateAdminInviteLink.mockResolvedValue({
      id: 1,
      prefix: 'vbnl_ab',
      status: 'pending',
      single_use: false,
      expires_at: null,
      use_count: 0,
      created_by_username: 'admin',
      raw_token: rawToken,
    })

    renderAdminPage()
    await waitFor(() => screen.getByText('Invite Links'))
    fireEvent.click(screen.getByText('Invite Links'))
    await waitFor(() => screen.getByText('Create link'))
    fireEvent.click(screen.getByText('Create link'))

    await waitFor(() => screen.getByText('Copy'))
    fireEvent.click(screen.getByText('Copy'))

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'https://visiban.example.com/join/vbnl_abc123def456'
    )
  })
})

// ---------------------------------------------------------------------------
// Tests: Escape key behaviour
// ---------------------------------------------------------------------------

describe('AdminPage — Escape key', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAdminSettings.mockResolvedValue(fakeSettings)
    mockGetAdminUsers.mockResolvedValue({ count: 2, offset: 0, page_size: 50, results: fakeAdminUsers })
    mockGetAdminInviteLinks.mockResolvedValue([])
    mockGetAdminEmailSettings.mockResolvedValue(fakeEmailSettings)
  })

  it('Escape navigates back from the admin page', async () => {
    renderAdminPage()
    await waitFor(() => expect(screen.getByText('Site Administration')).toBeInTheDocument())
    fireEvent.keyDown(document, { key: 'Escape' })
    // JSDOM has no real history, so history.length === 1 → navigate("/")
    expect(mockNavigate).toHaveBeenCalledWith('/')
  })

  it('Escape closes the Add User modal without navigating', async () => {
    renderAdminPage()
    await waitFor(() => expect(screen.getByText('Site Administration')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => expect(screen.getByText('+ Add User')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add User'))
    await waitFor(() => expect(screen.getByRole('dialog', { name: /add user/i })).toBeInTheDocument())
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /add user/i })).not.toBeInTheDocument())
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests: admin API functions (unit-level)
// ---------------------------------------------------------------------------

describe('admin API — api/auth.ts', () => {
  it('all admin functions are exported', async () => {
    const mod = await import('../api/auth')
    expect(typeof mod.getAdminSettings).toBe('function')
    expect(typeof mod.patchAdminSettings).toBe('function')
    expect(typeof mod.getAdminUsers).toBe('function')
    expect(typeof mod.createAdminUser).toBe('function')
    expect(typeof mod.patchAdminUser).toBe('function')
    expect(typeof mod.getAdminInviteLinks).toBe('function')
    expect(typeof mod.createAdminInviteLink).toBe('function')
    expect(typeof mod.deactivateAdminUser).toBe('function')
    expect(typeof mod.revokeAdminInviteLink).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Tests: maintenance mode (#783)
// ---------------------------------------------------------------------------

describe('AdminPage — maintenance mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAdminSettings.mockResolvedValue(fakeSettings)
    mockGetAdminUsers.mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] })
    mockGetAdminInviteLinks.mockResolvedValue([])
    mockGetAdminEmailSettings.mockResolvedValue(fakeEmailSettings)
  })

  it('renders the toggle and the message field', async () => {
    renderAdminPage()
    await waitFor(() => screen.getByLabelText('Maintenance mode'))
    expect(screen.getByLabelText('Maintenance mode')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByLabelText(/Message/)).toBeInTheDocument()
  })

  it('tells the admin they are exempt', async () => {
    renderAdminPage()
    await waitFor(() => screen.getByLabelText('Maintenance mode'))
    expect(
      screen.getByText(/Site admins are exempt and keep full read\/write access/)
    ).toBeInTheDocument()
  })

  it('prompts for confirmation before enabling, and does not save yet', async () => {
    // Enabling is instance-wide and takes effect immediately for every user.
    renderAdminPage()
    await waitFor(() => screen.getByLabelText('Maintenance mode'))
    fireEvent.click(screen.getByLabelText('Maintenance mode'))

    await waitFor(() => screen.getByText(/All non-admin users will immediately lose write access/))
    expect(mockPatchAdminSettings).not.toHaveBeenCalled()
  })

  it('keeps the toggle mounted and unflipped while confirming', async () => {
    // The confirm strip appears below the toggle rather than replacing it,
    // matching the two existing inline-confirm instances in BoardSettingsModal.
    // The toggle is never optimistically flipped, so Cancel has nothing to revert.
    renderAdminPage()
    await waitFor(() => screen.getByLabelText('Maintenance mode'))
    fireEvent.click(screen.getByLabelText('Maintenance mode'))

    await waitFor(() => screen.getByText('Confirm'))
    const toggle = screen.getByLabelText('Maintenance mode')
    expect(toggle).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('saves when the confirmation is accepted', async () => {
    mockPatchAdminSettings.mockResolvedValue({ ...fakeSettings, maintenance_mode: true })
    renderAdminPage()
    await waitFor(() => screen.getByLabelText('Maintenance mode'))
    fireEvent.click(screen.getByLabelText('Maintenance mode'))
    await waitFor(() => screen.getByText('Confirm'))
    fireEvent.click(screen.getByText('Confirm'))

    await waitFor(() => {
      expect(mockPatchAdminSettings).toHaveBeenCalledWith({ maintenance_mode: true })
    })
  })

  it('cancelling leaves the toggle off and saves nothing', async () => {
    renderAdminPage()
    await waitFor(() => screen.getByLabelText('Maintenance mode'))
    fireEvent.click(screen.getByLabelText('Maintenance mode'))
    // Scoped to the maintenance confirm row: the Email (SMTP) section's
    // Save/Cancel footer also renders a "Cancel", so a bare getByText would
    // match two elements and throw.
    const confirmRow = await waitFor(() =>
      screen.getByText(/Enable maintenance mode\?/).parentElement as HTMLElement
    )
    fireEvent.click(within(confirmRow).getByText('Cancel'))

    await waitFor(() => screen.getByLabelText('Maintenance mode'))
    expect(screen.getByLabelText('Maintenance mode')).toHaveAttribute('aria-checked', 'false')
    expect(mockPatchAdminSettings).not.toHaveBeenCalled()
  })

  it('turning maintenance mode off needs no confirmation', async () => {
    // Disabling only restores normal service — there is nothing to warn about.
    mockGetAdminSettings.mockResolvedValue({ ...fakeSettings, maintenance_mode: true })
    mockPatchAdminSettings.mockResolvedValue({ ...fakeSettings, maintenance_mode: false })
    renderAdminPage()
    await waitFor(() => screen.getByLabelText('Maintenance mode'))
    fireEvent.click(screen.getByLabelText('Maintenance mode'))

    await waitFor(() => {
      expect(mockPatchAdminSettings).toHaveBeenCalledWith({ maintenance_mode: false })
    })
  })

  it('saves the notice on blur, not on every keystroke', async () => {
    mockPatchAdminSettings.mockResolvedValue({ ...fakeSettings, maintenance_message: 'Back by 5.' })
    renderAdminPage()
    const field = await waitFor(() => screen.getByLabelText(/Message/))

    fireEvent.change(field, { target: { value: 'Back by 5.' } })
    expect(mockPatchAdminSettings).not.toHaveBeenCalled()

    fireEvent.blur(field)
    await waitFor(() => {
      expect(mockPatchAdminSettings).toHaveBeenCalledWith({ maintenance_message: 'Back by 5.' })
    })
  })

  it('does not save on blur when the notice is unchanged', async () => {
    renderAdminPage()
    const field = await waitFor(() => screen.getByLabelText(/Message/))
    fireEvent.blur(field)
    await waitFor(() => screen.getByLabelText('Maintenance mode'))
    expect(mockPatchAdminSettings).not.toHaveBeenCalled()
  })

  it('prompts for an ETA in the placeholder', async () => {
    // A notice with no end time is the top persona complaint.
    renderAdminPage()
    const field = await waitFor(() => screen.getByLabelText(/Message/))
    expect(field).toHaveAttribute('placeholder', expect.stringContaining('expect service back by'))
  })

  it('shows a live character count against the 1000-character cap', async () => {
    renderAdminPage()
    await waitFor(() => screen.getByLabelText(/Message/))
    expect(screen.getByText('0/1000')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/Message/), { target: { value: 'abc' } })
    expect(screen.getByText('3/1000')).toBeInTheDocument()
  })

  it('clamps the notice at the cap the serializer enforces', async () => {
    renderAdminPage()
    const field = await waitFor(() => screen.getByLabelText(/Message/))
    fireEvent.change(field, { target: { value: 'x'.repeat(1200) } })
    expect((field as HTMLTextAreaElement).value).toHaveLength(1000)
    expect(screen.getByText('1000/1000')).toBeInTheDocument()
  })

  it('rolls the toggle back when the save fails', async () => {
    mockPatchAdminSettings.mockRejectedValue(new Error('boom'))
    renderAdminPage()
    await waitFor(() => screen.getByLabelText('Maintenance mode'))
    fireEvent.click(screen.getByLabelText('Maintenance mode'))
    await waitFor(() => screen.getByText('Confirm'))
    fireEvent.click(screen.getByText('Confirm'))

    await waitFor(() => screen.getByText('Failed to save settings.'))
    expect(screen.getByLabelText('Maintenance mode')).toHaveAttribute('aria-checked', 'false')
  })
})

// ---------------------------------------------------------------------------
// Tests: Email (SMTP) settings section (#306)
// ---------------------------------------------------------------------------

describe('AdminPage — Email (SMTP) settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAdminSettings.mockResolvedValue(fakeSettings)
    mockGetAdminUsers.mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] })
    mockGetAdminInviteLinks.mockResolvedValue([])
    mockGetAdminEmailSettings.mockResolvedValue(fakeEmailSettings)
  })

  async function renderEmailSection(overrides: Partial<SiteEmailSettings> = {}) {
    mockGetAdminEmailSettings.mockResolvedValue({ ...fakeEmailSettings, ...overrides })
    renderAdminPage()
    await waitFor(() => screen.getByLabelText('Host'))
  }

  it('shows which source is actually sending mail', async () => {
    await renderEmailSection()
    const panel = screen.getByRole('group', { name: 'Currently sending mail' })
    expect(within(panel).getByText('Environment variables')).toBeInTheDocument()
    expect(within(panel).getByText(/smtp\.env\.example:587/)).toBeInTheDocument()
  })

  it('warns when no mail server is configured at all', async () => {
    await renderEmailSection({ effective_host: '', effective_from_email: '' })
    expect(
      screen.getByText(/password resets and invites are not being delivered/i)
    ).toBeInTheDocument()
  })

  it('explains an EMAIL_BACKEND override without disabling the form', async () => {
    await renderEmailSection({ effective_source: 'env_backend_override' })
    expect(screen.getByText(/EMAIL_BACKEND is set on the server/)).toBeInTheDocument()
    // The values still persist and are still worth editing, so the form must
    // not be a greyed dead end.
    expect(screen.getByLabelText('Host')).not.toBeDisabled()
  })

  it('warns when the stored password cannot be decrypted', async () => {
    await renderEmailSection({
      config_source: 'database',
      effective_source: 'database',
      password_set: true,
      password_decryptable: false,
    })
    expect(screen.getByText(/Can.t decrypt the stored password/)).toBeInTheDocument()
    expect(screen.getByText(/secret key most likely changed/)).toBeInTheDocument()
  })

  it('keeps Save and Cancel disabled until something changes', async () => {
    await renderEmailSection()
    expect(screen.getByText('Save email settings')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'smtp.new.test' } })
    await waitFor(() => expect(screen.getByText('Save email settings')).not.toBeDisabled())
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
  })

  it('does not autosave on change — the PATCH only fires on Save', async () => {
    await renderEmailSection()
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'smtp.new.test' } })
    fireEvent.blur(screen.getByLabelText('Host'))
    expect(mockPatchAdminEmailSettings).not.toHaveBeenCalled()
  })

  it('maps the encryption choice onto use_tls / use_ssl', async () => {
    mockPatchAdminEmailSettings.mockResolvedValue({
      ...fakeEmailSettings, use_tls: false, use_ssl: true,
    })
    await renderEmailSection()
    fireEvent.click(screen.getByText('SSL/TLS'))
    fireEvent.click(screen.getByText('Save email settings'))
    await waitFor(() => {
      expect(mockPatchAdminEmailSettings).toHaveBeenCalledWith(
        expect.objectContaining({ use_tls: false, use_ssl: true })
      )
    })
  })

  it('warns that None sends credentials unencrypted', async () => {
    await renderEmailSection()
    fireEvent.click(screen.getByText('None'))
    expect(
      screen.getByText(/Credentials and message contents are sent unencrypted/)
    ).toBeInTheDocument()
  })

  it('omits the password from the PATCH when left blank', async () => {
    mockPatchAdminEmailSettings.mockResolvedValue(fakeEmailSettings)
    await renderEmailSection({ password_set: true })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'smtp.new.test' } })
    fireEvent.click(screen.getByText('Save email settings'))
    await waitFor(() => expect(mockPatchAdminEmailSettings).toHaveBeenCalled())
    // "Leave blank to keep the current password" has to mean the key is absent
    // on the wire, not an empty string.
    expect(mockPatchAdminEmailSettings.mock.calls[0][0]).not.toHaveProperty('password')
  })

  it('sends an empty password only when Clear is used', async () => {
    mockPatchAdminEmailSettings.mockResolvedValue(fakeEmailSettings)
    await renderEmailSection({ password_set: true })
    fireEvent.click(screen.getByText('Clear'))
    expect(screen.getByText(/Password will be cleared when you save/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Save email settings'))
    await waitFor(() => {
      expect(mockPatchAdminEmailSettings).toHaveBeenCalledWith(
        expect.objectContaining({ password: '' })
      )
    })
  })

  it('Undo cancels a pending password clear', async () => {
    await renderEmailSection({ password_set: true })
    fireEvent.click(screen.getByText('Clear'))
    fireEvent.click(screen.getByText('Undo'))
    expect(screen.queryByText(/Password will be cleared/)).not.toBeInTheDocument()
    expect(screen.getByText('A password is stored.')).toBeInTheDocument()
  })

  it('replaces the blank-is-fine hint when a password becomes required', async () => {
    await renderEmailSection()
    expect(
      screen.getByText(/Leave blank if your server doesn.t require a password/)
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'mailer' } })
    fireEvent.click(screen.getByText('Save email settings'))
    await waitFor(() => {
      expect(screen.getByText('A password is required when a username is set.')).toBeInTheDocument()
    })
    // Showing "leave blank if not required" beside "a password is required"
    // would be two contradictory instructions at once.
    expect(
      screen.queryByText(/Leave blank if your server doesn.t require a password/)
    ).not.toBeInTheDocument()
  })

  it('does not claim a source is unused until that choice is saved', async () => {
    await renderEmailSection({
      config_source: 'database', host: 'smtp.db.test', from_email: 'db@visiban.test',
      effective_source: 'database',
    })
    expect(screen.queryByText(/Saved, but not in use/)).not.toBeInTheDocument()
    const group = screen.getByRole('radiogroup', { name: 'Email configuration source' })
    fireEvent.click(within(group).getByText('Environment variables'))
    // The database config is still what is live until this is saved.
    expect(screen.queryByText(/Saved, but not in use/)).not.toBeInTheDocument()
  })

  it('requires a password when a username is set', async () => {
    await renderEmailSection()
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'mailer' } })
    fireEvent.click(screen.getByText('Save email settings'))
    await waitFor(() => {
      expect(screen.getByText('A password is required when a username is set.')).toBeInTheDocument()
    })
    expect(mockPatchAdminEmailSettings).not.toHaveBeenCalled()
  })

  it('rejects an out-of-range port without calling the API', async () => {
    await renderEmailSection()
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '70000' } })
    fireEvent.click(screen.getByText('Save email settings'))
    await waitFor(() => {
      expect(
        screen.getByText('Port must be a whole number between 1 and 65535.')
      ).toBeInTheDocument()
    })
    expect(mockPatchAdminEmailSettings).not.toHaveBeenCalled()
  })

  it('requires host and sender before switching to database', async () => {
    await renderEmailSection()
    const group = screen.getByRole('radiogroup', { name: 'Email configuration source' })
    fireEvent.click(within(group).getByText('Database'))
    fireEvent.click(screen.getByText('Save email settings'))
    await waitFor(() => {
      expect(screen.getByText('Host is required.')).toBeInTheDocument()
    })
    expect(screen.getByText('From address is required.')).toBeInTheDocument()
    expect(mockPatchAdminEmailSettings).not.toHaveBeenCalled()
  })

  it('rejects a display-name sender the backend would 400 on', async () => {
    // The backend uses a DRF EmailField, which rejects the display-name form.
    // Accepting it here would promise something the server refuses.
    await renderEmailSection()
    fireEvent.change(screen.getByLabelText('From address'), {
      target: { value: 'Visiban <noreply@visiban.test>' },
    })
    fireEvent.click(screen.getByText('Save email settings'))
    await waitFor(() => {
      expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument()
    })
    expect(mockPatchAdminEmailSettings).not.toHaveBeenCalled()
  })

  it('confirms before switching env to database', async () => {
    mockPatchAdminEmailSettings.mockResolvedValue({
      ...fakeEmailSettings, config_source: 'database',
    })
    await renderEmailSection()
    const group = screen.getByRole('radiogroup', { name: 'Email configuration source' })
    fireEvent.click(within(group).getByText('Database'))
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'smtp.new.test' } })
    fireEvent.change(screen.getByLabelText('From address'), {
      target: { value: 'noreply@visiban.test' },
    })
    fireEvent.click(screen.getByText('Save email settings'))

    // The confirm row appears and nothing is sent yet.
    await waitFor(() => screen.getByText(/Switch to database configuration\?/))
    expect(mockPatchAdminEmailSettings).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Confirm'))
    await waitFor(() => {
      expect(mockPatchAdminEmailSettings).toHaveBeenCalledWith(
        expect.objectContaining({ config_source: 'database' })
      )
    })
  })

  it('does not confirm when switching database back to env', async () => {
    mockPatchAdminEmailSettings.mockResolvedValue(fakeEmailSettings)
    await renderEmailSection({
      config_source: 'database', host: 'smtp.db.test', from_email: 'db@visiban.test',
    })
    const sourceGroup = screen.getByRole('radiogroup', { name: 'Email configuration source' })
    fireEvent.click(within(sourceGroup).getByText('Environment variables'))
    fireEvent.click(screen.getByText('Save email settings'))
    // Restoring the previous behavior needs no warning.
    await waitFor(() => {
      expect(mockPatchAdminEmailSettings).toHaveBeenCalledWith(
        expect.objectContaining({ config_source: 'env' })
      )
    })
  })

  it('Cancel restores the last saved values', async () => {
    await renderEmailSection()
    const host = screen.getByLabelText('Host') as HTMLInputElement
    fireEvent.change(host, { target: { value: 'smtp.typo.test' } })
    await waitFor(() => screen.getByText('Unsaved changes'))
    const footerCancel = screen.getByText('Save email settings').parentElement as HTMLElement
    fireEvent.click(within(footerCancel).getByText('Cancel'))
    await waitFor(() => expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe(''))
  })

  it('uses its own status line, distinct from the shared one', async () => {
    mockPatchAdminEmailSettings.mockResolvedValue(fakeEmailSettings)
    await renderEmailSection()
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'smtp.new.test' } })
    fireEvent.click(screen.getByText('Save email settings'))
    await waitFor(() => expect(screen.getByText('Email settings saved.')).toBeInTheDocument())
    // Must not collide with SettingsTab's shared "Settings saved." line.
    expect(screen.queryByText('Settings saved.')).not.toBeInTheDocument()
  })

  it('disables the test button while there are unsaved changes', async () => {
    await renderEmailSection()
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'smtp.new.test' } })
    await waitFor(() => expect(screen.getByText('Send test email')).toBeDisabled())
    expect(screen.getByText('Save your changes before testing.')).toBeInTheDocument()
    expect(mockSendAdminTestEmail).not.toHaveBeenCalled()
  })

  it('reports a successful test send', async () => {
    mockSendAdminTestEmail.mockResolvedValue({
      success: true, code: null, sent_to: 'admin@example.com',
    })
    await renderEmailSection()
    fireEvent.click(screen.getByText('Send test email'))
    await waitFor(() => {
      expect(screen.getByText('Test email sent to admin@example.com.')).toBeInTheDocument()
    })
  })

  it('maps each failure code to a headline and a remedy', async () => {
    mockSendAdminTestEmail.mockResolvedValue({ success: false, code: 'auth_failed' })
    await renderEmailSection()
    fireEvent.click(screen.getByText('Send test email'))
    await waitFor(() => {
      expect(
        screen.getByText('The server rejected the username or password.')
      ).toBeInTheDocument()
    })
    expect(
      screen.getByText('Re-enter the password and save before testing again.')
    ).toBeInTheDocument()
  })

  it('treats an unrecognized failure code as unknown', async () => {
    mockSendAdminTestEmail.mockResolvedValue({ success: false, code: 'brand_new_code' })
    await renderEmailSection()
    fireEvent.click(screen.getByText('Send test email'))
    await waitFor(() => expect(screen.getByText('The test failed.')).toBeInTheDocument())
  })

  it('explains a throttled test without treating it as a failure', async () => {
    mockSendAdminTestEmail.mockRejectedValue({ response: { status: 429, data: {} } })
    await renderEmailSection()
    fireEvent.click(screen.getByText('Send test email'))
    await waitFor(() => expect(screen.getByText('Too many test emails.')).toBeInTheDocument())
    expect(screen.getByText('You can send 5 per hour. Try again later.')).toBeInTheDocument()
  })

  it('offers a retry when the section fails to load', async () => {
    mockGetAdminEmailSettings.mockRejectedValueOnce(new Error('boom'))
    renderAdminPage()
    await waitFor(() => screen.getByText('Failed to load email settings.'))
    mockGetAdminEmailSettings.mockResolvedValue(fakeEmailSettings)
    fireEvent.click(screen.getByText('Retry'))
    await waitFor(() => expect(screen.getByLabelText('Host')).toBeInTheDocument())
  })

  it('surfaces a server field error next to the field', async () => {
    mockPatchAdminEmailSettings.mockRejectedValue({
      response: { data: { from_email: ['Enter your real sending address.'] } },
    })
    await renderEmailSection()
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'smtp.new.test' } })
    fireEvent.click(screen.getByText('Save email settings'))
    await waitFor(() => {
      expect(screen.getByText('Enter your real sending address.')).toBeInTheDocument()
    })
    expect(screen.getByText('Failed to save email settings.')).toBeInTheDocument()
  })
})
