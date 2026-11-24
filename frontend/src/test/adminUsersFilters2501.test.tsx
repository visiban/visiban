import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AdminPage from '../pages/AdminPage'
import type { AdminUser, AdminUserStatus, User } from '../types'

// Users filter pills (#2501): All / Active / Deactivated / Admins, filtered on the server.
vi.mock('../hooks/useIsPhoneViewport', () => ({ useIsPhoneViewport: () => false }))
vi.mock('../components/Layout/Navbar', () => ({ default: () => <div data-testid="navbar" /> }))
vi.mock('../components/Common/Avatar', () => ({ default: () => <span data-testid="avatar" /> }))

const api = vi.hoisted(() => ({ getAdminUsers: vi.fn(), patchAdminUser: vi.fn() }))
vi.mock('../api/auth', () => ({
  getAdminUsers: (...a: unknown[]) => api.getAdminUsers(...a),
  patchAdminUser: (...a: unknown[]) => api.patchAdminUser(...a),
  deactivateAdminUser: vi.fn(),
  clearAdminUserLockout: vi.fn(),
  getAdminSettings: vi.fn().mockResolvedValue({ registration_mode: 'open', uploads_enabled: true, maintenance_mode: false, maintenance_message: '' }),
  patchAdminSettings: vi.fn(),
  createAdminUser: vi.fn(),
  createAdminInviteLink: vi.fn(),
  revokeAdminInviteLink: vi.fn(),
  getAdminInviteLinksPage: vi.fn().mockResolvedValue({ links: [], total: 0, truncated: false }),
  getAdminBoardInviteLinks: vi.fn().mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] }),
  sendAdminInviteEmail: vi.fn(),
  getSiteConfig: vi.fn().mockResolvedValue({ registration_open: true, registration_mode: 'open', demo_mode: false, demo_login: null, invite_email_available: true }),
}))
vi.mock('../api/client', () => ({ default: { get: vi.fn().mockResolvedValue({ data: [] }) } }))

const actor = {
  id: 1, username: 'admin', email: 'admin@example.com', first_name: 'Admin', last_name: '', avatar_url: '',
  display_name: 'Admin', is_site_admin: true, can_access_all_content: false, is_superuser: false,
  must_change_password: false, must_change_username: false,
} as User

function row(over: Partial<AdminUser>): AdminUser {
  return {
    id: 2, username: 'alice', email: 'alice@example.com', display_name: 'Alice', first_name: 'Alice', last_name: '',
    avatar_url: '', is_active: true, is_site_admin: false, can_access_all_content: false, is_superuser: false,
    must_change_password: false, has_completed_tour: true, date_joined: '2024-01-01T00:00:00Z', owned_boards: [],
    ...over,
  } as AdminUser
}

const ROWS: AdminUser[] = [
  row({ id: 1, username: 'admin', display_name: 'Ada Root', is_site_admin: true }),
  row({ id: 2, username: 'alice', display_name: 'Alice' }),
  row({ id: 3, username: 'carol', display_name: 'Carol', is_active: false }),
]

type Params = { search?: string; offset?: number; status?: AdminUserStatus }
const matches = (u: AdminUser, s: AdminUserStatus = 'all') =>
  s === 'all' || (s === 'active' && u.is_active) || (s === 'deactivated' && !u.is_active) || (s === 'admins' && u.is_site_admin)

/** A stateless fake of the endpoint: filters ROWS by search and status, like the server. */
function serve({ total }: { total?: number } = {}) {
  api.getAdminUsers.mockImplementation(async (p: Params = {}) => {
    const searched = ROWS.filter((u) => !p.search || u.username.includes(p.search))
    const results = searched.filter((u) => matches(u, p.status))
    const counts = Object.fromEntries((['all', 'active', 'deactivated', 'admins'] as const).map((s) => [s, searched.filter((u) => matches(u, s)).length]))
    return { count: total ?? results.length, offset: p.offset ?? 0, page_size: 50, results, counts }
  })
}

async function renderUsers() {
  render(
    <MemoryRouter initialEntries={['/admin?tab=users']}>
      <AdminPage user={actor} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
    </MemoryRouter>,
  )
  await screen.findByRole('list', { name: 'Users' })
}

const pill = (label: string) => within(screen.getByRole('group', { name: 'Filter users' })).getByRole('button', { name: (n) => n.split(' ')[0] === label })
const lastCall = () => api.getAdminUsers.mock.calls.at(-1)?.[0] as Params

beforeEach(() => {
  vi.clearAllMocks()
  serve()
})

