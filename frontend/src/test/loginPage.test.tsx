import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import LoginPage from '../components/Auth/LoginPage'
import { formatClockTime } from '../utils/date'

vi.mock('../api/auth', () => ({
  login: vi.fn(),
  register: vi.fn(),
  getCurrentUser: vi.fn(),
  getAuthProviders: vi.fn(),
  getSiteConfig: vi.fn(),
}))

import { login, register, getCurrentUser, getAuthProviders, getSiteConfig } from '../api/auth'

const mockLogin = login as ReturnType<typeof vi.fn>
const mockRegister = register as ReturnType<typeof vi.fn>
const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>
const mockGetAuthProviders = getAuthProviders as ReturnType<typeof vi.fn>
const mockGetSiteConfig = getSiteConfig as ReturnType<typeof vi.fn>

function renderLoginPage(locationState?: Record<string, unknown>) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/', state: locationState ?? {} }]}>
      <LoginPage onLogin={vi.fn()} />
    </MemoryRouter>
  )
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    mockGetAuthProviders.mockResolvedValue({ google: false, github: false, gitlab: false, oidc: false, oidc_name: null })
    mockGetSiteConfig.mockResolvedValue({ registration_open: true, invite_email_available: false })
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  it('renders login form by default', () => {
    renderLoginPage()
    expect(screen.getByAltText('Visiban')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Username or email')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument()
    expect(screen.getByText('Sign in')).toBeInTheDocument()
  })

  it('shows "Forgot password?" link in login mode', () => {
    renderLoginPage()
    expect(screen.getByText('Forgot password?')).toBeInTheDocument()
  })

  it('hides "Forgot password?" link in register mode', async () => {
    const user = userEvent.setup()
    renderLoginPage()
    await user.click(screen.getByText('Create one'))
    expect(screen.queryByText('Forgot password?')).not.toBeInTheDocument()
  })

  it('starts in register mode when authMode is "register" in location state', () => {
    renderLoginPage({ authMode: 'register' })
    expect(screen.getByText('Create account')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Confirm password')).toBeInTheDocument()
  })

  it('starts in login mode when authMode is absent', () => {
    renderLoginPage()
    expect(screen.getByText('Sign in')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Confirm password')).not.toBeInTheDocument()
  })

  it('switches to register mode', async () => {
    const user = userEvent.setup()
    renderLoginPage()

    await user.click(screen.getByText('Create one'))
    expect(screen.getByText('Create account')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Confirm password')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Username (optional)')).not.toBeInTheDocument()
  })

  it('switches back to login mode', async () => {
    const user = userEvent.setup()
    renderLoginPage()

    await user.click(screen.getByText('Create one'))
    await user.click(screen.getByText('Sign in', { selector: 'button[type="button"]' }))
    expect(screen.getByText('Sign in', { selector: 'button[type="submit"]' })).toBeInTheDocument()
  })

  it('shows password mismatch error in register mode', async () => {
    const user = userEvent.setup({ delay: null })
    renderLoginPage()

    await user.click(screen.getByText('Create one'))
    await user.type(screen.getByPlaceholderText('Email address'), 'test@test.com')
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'different')
    await user.click(screen.getByText('Create account'))

    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument()
  })

  it('shows short password error in register mode', async () => {
    const user = userEvent.setup({ delay: null })
    renderLoginPage()

    await user.click(screen.getByText('Create one'))
    await user.type(screen.getByPlaceholderText('Email address'), 'test@test.com')
    // 11 characters: one below the 12-character server policy (#1258).
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'password123')
    await user.click(screen.getByText('Create account'))

    expect(screen.getByText('Password must be at least 12 characters.')).toBeInTheDocument()
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it('calls login API and onLogin on success', async () => {
    const fakeUser = { id: 1, username: 'test' }
    mockLogin.mockResolvedValue({})
    mockGetCurrentUser.mockResolvedValue(fakeUser)

    const user = userEvent.setup({ delay: null })
    renderLoginPage()

    await user.type(screen.getByPlaceholderText('Username or email'), 'test')
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.click(screen.getByText('Sign in'))

    expect(mockLogin).toHaveBeenCalledWith('test', 'password123')
  })

  it('shows OAuth buttons when providers are available', async () => {
    mockGetAuthProviders.mockResolvedValue({ google: true, github: true, gitlab: false, oidc: false, oidc_name: null })
    renderLoginPage()

    expect(await screen.findByText('Continue with Google')).toBeInTheDocument()
    expect(screen.getByText('Continue with GitHub')).toBeInTheDocument()
    expect(screen.queryByText('Continue with GitLab')).not.toBeInTheDocument()
  })

  it('shows error on login failure', async () => {
    mockLogin.mockRejectedValue({ response: { data: { non_field_errors: ['Invalid credentials'] } } })

    const user = userEvent.setup({ delay: null })
    renderLoginPage()

    await user.type(screen.getByPlaceholderText('Username or email'), 'test')
    await user.type(screen.getByPlaceholderText('Password'), 'wrong')
    await user.click(screen.getByText('Sign in'))

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument()
  })

  it('calls register API with email and passwords (no username)', async () => {
    const fakeUser = { id: 1, username: 'kelly42' }
    mockRegister.mockResolvedValue({})
    mockGetCurrentUser.mockResolvedValue(fakeUser)

    const user = userEvent.setup({ delay: null })
    renderLoginPage()

    await user.click(screen.getByText('Create one'))
    // Wait for getSiteConfig to settle before interacting — the submit button is
    // disabled until the async config resolves, so a synchronous getByRole click
    // races against the pending microtask and fails intermittently.
    await user.type(screen.getByPlaceholderText('Email address'), 'kelly@example.com')
    await user.type(screen.getByPlaceholderText('Password'), 'password1234')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'password1234')
    await user.click(await screen.findByRole('button', { name: /create account/i }))

    // 4th arg is the invite token from sessionStorage — undefined when none is present
    expect(mockRegister).toHaveBeenCalledWith('kelly@example.com', 'password1234', 'password1234', undefined)
  })

  it('drops a rejected invite token after a failed registration (#1445)', async () => {
    mockGetSiteConfig.mockResolvedValue({ registration_open: false, invite_email_available: false })
    sessionStorage.setItem('invite_token', 'vbng_shared')
    const detail = "This invite link can't be used to create an account. Ask a group admin to send an invite to your email address."
    mockRegister.mockRejectedValue({ response: { status: 400, data: { invite_token: [detail] } } })

    const user = userEvent.setup({ delay: null })
    renderLoginPage({ authMode: 'register' })
    await screen.findByText('Complete your registration')
    await user.type(screen.getByPlaceholderText('Email address'), 'new@example.com')
    await user.type(screen.getByPlaceholderText('Password'), 'password1234')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'password1234')
    await user.click(screen.getByRole('button', { name: /create account/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(detail)
    expect(sessionStorage.getItem('invite_token')).toBeNull()
    expect(screen.getByText('An invite link is required to create an account.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled()
  })

  it('drops an invite token on a closed site instead of enabling registration (#1445)', async () => {
    mockGetSiteConfig.mockResolvedValue({ registration_open: false, registration_mode: 'closed', invite_email_available: false })
    sessionStorage.setItem('invite_token', 'vbng_emailed')
    renderLoginPage({ authMode: 'register' })

    await screen.findByText('An invite link is required to create an account.')
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled()
    expect(screen.queryByText('Complete your registration')).not.toBeInTheDocument()
    expect(sessionStorage.getItem('invite_token')).toBeNull()
  })

  it('keeps the invite token when registration fails for another reason', async () => {
    mockGetSiteConfig.mockResolvedValue({ registration_open: false, invite_email_available: false })
    sessionStorage.setItem('invite_token', 'vbng_emailed')
    mockRegister.mockRejectedValue({ response: { status: 400, data: { email: ['A user is already registered with this e-mail address.'] } } })

    const user = userEvent.setup({ delay: null })
    renderLoginPage({ authMode: 'register' })
    await screen.findByText('Complete your registration')
    await user.type(screen.getByPlaceholderText('Email address'), 'taken@example.com')
    await user.type(screen.getByPlaceholderText('Password'), 'password1234')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'password1234')
    await user.click(screen.getByRole('button', { name: /create account/i }))

    await screen.findByRole('alert')
    expect(sessionStorage.getItem('invite_token')).toBe('vbng_emailed')
  })

  it('hides "Create one" and shows invite-only message when registration is closed', async () => {
    mockGetSiteConfig.mockResolvedValue({ registration_open: false, invite_email_available: false })
    renderLoginPage()

    expect(await screen.findByText('Registration is invite-only.')).toBeInTheDocument()
    expect(screen.queryByText('Create one')).not.toBeInTheDocument()
  })

  it('disables submit button in register mode when registration is closed', async () => {
    mockGetSiteConfig.mockResolvedValue({ registration_open: false, invite_email_available: false })
    renderLoginPage({ authMode: 'register' })

    // Wait for the async getSiteConfig response to propagate — the invite-only
    // message appears at the same time the button becomes disabled.
    await screen.findByText('An invite link is required to create an account.')
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled()
  })

  it('shows invite-only message in register mode when registration is closed', async () => {
    mockGetSiteConfig.mockResolvedValue({ registration_open: false, invite_email_available: false })
    renderLoginPage({ authMode: 'register' })

    expect(await screen.findByText('An invite link is required to create an account.')).toBeInTheDocument()
  })

  it('enables submit button in register mode when registration is closed but invite token is present', async () => {
    mockGetSiteConfig.mockResolvedValue({ registration_open: false, invite_email_available: false })
    sessionStorage.setItem('invite_token', 'vbnl_abc123')
    renderLoginPage({ authMode: 'register' })

    // Wait for site config to resolve — the button must remain enabled
    await screen.findByText('Create account')
    expect(screen.getByRole('button', { name: 'Create account' })).not.toBeDisabled()
  })

  it('hides invite-required message when invite token is present', async () => {
    mockGetSiteConfig.mockResolvedValue({ registration_open: false, invite_email_available: false })
    sessionStorage.setItem('invite_token', 'vbnl_abc123')
    renderLoginPage({ authMode: 'register' })

    await screen.findByText('Create account')
    expect(screen.queryByText('An invite link is required to create an account.')).not.toBeInTheDocument()
  })

  it('assumes registration open when getSiteConfig fails', async () => {
    mockGetSiteConfig.mockRejectedValue(new Error('network error'))
    renderLoginPage()

    // "Create one" link should still be present (fail open)
    expect(await screen.findByText('Create one')).toBeInTheDocument()
  })

  it('shows SSO button when oidc provider is enabled', async () => {
    mockGetAuthProviders.mockResolvedValue({ google: false, github: false, gitlab: false, oidc: true, oidc_name: null })
    renderLoginPage()
    expect(await screen.findByText('Continue with SSO')).toBeInTheDocument()
  })

  it('shows OIDC provider name when oidc_name is set', async () => {
    mockGetAuthProviders.mockResolvedValue({ google: false, github: false, gitlab: false, oidc: true, oidc_name: 'Acme Corp' })
    renderLoginPage()
    expect(await screen.findByText('Continue with Acme Corp')).toBeInTheDocument()
  })

  // ---------------------------------------------------------------------------
  // OAuth invite token flow
  // ---------------------------------------------------------------------------

  describe('OAuth invite token in URLs', () => {
    it('includes invite_token in OAuth URLs in register mode with token', async () => {
      mockGetAuthProviders.mockResolvedValue({ google: true, github: false, gitlab: false, oidc: false, oidc_name: null })
      mockGetSiteConfig.mockResolvedValue({ registration_open: false, invite_email_available: false })
      sessionStorage.setItem('invite_token', 'vbnl_test_token_123')
      renderLoginPage({ authMode: 'register' })

      const googleLink = await screen.findByText('Continue with Google')
      const href = googleLink.closest('a')?.getAttribute('href') ?? ''
      expect(href).toContain('invite_token=vbnl_test_token_123')
    })

    it('excludes invite_token from OAuth URLs in login mode', async () => {
      mockGetAuthProviders.mockResolvedValue({ google: true, github: false, gitlab: false, oidc: false, oidc_name: null })
      sessionStorage.setItem('invite_token', 'vbnl_test_token_123')
      renderLoginPage()

      const googleLink = await screen.findByText('Continue with Google')
      const href = googleLink.closest('a')?.getAttribute('href') ?? ''
      expect(href).not.toContain('invite_token')
    })

    it('excludes invite_token when no token in sessionStorage', async () => {
      mockGetAuthProviders.mockResolvedValue({ google: true, github: false, gitlab: false, oidc: false, oidc_name: null })
      renderLoginPage({ authMode: 'register' })

      const googleLink = await screen.findByText('Continue with Google')
      const href = googleLink.closest('a')?.getAttribute('href') ?? ''
      expect(href).not.toContain('invite_token')
    })
  })

  describe('context banner', () => {
    it('shows "Complete your registration" in register mode with invite token', async () => {
      mockGetSiteConfig.mockResolvedValue({ registration_open: false, invite_email_available: false })
      sessionStorage.setItem('invite_token', 'vbnl_abc')
      renderLoginPage({ authMode: 'register' })

      expect(await screen.findByText('Complete your registration')).toBeInTheDocument()
    })

    it('hides banner in login mode', async () => {
      mockGetSiteConfig.mockResolvedValue({ registration_open: false, invite_email_available: false })
      sessionStorage.setItem('invite_token', 'vbnl_abc')
      renderLoginPage()

      // Wait for providers to load, then check
      await screen.findByText('Sign in')
      expect(screen.queryByText('Complete your registration')).not.toBeInTheDocument()
    })

    it('hides banner when registration is open', () => {
      sessionStorage.setItem('invite_token', 'vbnl_abc')
      renderLoginPage({ authMode: 'register' })

      expect(screen.queryByText('Complete your registration')).not.toBeInTheDocument()
    })
  })

  describe('auth_error query param handling', () => {
    it('shows expired error message from query param', async () => {
      // Simulate redirect from backend with ?auth_error=invite_expired
      render(
        <MemoryRouter initialEntries={['/?auth_error=invite_expired']}>
          <LoginPage onLogin={vi.fn()} />
        </MemoryRouter>
      )

      expect(await screen.findByText('This invite link has expired. Please ask your administrator for a new one.')).toBeInTheDocument()
    })

    it('shows used error message from query param', async () => {
      render(
        <MemoryRouter initialEntries={['/?auth_error=invite_used']}>
          <LoginPage onLogin={vi.fn()} />
        </MemoryRouter>
      )

      expect(await screen.findByText('This invite link has already been used. Please ask your administrator for a new one.')).toBeInTheDocument()
    })

    it('shows closed-registration message for signup_closed (#1324)', async () => {
      render(
        <MemoryRouter initialEntries={['/?auth_error=signup_closed']}>
          <LoginPage onLogin={vi.fn()} />
        </MemoryRouter>
      )

      expect(await screen.findByText('Registration is currently closed.')).toBeInTheDocument()
    })

    it('shows invite-required message for invite_required (#1324)', async () => {
      render(
        <MemoryRouter initialEntries={['/?auth_error=invite_required']}>
          <LoginPage onLogin={vi.fn()} />
        </MemoryRouter>
      )

      expect(await screen.findByText('An invite link is required to create an account.')).toBeInTheDocument()
    })

    it('explains a shareable group link cannot create an account (#1445)', async () => {
      sessionStorage.setItem('invite_token', 'vbng_shared')
      render(
        <MemoryRouter initialEntries={['/?auth_error=invite_not_for_registration']}>
          <LoginPage onLogin={vi.fn()} />
        </MemoryRouter>
      )

      expect(await screen.findByText(/This invite link can't be used to create an account\./)).toBeInTheDocument()
      expect(sessionStorage.getItem('invite_token')).toBeNull()
    })

    it('clears invite_token from sessionStorage on invite errors', async () => {
      sessionStorage.setItem('invite_token', 'vbnl_abc')
      render(
        <MemoryRouter initialEntries={['/?auth_error=invite_expired']}>
          <LoginPage onLogin={vi.fn()} />
        </MemoryRouter>
      )

      await screen.findByText(/expired/)
      expect(sessionStorage.getItem('invite_token')).toBeNull()
    })

    it('shows generic error for unknown auth_error codes', async () => {
      render(
        <MemoryRouter initialEntries={['/?auth_error=unknown_code']}>
          <LoginPage onLogin={vi.fn()} />
        </MemoryRouter>
      )

      expect(await screen.findByText('Something went wrong during authentication. Please try again.')).toBeInTheDocument()
    })

    it('error element has role="alert" for accessibility', async () => {
      render(
        <MemoryRouter initialEntries={['/?auth_error=invite_expired']}>
          <LoginPage onLogin={vi.fn()} />
        </MemoryRouter>
      )

      const alert = await screen.findByRole('alert')
      expect(alert).toBeInTheDocument()
    })
  })

  // ── OAuth email collision (#1314) ─────────────────────────────────────────

  describe('account_exists / account_exists_provider', () => {
    function renderAt(url: string) {
      return render(
        <MemoryRouter initialEntries={[url]}>
          <LoginPage onLogin={vi.fn()} />
        </MemoryRouter>
      )
    }

    it('account_exists: banner above the untouched login form, naming the provider', async () => {
      renderAt('/?auth_error=account_exists&provider=github')
      const banner = await screen.findByTestId('account-exists-banner')
      expect(banner).toHaveAttribute('role', 'alert')
      expect(within(banner).getByText('You already have a Visiban account')).toBeInTheDocument()
      expect(banner).toHaveTextContent(
        "This email is already registered. Log in with your password once and we'll connect GitHub for next time."
      )
      // The full form stays, including the recovery link.
      expect(screen.getByPlaceholderText('Username or email')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Password')).toBeInTheDocument()
      expect(screen.getByText('Forgot password?')).toBeInTheDocument()
      // Banner comes before the form in document order.
      const form = screen.getByPlaceholderText('Password').closest('form')!
      expect(banner.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('account_exists keeps an in-flight invite token', async () => {
      sessionStorage.setItem('invite_token', 'vbnl_abc')
      renderAt('/?auth_error=account_exists&provider=google')
      await screen.findByTestId('account-exists-banner')
      expect(sessionStorage.getItem('invite_token')).toBe('vbnl_abc')
    })

    it('account_exists_provider: replaces the form with a Continue-with-via CTA and a reset link', async () => {
      mockGetAuthProviders.mockResolvedValue({ google: true, github: true, gitlab: false, oidc: false, oidc_name: null })
      renderAt('/?auth_error=account_exists_provider&provider=github&via=google')
      const banner = await screen.findByTestId('account-exists-banner')
      expect(banner).toHaveTextContent(
        "This email signs in with Google. Continue with Google and we'll connect GitHub afterwards."
      )
      expect(screen.getByRole('button', { name: /Continue with Google/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: "Can't access Google? Reset your password instead" })).toBeInTheDocument()
      expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument()
      expect(screen.queryByText('Continue with GitHub')).not.toBeInTheDocument()
    })

    it('account_exists_provider: the reset link goes to the forgot-password page', async () => {
      const user = userEvent.setup()
      render(
        <MemoryRouter initialEntries={['/?auth_error=account_exists_provider&provider=github&via=google']}>
          <Routes>
            <Route path="/" element={<LoginPage onLogin={vi.fn()} />} />
            <Route path="/forgot-password" element={<div>forgot page</div>} />
          </Routes>
        </MemoryRouter>
      )
      await user.click(await screen.findByRole('button', { name: /Reset your password instead/ }))
      expect(await screen.findByText('forgot page')).toBeInTheDocument()
    })

    it('names generic OIDC with the configured SSO name', async () => {
      mockGetAuthProviders.mockResolvedValue({ google: false, github: false, gitlab: false, oidc: true, oidc_name: 'Okta' })
      renderAt('/?auth_error=account_exists_provider&provider=github&via=oidc')
      expect(await screen.findByRole('button', { name: /Continue with Okta/ })).toBeInTheDocument()
    })

    it('an unknown provider id in the URL is never echoed into the banner', async () => {
      renderAt('/?auth_error=account_exists_provider&provider=github&via=Evil%20Corp%20Support')
      expect(await screen.findByText('Something went wrong during authentication. Please try again.')).toBeInTheDocument()
      expect(screen.queryByTestId('account-exists-banner')).not.toBeInTheDocument()
      expect(screen.queryByText(/Evil Corp/)).not.toBeInTheDocument()
    })

    it('other codes still use the bottom-of-form error slot', async () => {
      renderAt('/?auth_error=oauth_failed')
      expect(await screen.findByText('Something went wrong during authentication. Please try again.')).toBeInTheDocument()
      expect(screen.queryByTestId('account-exists-banner')).not.toBeInTheDocument()
    })
  })

  it('points the SSO button at allauth\'s nested OIDC login path', async () => {
    mockGetAuthProviders.mockResolvedValue({ google: false, github: false, gitlab: false, oidc: true, oidc_name: 'Okta' })
    renderLoginPage()
    const link = await screen.findByText('Continue with Okta')
    expect(link.closest('a')?.getAttribute('href')).toContain('/accounts/oidc/oidc/login/?process=login')
  })

  // ── Demo banner (#1034) ────────────────────────────────────────────────────

  it('shows the demo banner with credentials and the next reset time from site-config', async () => {
    mockGetSiteConfig.mockResolvedValue({
      registration_open: true,
      demo_mode: true,
      invite_email_available: false,
      demo_login: { username: 'visitor', password: 'pw-from-config' },
      // A scheduled reset always carries a real cron string alongside next_reset_at
      // (#1180) — this fixture used to omit it and rely on cadenceText's now-removed
      // `=== null` fallback defaulting to "hourly", which masked exactly the bug
      // #1180 fixed at a different call site.
      demo_reset_schedule: '0 * * * *',
      demo_next_reset_at: '2026-09-27T13:00:00Z',
    })
    renderLoginPage()
    const banner = await screen.findByTestId('demo-banner')
    expect(banner).toHaveAttribute('role', 'note')
    expect(banner).toHaveTextContent('This is a shared demo.')
    expect(banner).toHaveTextContent('Resets every hour, on the hour')
    expect(banner).toHaveTextContent(`next reset at ${formatClockTime('2026-09-27T13:00:00Z')} (your local time)`)
    expect(banner).toHaveTextContent('Everything you change is erased and you will be signed out.')
    // The old hardcoded nightly copy and the throwaway-account line are gone (#1179).
    expect(banner).not.toHaveTextContent('00:00 UTC')
    expect(banner).not.toHaveTextContent('throwaway')
    expect(banner).toHaveTextContent('visitor')
    expect(banner).toHaveTextContent('pw-from-config')
  })

  it('never promises "every hour" for a non-hourly reset schedule', async () => {
    mockGetSiteConfig.mockResolvedValue({
      registration_open: false,
      demo_mode: true,
      invite_email_available: false,
      demo_login: { username: 'visitor', password: 'pw' },
      demo_reset_schedule: '0 0 * * *',
      demo_next_reset_at: '2026-09-28T00:00:00Z',
    })
    renderLoginPage()
    const banner = await screen.findByTestId('demo-banner')
    expect(banner).toHaveTextContent('Resets on a regular schedule')
    expect(banner).not.toHaveTextContent('every hour')
    expect(banner).toHaveTextContent(`next reset at ${formatClockTime('2026-09-28T00:00:00Z')}`)
  })

  it('promises no reset when none is scheduled (#1180)', async () => {
    mockGetSiteConfig.mockResolvedValue({
      registration_open: false,
      demo_mode: true,
      invite_email_available: false,
      demo_login: { username: 'visitor', password: 'pw' },
      demo_reset_schedule: null,
      demo_next_reset_at: null,
    })
    renderLoginPage()
    const banner = await screen.findByTestId('demo-banner')
    expect(banner).toHaveTextContent(
      'This is a shared demo. Other visitors can see and change everything here, and it is never reset.',
    )
    expect(banner).not.toHaveTextContent('Resets')
    expect(banner).not.toHaveTextContent('erased')
    expect(banner).not.toHaveTextContent('signed out')
  })

  it('"Explore the demo" signs in with the published credential in one click (#1179)', async () => {
    const onLogin = vi.fn()
    const fakeUser = { id: 7, username: 'visitor' }
    mockLogin.mockResolvedValue({})
    mockGetCurrentUser.mockResolvedValue(fakeUser)
    mockGetSiteConfig.mockResolvedValue({
      registration_open: false,
      demo_mode: true,
      invite_email_available: false,
      demo_login: { username: 'visitor', password: 'pw-from-config' },
      demo_next_reset_at: '2026-09-27T13:00:00Z',
    })
    render(
      <MemoryRouter>
        <LoginPage onLogin={onLogin} />
      </MemoryRouter>
    )
    const explore = await screen.findByRole('button', { name: 'Explore the demo' })
    await userEvent.setup().click(explore)
    // Same login endpoint as the manual form — no separate demo auth path.
    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith('visitor', 'pw-from-config'))
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(fakeUser))
    // The manual form was never cross-disabled.
    expect(screen.getByRole('button', { name: 'Sign in' })).not.toBeDisabled()
  })

  it('"Explore the demo" surfaces a login failure in its own error slot', async () => {
    mockLogin.mockRejectedValue({ response: { data: { non_field_errors: ['Demo is resetting.'] } } })
    mockGetSiteConfig.mockResolvedValue({
      registration_open: false,
      demo_mode: true,
      invite_email_available: false,
      demo_login: { username: 'visitor', password: 'pw' },
      demo_next_reset_at: null,
    })
    renderLoginPage()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Explore the demo' }))
    const banner = screen.getByTestId('demo-banner')
    expect(await within(banner).findByRole('alert')).toHaveTextContent('Demo is resetting.')
  })

  it('shows the one-shot "demo was reset" notice after a reset, then clears it (#1179)', async () => {
    sessionStorage.setItem('demo_reset_notice_at', '2026-09-27T13:00:00Z')
    const { unmount } = renderLoginPage()
    const notice = screen.getByTestId('demo-reset-notice')
    expect(notice).toHaveAttribute('role', 'status')
    expect(notice).toHaveTextContent(`The demo was reset at ${formatClockTime('2026-09-27T13:00:00Z')} — explore again.`)
    await waitFor(() => expect(sessionStorage.getItem('demo_reset_notice_at')).toBeNull())
    unmount()
    renderLoginPage()
    expect(screen.queryByTestId('demo-reset-notice')).not.toBeInTheDocument()
  })

  it('does not show the demo banner when demo mode is off', async () => {
    mockGetSiteConfig.mockResolvedValue({ registration_open: true, demo_mode: false, demo_login: null, invite_email_available: true })
    renderLoginPage()
    await screen.findByRole('button', { name: /sign in/i })
    await waitFor(() => expect(mockGetSiteConfig).toHaveBeenCalled())
    expect(screen.queryByTestId('demo-banner')).not.toBeInTheDocument()
  })

  it('does not show the demo banner when demo mode has no credentials', async () => {
    mockGetSiteConfig.mockResolvedValue({ registration_open: true, demo_mode: true, demo_login: null, invite_email_available: false })
    renderLoginPage()
    await screen.findByRole('button', { name: /sign in/i })
    await waitFor(() => expect(mockGetSiteConfig).toHaveBeenCalled())
    expect(screen.queryByTestId('demo-banner')).not.toBeInTheDocument()
  })
})
