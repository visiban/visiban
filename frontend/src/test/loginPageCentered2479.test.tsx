/** #2479: the sign-in card on the shared Centered layout. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import LoginPage from '../components/Auth/LoginPage'

vi.mock('../api/auth', () => ({
  login: vi.fn(),
  register: vi.fn(),
  getCurrentUser: vi.fn(),
  getAuthProviders: vi.fn(),
  getSiteConfig: vi.fn(),
}))

import { getAuthProviders, getSiteConfig } from '../api/auth'

const mockProviders = getAuthProviders as ReturnType<typeof vi.fn>
const mockSiteConfig = getSiteConfig as ReturnType<typeof vi.fn>

function renderAt(url = '/', state?: Record<string, unknown>) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: url.split('?')[0], search: url.includes('?') ? `?${url.split('?')[1]}` : '', state: state ?? {} }]}>
      <LoginPage onLogin={vi.fn()} />
    </MemoryRouter>,
  )
}

describe('LoginPage on the Centered layout (#2479)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    mockProviders.mockResolvedValue({ google: false, github: false, gitlab: false, oidc: false, oidc_name: null })
    mockSiteConfig.mockResolvedValue({ registration_open: true, registration_mode: 'open' })
  })

  it('renders the logo tile, the h1 and visibly labeled fields with autocomplete', () => {
    renderAt()
    expect(screen.getByTestId('login-page')).toHaveAttribute('data-layout', 'centered')
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in to Visiban' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Visiban' })).toBeInTheDocument()
    expect(screen.getByLabelText('Username or email')).toHaveAttribute('autocomplete', 'username')
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password')
  })

  it('register mode is "Create your account" with new-password fields', async () => {
    const user = userEvent.setup()
    renderAt()
    await user.click(await screen.findByRole('button', { name: 'Create account' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Create your account' })).toBeInTheDocument()
    expect(screen.getByLabelText('Email address')).toHaveAttribute('autocomplete', 'email')
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.getByText(/Already have an account\?/)).toBeInTheDocument()
  })

  it('a site invite opens the card as "Complete your registration"', async () => {
    mockSiteConfig.mockResolvedValue({ registration_open: false, registration_mode: 'invite_only' })
    sessionStorage.setItem('invite_token', 'vbnl_abc')
    renderAt('/', { authMode: 'register' })
    expect(await screen.findByRole('heading', { level: 1, name: 'Complete your registration' })).toBeInTheDocument()
  })

  it('says registration is invite-only on an invite-only site', async () => {
    mockSiteConfig.mockResolvedValue({ registration_open: false, registration_mode: 'invite_only' })
    renderAt()
    expect(await screen.findByTestId('registration-line')).toHaveTextContent('Registration is invite-only.')
    expect(screen.queryByRole('button', { name: 'Create account' })).toBeNull()
  })

  it('says registration is closed on a closed site', async () => {
    mockSiteConfig.mockResolvedValue({ registration_open: false, registration_mode: 'closed' })
    renderAt()
    expect(await screen.findByTestId('registration-line')).toHaveTextContent('Registration is closed. Ask an admin for an account.')
  })

  it('falls back to invite-only when an older backend sends no registration_mode', async () => {
    mockSiteConfig.mockResolvedValue({ registration_open: false })
    renderAt()
    expect(await screen.findByTestId('registration-line')).toHaveTextContent('Registration is invite-only.')
  })

  it('puts only the enabled providers above an "or" divider, OIDC first with its configured name', async () => {
    mockProviders.mockResolvedValue({ google: true, github: false, gitlab: true, oidc: true, oidc_name: 'Keycloak' })
    renderAt()
    const keycloak = await screen.findByRole('link', { name: 'Continue with Keycloak' })
    const links = screen.getAllByRole('link').map((a) => a.textContent)
    expect(links).toEqual(['Continue with Keycloak', 'Continue with Google', 'Continue with GitLab'])
    expect(screen.queryByRole('link', { name: /GitHub/ })).toBeNull()
    const divider = screen.getByRole('separator', { name: 'or' })
    // Providers come before the divider, the form after it.
    expect(keycloak.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(divider.compareDocumentPosition(screen.getByLabelText('Username or email')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows no divider when no provider is on', async () => {
    renderAt()
    await waitFor(() => expect(mockProviders).toHaveBeenCalled())
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('an OAuth error returns here as an alert above the form', async () => {
    renderAt('/?auth_error=oauth_failed')
    const alert = await screen.findByTestId('auth-error')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert).toHaveTextContent('Something went wrong during authentication. Please try again.')
    expect(alert.compareDocumentPosition(screen.getByLabelText('Username or email')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('a site invite error keeps the "ask your administrator for a new one" wording', async () => {
    renderAt('/?auth_error=invite_expired')
    expect(await screen.findByTestId('auth-error')).toHaveTextContent('This invite link has expired. Please ask your administrator for a new one.')
  })
})
