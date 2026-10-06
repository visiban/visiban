import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import JoinPage from '../pages/JoinPage'
import type { User } from '../types'

vi.mock('../api/groups', () => ({
  resolveJoinToken: vi.fn(),
  joinGroup: vi.fn(),
}))

vi.mock('../api/auth', () => ({
  getAuthProviders: vi.fn(),
}))

vi.mock('../api/boards', () => ({
  resolveBoardJoinToken: vi.fn(),
  joinBoard: vi.fn(),
}))

import { resolveJoinToken, joinGroup } from '../api/groups'
import { getAuthProviders } from '../api/auth'
import { resolveBoardJoinToken, joinBoard } from '../api/boards'

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
  must_change_password: false, must_change_username: false,
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

  it('shows "already used" message when token returns 410', async () => {
    const err = Object.assign(new Error('Gone'), { response: { status: 410 } })
    mockResolveJoinToken.mockRejectedValue(err)
    renderJoinPage()
    expect(await screen.findByText('This link has already been used')).toBeInTheDocument()
    expect(screen.getByText(/single-use invite link/)).toBeInTheDocument()
  })

  it('shows generic error (not "already used") for non-410 failures', async () => {
    const err = Object.assign(new Error('Not Found'), { response: { status: 404 } })
    mockResolveJoinToken.mockRejectedValue(err)
    renderJoinPage()
    expect(await screen.findByText('Invalid or expired invite link')).toBeInTheDocument()
    expect(screen.queryByText('This link has already been used')).not.toBeInTheDocument()
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

  it('redirects to / with register authMode for a site invite token (#1374)', async () => {
    render(
      <MemoryRouter initialEntries={['/join/vbnl_abc123']}>
        <Routes>
          <Route path="/join/:token" element={<JoinPage user={null} onLogin={vi.fn()} />} />
          <Route path="/" element={<div data-testid="home-page" />} />
        </Routes>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByTestId('home-page')).toBeInTheDocument())
    expect(sessionStorage.getItem('invite_token')).toBe('vbnl_abc123')
    expect(mockResolveJoinToken).not.toHaveBeenCalled()
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

  it('hands the group invite to the registration form as invite_token (#1445)', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    renderJoinPage(null, 'vbng_emailed')
    fireEvent.click(await screen.findByText('Create an account'))
    expect(sessionStorage.getItem('invite_token')).toBe('vbng_emailed')
  })

  it('does not set invite_token when signing in to an existing account (#1445)', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    renderJoinPage(null, 'vbng_emailed')
    fireEvent.click(await screen.findByText('Sign in'))
    expect(sessionStorage.getItem('invite_token')).toBeNull()
  })

  it('passes the group invite to the OAuth login URL (#1445)', async () => {
    const original = window.location
    Object.defineProperty(window, 'location', { value: { ...original, href: '' }, writable: true, configurable: true })
    try {
      mockGetAuthProviders.mockResolvedValue({ google: true, github: false, gitlab: false, oidc: false, oidc_name: null })
      mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
      renderJoinPage(null, 'vbng_emailed')
      fireEvent.click(await screen.findByText('Continue with Google'))
      expect(window.location.href).toMatch(/\/accounts\/google\/login\/\?process=login&invite_token=vbng_emailed$/)
      expect(sessionStorage.getItem('pendingJoinToken')).toBe('vbng_emailed')
    } finally {
      Object.defineProperty(window, 'location', { value: original, writable: true, configurable: true })
    }
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

describe('JoinPage — can_register preview (#1481)', () => {
  const BLOCKED_COPY = "This invite link can't be used to create a new account. Sign in with an existing account to join."

  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    mockGetAuthProviders.mockResolvedValue({ google: false, github: false, gitlab: false, oidc: false, oidc_name: null })
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  function HomeProbe() {
    const location = useLocation()
    return <div data-testid="home-page">{(location.state as { authMode?: string } | null)?.authMode}</div>
  }

  it('shows the sign-in-only view to an anonymous visitor when the link cannot register', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering', role: 'viewer', can_register: false })
    renderJoinPage(null)
    expect(await screen.findByText(BLOCKED_COPY)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: "You're invited" })).toBeInTheDocument()
    expect(screen.getByText('Engineering')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in to join Engineering' })).toBeInTheDocument()
    expect(screen.queryByText('Create an account')).not.toBeInTheDocument()
    expect(screen.queryByText('already have an account?')).not.toBeInTheDocument()
    expect(screen.queryByText(/To accept this invitation you need a Visiban account/)).not.toBeInTheDocument()
  })

  it('Sign in stores the join return path, navigates to login, and sets no invite_token', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering', can_register: false })
    render(
      <MemoryRouter initialEntries={['/join/vbng_shared']}>
        <Routes>
          <Route path="/join/:token" element={<JoinPage user={null} onLogin={vi.fn()} />} />
          <Route path="/" element={<HomeProbe />} />
        </Routes>
      </MemoryRouter>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to join Engineering' }))
    expect(await screen.findByTestId('home-page')).toHaveTextContent('login')
    expect(sessionStorage.getItem('returnTo')).toBe('/join/vbng_shared')
    expect(sessionStorage.getItem('pendingJoinToken')).toBe('vbng_shared')
    expect(sessionStorage.getItem('invite_token')).toBeNull()
  })

  it('keeps the original layout when can_register is true', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering', can_register: true })
    renderJoinPage(null)
    expect(await screen.findByText('Create an account')).toBeInTheDocument()
    expect(screen.getByText('already have an account?')).toBeInTheDocument()
    expect(screen.getByText(/To accept this invitation you need a Visiban account/)).toBeInTheDocument()
    expect(screen.queryByText(BLOCKED_COPY)).not.toBeInTheDocument()
  })

  it('keeps the original layout when can_register is absent (older backend)', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    renderJoinPage(null)
    expect(await screen.findByText('Create an account')).toBeInTheDocument()
    expect(screen.getByText('already have an account?')).toBeInTheDocument()
    expect(screen.queryByText(BLOCKED_COPY)).not.toBeInTheDocument()
  })

  it('keeps the original layout when can_register is null', async () => {
    mockResolveJoinToken.mockResolvedValue({
      group_id: 1,
      group_name: 'Engineering',
      can_register: null as unknown as boolean,
    })
    renderJoinPage(null)
    expect(await screen.findByText('Create an account')).toBeInTheDocument()
    expect(screen.getByText('already have an account?')).toBeInTheDocument()
    expect(screen.queryByText(BLOCKED_COPY)).not.toBeInTheDocument()
  })

  it('still auto-joins a signed-in user when can_register is false', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering', can_register: false })
    mockJoinGroup.mockReturnValue(new Promise(() => {}))
    renderJoinPage(fakeUser)
    expect(await screen.findByText('Joining Engineering…')).toBeInTheDocument()
    expect(mockJoinGroup).toHaveBeenCalledWith('abc123')
    expect(screen.queryByText(BLOCKED_COPY)).not.toBeInTheDocument()
  })

  it('keeps the OAuth buttons below Sign in when can_register is false', async () => {
    mockGetAuthProviders.mockResolvedValue({ google: true, github: false, gitlab: false, oidc: false, oidc_name: null })
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering', can_register: false })
    renderJoinPage(null)
    const google = await screen.findByText('Continue with Google')
    const signIn = screen.getByRole('button', { name: 'Sign in to join Engineering' })
    expect(screen.getByText('or continue with')).toBeInTheDocument()
    expect(signIn.compareDocumentPosition(google) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('still shows the invalid-link message on a 410', async () => {
    const err = Object.assign(new Error('Gone'), { response: { status: 410 } })
    mockResolveJoinToken.mockRejectedValue(err)
    renderJoinPage(null)
    expect(await screen.findByText('This link has already been used')).toBeInTheDocument()
    expect(screen.queryByText(BLOCKED_COPY)).not.toBeInTheDocument()
  })
})

describe('JoinPage — board invites (vbnb_, #1444)', () => {
  const TOKEN = 'vbnb_abc123'
  const mockResolveBoard = resolveBoardJoinToken as ReturnType<typeof vi.fn>
  const mockJoinBoard = joinBoard as ReturnType<typeof vi.fn>
  const preview = { board_id: 7, board_name: 'Launch Plan', role: 'collaborator', can_register: true }

  function gone(code: string) {
    return Object.assign(new Error('Gone'), { response: { status: 410, data: { code } } })
  }

  function BoardProbe() {
    const location = useLocation()
    return <div data-testid="board-page">{JSON.stringify(location.state)}</div>
  }

  function renderBoardJoin(user: User | null) {
    return render(
      <MemoryRouter initialEntries={[`/join/${TOKEN}`]}>
        <Routes>
          <Route path="/join/:token" element={<JoinPage user={user} onLogin={vi.fn()} />} />
          <Route path="/boards/:id" element={<BoardProbe />} />
        </Routes>
      </MemoryRouter>
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    mockGetAuthProviders.mockResolvedValue({ google: false, github: false, gitlab: false, oidc: false, oidc_name: null })
  })

  afterEach(() => { sessionStorage.clear() })

  it('previews through the board API with the role and its capability line', async () => {
    mockResolveBoard.mockResolvedValue(preview)
    renderBoardJoin(null)
    expect(await screen.findByText('Launch Plan')).toHaveClass('break-words')
    expect(screen.getByText(/as a collaborator/)).toBeInTheDocument()
    expect(screen.getByText("You'll be able to comment and upload files.")).toHaveClass('text-xs', 'text-fg-muted', 'mt-1')
    expect(mockResolveBoard).toHaveBeenCalledWith(TOKEN)
    expect(mockResolveJoinToken).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Create an account' })).toBeInTheDocument()
  })

  it.each([
    ['member', "You'll be able to create, edit, and move cards."],
    ['viewer', "You'll be able to view the board."],
  ])('capability line for %s', async (role, line) => {
    mockResolveBoard.mockResolvedValue({ ...preview, role })
    renderBoardJoin(null)
    expect(await screen.findByText(line)).toBeInTheDocument()
  })

  it('signed out and cannot register: the sign-in-only view names the board', async () => {
    mockResolveBoard.mockResolvedValue({ ...preview, can_register: false })
    renderBoardJoin(null)
    expect(await screen.findByRole('button', { name: 'Sign in to join Launch Plan' })).toBeInTheDocument()
    expect(screen.queryByText('Create an account')).not.toBeInTheDocument()
  })

  it('signed in: joins and navigates to the board with the joined state', async () => {
    mockResolveBoard.mockResolvedValue(preview)
    mockJoinBoard.mockResolvedValue({ board_id: 7, board_name: 'Launch Plan', role: 'collaborator', created: true })
    renderBoardJoin(fakeUser)
    const page = await screen.findByTestId('board-page')
    expect(JSON.parse(page.textContent ?? 'null')).toEqual({ joinedBoard: 'Launch Plan', joinedRole: 'collaborator', created: true })
    expect(mockJoinBoard).toHaveBeenCalledWith(TOKEN)
    expect(mockJoinGroup).not.toHaveBeenCalled()
  })

  it('signed in: shows "Joining …" while the join is in flight', async () => {
    mockResolveBoard.mockResolvedValue(preview)
    mockJoinBoard.mockReturnValue(new Promise(() => {}))
    renderBoardJoin(fakeUser)
    expect(await screen.findByText('Joining Launch Plan…')).toBeInTheDocument()
  })

  it.each([
    ['used', 'This invite has already been used', 'Invites are single-use. Ask a board admin to send you a new one.', 'text-fg-tertiary'],
    ['expired', 'This invite has expired', 'Ask a board admin for a new invite.', 'text-danger'],
    ['revoked', 'This invite is no longer valid', 'It may have been revoked. Ask a board admin for a new one.', 'text-danger'],
  ])('preview 410 %s shows its own message and focuses the title', async (code, title, body, tone) => {
    mockResolveBoard.mockRejectedValue(gone(code))
    renderBoardJoin(null)
    const heading = await screen.findByText(title)
    expect(heading).toHaveClass(tone)
    expect(screen.getByText(body)).toBeInTheDocument()
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.getByText(/Redirecting to dashboard in/)).toBeInTheDocument()
  })

  it('an unknown token (404) reads as no longer valid', async () => {
    mockResolveBoard.mockRejectedValue(Object.assign(new Error('nf'), { response: { status: 404 } }))
    renderBoardJoin(null)
    expect(await screen.findByText('This invite is no longer valid')).toBeInTheDocument()
  })

  it('join failure shows the error with Try again; a 410 on retry switches to the invalid view', async () => {
    mockResolveBoard.mockResolvedValue(preview)
    mockJoinBoard.mockRejectedValueOnce(new Error('network'))
    renderBoardJoin(fakeUser)
    expect(await screen.findByText("Couldn't join Launch Plan. The invite may have expired or been used.")).toHaveClass('text-danger')
    await waitFor(() => expect(screen.getByRole('heading', { name: "You're invited" })).toHaveFocus())
    mockJoinBoard.mockRejectedValueOnce(gone('used'))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('This invite has already been used')).toBeInTheDocument()
  })

  it('Try again can succeed', async () => {
    mockResolveBoard.mockResolvedValue(preview)
    mockJoinBoard
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ board_id: 7, board_name: 'Launch Plan', role: 'collaborator', created: false })
    renderBoardJoin(fakeUser)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('board-page')).toHaveTextContent('"created":false')
  })

  it('a 410 on the first join goes straight to the invalid view', async () => {
    mockResolveBoard.mockResolvedValue(preview)
    mockJoinBoard.mockRejectedValue(gone('expired'))
    renderBoardJoin(fakeUser)
    expect(await screen.findByText('This invite has expired')).toBeInTheDocument()
  })

  it('register hands the board invite to the registration form', async () => {
    mockResolveBoard.mockResolvedValue(preview)
    renderBoardJoin(null)
    fireEvent.click(await screen.findByRole('button', { name: 'Create an account' }))
    expect(sessionStorage.getItem('invite_token')).toBe(TOKEN)
    expect(sessionStorage.getItem('pendingJoinToken')).toBe(TOKEN)
    expect(sessionStorage.getItem('returnTo')).toBe(`/join/${TOKEN}`)
  })
})
