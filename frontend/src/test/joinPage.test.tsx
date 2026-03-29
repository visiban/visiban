import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import JoinPage from '../pages/JoinPage'
import type { User } from '../types'

vi.mock('../api/groups', () => ({
  resolveJoinToken: vi.fn(),
  joinGroup: vi.fn(),
}))

vi.mock('../api/auth', () => ({
  getAuthProviders: vi.fn(),
}))

import { resolveJoinToken, joinGroup } from '../api/groups'
import { getAuthProviders } from '../api/auth'

const mockResolveJoinToken = resolveJoinToken as ReturnType<typeof vi.fn>
const mockJoinGroup = joinGroup as ReturnType<typeof vi.fn>
const mockGetAuthProviders = getAuthProviders as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1,
  username: 'jdoe',
  email: 'j@example.com',
  first_name: 'Jane',
  last_name: 'Doe',
  avatar_url: '',
  display_name: 'Jane Doe',
  is_site_admin: false,
  must_change_password: false,
}

function renderJoinPage(user: User | null = fakeUser, token = 'abc123') {
  return render(
    <MemoryRouter initialEntries={[`/join/${token}`]}>
      <Routes>
        <Route path="/join/:token" element={<JoinPage user={user} onLogin={vi.fn()} />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('JoinPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    mockGetAuthProviders.mockResolvedValue({ google: false, github: false, gitlab: false, oidc: false, oidc_name: null })
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  it('shows loading state initially', () => {
    mockResolveJoinToken.mockReturnValue(new Promise(() => {}))
    renderJoinPage()
    expect(screen.getByText('Checking invite…')).toBeInTheDocument()
  })

  it('shows invalid invite message on error', async () => {
    mockResolveJoinToken.mockRejectedValue(new Error('Not found'))
    renderJoinPage()
    expect(await screen.findByText('Invalid or expired invite link')).toBeInTheDocument()
  })

  it('auto-joins and shows spinner for authenticated user', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    mockJoinGroup.mockReturnValue(new Promise(() => {})) // keep pending so spinner stays
    renderJoinPage(fakeUser)
    expect(await screen.findByText('Joining Engineering…')).toBeInTheDocument()
  })

  it('shows group name in invite message', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    renderJoinPage(fakeUser)
    expect(await screen.findByText('Engineering')).toBeInTheDocument()
  })

  it('shows auth buttons and explanation for unauthenticated user', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    renderJoinPage(null)
    expect(await screen.findByText('Create an account')).toBeInTheDocument()
    expect(screen.getByText('Sign in')).toBeInTheDocument()
    expect(screen.getByText(/To accept this invitation you need a Visiban account/)).toBeInTheDocument()
  })

  it('does not show social login buttons when no providers are configured', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    mockGetAuthProviders.mockResolvedValue({ google: false, github: false, gitlab: false, oidc: false, oidc_name: null })
    renderJoinPage(null)
    await screen.findByText('Create an account')
    expect(screen.queryByText('Continue with Google')).not.toBeInTheDocument()
    expect(screen.queryByText('Continue with GitHub')).not.toBeInTheDocument()
    expect(screen.queryByText('Continue with GitLab')).not.toBeInTheDocument()
  })

  it('shows Google button when Google provider is configured', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    mockGetAuthProviders.mockResolvedValue({ google: true, github: false, gitlab: false, oidc: false, oidc_name: null })
    renderJoinPage(null)
    expect(await screen.findByText('Continue with Google')).toBeInTheDocument()
    expect(screen.queryByText('Continue with GitHub')).not.toBeInTheDocument()
  })

  it('shows GitHub and GitLab buttons when those providers are configured', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    mockGetAuthProviders.mockResolvedValue({ google: false, github: true, gitlab: true, oidc: false, oidc_name: null })
    renderJoinPage(null)
    expect(await screen.findByText('Continue with GitHub')).toBeInTheDocument()
    expect(screen.getByText('Continue with GitLab')).toBeInTheDocument()
  })

  it('does not fetch providers when user is authenticated', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    mockJoinGroup.mockReturnValue(new Promise(() => {}))
    renderJoinPage(fakeUser)
    await screen.findByText('Joining Engineering…')
    expect(mockGetAuthProviders).not.toHaveBeenCalled()
  })

  it('sets returnTo and pendingJoinToken in sessionStorage when redirecting to register', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    renderJoinPage(null)
    fireEvent.click(await screen.findByText('Create an account'))
    expect(sessionStorage.getItem('returnTo')).toBe('/join/abc123')
    expect(sessionStorage.getItem('pendingJoinToken')).toBe('abc123')
  })

  it('sets returnTo and pendingJoinToken in sessionStorage when redirecting to sign in', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    renderJoinPage(null)
    fireEvent.click(await screen.findByText('Sign in'))
    expect(sessionStorage.getItem('returnTo')).toBe('/join/abc123')
    expect(sessionStorage.getItem('pendingJoinToken')).toBe('abc123')
  })

  it('shows countdown redirect on invalid invite', async () => {
    mockResolveJoinToken.mockRejectedValue(new Error('Not found'))
    renderJoinPage(fakeUser)
    expect(await screen.findByText(/Redirecting to dashboard in/)).toBeInTheDocument()
  })

  it('auto-joins and navigates to group page on success', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 42, group_name: 'Engineering' })
    mockJoinGroup.mockResolvedValue({ id: 42, name: 'Engineering' })
    render(
      <MemoryRouter initialEntries={['/join/abc123']}>
        <Routes>
          <Route path="/join/:token" element={<JoinPage user={fakeUser} onLogin={vi.fn()} />} />
          <Route path="/groups/:id" element={<div data-testid="group-page" />} />
        </Routes>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByTestId('group-page')).toBeInTheDocument())
    expect(mockJoinGroup).toHaveBeenCalledWith('abc123')
  })

  it('shows error and Try again button when auto-join fails', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    mockJoinGroup.mockRejectedValue(new Error('Gone'))
    renderJoinPage(fakeUser)
    expect(await screen.findByText('Failed to join group. The invite may have expired.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('shows SSO button when oidc provider is enabled', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    mockGetAuthProviders.mockResolvedValue({ google: false, github: false, gitlab: false, oidc: true, oidc_name: null })
    renderJoinPage(null)
    expect(await screen.findByText('Continue with SSO')).toBeInTheDocument()
  })

  it('shows OIDC provider name when oidc_name is set', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    mockGetAuthProviders.mockResolvedValue({ google: false, github: false, gitlab: false, oidc: true, oidc_name: 'Acme Corp' })
    renderJoinPage(null)
    expect(await screen.findByText('Continue with Acme Corp')).toBeInTheDocument()
  })
})
