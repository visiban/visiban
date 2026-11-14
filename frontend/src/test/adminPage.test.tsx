import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AdminPage from '../pages/AdminPage'
import type { User, AdminUser, SiteSettings, SiteEmailSettings } from '../types'
import { stallEventLoopAfterWaitFor } from './eventLoopStall'
import { stubVisualViewport, clearVisualViewport } from './visualViewportStub'
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
const mockClearAdminUserLockout = vi.fn()
const mockRevokeAdminInviteLink = vi.fn()
const mockGetAdminEmailSettings = vi.fn()
const mockPatchAdminEmailSettings = vi.fn()
const mockSendAdminTestEmail = vi.fn()
const mockSendAdminInviteEmail = vi.fn()
const mockGetSiteConfig = vi.fn()
const mockGetAdminBoardInviteLinks = vi.fn()
const mockRevokeAdminBoardInviteLink = vi.fn()

vi.mock('../api/auth', () => ({
  getAdminSettings: (...args: unknown[]) => mockGetAdminSettings(...args),
  patchAdminSettings: (...args: unknown[]) => mockPatchAdminSettings(...args),
  getAdminUsers: (...args: unknown[]) => mockGetAdminUsers(...args),
  createAdminUser: (...args: unknown[]) => mockCreateAdminUser(...args),
  patchAdminUser: (...args: unknown[]) => mockPatchAdminUser(...args),
  getAdminInviteLinks: (...args: unknown[]) => mockGetAdminInviteLinks(...args),
  createAdminInviteLink: (...args: unknown[]) => mockCreateAdminInviteLink(...args),
  deactivateAdminUser: (...args: unknown[]) => mockDeactivateAdminUser(...args),
  clearAdminUserLockout: (...args: unknown[]) => mockClearAdminUserLockout(...args),
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
  getSiteConfig: (...args: unknown[]) => mockGetSiteConfig(...args),
  sendAdminInviteEmail: (...args: unknown[]) => mockSendAdminInviteEmail(...args),
  getAdminBoardInviteLinks: (...args: unknown[]) => mockGetAdminBoardInviteLinks(...args),
  revokeAdminBoardInviteLink: (...args: unknown[]) => mockRevokeAdminBoardInviteLink(...args),
  changePassword: vi.fn(),
  searchUsers: vi.fn(),
}))

// OffboardingModal's per-board member search bypasses ../api/auth and calls
// the shared axios client directly (a dynamic import), so it needs its own mock.
const mockClientGet = vi.fn()
vi.mock('../api/client', () => ({
  default: { get: (...args: unknown[]) => mockClientGet(...args) },
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
  is_superuser: false,
  must_change_password: false,
  must_change_username: false,
}

const superuserActor: User = { ...adminUser, is_superuser: true }

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
    is_superuser: false,
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
    is_superuser: false,
    must_change_password: false,
    date_joined: '2024-02-01T00:00:00Z',
    owned_boards: [],
  },
]

// Full SiteConfig, including invite_email_available, which the Invite Links tab's
// EmailInviteForm reads (#731). Set for every describe so a partial mock never leaks in.
const fakeSiteConfig = {
  registration_open: true,
  registration_mode: 'open',
  demo_mode: false,
  demo_login: null,
  invite_email_available: true,
}
beforeEach(() => {
  mockGetSiteConfig.mockResolvedValue(fakeSiteConfig)
})

function renderAdminPage(user: User = adminUser, initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AdminPage user={user} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
    </MemoryRouter>
  )
}