describe('Users filter pills (#2501)', () => {
  it('shows each pill with its server count, All selected', async () => {
    await renderUsers()
    expect(pill('All')).toHaveAttribute('aria-pressed', 'true')
    expect(pill('All')).toHaveTextContent('3')
    expect(pill('Active')).toHaveTextContent('2')
    expect(pill('Deactivated')).toHaveTextContent('1')
    expect(pill('Admins')).toHaveTextContent('1')
    expect(pill('Admins')).toHaveAttribute('aria-pressed', 'false')
  })

  it.each([
    ['Active', 'active', ['Ada Root', 'Alice']],
    ['Deactivated', 'deactivated', ['Carol']],
    ['Admins', 'admins', ['Ada Root']],
  ] as const)('%s asks the server for status=%s and lists only its rows', async (label, status, names) => {
    await renderUsers()
    fireEvent.click(pill(label))
    await waitFor(() => expect(lastCall()).toMatchObject({ status, offset: 0 }))
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Users' })).getAllByRole('listitem')).toHaveLength(names.length))
    for (const n of names) expect(screen.getByText(n)).toBeInTheDocument()
    expect(pill(label)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(`Showing 1–${names.length} of ${names.length}`)).toBeInTheDocument()
  })

  it('combines with the search, keeping both in the request', async () => {
    await renderUsers()
    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'car' } })
    await waitFor(() => expect(lastCall()).toMatchObject({ search: 'car' }), { timeout: 1500 })
    fireEvent.click(pill('Deactivated'))
    await waitFor(() => expect(lastCall()).toMatchObject({ search: 'car', status: 'deactivated', offset: 0 }))
    // Counts follow the search: only carol matches "car".
    await waitFor(() => expect(pill('All')).toHaveTextContent('1'))
    expect(pill('Active')).toHaveTextContent('0')
  })

  it('a search typed under a pill keeps that pill', async () => {
    await renderUsers()
    fireEvent.click(pill('Active'))
    await waitFor(() => expect(lastCall()).toMatchObject({ status: 'active' }))
    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'ali' } })
    await waitFor(() => expect(lastCall()).toMatchObject({ search: 'ali', status: 'active', offset: 0 }), { timeout: 1500 })
  })

  it('starts again at page 1 when the filter changes', async () => {
    serve({ total: 120 })
    await renderUsers()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(lastCall()).toMatchObject({ offset: 50 }))
    fireEvent.click(pill('Active'))
    await waitFor(() => expect(lastCall()).toMatchObject({ status: 'active', offset: 0 }))
  })

  it('selecting the current pill again does not refetch', async () => {
    await renderUsers()
    const calls = api.getAdminUsers.mock.calls.length
    fireEvent.click(pill('All'))
    expect(api.getAdminUsers.mock.calls.length).toBe(calls)
  })

  it.each([
    ['Active', 'No active users.'],
    ['Deactivated', 'No deactivated users.'],
    ['Admins', 'No admins.'],
  ])('an empty %s list says so', async (label, copy) => {
    await renderUsers()
    api.getAdminUsers.mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [], counts: { all: 3, active: 0, deactivated: 0, admins: 0 } })
    fireEvent.click(pill(label))
    expect(await screen.findByText(copy)).toBeInTheDocument()
  })

  it('an empty search under a filter keeps the search copy', async () => {
    await renderUsers()
    fireEvent.click(pill('Admins'))
    await waitFor(() => expect(lastCall()).toMatchObject({ status: 'admins' }))
    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'zzz' } })
    expect(await screen.findByText('No users match "zzz".', {}, { timeout: 1500 })).toBeInTheDocument()
    expect(screen.getByText('Check the spelling, or clear the filter.')).toBeInTheDocument()
  })

  it('the phone select carries the same filters and counts', async () => {
    await renderUsers()
    const select = screen.getByRole('combobox', { name: 'Filter users' })
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['All (3)', 'Active (2)', 'Deactivated (1)', 'Admins (1)'])
    fireEvent.change(select, { target: { value: 'deactivated' } })
    await waitFor(() => expect(lastCall()).toMatchObject({ status: 'deactivated', offset: 0 }))
  })

  it('pills render without counts when the response has none', async () => {
    api.getAdminUsers.mockResolvedValue({ count: 3, offset: 0, page_size: 50, results: ROWS })
    await renderUsers()
    expect(pill('All').textContent).toBe('All')
    expect(within(screen.getByRole('combobox', { name: 'Filter users' })).getAllByRole('option')[0].textContent).toBe('All')
  })

  it('a row action that changes a status moves the counts', async () => {
    api.patchAdminUser.mockResolvedValue(row({ id: 2, username: 'alice', display_name: 'Alice', is_site_admin: true }))
    await renderUsers()
    fireEvent.click(screen.getByRole('button', { name: 'Make admin Alice' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Make admin' }))
    await waitFor(() => expect(pill('Admins')).toHaveTextContent('2'))
    expect(pill('All')).toHaveTextContent('3')
    expect(pill('Active')).toHaveTextContent('2')
  })
})
