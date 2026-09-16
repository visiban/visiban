import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AdminPage from '../pages/AdminPage'
import type { User, AdminUser, SiteSettings } from '../types'

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
    await waitFor(() => screen.getByText('Cancel'))
    fireEvent.click(screen.getByText('Cancel'))

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
