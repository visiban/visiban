import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PersonalAccessToken, CreatedPersonalAccessToken } from '../types'

vi.mock('../api/auth', () => ({
  updateCurrentUser: vi.fn(),
  changePassword: vi.fn(),
  listTokens: vi.fn(),
  createToken: vi.fn(),
  revokeToken: vi.fn(),
}))

vi.mock('../api/boards', () => ({ getBoards: vi.fn(() => Promise.resolve([])) }))
vi.mock('../context/ThemeContext', () => ({
  useTheme: () => ({ preference: 'dark', setPreference: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}))

import { listTokens, createToken, revokeToken } from '../api/auth'
const mockListTokens = listTokens as ReturnType<typeof vi.fn>
const mockCreateToken = createToken as ReturnType<typeof vi.fn>
const mockRevokeToken = revokeToken as ReturnType<typeof vi.fn>

// We render AccessTokensTab by rendering SettingsPage with the tab active.
// It's simpler to test the tab in isolation by rendering it via SettingsPage.
// However the component is not exported directly, so we test it through the page.
// To avoid mounting the full page (Navbar etc.), we import and render the full page
// and switch to the access-tokens tab.

import { MemoryRouter } from 'react-router-dom'

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})
import SettingsPage from '../pages/SettingsPage'
import type { User } from '../types'

const fakeUser: User = {
  id: 1,
  username: 'alice',
  email: 'alice@example.com',
  first_name: 'Alice',
  last_name: 'Smith',
  avatar_url: '',
  display_name: 'Alice Smith',
  is_site_admin: false,
  must_change_password: false, must_change_username: false,
}

const token1: PersonalAccessToken = {
  id: 1,
  name: 'CI pipeline',
  prefix: 'vbn_1234',
  created_at: '2026-01-01T00:00:00Z',
  last_used_at: null,
  expires_at: null,
  scopes: ['read', 'write'],
}

const token2: PersonalAccessToken = {
  id: 2,
  name: 'Local dev',
  prefix: 'vbn_5678',
  created_at: '2026-01-02T00:00:00Z',
  last_used_at: null,
  expires_at: '2027-01-02T00:00:00Z',
  // Legacy token issued before #1110 — scopes is null, not [].
  scopes: null,
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SettingsPage user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />
    </MemoryRouter>
  )
}

async function switchToAccessTokensTab() {
  const tab = screen.getByRole('button', { name: 'Access Tokens' })
  await userEvent.click(tab)
}

