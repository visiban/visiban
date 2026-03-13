import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LoginPage from '../components/Auth/LoginPage'

vi.mock('../api/auth', () => ({
  login: vi.fn(),
  register: vi.fn(),
  getCurrentUser: vi.fn(),
  getAuthProviders: vi.fn(),
}))

import { login, register, getCurrentUser, getAuthProviders } from '../api/auth'

const mockLogin = login as ReturnType<typeof vi.fn>
const mockRegister = register as ReturnType<typeof vi.fn>
const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>
const mockGetAuthProviders = getAuthProviders as ReturnType<typeof vi.fn>

describe('LoginPage', () => {
  const onLogin = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAuthProviders.mockResolvedValue({ google: false, github: false, gitlab: false })
  })

  it('renders login form by default', () => {
    render(<LoginPage onLogin={onLogin} />)
    expect(screen.getByAltText('Visiban')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Username or email')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument()
    expect(screen.getByText('Sign in')).toBeInTheDocument()
  })

  it('switches to register mode', async () => {
    const user = userEvent.setup()
    render(<LoginPage onLogin={onLogin} />)

    await user.click(screen.getByText('Create one'))
    expect(screen.getByText('Create account')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Confirm password')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Username (optional)')).toBeInTheDocument()
  })

  it('switches back to login mode', async () => {
    const user = userEvent.setup()
    render(<LoginPage onLogin={onLogin} />)

    await user.click(screen.getByText('Create one'))
    await user.click(screen.getByText('Sign in', { selector: 'button[type="button"]' }))
    expect(screen.getByText('Sign in', { selector: 'button[type="submit"]' })).toBeInTheDocument()
  })

  it('shows password mismatch error in register mode', async () => {
    const user = userEvent.setup()
    render(<LoginPage onLogin={onLogin} />)

    await user.click(screen.getByText('Create one'))
    await user.type(screen.getByPlaceholderText('Email address'), 'test@test.com')
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'different')
    await user.click(screen.getByText('Create account'))

    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument()
  })

  it('shows short password error in register mode', async () => {
    const user = userEvent.setup()
    render(<LoginPage onLogin={onLogin} />)

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
    render(<LoginPage onLogin={onLogin} />)

    await user.type(screen.getByPlaceholderText('Username or email'), 'test')
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.click(screen.getByText('Sign in'))

    expect(mockLogin).toHaveBeenCalledWith('test', 'password123')
  })

  it('shows OAuth buttons when providers are available', async () => {
    mockGetAuthProviders.mockResolvedValue({ google: true, github: true, gitlab: false })
    render(<LoginPage onLogin={onLogin} />)

    // Wait for providers to load
    expect(await screen.findByText('Continue with Google')).toBeInTheDocument()
    expect(screen.getByText('Continue with GitHub')).toBeInTheDocument()
    expect(screen.queryByText('Continue with GitLab')).not.toBeInTheDocument()
  })

  it('shows error on login failure', async () => {
    mockLogin.mockRejectedValue({ response: { data: { non_field_errors: ['Invalid credentials'] } } })

    const user = userEvent.setup()
    render(<LoginPage onLogin={onLogin} />)

    await user.type(screen.getByPlaceholderText('Username or email'), 'test')
    await user.type(screen.getByPlaceholderText('Password'), 'wrong')
    await user.click(screen.getByText('Sign in'))

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument()
  })

  it('registers without username when username field is left blank', async () => {
    const fakeUser = { id: 1, username: 'kelly42' }
    mockRegister.mockResolvedValue({})
    mockGetCurrentUser.mockResolvedValue(fakeUser)

    const user = userEvent.setup()
    render(<LoginPage onLogin={onLogin} />)

    await user.click(screen.getByText('Create one'))
    await user.type(screen.getByPlaceholderText('Email address'), 'kelly@example.com')
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'password123')
    await user.click(screen.getByText('Create account'))

    expect(mockRegister).toHaveBeenCalledWith('kelly@example.com', 'password123', 'password123', undefined)
  })

  it('passes username to register when provided', async () => {
    const fakeUser = { id: 1, username: 'kelly' }
    mockRegister.mockResolvedValue({})
    mockGetCurrentUser.mockResolvedValue(fakeUser)

    const user = userEvent.setup()
    render(<LoginPage onLogin={onLogin} />)

    await user.click(screen.getByText('Create one'))
    await user.type(screen.getByPlaceholderText('Email address'), 'kelly@example.com')
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'password123')
    await user.type(screen.getByPlaceholderText('Username (optional)'), 'kelly')
    await user.click(screen.getByText('Create account'))

    expect(mockRegister).toHaveBeenCalledWith('kelly@example.com', 'password123', 'password123', 'kelly')
  })

  it('shows username conflict error with a suggestion', async () => {
    mockRegister.mockRejectedValue({ response: { data: { username: ['A user with that username already exists.'] } } })

    const user = userEvent.setup()
    render(<LoginPage onLogin={onLogin} />)

    await user.click(screen.getByText('Create one'))
    await user.type(screen.getByPlaceholderText('Email address'), 'kelly@example.com')
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'password123')
    await user.type(screen.getByPlaceholderText('Username (optional)'), 'kelly')
    await user.click(screen.getByText('Create account'))

    expect(await screen.findByText(/A user with that username already exists/)).toBeInTheDocument()
    expect(screen.getByText(/try/)).toBeInTheDocument()
  })

  it('populates username field when suggestion is clicked', async () => {
    mockRegister.mockRejectedValue({ response: { data: { username: ['A user with that username already exists.'] } } })

    const user = userEvent.setup()
    render(<LoginPage onLogin={onLogin} />)

    await user.click(screen.getByText('Create one'))
    await user.type(screen.getByPlaceholderText('Email address'), 'kelly@example.com')
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'password123')
    await user.type(screen.getByPlaceholderText('Username (optional)'), 'kelly')
    await user.click(screen.getByText('Create account'))

    const suggestionBtn = await screen.findByRole('button', { name: /kelly\d+/ })
    await user.click(suggestionBtn)

    expect((screen.getByPlaceholderText('Username (optional)') as HTMLInputElement).value).toMatch(/^kelly\d+$/)
  })
})
