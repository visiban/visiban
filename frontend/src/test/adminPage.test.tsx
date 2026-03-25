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

vi.mock('../api/auth', () => ({
  getAdminSettings: (...args: unknown[]) => mockGetAdminSettings(...args),
  patchAdminSettings: (...args: unknown[]) => mockPatchAdminSettings(...args),
  getAdminUsers: (...args: unknown[]) => mockGetAdminUsers(...args),
  createAdminUser: (...args: unknown[]) => mockCreateAdminUser(...args),
  patchAdminUser: (...args: unknown[]) => mockPatchAdminUser(...args),
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
    mockGetAdminUsers.mockResolvedValue({ count: 0, next: null, previous: null, results: [] })
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
    mockGetAdminUsers.mockResolvedValue({ count: 0, next: null, previous: null, results: [] })
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
    mockPatchAdminSettings.mockResolvedValue({ registration_mode: 'closed' })
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
      next: null,
      previous: null,
      results: fakeAdminUsers,
    })
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
// Tests: Escape key behaviour
// ---------------------------------------------------------------------------

describe('AdminPage — Escape key', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAdminSettings.mockResolvedValue(fakeSettings)
    mockGetAdminUsers.mockResolvedValue({ count: 2, next: null, previous: null, results: fakeAdminUsers })
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
  it('getAdminSettings and patchAdminSettings are exported', async () => {
    const mod = await import('../api/auth')
    expect(typeof mod.getAdminSettings).toBe('function')
    expect(typeof mod.patchAdminSettings).toBe('function')
    expect(typeof mod.getAdminUsers).toBe('function')
    expect(typeof mod.createAdminUser).toBe('function')
    expect(typeof mod.patchAdminUser).toBe('function')
  })
})
