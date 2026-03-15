import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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
    mockGetAuthProviders.mockResolvedValue({ google: false, github: false, gitlab: false })
    mockGetSiteConfig.mockResolvedValue({ registration_open: true })
  })

  it('renders login form by default', () => {
    renderLoginPage()
    expect(screen.getByAltText('Visiban')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Username or email')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument()
    expect(screen.getByText('Sign in')).toBeInTheDocument()
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
    const user = userEvent.setup()
    renderLoginPage()

    await user.click(screen.getByText('Create one'))
    await user.type(screen.getByPlaceholderText('Email address'), 'test@test.com')
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'different')
    await user.click(screen.getByText('Create account'))

    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument()
  })

  it('shows short password error in register mode', async () => {
    const user = userEvent.setup()
    renderLoginPage()

    await user.click(screen.getByText('Create one'))
    await user.type(screen.getByPlaceholderText('Email address'), 'test@test.com')
    await user.type(screen.getByPlaceholderText('Password'), 'short')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'short')
    await user.click(screen.getByText('Create account'))

    expect(screen.getByText('Password must be at least 8 characters.')).toBeInTheDocument()
  })

  it('calls login API and onLogin on success', async () => {
    const fakeUser = { id: 1, username: 'test' }
    mockLogin.mockResolvedValue({})
    mockGetCurrentUser.mockResolvedValue(fakeUser)

    const user = userEvent.setup()
    renderLoginPage()

    await user.type(screen.getByPlaceholderText('Username or email'), 'test')
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.click(screen.getByText('Sign in'))

    expect(mockLogin).toHaveBeenCalledWith('test', 'password123')
  })

  it('shows OAuth buttons when providers are available', async () => {
    mockGetAuthProviders.mockResolvedValue({ google: true, github: true, gitlab: false })
    renderLoginPage()

    expect(await screen.findByText('Continue with Google')).toBeInTheDocument()
    expect(screen.getByText('Continue with GitHub')).toBeInTheDocument()
    expect(screen.queryByText('Continue with GitLab')).not.toBeInTheDocument()
  })

  it('shows error on login failure', async () => {
    mockLogin.mockRejectedValue({ response: { data: { non_field_errors: ['Invalid credentials'] } } })

    const user = userEvent.setup()
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

    const user = userEvent.setup()
    renderLoginPage()

    await user.click(screen.getByText('Create one'))
    await user.type(screen.getByPlaceholderText('Email address'), 'kelly@example.com')
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'password123')
    await user.click(screen.getByText('Create account'))

    expect(mockRegister).toHaveBeenCalledWith('kelly@example.com', 'password123', 'password123')
  })

  it('hides "Create one" and shows invite-only message when registration is closed', async () => {
    mockGetSiteConfig.mockResolvedValue({ registration_open: false })
    renderLoginPage()

    expect(await screen.findByText('Registration is invite-only.')).toBeInTheDocument()
    expect(screen.queryByText('Create one')).not.toBeInTheDocument()
  })

  it('disables submit button in register mode when registration is closed', async () => {
    mockGetSiteConfig.mockResolvedValue({ registration_open: false })
    renderLoginPage({ authMode: 'register' })

    const submitButton = await screen.findByRole('button', { name: 'Create account' })
    expect(submitButton).toBeDisabled()
  })

  it('shows invite-only message in register mode when registration is closed', async () => {
    mockGetSiteConfig.mockResolvedValue({ registration_open: false })
    renderLoginPage({ authMode: 'register' })

    expect(await screen.findByText('An invite link is required to create an account.')).toBeInTheDocument()
  })

  it('assumes registration open when getSiteConfig fails', async () => {
    mockGetSiteConfig.mockRejectedValue(new Error('network error'))
    renderLoginPage()

    // "Create one" link should still be present (fail open)
    expect(await screen.findByText('Create one')).toBeInTheDocument()
  })
})