// The Settings tab renders in stages: the instance settings load first, then
// EmailSettingsSection mounts and loads its own settings. Finding an element
// from the first stage does not mean the page is idle: the commit that shows
// it can still have mount effects queued, and on a slow CI runner the test can
// act before they run (#1319, occurrence 4). Waiting for the last stage (an
// SMTP field) means every load and mount effect has already run, so the test
// starts from a page with no work in flight.
//
// Use it for every test that acts on the page. Plain renderAdminPage() is left
// only where the page never reaches that state or the test needs the unsettled
// window: the non-admin redirect (renders nothing), a failed settings or email
// settings load (no SMTP field ever appears), and the #1319 race regressions.
async function renderAdminPageSettled(user: User = adminUser) {
  const view = renderAdminPage(user)
  await screen.findByLabelText('Host')
  return view
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
    await renderAdminPageSettled(adminUser)
    await waitFor(() => {
      expect(screen.getByText('Site Administration')).toBeInTheDocument()
    })
  })

  it('opens the tab named by ?tab= and ignores an unknown one (#1301)', async () => {
    const { unmount } = renderAdminPage(adminUser, '/admin?tab=users')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Users' })).toHaveAttribute('aria-current', 'page')
    })
    unmount()
    renderAdminPage(adminUser, '/admin?tab=nope')
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
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
    await renderAdminPageSettled()
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
    await renderAdminPageSettled()
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
    await renderAdminPageSettled()
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
    await renderAdminPageSettled()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => {
      // username rendered as "@alice" in the table row
      expect(screen.getByText('@alice')).toBeInTheDocument()
    })
  })

  it('shows Add User button', async () => {
    await renderAdminPageSettled()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => {
      expect(screen.getByText('+ Add User')).toBeInTheDocument()
    })
  })

  it('opens add user modal on Add User click', async () => {
    await renderAdminPageSettled()
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
      is_superuser: false,
      must_change_password: true,
      date_joined: '2024-03-01T00:00:00Z',
      owned_boards: [],
    }
    mockCreateAdminUser.mockResolvedValue(newUser)
    await renderAdminPageSettled()
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
    await renderAdminPageSettled()
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

  // Force reset, Restart onboarding tour, and Clear lockout all moved into
  // each row's OverflowMenu (#1291) — open the row's "More actions" trigger
  // before interacting with any of them.
  async function openRowMenu(name: string) {
    fireEvent.click(screen.getByRole('button', { name: `More actions for ${name}` }))
    await screen.findByRole('menu')
  }

  it('calls patchAdminUser on force reset click', async () => {
    mockPatchAdminUser.mockResolvedValue({ ...fakeAdminUsers[1], must_change_password: true })
    await renderAdminPageSettled()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('@alice'))
    await openRowMenu('Admin User')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Force reset' }))
    await waitFor(() => {
      expect(mockPatchAdminUser).toHaveBeenCalledWith(
        expect.any(Number),
        { must_change_password: true }
      )
    })
  })

  it('shows Restart onboarding tour only for a user who completed the tour, PATCHes has_completed_tour: false on click, disables the item while pending, and shows a success message (#1280)', async () => {
    const toured: AdminUser = { ...fakeAdminUsers[1], has_completed_tour: true }
    mockGetAdminUsers.mockResolvedValue({
      count: 2,
      offset: 0,
      page_size: 50,
      results: [fakeAdminUsers[0], toured],
    })
    let resolvePatch: ((value: AdminUser) => void) | undefined
    mockPatchAdminUser.mockReturnValue(
      new Promise<AdminUser>((resolve) => { resolvePatch = resolve })
    )
    await renderAdminPageSettled()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('@alice'))

    // fakeAdminUsers[0] (admin) has no has_completed_tour set (falsy), so the
    // action must not appear in that row's menu.
    await openRowMenu('Admin User')
    expect(screen.queryByText('Restart onboarding tour')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Admin User' })) // close it again

    await openRowMenu(toured.display_name)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restart onboarding tour' }))
    expect(mockPatchAdminUser).toHaveBeenCalledWith(toured.id, { has_completed_tour: false })

    // In-flight guard: OverflowMenu closes the panel on any select, so reopen
    // it — the item now renders a pending label and is disabled, so a stray
    // second click while the PATCH is outstanding can't fire a duplicate
    // request for the same user.
    await openRowMenu(toured.display_name)
    const pendingItem = await screen.findByRole('menuitem', { name: 'Restarting…' })
    expect(pendingItem).toBeDisabled()
    fireEvent.click(pendingItem)
    expect(mockPatchAdminUser).toHaveBeenCalledTimes(1)

    resolvePatch!({ ...toured, has_completed_tour: false })

    // After the update comes back with has_completed_tour: false, the action
    // disappears from the (still open) menu — nothing left to reset — and an
    // inline success message appears, mirroring the self-service confirmation
    // in SettingsPage.
    await waitFor(() => {
      expect(screen.queryByText('Restart onboarding tour')).not.toBeInTheDocument()
      expect(screen.queryByText('Restarting…')).not.toBeInTheDocument()
    })
    expect(
      screen.getByText(`Tour will restart for ${toured.display_name} on their next visit to a board.`)
    ).toBeInTheDocument()
  })

  it('ignores a second restart-tour click for the same user while its PATCH is in flight (#1280)', async () => {
    // OverflowMenu closes its panel on select and re-renders its items from
    // the parent on every open, so reopening it after the first click is what
    // exercises both guards against a duplicate PATCH for the same in-flight
    // user: OverflowMenu's own `item.disabled` check on the reopened item, and
    // handleRestartTour's `restartingTourIds` guard underneath it.
    const toured: AdminUser = { ...fakeAdminUsers[1], has_completed_tour: true }
    mockGetAdminUsers.mockResolvedValue({
      count: 2,
      offset: 0,
      page_size: 50,
      results: [fakeAdminUsers[0], toured],
    })
    mockPatchAdminUser.mockReturnValue(new Promise<AdminUser>(() => { /* never resolves */ }))
    await renderAdminPageSettled()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('@alice'))

    await openRowMenu(toured.display_name)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restart onboarding tour' }))
    expect(mockPatchAdminUser).toHaveBeenCalledTimes(1)

    await openRowMenu(toured.display_name)
    const pendingItem = await screen.findByRole('menuitem', { name: 'Restarting…' })
    expect(pendingItem).toBeDisabled()
    fireEvent.click(pendingItem)

    expect(mockPatchAdminUser).toHaveBeenCalledTimes(1)
  })

  // Regression guard (#1280): unmounting while the 4s success-message
  // auto-clear timer is pending must clear it, not fire a state update after
  // teardown — the same class of bug fixed for SettingsPage's tour-restart
  // confirmation in #870.
  it('clears the pending success-message timer on unmount, without throwing or warning', async () => {
    const toured: AdminUser = { ...fakeAdminUsers[1], has_completed_tour: true }
    mockGetAdminUsers.mockResolvedValue({
      count: 2,
      offset: 0,
      page_size: 50,
      results: [fakeAdminUsers[0], toured],
    })
    mockPatchAdminUser.mockResolvedValue({ ...toured, has_completed_tour: false })
    const { unmount } = await renderAdminPageSettled()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('@alice'))
    await openRowMenu(toured.display_name)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restart onboarding tour' }))
    await waitFor(() => {
      expect(
        screen.getByText(`Tour will restart for ${toured.display_name} on their next visit to a board.`)
      ).toBeInTheDocument()
    })

    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => unmount()).not.toThrow()
    expect(clearSpy).toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    clearSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('confirm dialog starts on Cancel, traps Tab, and returns focus to the row kebab (#1732)', async () => {
    await renderAdminPageSettled()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('@alice'))
    await openRowMenu('Admin User')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear lockout' }))
    const dialog = await screen.findByRole('dialog')
    const cancel = within(dialog).getByText('Cancel')
    const confirm = within(dialog).getByText('Confirm')
    expect(cancel).toHaveFocus()
    confirm.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()
    fireEvent.click(cancel)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // The opener (a menu item) unmounted with its menu; focus returns to the row kebab.
    expect(screen.getByRole('button', { name: 'More actions for Admin User' })).toHaveFocus()
  })

  it('calls clearAdminUserLockout after confirming the clear-lockout action (#1203)', async () => {
    mockClearAdminUserLockout.mockResolvedValue(fakeAdminUsers[1])
    await renderAdminPageSettled()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('@alice'))
    await openRowMenu('Admin User')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear lockout' }))

    // The action is confirm-gated — it must not fire before the dialog is confirmed.
    expect(mockClearAdminUserLockout).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('Confirm'))

    await waitFor(() => {
      expect(mockClearAdminUserLockout).toHaveBeenCalledWith(expect.any(Number))
    })
  })

  it('does not call clearAdminUserLockout if the confirm dialog is canceled', async () => {
    await renderAdminPageSettled()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('@alice'))
    await openRowMenu('Admin User')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear lockout' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('Cancel'))

    expect(mockClearAdminUserLockout).not.toHaveBeenCalled()
  })

  it('shows the server detail message when clearAdminUserLockout fails (#1203)', async () => {
    mockClearAdminUserLockout.mockRejectedValue({
      response: { data: { detail: 'Account is not currently locked out.' } },
    })
    await renderAdminPageSettled()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('@alice'))
    await openRowMenu('Admin User')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear lockout' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('Confirm'))

    await waitFor(() => {
      expect(screen.getByText('Account is not currently locked out.')).toBeInTheDocument()
    })
  })

  it('shows the server detail message when revoking all-content access fails', async () => {
    const message = 'Cannot remove all-content access from a superuser; remove superuser status first.'
    const holder: AdminUser = { ...fakeAdminUsers[1], can_access_all_content: true }
    mockGetAdminUsers.mockResolvedValue({
      count: 2, offset: 0, page_size: 50, results: [fakeAdminUsers[0], holder],
    })
    mockPatchAdminUser.mockRejectedValue({ response: { data: { detail: message } } })
    await renderAdminPageSettled()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('@alice'))
    await openRowMenu('Alice')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke all-content' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('Confirm'))

    await waitFor(() => {
      expect(mockPatchAdminUser).toHaveBeenCalledWith(3, { can_access_all_content: false })
      expect(screen.getByText(message)).toBeInTheDocument()
    })
  })

  it('does not offer Revoke all-content or Demote admin on a superuser row', async () => {
    // Superuser status implies both site admin and all-content access, so the
    // row leaves out the two actions that would clear them.
    const superuser: AdminUser = {
      ...fakeAdminUsers[1],
      is_site_admin: true,
      can_access_all_content: true,
      is_superuser: true,
    }
    const holder: AdminUser = {
      ...fakeAdminUsers[1],
      id: 4,
      username: 'bob',
      display_name: 'Bob',
      is_site_admin: true,
      can_access_all_content: true,
    }
    mockGetAdminUsers.mockResolvedValue({
      count: 3, offset: 0, page_size: 50, results: [fakeAdminUsers[0], superuser, holder],
    })
    await renderAdminPageSettled(superuserActor)
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('@alice'))

    const superRow = screen.getByText('@alice').closest('tr') as HTMLElement
    const holderRow = screen.getByText('@bob').closest('tr') as HTMLElement
    expect(within(superRow).queryByRole('button', { name: 'Demote admin' })).not.toBeInTheDocument()
    expect(within(superRow).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument()
    expect(within(holderRow).getByRole('button', { name: 'Demote admin' })).toBeInTheDocument()

    await openRowMenu('Alice')
    expect(screen.queryByRole('menuitem', { name: 'Revoke all-content' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Grant all-content' })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Clear lockout' })).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    await openRowMenu('Bob')
    expect(screen.getByRole('menuitem', { name: 'Revoke all-content' })).toBeInTheDocument()
  })

  it('shows the Superuser chip only on superuser rows and no describedby on others (#2083)', async () => {
    const superuser: AdminUser = { ...fakeAdminUsers[1], is_superuser: true }
    mockGetAdminUsers.mockResolvedValue({
      count: 2, offset: 0, page_size: 50, results: [fakeAdminUsers[0], superuser],
    })
    await renderAdminPageSettled(superuserActor)
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('@alice'))
    const superRow = screen.getByText('@alice').closest('tr') as HTMLElement
    const otherRow = screen.getByText(`@${fakeAdminUsers[0].username}`).closest('tr') as HTMLElement
    expect(within(superRow).getByText('Superuser')).toBeInTheDocument()
    expect(within(otherRow).queryByText('Superuser')).not.toBeInTheDocument()
    expect(within(otherRow).getByRole('button', { name: /^More actions for/ })).not.toHaveAttribute('aria-describedby')
  })

  it('still offers Grant all-content on a superuser row whose flag is off', async () => {
    const superuser: AdminUser = { ...fakeAdminUsers[1], is_superuser: true }
    mockGetAdminUsers.mockResolvedValue({
      count: 2, offset: 0, page_size: 50, results: [fakeAdminUsers[0], superuser],
    })
    await renderAdminPageSettled(superuserActor)
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('@alice'))
    await openRowMenu('Alice')
    expect(screen.getByRole('menuitem', { name: 'Grant all-content' })).toBeInTheDocument()
  })

  describe('a superuser row seen by a site admin who is not a superuser (#1644)', () => {
    const EXPLANATION = "Only a superuser can change this account's access or sign-in."
    // The four actions the API answers 400 to: activation, all-content access,
    // forced password change, and the lockout.
    const REFUSED_MENU_ITEMS = ['Grant all-content', 'Revoke all-content', 'Force reset', 'Clear lockout']

    const superuserRow = (overrides: Partial<AdminUser> = {}): AdminUser => ({
      ...fakeAdminUsers[1],
      is_site_admin: true,
      can_access_all_content: true,
      is_superuser: true,
      has_completed_tour: true,
      ...overrides,
    })

    async function openUsersTab(actor: User, row: AdminUser) {
      mockGetAdminUsers.mockResolvedValue({
        count: 2, offset: 0, page_size: 50, results: [fakeAdminUsers[0], row],
      })
      await renderAdminPageSettled(actor)
      fireEvent.click(screen.getByText('Users'))
      await waitFor(() => screen.getByText('@alice'))
      return screen.getByText('@alice').closest('tr') as HTMLElement
    }

    it('ties the explanation to the More actions trigger and badges the row (#2083)', async () => {
      const row = await openUsersTab(adminUser, superuserRow())
      const note = within(row).getByText(EXPLANATION)
      expect(note.id).toBeTruthy()
      const trigger = within(row).getByRole('button', { name: 'More actions for Alice' })
      expect(trigger).toHaveAttribute('aria-describedby', note.id)
      expect(within(row).getByText('Superuser')).toBeInTheDocument()
    })

    it('leaves out every refused action and says why in text a screen reader reaches', async () => {
      const row = await openUsersTab(adminUser, superuserRow({ can_access_all_content: false }))
      expect(within(row).queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument()
      expect(within(row).queryByRole('button', { name: 'Demote admin' })).not.toBeInTheDocument()
      // In the row's text, not a tooltip or title: no hover or focus needed.
      expect(within(row).getByText(EXPLANATION)).toBeVisible()

      await openRowMenu('Alice')
      for (const name of REFUSED_MENU_ITEMS) {
        expect(screen.queryByRole('menuitem', { name })).not.toBeInTheDocument()
      }
    })

    it('leaves out Reactivate on an inactive superuser', async () => {
      const row = await openUsersTab(adminUser, superuserRow({ is_active: false }))
      expect(within(row).queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument()
      expect(within(row).getByText(EXPLANATION)).toBeVisible()
    })

    it('does not start the transfer dialog for a superuser who owns boards', async () => {
      const row = await openUsersTab(
        adminUser,
        superuserRow({ owned_boards: [{ id: 9, uid: 'owned', name: 'Owned' }] }),
      )
      expect(within(row).queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('keeps the actions the server still permits', async () => {
      mockPatchAdminUser.mockResolvedValue(superuserRow({ has_completed_tour: false }))
      const row = await openUsersTab(adminUser, superuserRow({ is_site_admin: false }))
      expect(within(row).getByRole('button', { name: 'Make admin' })).toBeInTheDocument()

      await openRowMenu('Alice')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Restart onboarding tour' }))
      await waitFor(() => {
        expect(mockPatchAdminUser).toHaveBeenCalledWith(3, { has_completed_tour: false })
      })
    })

    it('still explains a row with nothing left to offer, and renders no empty menu', async () => {
      const row = await openUsersTab(adminUser, superuserRow({ has_completed_tour: false }))
      expect(within(row).getByText(EXPLANATION)).toBeVisible()
      expect(within(row).queryByRole('button')).not.toBeInTheDocument()
    })

    it('leaves an ordinary row untouched', async () => {
      const row = await openUsersTab(superuserActor, { ...fakeAdminUsers[1] })
      expect(within(row).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument()
      expect(within(row).queryByText(EXPLANATION)).not.toBeInTheDocument()

      await openRowMenu('Alice')
      for (const name of ['Grant all-content', 'Force reset', 'Clear lockout']) {
        expect(screen.getByRole('menuitem', { name })).toBeInTheDocument()
      }
    })

    it('offers a superuser actor every action the API allows them', async () => {
      const row = await openUsersTab(superuserActor, superuserRow({ can_access_all_content: false }))
      expect(within(row).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument()
      expect(within(row).queryByText(EXPLANATION)).not.toBeInTheDocument()

      await openRowMenu('Alice')
      for (const name of ['Grant all-content', 'Force reset', 'Clear lockout']) {
        expect(screen.getByRole('menuitem', { name })).toBeInTheDocument()
      }
    })

    it('offers Reactivate on an inactive superuser to a superuser actor', async () => {
      const row = await openUsersTab(superuserActor, superuserRow({ is_active: false }))
      expect(within(row).getByRole('button', { name: 'Reactivate' })).toBeInTheDocument()
    })

    it('hides nothing when the actor\'s status is unknown and leaves the answer to the server', async () => {
      // A User object without the field, for example one built by a test or a
      // stale client: hiding a permitted action is worse than a server refusal.
      const unknownActor: User = { ...adminUser }
      delete unknownActor.is_superuser
      const row = await openUsersTab(unknownActor, superuserRow())
      expect(within(row).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument()
      expect(within(row).queryByText(EXPLANATION)).not.toBeInTheDocument()
    })
  })

  describe('granting all-content access is superuser-only (#1830)', () => {
    const openAliceMenu = async (actor: User, row: AdminUser) => {
      mockGetAdminUsers.mockResolvedValue({
        count: 2, offset: 0, page_size: 50, results: [fakeAdminUsers[0], row],
      })
      await renderAdminPageSettled(actor)
      fireEvent.click(screen.getByText('Users'))
      await waitFor(() => screen.getByText('@alice'))
      await openRowMenu('Alice')
    }

    it('hides Grant from a site admin who is not a superuser and keeps the row\'s other actions', async () => {
      await openAliceMenu(adminUser, { ...fakeAdminUsers[1] })
      expect(screen.queryByRole('menuitem', { name: 'Grant all-content' })).not.toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: 'Force reset' })).toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: 'Clear lockout' })).toBeInTheDocument()
    })

    it('hides Grant on the actor\'s own row too', async () => {
      await openAliceMenu(adminUser, { ...fakeAdminUsers[1] })
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      await openRowMenu('Admin User')
      expect(screen.queryByRole('menuitem', { name: 'Grant all-content' })).not.toBeInTheDocument()
    })

    it('keeps Revoke for a site admin who is not a superuser, and it still sends the revoke', async () => {
      const holder: AdminUser = { ...fakeAdminUsers[1], can_access_all_content: true }
      mockPatchAdminUser.mockResolvedValue({ ...holder, can_access_all_content: false })
      await openAliceMenu(adminUser, holder)
      fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke all-content' }))
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByText('Confirm'))
      await waitFor(() => {
        expect(mockPatchAdminUser).toHaveBeenCalledWith(3, { can_access_all_content: false })
      })
    })

    it('offers Grant to a superuser, and it sends the grant', async () => {
      const row: AdminUser = { ...fakeAdminUsers[1] }
      mockPatchAdminUser.mockResolvedValue({ ...row, can_access_all_content: true })
      await openAliceMenu(superuserActor, row)
      fireEvent.click(screen.getByRole('menuitem', { name: 'Grant all-content' }))
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByText('Confirm'))
      await waitFor(() => {
        expect(mockPatchAdminUser).toHaveBeenCalledWith(3, { can_access_all_content: true })
      })
    })

    it('keeps Grant when the actor\'s status is unknown and shows the server\'s refusal', async () => {
      const message = 'Only a superuser can grant all-content access.'
      const unknownActor: User = { ...adminUser }
      delete unknownActor.is_superuser
      mockPatchAdminUser.mockRejectedValue(
        Object.assign(new Error('refused'), { response: { data: { detail: message } } }),
      )
      await openAliceMenu(unknownActor, { ...fakeAdminUsers[1] })
      fireEvent.click(screen.getByRole('menuitem', { name: 'Grant all-content' }))
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByText('Confirm'))
      await waitFor(() => {
        expect(screen.getByText(message)).toBeInTheDocument()
      })
    })
  })

  it('falls back to a generic error message when clearAdminUserLockout fails without detail (#1203)', async () => {
    mockClearAdminUserLockout.mockRejectedValue(new Error('network error'))
    await renderAdminPageSettled()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('@alice'))
    await openRowMenu('Admin User')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear lockout' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('Confirm'))

    await waitFor(() => {
      expect(screen.getByText('Action failed. Please try again.')).toBeInTheDocument()
    })
  })

  it('keeps at most three inline row actions and moves the low-frequency actions into the overflow menu (#1291)', async () => {
    // Alice (id 3, active, not site admin, not all-content, not
    // must_change_password, tour not completed) exercises the full inline
    // set (Deactivate, Make admin) plus the overflow trigger — three
    // controls total — with the remaining actions folded into its menu.
    // A superuser actor: only a superuser is offered Grant all-content (#1830).
    await renderAdminPageSettled(superuserActor)
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('@alice'))

    const aliceRow = screen.getByText('@alice').closest('tr') as HTMLElement
    // Deactivate + Make admin + the overflow trigger itself — three controls
    // in the row, at the acceptance-criteria cap.
    const rowButtons = within(aliceRow).getAllByRole('button')
    expect(rowButtons.length).toBeLessThanOrEqual(3)
    expect(within(aliceRow).getByRole('button', { name: 'More actions for Alice' })).toBeInTheDocument()
    expect(within(aliceRow).getByText('Deactivate')).toBeInTheDocument()
    expect(within(aliceRow).getByText('Make admin')).toBeInTheDocument()
    expect(within(aliceRow).queryByText('Grant all-content')).not.toBeInTheDocument()
    expect(within(aliceRow).queryByText('Force reset')).not.toBeInTheDocument()
    expect(within(aliceRow).queryByText('Clear lockout')).not.toBeInTheDocument()

    fireEvent.click(within(aliceRow).getByRole('button', { name: 'More actions for Alice' }))
    const menu = await screen.findByRole('menu', { name: 'More actions for Alice' })
    expect(within(menu).getByRole('menuitem', { name: 'Grant all-content' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Force reset' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Clear lockout' })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Restart onboarding tour' })).not.toBeInTheDocument()
  })

  it('clears the pending search debounce timer on unmount (#1304)', async () => {
    const { unmount } = await renderAdminPageSettled()
    fireEvent.click(screen.getByText('Users'))
    const search = await waitFor(() =>
      screen.getByPlaceholderText('Search by name, email, or username…')
    )
    // Schedules the 400ms debounced fetchUsers call, but the component
    // unmounts before it fires — without the cleanup effect, this timer
    // would fire against an unmounted component's setters.
    fireEvent.change(search, { target: { value: 'ali' } })

    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => unmount()).not.toThrow()
    expect(clearSpy).toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    clearSpy.mockRestore()
    errorSpy.mockRestore()
  })

  // #1482: the transfer-owner results sit in an `overflow-hidden` list, so the
  // old in-flow `absolute` menu was clipped on the last board. They are now a
  // fixed panel; selecting one fills the input and closes the panel, and a
  // scroll outside the panel dismisses it.
  it('renders offboarding member-search results as a fixed panel and selects one (#1482)', async () => {
    const owner: AdminUser = {
      ...fakeAdminUsers[1],
      owned_boards: [{ id: 42, uid: 'boarduid00042', name: 'Owned Board' }],
    }
    mockGetAdminUsers.mockResolvedValue({ count: 2, offset: 0, page_size: 50, results: [fakeAdminUsers[0], owner] })
    mockClientGet.mockResolvedValue({ data: [{ id: 7, username: 'carol', display_name: 'Carol C', avatar_url: '' }] })
    await renderAdminPageSettled()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('@alice'))
    fireEvent.click(screen.getByText('Deactivate'))
    const input = await screen.findByPlaceholderText('Search for a member…')
    fireEvent.change(input, { target: { value: 'ca' } })
    const result = await screen.findByText('@carol', {}, { timeout: 2000 })
    const panel = result.closest('div[style]') as HTMLElement
    expect(panel.style.position).toBe('fixed')
    fireEvent.scroll(document.body)
    await waitFor(() => expect(screen.queryByText('@carol')).not.toBeInTheDocument())
    fireEvent.change(input, { target: { value: 'car' } })
    fireEvent.click(await screen.findByText('@carol', {}, { timeout: 2000 }))
    expect(screen.queryByText('@carol')).not.toBeInTheDocument()
    expect(input).toHaveValue('Carol C')
  })

  // #1482: the panel re-measures when the debounced result count changes, so a
  // longer list is re-placed instead of keeping the placement measured for the
  // shorter one. The anchor is a text input, so it is capped to its side rather
  // than pinned over the input (#2163).
  describe.each([
    // jsdom rects are all zero: 1600px of rows fits neither side, so the panel takes the larger side capped to it.
    { name: 'without a visualViewport', vv: null, grows: true, top: '4px', expectedCap: (): string => `${window.innerHeight - 8 - 4}px` },
    // The stub shrinks the visible viewport (phone keyboard), so the cap follows it, not window.innerHeight (#2163).
    { name: 'with a visualViewport', vv: { height: 400 }, grows: false, top: '4px', expectedCap: (): string => `${400 - 8 - 4}px` },
  ])('offboarding results panel placement $name', ({ vv, grows, top, expectedCap }) => {
  it('re-measures when the result count grows (#1482)', async () => {
    if (vv) stubVisualViewport(vv)
    const owner: AdminUser = {
      ...fakeAdminUsers[1],
      owned_boards: [{ id: 42, uid: 'boarduid00042', name: 'Owned Board' }],
    }
    mockGetAdminUsers.mockResolvedValue({ count: 2, offset: 0, page_size: 50, results: [fakeAdminUsers[0], owner] })
    const users = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 100 + i, username: `u${i}`, display_name: `User ${i}`, avatar_url: '' }))
    mockClientGet.mockResolvedValueOnce({ data: users(2) }).mockResolvedValueOnce({ data: users(8) })
    const spy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-anchored-menu') ? this.querySelectorAll('li').length * 200 : 0
    })
    try {
      await renderAdminPageSettled()
      fireEvent.click(screen.getByText('Users'))
      await waitFor(() => screen.getByText('@alice'))
      fireEvent.click(screen.getByText('Deactivate'))
      const input = await screen.findByPlaceholderText('Search for a member…')
      fireEvent.change(input, { target: { value: 'us' } })
      const panelOf = (el: HTMLElement) => el.closest('[data-anchored-menu]') as HTMLElement
      const few = panelOf(await screen.findByText('@u0', {}, { timeout: 2000 }))
      const capFew = few.style.maxHeight
      fireEvent.change(input, { target: { value: 'use' } })
      await waitFor(() => expect(screen.getAllByText(/^@u\d$/)).toHaveLength(8), { timeout: 2000 })
      const many = panelOf(screen.getByText('@u0'))
      // jsdom rects are all zero: 1600px of rows fits neither side, so it takes the larger (below) capped to it.
      expect(many.style.top).toBe(top)
      expect(many.style.maxHeight).toBe(expectedCap())
      // Without the stub the 2-row list is shorter than the cap; in the 400px viewport both lists hit it.
      if (grows) expect(many.style.maxHeight).not.toBe(capFew)
      else expect(many.style.maxHeight).toBe(capFew)
    } finally {
      spy.mockRestore()
      clearVisualViewport()
    }
  })
  })

  // Regression guard (#1305): OffboardingModal's per-board member search
  // (debounceRefs, one timer per owned board) had no unmount cleanup. Closing
  // the modal mid-debounce must clear the pending timer(s), not fire
  // setMemberResults against a torn-down modal.
  it('clears the pending offboarding member-search debounce timer on unmount (#1305)', async () => {
    const owner: AdminUser = {
      ...fakeAdminUsers[1],
      owned_boards: [{ id: 42, uid: 'boarduid00042', name: 'Owned Board' }],
    }
    mockGetAdminUsers.mockResolvedValue({
      count: 2,
      offset: 0,
      page_size: 50,
      results: [fakeAdminUsers[0], owner],
    })
    mockClientGet.mockReturnValue(new Promise(() => { /* never resolves */ }))
    await renderAdminPageSettled()
    fireEvent.click(screen.getByText('Users'))
    await waitFor(() => screen.getByText('@alice'))

    fireEvent.click(screen.getByText('Deactivate'))
    const searchInput = await screen.findByPlaceholderText('Search for a member…')
    // Schedules the 300ms debounced client.get() call, but the modal unmounts
    // before it fires.
    fireEvent.change(searchInput, { target: { value: 'bo' } })

    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fireEvent.click(screen.getByText('Cancel'))
    expect(clearSpy).toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    clearSpy.mockRestore()
    errorSpy.mockRestore()
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
    mockGetAdminEmailSettings.mockResolvedValue(fakeEmailSettings)

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

    await renderAdminPageSettled()
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

    await renderAdminPageSettled()
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

  // #1374 — the clipboard write is a floating promise if its rejection isn't
  // surfaced; a failed copy must not fail silently.
  it('shows an error when copying the join URL to the clipboard fails', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    mockCreateAdminInviteLink.mockResolvedValue({
      id: 1,
      prefix: 'vbnl_ab',
      status: 'pending',
      single_use: false,
      expires_at: null,
      use_count: 0,
      created_by_username: 'admin',
      raw_token: 'vbnl_abc123def456',
    })

    await renderAdminPageSettled()
    await waitFor(() => screen.getByText('Invite Links'))
    fireEvent.click(screen.getByText('Invite Links'))
    await waitFor(() => screen.getByText('Create link'))
    fireEvent.click(screen.getByText('Create link'))

    await waitFor(() => screen.getByText('Copy'))
    fireEvent.click(screen.getByText('Copy'))

    await waitFor(() => {
      expect(screen.getByText('Failed to copy the link. Copy it manually instead.')).toBeInTheDocument()
    })
    // The reveal panel stays up so the link is still available to copy by hand.
    expect(screen.getByText('https://visiban.example.com/join/vbnl_abc123def456')).toBeInTheDocument()
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
    await renderAdminPageSettled()
    await waitFor(() => expect(screen.getByText('Site Administration')).toBeInTheDocument())
    fireEvent.keyDown(document, { key: 'Escape' })
    // JSDOM has no real history, so history.length === 1 → navigate("/")
    expect(mockNavigate).toHaveBeenCalledWith('/')
  })

  it('Escape cancels an open invite-link revoke confirm without navigating (#1238)', async () => {
    mockGetAdminInviteLinks.mockResolvedValue([
      { id: 7, prefix: 'vbnl_zz', status: 'pending', single_use: false, expires_at: null, use_count: 0, created_by_username: 'admin' },
    ])
    await renderAdminPageSettled()
    await waitFor(() => screen.getByText('Invite Links'))
    fireEvent.click(screen.getByText('Invite Links'))
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke invite link vbnl_zz' }))
    expect(screen.getByText(/Anyone holding it will no longer be able to join/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText(/Anyone holding it will no longer be able to join/)).not.toBeInTheDocument()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('Escape on the revoke confirm returns focus to the Revoke trigger (#1367)', async () => {
    mockGetAdminInviteLinks.mockResolvedValue([
      { id: 7, prefix: 'vbnl_zz', status: 'pending', single_use: false, expires_at: null, use_count: 0, created_by_username: 'admin' },
    ])
    await renderAdminPageSettled()
    await waitFor(() => screen.getByText('Invite Links'))
    fireEvent.click(screen.getByText('Invite Links'))
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke invite link vbnl_zz' }))
    screen.getByRole('button', { name: 'Cancel' }).focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Revoke invite link vbnl_zz' })).toHaveFocus()
  })

  it('revoke Confirm shows Revoking… and a double click sends one request (#1238)', async () => {
    mockGetAdminInviteLinks.mockResolvedValue([
      { id: 7, prefix: 'vbnl_zz', status: 'pending', single_use: false, expires_at: null, use_count: 0, created_by_username: 'admin' },
    ])
    let resolveRevoke: (v: unknown) => void = () => {}
    mockRevokeAdminInviteLink.mockReturnValue(new Promise((r) => { resolveRevoke = r }))
    await renderAdminPageSettled()
    await waitFor(() => screen.getByText('Invite Links'))
    fireEvent.click(screen.getByText('Invite Links'))
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke invite link vbnl_zz' }))
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(await screen.findByRole('button', { name: 'Revoking…' })).toBeDisabled()
    expect(mockRevokeAdminInviteLink).toHaveBeenCalledTimes(1)
    resolveRevoke({ id: 7, prefix: 'vbnl_zz', status: 'revoked', single_use: false, expires_at: null, use_count: 0, created_by_username: 'admin' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revoking…' })).not.toBeInTheDocument())
  })

  it('revoke failure shows an error and closes the prompt (#1238)', async () => {
    mockGetAdminInviteLinks.mockResolvedValue([
      { id: 7, prefix: 'vbnl_zz', status: 'pending', single_use: false, expires_at: null, use_count: 0, created_by_username: 'admin' },
    ])
    mockRevokeAdminInviteLink.mockRejectedValue(new Error('boom'))
    await renderAdminPageSettled()
    await waitFor(() => screen.getByText('Invite Links'))
    fireEvent.click(screen.getByText('Invite Links'))
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke invite link vbnl_zz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('Failed to revoke invite link. Please try again.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
  })

  it('Escape closes the Add User modal without navigating', async () => {
    await renderAdminPageSettled()
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
    await renderAdminPageSettled()
    expect(screen.getByLabelText('Maintenance mode')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByLabelText(/Message/)).toBeInTheDocument()
  })

  it('tells the admin they are exempt', async () => {
    await renderAdminPageSettled()
    expect(
      screen.getByText(/Site admins are exempt and keep full read\/write access/)
    ).toBeInTheDocument()
  })

  it('warns that the notice is public (#1872)', async () => {
    renderAdminPage()
    await waitFor(() => screen.getByLabelText('Maintenance mode'))
    expect(
      screen.getByText(/Anyone can read it without signing in, so keep internal detail out of it\./)
    ).toBeInTheDocument()
  })

  it('prompts for confirmation before enabling, and does not save yet', async () => {
    // Enabling is instance-wide and takes effect immediately for every user.
    await renderAdminPageSettled()
    fireEvent.click(screen.getByLabelText('Maintenance mode'))

    await waitFor(() => screen.getByText(/All non-admin users will immediately lose write access/))
    expect(mockPatchAdminSettings).not.toHaveBeenCalled()
  })

  it('keeps the toggle mounted and unflipped while confirming', async () => {
    // The confirm strip appears below the toggle rather than replacing it,
    // matching the two existing inline-confirm instances in BoardSettingsModal.
    // The toggle is never optimistically flipped, so Cancel has nothing to revert.
    await renderAdminPageSettled()
    fireEvent.click(screen.getByLabelText('Maintenance mode'))

    await waitFor(() => screen.getByText('Confirm'))
    const toggle = screen.getByLabelText('Maintenance mode')
    expect(toggle).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('Cancel on the enable confirm returns focus to the Maintenance mode toggle (#1367)', async () => {
    await renderAdminPageSettled()
    fireEvent.click(screen.getByLabelText('Maintenance mode'))
    await waitFor(() => screen.getByText('Confirm'))
    const prompt = screen.getByText(/Enable maintenance mode\?/).parentElement as HTMLElement
    const cancel = within(prompt).getByRole('button', { name: 'Cancel' })
    expect(announced()).toBe('Enable maintenance mode? All non-admin users will immediately lose write access.')
    cancel.focus()
    fireEvent.click(cancel)
    expect(screen.getByLabelText('Maintenance mode')).toHaveFocus()
  })

  it('saves when the confirmation is accepted', async () => {
    mockPatchAdminSettings.mockResolvedValue({ ...fakeSettings, maintenance_mode: true })
    await renderAdminPageSettled()
    fireEvent.click(screen.getByLabelText('Maintenance mode'))
    await waitFor(() => screen.getByText('Confirm'))
    fireEvent.click(screen.getByText('Confirm'))

    await waitFor(() => {
      expect(mockPatchAdminSettings).toHaveBeenCalledWith({ maintenance_mode: true })
    })
  })

  it('cancelling leaves the toggle off and saves nothing', async () => {
    await renderAdminPageSettled()
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
    await renderAdminPageSettled()
    fireEvent.click(screen.getByLabelText('Maintenance mode'))

    await waitFor(() => {
      expect(mockPatchAdminSettings).toHaveBeenCalledWith({ maintenance_mode: false })
    })
  })

  it('saves the notice on blur, not on every keystroke', async () => {
    mockPatchAdminSettings.mockResolvedValue({ ...fakeSettings, maintenance_message: 'Back by 5.' })
    await renderAdminPageSettled()
    const field = screen.getByLabelText(/Message/)

    fireEvent.change(field, { target: { value: 'Back by 5.' } })
    expect(mockPatchAdminSettings).not.toHaveBeenCalled()

    fireEvent.blur(field)
    await waitFor(() => {
      expect(mockPatchAdminSettings).toHaveBeenCalledWith({ maintenance_message: 'Back by 5.' })
    })
  })

  it('does not save on blur when the notice is unchanged', async () => {
    await renderAdminPageSettled()
    const field = screen.getByLabelText(/Message/)
    fireEvent.blur(field)
    await waitFor(() => screen.getByLabelText('Maintenance mode'))
    expect(mockPatchAdminSettings).not.toHaveBeenCalled()
  })

  it('prompts for an ETA in the placeholder', async () => {
    // A notice with no end time is the top persona complaint.
    await renderAdminPageSettled()
    const field = screen.getByLabelText(/Message/)
    expect(field).toHaveAttribute('placeholder', expect.stringContaining('expect service back by'))
  })

  it('shows a live character count against the 1000-character cap', async () => {
    await renderAdminPageSettled()
    expect(screen.getByText('0/1000')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/Message/), { target: { value: 'abc' } })
    expect(screen.getByText('3/1000')).toBeInTheDocument()
  })

  it('clamps the notice at the cap the serializer enforces', async () => {
    await renderAdminPageSettled()
    fireEvent.change(screen.getByLabelText(/Message/), { target: { value: 'x'.repeat(1200) } })
    expect(screen.getByLabelText<HTMLTextAreaElement>(/Message/).value).toHaveLength(1000)
    expect(screen.getByText('1000/1000')).toBeInTheDocument()
  })

  it('keeps an edit made before the mount effects run (#1319)', async () => {
    // The CI failure in #1319 (occurrence 4): the notice buffer used to be
    // seeded from the server value by a useEffect, which runs after the commit
    // that first shows the field. An edit landing in between was queued ahead
    // of the late seed, so the seed overwrote it and the field read ''.
    renderAdminPage()
    const field = await waitFor(() => {
      const f = screen.getByLabelText(/Message/)
      stallEventLoopAfterWaitFor()
      return f
    })
    // Proves the test really is inside the window: EmailSettingsSection's
    // mount effect, which fetches its settings, has not run yet.
    expect(mockGetAdminEmailSettings).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: 'x'.repeat(1200) } })
    expect(screen.getByLabelText<HTMLTextAreaElement>(/Message/).value).toHaveLength(1000)
    await screen.findByLabelText('Host')
  })

  it('keeps an in-progress notice edit when an unrelated setting is saved', async () => {
    // The re-seed is keyed on the server's notice, not the whole settings
    // object, so a registration mode save (which returns a new object with the
    // same notice) must not discard what the admin is typing.
    mockPatchAdminSettings.mockResolvedValue({ ...fakeSettings, registration_mode: 'closed' })
    await renderAdminPageSettled()
    fireEvent.change(screen.getByLabelText(/Message/), { target: { value: 'Draft notice' } })
    fireEvent.click(screen.getByText('Closed'))
    await waitFor(() => screen.getByText('Settings saved.'))
    expect(mockPatchAdminSettings).toHaveBeenCalledWith({ registration_mode: 'closed' })
    expect(screen.getByLabelText<HTMLTextAreaElement>(/Message/).value).toBe('Draft notice')
  })

  it('rolls the notice back to the saved value when its save fails', async () => {
    mockGetAdminSettings.mockResolvedValue({ ...fakeSettings, maintenance_message: 'Back by 5.' })
    mockPatchAdminSettings.mockRejectedValue(new Error('boom'))
    await renderAdminPageSettled()
    const field = screen.getByLabelText<HTMLTextAreaElement>(/Message/)
    expect(field.value).toBe('Back by 5.')
    fireEvent.change(field, { target: { value: 'Back by 6.' } })
    fireEvent.blur(field)
    await waitFor(() => screen.getByText('Failed to save settings.'))
    expect(mockPatchAdminSettings).toHaveBeenCalledWith({ maintenance_message: 'Back by 6.' })
    expect(screen.getByLabelText<HTMLTextAreaElement>(/Message/).value).toBe('Back by 5.')
  })

  it('re-seeds the field from the canonical value a save returns', async () => {
    mockPatchAdminSettings.mockResolvedValue({ ...fakeSettings, maintenance_message: 'Back by 5.' })
    await renderAdminPageSettled()
    const field = screen.getByLabelText<HTMLTextAreaElement>(/Message/)
    fireEvent.change(field, { target: { value: '  Back by 5.  ' } })
    fireEvent.blur(field)
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>(/Message/).value).toBe('Back by 5.')
    })
  })

  it('shows the saved notice in the very first render of the field (#1319)', async () => {
    mockGetAdminSettings.mockResolvedValue({ ...fakeSettings, maintenance_message: 'Back by 5.' })
    renderAdminPage()
    // Record the value the first time the field is seen, before any effect
    // could patch it up; waitFor would otherwise just retry until it matches.
    let firstSeen: string | undefined
    await waitFor(() => {
      firstSeen ??= screen.getByLabelText<HTMLTextAreaElement>(/Message/).value
    })
    expect(firstSeen).toBe('Back by 5.')
    await screen.findByLabelText('Host')
  })

  it('rolls the toggle back when the save fails', async () => {
    mockPatchAdminSettings.mockRejectedValue(new Error('boom'))
    await renderAdminPageSettled()
    fireEvent.click(screen.getByLabelText('Maintenance mode'))
    await waitFor(() => screen.getByText('Confirm'))
    fireEvent.click(screen.getByText('Confirm'))

    await waitFor(() => screen.getByText('Failed to turn on maintenance mode. Please try again.'))
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
    await renderAdminPageSettled(superuserActor)
  }

  it('shows email settings read-only to a site admin who is not a superuser', async () => {
    mockGetAdminEmailSettings.mockResolvedValue(fakeEmailSettings)
    await renderAdminPageSettled(adminUser)
    expect(screen.getByLabelText('Host')).toBeDisabled()
    expect(screen.getByLabelText('Port')).toBeDisabled()
    expect(screen.getByLabelText('Password')).toBeDisabled()
    expect(screen.queryByText('Save email settings')).not.toBeInTheDocument()
    expect(screen.getByTestId('email-settings-readonly-note')).toHaveTextContent(
      'Only a superuser can change email settings.'
    )
    expect(mockPatchAdminEmailSettings).not.toHaveBeenCalled()
  })

  it('links the read-only note to the disabled fields', async () => {
    await renderAdminPageSettled(adminUser)
    const noteId = screen.getByTestId('email-settings-readonly-note').id
    expect(noteId).toBeTruthy()
    for (const label of ['Host', 'Port', 'Timeout', 'Username', 'Password', 'From address']) {
      expect(screen.getByLabelText(label).getAttribute('aria-describedby')).toContain(noteId)
    }
    expect(screen.getByRole('radiogroup', { name: 'Email configuration source' })).toHaveAttribute(
      'aria-describedby',
      noteId
    )
  })

  it('tells a read-only admin to ask a superuser instead of re-entering the password', async () => {
    mockGetAdminEmailSettings.mockResolvedValue({
      ...fakeEmailSettings,
      config_source: 'database',
      effective_source: 'database',
      password_set: true,
      password_decryptable: false,
    })
    await renderAdminPageSettled(adminUser)
    expect(screen.getAllByText(/ask a superuser to re-enter it/i)).toHaveLength(2)
    expect(screen.queryByText(/Re-enter it below/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Clear$/)).not.toBeInTheDocument()
  })

  it('does not tell a read-only admin to type or clear a stored password', async () => {
    mockGetAdminEmailSettings.mockResolvedValue({ ...fakeEmailSettings, password_set: true })
    await renderAdminPageSettled(adminUser)
    expect(screen.getByText('A password is stored.')).toBeInTheDocument()
    expect(screen.queryByText(/Type a new one to replace it/)).not.toBeInTheDocument()
  })

  it('read-only: keeps the no_recipient and backend_pinned remedies, swaps only edit-type ones', async () => {
    await renderAdminPageSettled(adminUser)
    mockSendAdminTestEmail.mockResolvedValue({ success: false, code: 'no_recipient', detail: 'x' })
    fireEvent.click(screen.getByText('Send test email'))
    await waitFor(() =>
      expect(screen.getByText('Add one in your profile, then test again.')).toBeInTheDocument()
    )
    mockSendAdminTestEmail.mockResolvedValue({ success: false, code: 'backend_pinned', detail: 'x' })
    fireEvent.click(screen.getByText('Send test email'))
    await waitFor(() =>
      expect(
        screen.getByText(/can.t test that path/)
      ).toBeInTheDocument()
    )
    mockSendAdminTestEmail.mockResolvedValue({ success: false, code: 'auth_failed', detail: 'x' })
    fireEvent.click(screen.getByText('Send test email'))
    await waitFor(() =>
      expect(screen.getByText('Ask a superuser to update the email settings.')).toBeInTheDocument()
    )
  })

  it('read-only: hides the blank-password hint when no password is stored', async () => {
    await renderAdminPageSettled(adminUser)
    expect(screen.getByText('No password stored.')).toBeInTheDocument()
    expect(screen.queryByText(/Leave blank if your server doesn.t require a password/)).not.toBeInTheDocument()
  })

  it('keeps email settings editable for a superuser', async () => {
    await renderEmailSection()
    expect(screen.getByLabelText('Host')).not.toBeDisabled()
    expect(screen.getByText('Save email settings')).toBeInTheDocument()
    expect(screen.queryByTestId('email-settings-readonly-note')).not.toBeInTheDocument()
  })

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
    expect(announced()).toMatch(/^Switch to database configuration\?/)

    fireEvent.click(screen.getByText('Confirm'))
    await waitFor(() => {
      expect(mockPatchAdminEmailSettings).toHaveBeenCalledWith(
        expect.objectContaining({ config_source: 'database' })
      )
    })
  })

  it('Cancel on the source-switch confirm returns focus to Save (#1367)', async () => {
    await renderEmailSection()
    const group = screen.getByRole('radiogroup', { name: 'Email configuration source' })
    fireEvent.click(within(group).getByText('Database'))
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'smtp.new.test' } })
    fireEvent.change(screen.getByLabelText('From address'), {
      target: { value: 'noreply@visiban.test' },
    })
    fireEvent.click(screen.getByText('Save email settings'))
    await waitFor(() => screen.getByText(/Switch to database configuration\?/))

    fireEvent.click(screen.getByRole('button', { name: 'Cancel switching the email configuration source' }))
    expect(screen.queryByText(/Switch to database configuration\?/)).not.toBeInTheDocument()
    expect(screen.getByText('Save email settings')).toHaveFocus()
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
    mockSendAdminTestEmail.mockResolvedValue({
      success: false, code: 'auth_failed',
      detail: 'The mail server rejected the username or password.',
    })
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
    mockSendAdminTestEmail.mockResolvedValue({
      success: false, code: 'brand_new_code', detail: 'Something new.',
    })
    await renderEmailSection()
    fireEvent.click(screen.getByText('Send test email'))
    await waitFor(() => expect(screen.getByText('The test failed.')).toBeInTheDocument())
  })

  it('maps the 400 failure envelope by code, never rendering the server detail', async () => {
    // The real failure path: axios rejects the 400 carrying {success, code, detail} (#1682).
    const detail = 'The secure connection to the mail server could not be established.'
    mockSendAdminTestEmail.mockRejectedValue({
      response: { status: 400, data: { success: false, code: 'tls_failure', detail } },
    })
    await renderEmailSection()
    fireEvent.click(screen.getByText('Send test email'))
    await waitFor(() => {
      expect(screen.getByText('Encryption handshake failed.')).toBeInTheDocument()
    })
    expect(screen.queryByText(detail)).not.toBeInTheDocument()
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

// ---------------------------------------------------------------------------
// Tests: Invite by email (#731)
// ---------------------------------------------------------------------------

describe('AdminPage — Invite by email', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSiteConfig.mockResolvedValue(fakeSiteConfig)
    mockGetAdminSettings.mockResolvedValue(fakeSettings)
    mockGetAdminUsers.mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] })
    mockGetAdminInviteLinks.mockResolvedValue([])
    mockGetAdminEmailSettings.mockResolvedValue(fakeEmailSettings)
  })

  async function openInviteLinksTab() {
    await renderAdminPageSettled()
    await waitFor(() => screen.getByText('Invite Links'))
    fireEvent.click(screen.getByText('Invite Links'))
  }

  it('sends an emailed invite, confirms inline and refetches the list', async () => {
    mockSendAdminInviteEmail.mockResolvedValue({ detail: 'Invite sent', sent_to: 'sam@example.com', already_registered: false })
    await openInviteLinksTab()
    const input = await screen.findByRole('textbox', { name: 'Email address' })
    // Site surface: no role picker.
    expect(screen.queryByText('Member')).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'sam@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))
    await waitFor(() => expect(mockSendAdminInviteEmail).toHaveBeenCalledWith({ email: 'sam@example.com' }))
    expect(await screen.findByText('Invite sent to sam@example.com.')).toBeInTheDocument()
    await waitFor(() => expect(mockGetAdminInviteLinks).toHaveBeenCalledTimes(2))
  })

  it('shows an Emailed badge on emailed links', async () => {
    mockGetAdminInviteLinks.mockResolvedValue([
      { id: 8, prefix: 'vbnl_em', status: 'pending', single_use: true, expires_at: null, use_count: 0, created_by_username: 'admin', delivery: 'email' },
      { id: 9, prefix: 'vbnl_sh', status: 'pending', single_use: false, expires_at: null, use_count: 0, created_by_username: 'admin', delivery: 'link' },
    ])
    await openInviteLinksTab()
    await screen.findByText('vbnl_em…')
    expect(screen.getAllByText('Emailed')).toHaveLength(1)
  })

  it('when email is not set up, shows the muted line and the link opens the Settings tab', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...fakeSiteConfig, invite_email_available: false })
    await openInviteLinksTab()
    expect(await screen.findByText(/Email invites aren't available\./)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Email address' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Settings → Email' }))
    expect(await screen.findByText('Registration requires a valid invite link')).toBeInTheDocument()
    expect(screen.queryByText(/Email invites aren't available/)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests: Board Invites tab (#439)
// ---------------------------------------------------------------------------

describe('AdminPage — Board Invites tab (#439)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAdminSettings.mockResolvedValue(fakeSettings)
    mockGetAdminEmailSettings.mockResolvedValue(fakeEmailSettings)
    mockGetAdminBoardInviteLinks.mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] })
  })

  it('sits after Invite Links and loads pending board invites', async () => {
    await renderAdminPageSettled()
    const nav = await screen.findByRole('navigation')
    const labels = within(nav).getAllByRole('button').map((b) => b.textContent)
    expect(labels.indexOf('Board Invites')).toBe(labels.indexOf('Invite Links') + 1)
    fireEvent.click(within(nav).getByText('Board Invites'))
    expect(await screen.findByRole('heading', { name: 'Board Invites' })).toBeInTheDocument()
    expect(await screen.findByText('No pending board invites.')).toBeInTheDocument()
    expect(mockGetAdminBoardInviteLinks).toHaveBeenCalledWith({ status: 'pending', offset: 0 })
  })

  it('sidebar tabs carry a focus ring and mark the active tab with aria-current', async () => {
    await renderAdminPageSettled()
    const nav = await screen.findByRole('navigation')
    const settings = within(nav).getByRole('button', { name: 'Settings' })
    const boardInvites = within(nav).getByRole('button', { name: 'Board Invites' })
    expect(settings).toHaveAttribute('aria-current', 'page')
    expect(boardInvites).not.toHaveAttribute('aria-current')
    expect(boardInvites).toHaveClass('focus:ring-2', 'focus:ring-primary-emphasis')
    fireEvent.click(boardInvites)
    expect(boardInvites).toHaveAttribute('aria-current', 'page')
    expect(settings).not.toHaveAttribute('aria-current')
  })
})

