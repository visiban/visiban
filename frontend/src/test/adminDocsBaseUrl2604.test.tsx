import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AdminPage from '../pages/AdminPage'
import type { SiteSettings, User } from '../types'

// Site admin → General → Help links (#2604): runtime docs base URL for the in-app help links.
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
  pat_max_lifetime_days: null, pat_default_lifetime_days: null, docs_base_url: null,
}

async function renderGeneral(settings: Partial<SiteSettings> = {}) {
  api.getAdminSettings.mockResolvedValue({ ...base, ...settings })
  render(
    <MemoryRouter initialEntries={['/admin?tab=general']}>
      <AdminPage user={actor} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
    </MemoryRouter>,
  )
  return (await screen.findByLabelText('Docs address')) as HTMLInputElement
}

function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

const MIRROR = 'https://docs.example.internal/visiban'

beforeEach(() => {
  vi.clearAllMocks()
  api.patchAdminSettings.mockImplementation(async (patch: Partial<SiteSettings>) => ({ ...base, ...patch }))
})

describe('Help links card (#2604)', () => {
  it('is blank when unset and shows the stored value when set', async () => {
    expect((await renderGeneral()).value).toBe('')
  })

  it('shows a stored value', async () => {
    expect((await renderGeneral({ docs_base_url: MIRROR })).value).toBe(MIRROR)
  })

  it('treats a server that omits the field as unset', async () => {
    const { docs_base_url: _omit, ...older } = base
    void _omit
    api.getAdminSettings.mockResolvedValue(older)
    render(
      <MemoryRouter initialEntries={['/admin?tab=general']}>
        <AdminPage user={actor} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
      </MemoryRouter>,
    )
    expect(((await screen.findByLabelText('Docs address')) as HTMLInputElement).value).toBe('')
  })

  it('saves a trimmed http(s) address on blur', async () => {
    const input = await renderGeneral()
    type(input, `  ${MIRROR}  `)
    await waitFor(() => expect(api.patchAdminSettings).toHaveBeenCalledWith({ docs_base_url: MIRROR }))
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument()
  })

  it('blank clears a stored value to null', async () => {
    const input = await renderGeneral({ docs_base_url: MIRROR })
    type(input, '   ')
    await waitFor(() => expect(api.patchAdminSettings).toHaveBeenCalledWith({ docs_base_url: null }))
  })

  it('an unchanged value does not save', async () => {
    const input = await renderGeneral({ docs_base_url: MIRROR })
    type(input, MIRROR)
    expect(api.patchAdminSettings).not.toHaveBeenCalled()
  })

  it.each([
    ['javascript:alert(1)', 'Enter an http:// or https:// address, such as https://docs.example.internal/visiban.'],
    ['ftp://docs.example.internal', 'Enter an http:// or https:// address, such as https://docs.example.internal/visiban.'],
    ['docs.example.internal', 'Enter an http:// or https:// address, such as https://docs.example.internal/visiban.'],
    ['https://docs.example .internal', 'Enter an http:// or https:// address, such as https://docs.example.internal/visiban.'],
    ['https://user:pw@docs.example.internal', 'Leave the user name and password out of the address: it is shown to everyone.'],
    ['https://docs.example.internal/?v=1', 'Leave out the ? and # parts: help links add their own page and section.'],
    ['https://docs.example.internal/#top', 'Leave out the ? and # parts: help links add their own page and section.'],
    ['https://docs.example.internal/?', 'Leave out the ? and # parts: help links add their own page and section.'],
  ])('refuses %s inline without saving', async (value, message) => {
    const input = await renderGeneral()
    type(input, value)
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(api.patchAdminSettings).not.toHaveBeenCalled()
  })

  it('clears the error as soon as the value is edited', async () => {
    const input = await renderGeneral()
    type(input, 'javascript:alert(1)')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(input, { target: { value: 'https://' } })
    expect(input).not.toHaveAttribute('aria-invalid', 'true')
  })

  it('rolls back the field and reports a failed save', async () => {
    api.patchAdminSettings.mockRejectedValueOnce(new Error('400'))
    const input = await renderGeneral({ docs_base_url: MIRROR })
    type(input, 'https://other.example.internal')
    expect(await screen.findByText('Failed to save settings.')).toBeInTheDocument()
    await waitFor(() => expect(input.value).toBe(MIRROR))
  })
})
