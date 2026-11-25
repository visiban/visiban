import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AdminPage from '../pages/AdminPage'
import type { AdminUser, AdminUserStatus, User } from '../types'

// Users filter pills (#2501): All / Active / Deactivated / Admins, filtered on the server.
const phone = vi.hoisted(() => ({ value: false }))
vi.mock('../hooks/useIsPhoneViewport', () => ({ useIsPhoneViewport: () => phone.value }))
vi.mock('../components/Layout/Navbar', () => ({ default: () => <div data-testid="navbar" /> }))
vi.mock('../components/Common/Avatar', () => ({ default: () => <span data-testid="avatar" /> }))

const api = vi.hoisted(() => ({ getAdminUsers: vi.fn(), patchAdminUser: vi.fn(), deactivateAdminUser: vi.fn(), createAdminUser: vi.fn() }))
vi.mock('../api/auth', () => ({
  getAdminUsers: (...a: unknown[]) => api.getAdminUsers(...a),
  patchAdminUser: (...a: unknown[]) => api.patchAdminUser(...a),
  deactivateAdminUser: (...a: unknown[]) => api.deactivateAdminUser(...a),
  clearAdminUserLockout: vi.fn(),
  getAdminSettings: vi.fn().mockResolvedValue({ registration_mode: 'open', uploads_enabled: true, maintenance_mode: false, maintenance_message: '' }),
  patchAdminSettings: vi.fn(),
  createAdminUser: (...a: unknown[]) => api.createAdminUser(...a),
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

// The fake server's accounts: row actions below write to it, so a refetch sees their effect.
let db: AdminUser[] = ROWS

type Params = { search?: string; offset?: number; status?: AdminUserStatus }
const matches = (u: AdminUser, s: AdminUserStatus = 'all') =>
  s === 'all' || (s === 'active' && u.is_active) || (s === 'deactivated' && !u.is_active) || (s === 'admins' && u.is_site_admin)

/** A fake of the endpoint: filters `db` by search and status and pages it, like the server. */
function serve({ total, pageSize }: { total?: number; pageSize?: number } = {}) {
  api.getAdminUsers.mockImplementation(async (p: Params = {}) => {
    const searched = db.filter((u) => !p.search || u.username.includes(p.search))
    const matching = searched.filter((u) => matches(u, p.status))
    const offset = p.offset ?? 0
    const results = pageSize ? matching.slice(offset, offset + pageSize) : matching
    const counts = Object.fromEntries((['all', 'active', 'deactivated', 'admins'] as const).map((s) => [s, searched.filter((u) => matches(u, s)).length]))
    return { count: total ?? matching.length, offset, page_size: pageSize ?? 50, results, counts }
  })
}

/** Deactivation on the fake server: the account changes in `db` and the server returns it. */
function serveDeactivate() {
  api.deactivateAdminUser.mockImplementation(async (id: number) => {
    db = db.map((u) => (u.id === id ? { ...u, is_active: false } : u))
    return db.find((u) => u.id === id)
  })
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/** A deactivation that changes `db` only once the returned gate is resolved. */
function deferDeactivate() {
  const gate = deferred<void>()
  api.deactivateAdminUser.mockImplementationOnce(async (id: number) => {
    await gate.promise
    db = db.map((u) => (u.id === id ? { ...u, is_active: false } : u))
    return db.find((u) => u.id === id)
  })
  return gate
}

/** Account creation on the fake server: the account joins `db` in username order, as the server sorts. */
function serveCreate(username: string) {
  api.createAdminUser.mockImplementation(async () => {
    const created = row({ id: 9, username, email: `${username}@example.com`, display_name: username[0].toUpperCase() + username.slice(1) })
    db = [...db, created].sort((a, b) => a.username.localeCompare(b.username))
    return created
  })
}

// Queries here are scoped to the modal's form or to one row, never the whole page (#2608): a
// page-wide getByLabelText or getByRole walks every element of a 50-row list, about 70% of a
// 51-account test's time, and on a loaded CI runner that alone passed the 5s test timeout.
async function addUser(username: string) {
  fireEvent.click(screen.getByText('Add user'))
  const form = within(screen.getByText('Create user').closest('form')!)
  fireEvent.change(form.getByLabelText(/username/i), { target: { value: username } })
  fireEvent.change(form.getByLabelText(/email/i), { target: { value: `${username}@example.com` } })
  fireEvent.change(form.getByLabelText('Password'), { target: { value: 'SecurePass123!' } })
  fireEvent.click(form.getByText('Create user'))
  await waitFor(() => expect(api.createAdminUser).toHaveBeenCalled())
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Add user' })).not.toBeInTheDocument())
}

/** 51 active accounts: page 1 holds 50 of them, page 2 holds "User 50" alone. */
const manyActive = () => Array.from({ length: 51 }, (_, i) => row({ id: 100 + i, username: `user${i}`, email: `user${i}@example.com`, display_name: `User ${i}` }))

/** The list row showing `name`: its actions and its inline confirm live inside it. */
const rowOf = (name: string) => within(screen.getByText(name).closest('li')!)

async function deactivate(name: string) {
  const r = rowOf(name)
  fireEvent.click(r.getByRole('button', { name: `Deactivate ${name}` }))
  fireEvent.click(await r.findByRole('button', { name: 'Deactivate' }))
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
  phone.value = false
  db = ROWS
  serve()
  serveDeactivate()
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
    // The filter is a group named for the concept; its phone select has its own name.
    expect(screen.getByRole('combobox', { name: 'User status' })).toBeInTheDocument()
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
    // The new total is announced in the polite status region.
    expect(screen.getByText(`${names.length} ${names.length === 1 ? 'user' : 'users'}`)).toHaveClass('sr-only')
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
    const select = screen.getByRole('combobox', { name: 'User status' })
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['All (3)', 'Active (2)', 'Deactivated (1)', 'Admins (1)'])
    fireEvent.change(select, { target: { value: 'deactivated' } })
    await waitFor(() => expect(lastCall()).toMatchObject({ status: 'deactivated', offset: 0 }))
  })

  it('pills render without counts when the response has none', async () => {
    api.getAdminUsers.mockResolvedValue({ count: 3, offset: 0, page_size: 50, results: ROWS })
    await renderUsers()
    expect(pill('All').textContent).toBe('All')
    expect(within(screen.getByRole('combobox', { name: 'User status' })).getAllByRole('option')[0].textContent).toBe('All')
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
  it('a row that leaves the selected filter is removed and the total follows', async () => {
    await renderUsers()
    fireEvent.click(pill('Active'))
    await waitFor(() => expect(screen.getByText(/Showing 1.2 of 2/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate Alice' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }))
    await waitFor(() => expect(screen.queryByText('Alice')).not.toBeInTheDocument())
    expect(screen.getByText(/Showing 1.1 of 1/)).toBeInTheDocument()
    expect(pill('Active')).toHaveTextContent('1')
    expect(pill('Deactivated')).toHaveTextContent('2')
    expect(pill('All')).toHaveTextContent('3')
    await waitFor(() => expect(pill('Active')).toHaveFocus())
  })

  it('creating a user under a search adds one to the site total in the nav, not the search total', async () => {
    serveCreate('alan')
    await renderUsers()
    const nav = () => screen.getByRole('button', { name: /^Users\b/ })
    await waitFor(() => expect(nav()).toHaveTextContent('3'))
    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'al' } })
    await waitFor(() => expect(screen.getByText(/Showing 1.1 of 1/)).toBeInTheDocument())
    await addUser('alan')
    // The search's refetch now holds 2 (alan, alice); the site holds 4.
    await waitFor(() => expect(screen.getByText(/Showing 1.2 of 2/)).toBeInTheDocument())
    expect(nav()).toHaveTextContent('4')
    expect(nav()).not.toHaveTextContent('2')
  })

  // The server sorts by username and pages by 50: a created row is fetched into its place, never prepended.
  it('creating a user refetches the current page, so the new row sorts into place', async () => {
    serveCreate('bob')
    await renderUsers()
    await addUser('bob')
    await waitFor(() => expect(screen.getByText(/Showing 1.4 of 4/)).toBeInTheDocument())
    const names = within(screen.getByRole('list', { name: 'Users' })).getAllByRole('listitem').map((li) => li.textContent ?? '')
    expect(names.map((t) => ['Ada Root', 'Alice', 'Bob', 'Carol'].find((n) => t.includes(n)))).toEqual(['Ada Root', 'Alice', 'Bob', 'Carol'])
    expect(lastCall()).toMatchObject({ status: 'all', offset: 0 })
    expect(pill('All')).toHaveTextContent('4')
    expect(pill('Active')).toHaveTextContent('3')
    expect(screen.getByRole('button', { name: /^Users\b/ })).toHaveTextContent('4')
  })

  it('a created user that sorts onto another page leaves a full page 1 of 50', async () => {
    db = manyActive()
    serve({ pageSize: 50 })
    serveCreate('zed')
    await renderUsers()
    await waitFor(() => expect(screen.getByText(/Showing 1.50 of 51/)).toBeInTheDocument())
    await addUser('zed')
    await waitFor(() => expect(screen.getByText(/Showing 1.50 of 52/)).toBeInTheDocument())
    expect(within(screen.getByRole('list', { name: 'Users' })).getAllByRole('listitem')).toHaveLength(50)
    expect(screen.queryByText('Zed')).not.toBeInTheDocument()
  })
  // A row leaving the selected filter shifts the server's pages, so the page is fetched again.
  it('the last row of page 2 leaving the filter steps back to page 1 with a true "Showing" line', async () => {
    db = manyActive()
    serve({ pageSize: 50 })
    await renderUsers()
    fireEvent.click(pill('Active'))
    await waitFor(() => expect(screen.getByText(/Showing 1.50 of 51/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(screen.getByText(/Showing 51.51 of 51/)).toBeInTheDocument())
    await deactivate('User 50')
    await waitFor(() => expect(screen.getByText(/Showing 1.50 of 50/)).toBeInTheDocument())
    expect(screen.queryByText('No active users.')).not.toBeInTheDocument()
    expect(screen.getByText('User 0')).toBeInTheDocument()
    expect(lastCall()).toMatchObject({ status: 'active', offset: 0 })
    expect(pill('Active')).toHaveTextContent('50')
    expect(pill('Deactivated')).toHaveTextContent('1')
    await waitFor(() => expect(pill('Active')).toHaveFocus())
  })

  it('a row leaving the filter on page 1 of 2 refills the page from the server', async () => {
    db = manyActive()
    serve({ pageSize: 50 })
    await renderUsers()
    fireEvent.click(pill('Active'))
    await waitFor(() => expect(screen.getByText(/Showing 1.50 of 51/)).toBeInTheDocument())
    expect(screen.queryByText('User 50')).not.toBeInTheDocument()
    await deactivate('User 0')
    // The user who shifted up from page 2 is shown, and the page is full again.
    expect(await screen.findByText('User 50')).toBeInTheDocument()
    expect(screen.queryByText('User 0')).not.toBeInTheDocument()
    expect(screen.getByText(/Showing 1.50 of 50/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument()
  })

  it('a slower response for an earlier filter never replaces the latest one', async () => {
    await renderUsers()
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    api.getAdminUsers.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    fireEvent.click(pill('Active'))
    await waitFor(() => expect(lastCall()).toMatchObject({ status: 'active' }))
    fireEvent.click(pill('Deactivated'))
    await waitFor(() => expect(lastCall()).toMatchObject({ status: 'deactivated' }))
    const counts = { all: 3, active: 2, deactivated: 1, admins: 1 }
    second.resolve({ count: 1, offset: 0, page_size: 50, results: [ROWS[2]], counts })
    await waitFor(() => expect(screen.getByText('Carol')).toBeInTheDocument())
    await act(async () => {
      first.resolve({ count: 2, offset: 0, page_size: 50, results: [ROWS[0], ROWS[1]], counts })
      await first.promise
    })
    expect(screen.queryByText('Alice')).not.toBeInTheDocument()
    expect(screen.getByText('Carol')).toBeInTheDocument()
    expect(screen.getByText(/Showing 1.1 of 1/)).toBeInTheDocument()
    expect(pill('Deactivated')).toHaveAttribute('aria-pressed', 'true')
  })

  // A row action resolves after the page or pill may have changed; its refetch is the newest request,
  // so it must ask for the query now on screen, not the one from when the action started.
  it('a deactivation that lands after Previous refetches page 1 and clears "Loading…"', async () => {
    db = manyActive()
    serve({ pageSize: 50 })
    await renderUsers()
    fireEvent.click(pill('Active'))
    await waitFor(() => expect(screen.getByText(/Showing 1.50 of 51/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(screen.getByText(/Showing 51.51 of 51/)).toBeInTheDocument())
    const gate = deferDeactivate()
    await deactivate('User 50')
    await waitFor(() => expect(api.deactivateAdminUser).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    await waitFor(() => expect(screen.getByText(/Showing 1.50 of 51/)).toBeInTheDocument())
    await act(async () => { gate.resolve(); await gate.promise })
    await waitFor(() => expect(screen.getByText(/Showing 1.50 of 50/)).toBeInTheDocument())
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
    expect(screen.getByText('User 0')).toBeInTheDocument()
    expect(lastCall()).toMatchObject({ status: 'active', offset: 0 })
  })

  it('a deactivation that lands after another pill is chosen refetches that pill, not the old one', async () => {
    db = [...ROWS, row({ id: 4, username: 'dave', email: 'dave@example.com', display_name: 'Dave' })]
    await renderUsers()
    fireEvent.click(pill('Active'))
    await waitFor(() => expect(screen.getByText(/Showing 1.3 of 3/)).toBeInTheDocument())
    const gate = deferDeactivate()
    await deactivate('Alice')
    await waitFor(() => expect(api.deactivateAdminUser).toHaveBeenCalled())
    fireEvent.click(pill('Admins'))
    await waitFor(() => expect(screen.getByText(/Showing 1.1 of 1/)).toBeInTheDocument())
    await act(async () => { gate.resolve(); await gate.promise })
    await waitFor(() => expect(lastCall()).toMatchObject({ status: 'admins' }))
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())
    expect(pill('Admins')).toHaveAttribute('aria-pressed', 'true')
    expect(within(screen.getByRole('list', { name: 'Users' })).getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('Ada Root')).toBeInTheDocument()
    expect(screen.queryByText('Dave')).not.toBeInTheDocument()
  })

  it('on a phone, a row leaving the filter moves focus to the status select', async () => {
    phone.value = true
    await renderUsers()
    fireEvent.change(screen.getByRole('combobox', { name: 'User status' }), { target: { value: 'active' } })
    await waitFor(() => expect(screen.getByText(/Showing 1.2 of 2/)).toBeInTheDocument())
    const trigger = screen.getByRole('button', { name: 'More actions for Alice' })
    trigger.focus()
    fireEvent.click(trigger)
    const sheet = screen.getByRole('dialog', { name: 'Alice' })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Deactivate' }))
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'Deactivate' })).getByRole('button', { name: 'Deactivate' }))
    await waitFor(() => expect(screen.queryByText('Alice')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'User status' })).toHaveFocus())
  })

  it('creating a user that does not match the search leaves the pill counts as the server has them', async () => {
    api.createAdminUser.mockImplementation(async () => {
      const created = row({ id: 9, username: 'bob', email: 'bob@example.com', display_name: 'Bob' })
      db = [...db, created]
      return created
    })
    await renderUsers()
    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'al' } })
    await waitFor(() => expect(screen.getByText(/Showing 1.1 of 1/)).toBeInTheDocument())
    expect(pill('All')).toHaveTextContent('1')
    await addUser('bob')
    await waitFor(() => expect(lastCall()).toMatchObject({ search: 'al' }))
    await waitFor(() => expect(screen.getByText(/Showing 1.1 of 1/)).toBeInTheDocument())
    expect(pill('All')).toHaveTextContent('1')
    expect(pill('Active')).toHaveTextContent('1')
    expect(screen.queryByText('Bob')).not.toBeInTheDocument()
  })
})