describe('AccessTokensTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListTokens.mockResolvedValue([])
  })

  it('renders the tab navigation item', () => {
    renderPage()
    expect(screen.getByRole('button', { name: 'Access Tokens' })).toBeInTheDocument()
  })

  it('shows no-tokens message when list is empty', async () => {
    renderPage()
    await switchToAccessTokensTab()
    await waitFor(() => {
      expect(screen.getByTestId('no-tokens-message')).toBeInTheDocument()
    })
  })

  // #1374 — fetchTokens had no catch at all, so a failed load left the user
  // staring at "No access tokens yet." indistinguishable from a real empty list.
  it('shows an error instead of the empty-state message when loading tokens fails', async () => {
    mockListTokens.mockRejectedValue(new Error('network error'))
    renderPage()
    await switchToAccessTokensTab()
    await waitFor(() => {
      expect(screen.getByTestId('tokens-load-error')).toHaveTextContent('Failed to load access tokens.')
    })
    expect(screen.queryByTestId('no-tokens-message')).not.toBeInTheDocument()
  })

  it('renders existing tokens', async () => {
    mockListTokens.mockResolvedValue([token1, token2])
    renderPage()
    await switchToAccessTokensTab()
    await waitFor(() => {
      expect(screen.getByText('CI pipeline')).toBeInTheDocument()
      expect(screen.getByText('Local dev')).toBeInTheDocument()
    })
  })

  it('shows token prefix for each token', async () => {
    mockListTokens.mockResolvedValue([token1])
    renderPage()
    await switchToAccessTokensTab()
    await waitFor(() => {
      expect(screen.getByText('vbn_1234…')).toBeInTheDocument()
    })
  })

  it('creates a token and shows the one-time reveal panel', async () => {
    const created: CreatedPersonalAccessToken = {
      ...token1,
      token: 'vbn_1234abcd5678efgh9012ijkl3456mnop7890qrst',
    }
    mockCreateToken.mockResolvedValue(created)
    mockListTokens.mockResolvedValue([]).mockResolvedValueOnce([]).mockResolvedValue([token1])
    renderPage()
    await switchToAccessTokensTab()
    await waitFor(() => expect(screen.getByTestId('create-token-form')).toBeInTheDocument())

    await userEvent.type(screen.getByTestId('token-name-input'), 'CI pipeline', { delay: null })
    await userEvent.click(screen.getByTestId('create-token-button'))

    await waitFor(() => {
      expect(screen.getByTestId('new-token-reveal')).toBeInTheDocument()
      expect(screen.getByTestId('new-token-value')).toHaveTextContent(created.token)
    })
    expect(mockCreateToken).toHaveBeenCalledWith('CI pipeline', undefined)
  })

  it('dismisses the reveal panel when the user confirms copy', async () => {
    const created: CreatedPersonalAccessToken = {
      ...token1,
      token: 'vbn_1234abcd5678efgh9012ijkl3456mnop7890qrst',
    }
    mockCreateToken.mockResolvedValue(created)
    mockListTokens.mockResolvedValue([token1])
    renderPage()
    await switchToAccessTokensTab()
    await waitFor(() => expect(screen.getByTestId('create-token-form')).toBeInTheDocument())

    await userEvent.type(screen.getByTestId('token-name-input'), 'CI pipeline', { delay: null })
    await userEvent.click(screen.getByTestId('create-token-button'))
    await waitFor(() => expect(screen.getByTestId('new-token-reveal')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('dismiss-token'))
    expect(screen.queryByTestId('new-token-reveal')).not.toBeInTheDocument()
  })

  it('shows error when create fails', async () => {
    mockCreateToken.mockRejectedValue({ response: { data: { detail: 'Maximum tokens reached.' } } })
    renderPage()
    await switchToAccessTokensTab()
    await waitFor(() => expect(screen.getByTestId('create-token-form')).toBeInTheDocument())

    await userEvent.type(screen.getByTestId('token-name-input'), 'bad', { delay: null })
    await userEvent.click(screen.getByTestId('create-token-button'))

    await waitFor(() => {
      expect(screen.getByText('Maximum tokens reached.')).toBeInTheDocument()
    })
  })

  it('asks for confirmation before revoking a token', async () => {
    mockListTokens.mockResolvedValue([token1])
    renderPage()
    await switchToAccessTokensTab()
    await waitFor(() => expect(screen.getByTestId(`revoke-${token1.id}`)).toBeInTheDocument())

    await userEvent.click(screen.getByTestId(`revoke-${token1.id}`))
    expect(screen.getByTestId(`confirm-revoke-${token1.id}`)).toBeInTheDocument()
  })

  it('revokes a token after confirmation and removes it from list', async () => {
    mockListTokens.mockResolvedValue([token1])
    mockRevokeToken.mockResolvedValue(undefined)
    renderPage()
    await switchToAccessTokensTab()
    await waitFor(() => expect(screen.getByTestId(`revoke-${token1.id}`)).toBeInTheDocument())

    await userEvent.click(screen.getByTestId(`revoke-${token1.id}`))
    await userEvent.click(screen.getByTestId(`confirm-revoke-${token1.id}`))

    await waitFor(() => {
      expect(screen.queryByText('CI pipeline')).not.toBeInTheDocument()
    })
    expect(mockRevokeToken).toHaveBeenCalledWith(token1.id)
  })

  it('cancels revoke confirmation when Cancel is clicked', async () => {
    mockListTokens.mockResolvedValue([token1])
    renderPage()
    await switchToAccessTokensTab()
    await waitFor(() => expect(screen.getByTestId(`revoke-${token1.id}`)).toBeInTheDocument())

    await userEvent.click(screen.getByTestId(`revoke-${token1.id}`))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByTestId(`confirm-revoke-${token1.id}`)).not.toBeInTheDocument()
    expect(mockRevokeToken).not.toHaveBeenCalled()
  })

  it('shows max-tokens notice when at the limit', async () => {
    const tenTokens: PersonalAccessToken[] = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      name: `token-${i}`,
      prefix: `vbn_000${i}`,
      created_at: '2026-01-01T00:00:00Z',
      last_used_at: null,
      expires_at: null,
      scopes: ['read', 'write'],
    }))
    mockListTokens.mockResolvedValue(tenTokens)
    renderPage()
    await switchToAccessTokensTab()
    await waitFor(() => {
      expect(screen.getByTestId('max-tokens-notice')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('create-token-form')).not.toBeInTheDocument()
  })

  it('Escape cancels the revoke confirm without navigating away (#1238)', async () => {
    mockListTokens.mockResolvedValue([token1])
    renderPage()
    await switchToAccessTokensTab()
    await userEvent.click(await screen.findByRole('button', { name: `Revoke ${token1.name}` }))
    expect(screen.getByText(/Anything using this token will lose access/)).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText(/Anything using this token will lose access/)).not.toBeInTheDocument()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('keeps the confirm open and shows Revoking… while the request is in flight', async () => {
    mockListTokens.mockResolvedValue([token1])
    let resolveRevoke: () => void = () => {}
    mockRevokeToken.mockReturnValue(new Promise<void>((r) => { resolveRevoke = r }))
    renderPage()
    await switchToAccessTokensTab()
    await userEvent.click(await screen.findByRole('button', { name: `Revoke ${token1.name}` }))
    await userEvent.click(screen.getByTestId(`confirm-revoke-${token1.id}`))
    const confirm = screen.getByTestId(`confirm-revoke-${token1.id}`)
    expect(confirm).toHaveTextContent('Revoking…')
    expect(confirm).toBeDisabled()
    expect(screen.queryByTestId(`revoke-${token1.id}`)).not.toBeInTheDocument()
    resolveRevoke()
    await waitFor(() => expect(screen.queryByText('CI pipeline')).not.toBeInTheDocument())
  })

  it('shows an error and keeps the prompt open when revoke fails', async () => {
    mockListTokens.mockResolvedValue([token1])
    mockRevokeToken.mockRejectedValue(new Error('boom'))
    renderPage()
    await switchToAccessTokensTab()
    await userEvent.click(await screen.findByRole('button', { name: `Revoke ${token1.name}` }))
    await userEvent.click(screen.getByTestId(`confirm-revoke-${token1.id}`))
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to revoke token')
    expect(screen.getByTestId(`confirm-revoke-${token1.id}`)).not.toBeDisabled()
  })
})
