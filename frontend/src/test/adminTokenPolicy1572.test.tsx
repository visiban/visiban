import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AdminPage from '../pages/AdminPage'
import type { SiteSettings, User } from '../types'

// Site admin → General → Personal access tokens (#1572): maximum lifetime and default expiry.
vi.mock('../hooks/useIsPhoneViewport', () => ({ useIsPhoneViewport: () => false }))
vi.mock('../components/Layout/Navbar', () => ({ default: () => <div data-testid="navbar" /> }))

const api = vi.hoisted(() => ({ getAdminSettings: vi.fn(), patchAdminSettings: vi.fn() }))
vi.mock('../api/auth', () => ({
  getAdminSettings: (...a: unknown[]) => api.getAdminSettings(...a),
  patchAdminSettings: (...a: unknown[]) => api.patchAdminSettings(...a),
  getAdminUsers: vi.fn().mockResolvedValue({ count: 1, offset: 0, page_size: 50, results: [], counts: { all: 1, active: 1, deactivated: 0, admins: 1 } }),
  patchAdminUser: vi.fn(),
  deactivateAdminUser: vi.fn(),
  clearAdminUserLockout: vi.fn(),
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

const base: SiteSettings = {
  registration_mode: 'open', uploads_enabled: true, maintenance_mode: false, maintenance_message: '',
  pat_max_lifetime_days: null, pat_default_lifetime_days: null,
}

async function renderGeneral(settings: Partial<SiteSettings> = {}) {
  api.getAdminSettings.mockResolvedValue({ ...base, ...settings })
  render(
    <MemoryRouter initialEntries={['/admin?tab=general']}>
      <AdminPage user={actor} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
    </MemoryRouter>,
  )
  return {
    max: (await screen.findByLabelText('Maximum lifetime (days)')) as HTMLInputElement,
    def: screen.getByLabelText('Default expiry (days)') as HTMLInputElement,
  }
}

function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

beforeEach(() => {
  vi.clearAllMocks()
  api.patchAdminSettings.mockImplementation(async (patch: Partial<SiteSettings>) => ({ ...base, ...patch }))
})

describe('Token lifetime policy card (#1572)', () => {
  it('shows both fields blank when unset, and the stored values when set', async () => {
    const { max, def } = await renderGeneral()
    expect(max.value).toBe('')
    expect(def.value).toBe('')
    expect(screen.getByText('Applies to new tokens only. Existing tokens keep the expiry they were created with.')).toBeInTheDocument()
  })

  it('shows stored values', async () => {
    const { max, def } = await renderGeneral({ pat_max_lifetime_days: 90, pat_default_lifetime_days: 30 })
    expect(max.value).toBe('90')
    expect(def.value).toBe('30')
  })

  it('saves a maximum on blur', async () => {
    const { max } = await renderGeneral()
    type(max, '90')
    await waitFor(() => expect(api.patchAdminSettings).toHaveBeenCalledWith({ pat_max_lifetime_days: 90 }))
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument()
  })

  it('blank clears a stored value', async () => {
    const { def } = await renderGeneral({ pat_default_lifetime_days: 30 })
    type(def, '  ')
    await waitFor(() => expect(api.patchAdminSettings).toHaveBeenCalledWith({ pat_default_lifetime_days: null }))
  })

  it('an unchanged value does not save', async () => {
    const { max } = await renderGeneral({ pat_max_lifetime_days: 90 })
    type(max, '90')
    expect(api.patchAdminSettings).not.toHaveBeenCalled()
  })

  it.each(['0', '366', '1.5', 'abc', '-3'])('refuses %s inline without saving', async (value) => {
    const { max } = await renderGeneral()
    type(max, value)
    expect(await screen.findByText('Enter a whole number of days from 1 to 365, or leave it blank.')).toBeInTheDocument()
    expect(max).toHaveAttribute('aria-invalid', 'true')
    expect(api.patchAdminSettings).not.toHaveBeenCalled()
    // Typing a correction clears the stale error before the next blur.
    fireEvent.change(max, { target: { value: '30' } })
    expect(max).not.toHaveAttribute('aria-invalid', 'true')
  })

  it('refuses a default longer than the maximum, from either field', async () => {
    const { max, def } = await renderGeneral({ pat_max_lifetime_days: 30, pat_default_lifetime_days: 14 })
    type(def, '60')
    expect(await screen.findByText("The default expiry can't be longer than the maximum lifetime (30 days).")).toBeInTheDocument()
    type(def, '14')
    type(max, '7')
    expect(await screen.findByText("The default expiry can't be longer than the maximum lifetime (7 days).")).toBeInTheDocument()
    expect(api.patchAdminSettings).not.toHaveBeenCalled()
  })

  it('a failed save restores the stored value and says so', async () => {
    api.patchAdminSettings.mockRejectedValue(new Error('500'))
    const { max } = await renderGeneral({ pat_max_lifetime_days: 90 })
    type(max, '45')
    expect(await screen.findByText('Failed to save settings.')).toBeInTheDocument()
    await waitFor(() => expect(max.value).toBe('90'))
  })

  it('treats a server that omits the fields as unset', async () => {
    api.getAdminSettings.mockResolvedValue({ registration_mode: 'open', uploads_enabled: true, maintenance_mode: false, maintenance_message: '' })
    render(
      <MemoryRouter initialEntries={['/admin?tab=general']}>
        <AdminPage user={actor} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
      </MemoryRouter>,
    )
    expect(((await screen.findByLabelText('Maximum lifetime (days)')) as HTMLInputElement).value).toBe('')
  })
})
