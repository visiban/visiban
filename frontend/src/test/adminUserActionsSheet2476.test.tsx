import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AdminPage from '../pages/AdminPage'
import type { AdminUser, User } from '../types'

// Phone row actions (#2476): on a phone every Users row action lives in the row's ⋯ bottom sheet.
const phone = vi.hoisted(() => ({ value: true }))
vi.mock('../hooks/useIsPhoneViewport', () => ({ useIsPhoneViewport: () => phone.value }))

vi.mock('../components/Layout/Navbar', () => ({ default: () => <div data-testid="navbar" /> }))
vi.mock('../components/Common/Avatar', () => ({ default: () => <span data-testid="avatar" /> }))

const api = vi.hoisted(() => ({
  getAdminUsers: vi.fn(),
  patchAdminUser: vi.fn(),
  deactivateAdminUser: vi.fn(),
  clearAdminUserLockout: vi.fn(),
}))
vi.mock('../api/auth', () => ({
  getAdminUsers: (...a: unknown[]) => api.getAdminUsers(...a),
  patchAdminUser: (...a: unknown[]) => api.patchAdminUser(...a),
  deactivateAdminUser: (...a: unknown[]) => api.deactivateAdminUser(...a),
  clearAdminUserLockout: (...a: unknown[]) => api.clearAdminUserLockout(...a),
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

const actor: User = {
  id: 1, username: 'admin', email: 'admin@example.com', first_name: 'Admin', last_name: 'User', avatar_url: '',
  display_name: 'Admin User', is_site_admin: true, can_access_all_content: false, is_superuser: false,
  must_change_password: false, must_change_username: false,
} as User

function adminUser(over: Partial<AdminUser>): AdminUser {
  return {
    id: 2, username: 'alice', email: 'alice@example.com', display_name: 'Alice', first_name: 'Alice', last_name: '',
    avatar_url: '', is_active: true, is_site_admin: false, can_access_all_content: false, is_superuser: false,
    must_change_password: false, has_completed_tour: true, date_joined: '2024-01-01T00:00:00Z', owned_boards: [],
    ...over,
  } as AdminUser
}

const self = adminUser({ id: 1, username: 'admin', display_name: 'Admin User', is_site_admin: true })

async function renderUsers(rows: AdminUser[], currentUser: User = actor) {
  api.getAdminUsers.mockResolvedValue({ count: rows.length, offset: 0, page_size: 50, results: rows })
  render(
    <MemoryRouter initialEntries={['/admin?tab=users']}>
      <AdminPage user={currentUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
    </MemoryRouter>,
  )
  await screen.findByRole('list', { name: 'Users' })
}

function openSheet(name: string) {
  const trigger = screen.getByRole('button', { name: `More actions for ${name}` })
  trigger.focus()
  fireEvent.click(trigger)
  return { trigger, sheet: screen.getByRole('dialog', { name }) }
}

const labels = (sheet: HTMLElement, group: 'Account' | 'Support') => {
  const list = within(sheet).queryByRole('list', { name: group })
  return list ? within(list).getAllByRole('button').map((b) => b.firstChild?.textContent) : []
}

beforeEach(() => {
  phone.value = true
  vi.clearAllMocks()
})

describe('Site admin phone row actions sheet (#2476)', () => {
  it('opens a modal bottom sheet with the user header, both groups and Cancel; no actions sit on the row', async () => {
    // A superuser actor sees Grant all-content (#1830).
    await renderUsers([self, adminUser({})], { ...actor, is_superuser: true })
    expect(screen.queryByRole('button', { name: 'Deactivate Alice' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Make admin Alice' })).not.toBeInTheDocument()
    const { trigger, sheet } = openSheet('Alice')
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(sheet).toHaveAttribute('aria-modal', 'true')
    expect(sheet.className).toContain('pb-[env(safe-area-inset-bottom)]')
    expect(within(sheet).getByRole('heading', { name: 'Alice' })).toBeInTheDocument()
    expect(within(sheet).getByText('@alice')).toBeInTheDocument()
    expect(labels(sheet, 'Account')).toEqual(['Make admin', 'Deactivate'])
    expect(labels(sheet, 'Support')).toEqual(['Grant all-content', 'Force password reset', 'Clear lockout', 'Restart onboarding tour'])
    // Every item and Cancel is a 44px target.
    for (const b of within(sheet).getAllByRole('button')) expect(b.className).toContain('min-h-11')
    expect(within(sheet).getByRole('button', { name: 'Make admin' })).toHaveFocus()
  })

  it('an inactive admin offers Demote admin and Reactivate; Revoke and no Force reset follow the row state', async () => {
    await renderUsers([self, adminUser({ is_site_admin: true, is_active: false, can_access_all_content: true, must_change_password: true, has_completed_tour: false })])
    const { sheet } = openSheet('Alice')
    expect(labels(sheet, 'Account')).toEqual(['Demote admin', 'Reactivate'])
    expect(labels(sheet, 'Support')).toEqual(['Revoke all-content', 'Clear lockout'])
  })

  it('your own row has no role or activation actions', async () => {
    await renderUsers([self])
    const { sheet } = openSheet('Admin User')
    expect(within(sheet).queryByRole('list', { name: 'Account' })).not.toBeInTheDocument()
    expect(labels(sheet, 'Support')).toContain('Clear lockout')
  })

  it('a known non-superuser actor gets no Grant all-content', async () => {
    await renderUsers([self, adminUser({})], { ...actor, is_superuser: false })
    expect(labels(openSheet('Alice').sheet, 'Support')).not.toContain('Grant all-content')
  })

  it('a superuser row, for a known non-superuser actor, keeps only Restart tour and says why', async () => {
    await renderUsers([self, adminUser({ is_superuser: true, is_site_admin: true, can_access_all_content: true })], { ...actor, is_superuser: false })
    const { sheet } = openSheet('Alice')
    expect(within(sheet).queryByRole('list', { name: 'Account' })).not.toBeInTheDocument()
    expect(labels(sheet, 'Support')).toEqual(['Restart onboarding tour'])
    expect(within(sheet).getByText("Only a superuser can change this account's access or sign-in.")).toBeInTheDocument()
  })

  it('absent actor superuser status keeps the server-checked actions on a superuser row', async () => {
    const { is_superuser: _omit, ...unknownActor } = actor
    await renderUsers([self, adminUser({ is_superuser: true, is_site_admin: true, can_access_all_content: true })], unknownActor as User)
    const { sheet } = openSheet('Alice')
    // Demote stays omitted (superuser implies admin), Deactivate stays for the server to answer.
    expect(labels(sheet, 'Account')).toEqual(['Deactivate'])
    expect(labels(sheet, 'Support')).toEqual(['Force password reset', 'Clear lockout', 'Restart onboarding tour'])
  })

  it('a row with no applicable actions gets no ⋯ trigger', async () => {
    await renderUsers([self, adminUser({ is_superuser: true, is_site_admin: true, can_access_all_content: true, has_completed_tour: false })], { ...actor, is_superuser: false })
    expect(screen.queryByRole('button', { name: 'More actions for Alice' })).not.toBeInTheDocument()
  })

  it('Deactivate confirms inside the sheet; Cancel returns to the list on the item, confirm runs and returns focus to ⋯', async () => {
    api.deactivateAdminUser.mockResolvedValue(adminUser({ is_active: false }))
    await renderUsers([self, adminUser({})])
    const { trigger, sheet } = openSheet('Alice')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Deactivate' }))
    const group = within(sheet).getByRole('group', { name: 'Deactivate' })
    expect(group).toHaveTextContent('Deactivate Alice? They will no longer be able to log in.')
    expect(within(sheet).queryByRole('list', { name: 'Account' })).not.toBeInTheDocument()
    // Not duplicated under the row.
    expect(screen.getAllByRole('group', { name: 'Deactivate' })).toHaveLength(1)
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(within(sheet).getByRole('button', { name: 'Deactivate' })).toHaveFocus())
    fireEvent.click(within(sheet).getByRole('button', { name: 'Deactivate' }))
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'Deactivate' })).getByRole('button', { name: 'Deactivate' }))
    await waitFor(() => expect(api.deactivateAdminUser).toHaveBeenCalledWith(2))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('Make admin, Revoke all-content and Clear lockout keep their confirms in the sheet', async () => {
    await renderUsers([self, adminUser({ can_access_all_content: true })])
    const { sheet } = openSheet('Alice')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Make admin' }))
    expect(within(sheet).getByRole('group', { name: 'Make admin' })).toHaveTextContent('Grant site admin to Alice?')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Revoke all-content' }))
    expect(within(sheet).getByRole('group', { name: 'Revoke access' })).toHaveTextContent('Revoke all-content access from Alice? They will only see boards they are a member of.')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Clear lockout' }))
    expect(within(sheet).getByRole('group', { name: 'Clear lockout' })).toHaveTextContent('Clear the login lockout for Alice? They will be able to log in immediately, even if they are currently locked out.')
    expect(api.patchAdminUser).not.toHaveBeenCalled()
    expect(api.clearAdminUserLockout).not.toHaveBeenCalled()
  })

  it('Escape leaves a confirm first, then closes the sheet and returns focus to ⋯', async () => {
    await renderUsers([self, adminUser({})])
    const { trigger, sheet } = openSheet('Alice')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Make admin' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(within(sheet).getByRole('list', { name: 'Account' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('an action without a confirm runs and closes the sheet; Cancel closes it too', async () => {
    api.patchAdminUser.mockResolvedValue(adminUser({ must_change_password: true }))
    await renderUsers([self, adminUser({})])
    let { sheet } = openSheet('Alice')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Force password reset' }))
    expect(api.patchAdminUser).toHaveBeenCalledWith(2, { must_change_password: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    ;({ sheet } = openSheet('Alice'))
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a board owner gets "Transfer boards and deactivate…" with its subtitle, which opens the transfer dialog full screen', async () => {
    const owned = [{ id: 7, uid: 'b7', name: 'Ops' }, { id: 8, uid: 'b8', name: 'Web' }]
    await renderUsers([self, adminUser({ owned_boards: owned })])
    const { sheet } = openSheet('Alice')
    const item = within(sheet).getByRole('button', { name: /Transfer boards and deactivate…/ })
    expect(item).toHaveTextContent('Choose a new owner for each of their 2 boards first')
    fireEvent.click(item)
    const modal = await screen.findByRole('dialog', { name: 'Transfer boards & deactivate' })
    expect(modal.className).toContain('max-sm:inset-0')
    expect(screen.queryByRole('dialog', { name: 'Alice' })).not.toBeInTheDocument()
  })

  it('desktop keeps the inline row actions and the ⋯ menu, with no sheet', async () => {
    phone.value = false
    await renderUsers([self, adminUser({})])
    expect(screen.getByRole('button', { name: 'Deactivate Alice' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Make admin Alice' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More actions for Alice' })).toHaveAttribute('aria-haspopup', 'menu')
  })
})
