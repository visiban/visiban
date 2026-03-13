import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import JoinPage from '../pages/JoinPage'
import type { User } from '../types'

vi.mock('../api/groups', () => ({
  resolveJoinToken: vi.fn(),
  joinGroup: vi.fn(),
}))

import { resolveJoinToken, joinGroup } from '../api/groups'

const mockResolveJoinToken = resolveJoinToken as ReturnType<typeof vi.fn>
const mockJoinGroup = joinGroup as ReturnType<typeof vi.fn>

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

  it('shows join button for authenticated user', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    renderJoinPage(fakeUser)
    expect(await screen.findByText('Join Engineering')).toBeInTheDocument()
  })

  it('shows group name in invite message', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    renderJoinPage(fakeUser)
    expect(await screen.findByText('Engineering')).toBeInTheDocument()
  })

  it('shows auth buttons for unauthenticated user', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    renderJoinPage(null)
    expect(await screen.findByText('Create account to join')).toBeInTheDocument()
    expect(screen.getByText('Sign in to join')).toBeInTheDocument()
  })

  it('shows dashboard link on invalid invite for authenticated user', async () => {
    mockResolveJoinToken.mockRejectedValue(new Error('Not found'))
    renderJoinPage(fakeUser)
    expect(await screen.findByText('Go to dashboard')).toBeInTheDocument()
  })

  it('navigates to group page with joinedGroup state on successful join', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 42, group_name: 'Engineering' })
    mockJoinGroup.mockResolvedValue({})
    const navigated: { to: string; state: unknown }[] = []
    render(
      <MemoryRouter initialEntries={['/join/abc123']}>
        <Routes>
          <Route path="/join/:token" element={<JoinPage user={fakeUser} onLogin={vi.fn()} />} />
          <Route path="/groups/:id" element={<div data-testid="group-page" />} />
        </Routes>
      </MemoryRouter>
    )
    fireEvent.click(await screen.findByText('Join Engineering'))
    await waitFor(() => expect(screen.getByTestId('group-page')).toBeInTheDocument())
    expect(mockJoinGroup).toHaveBeenCalledWith('abc123')
  })

  it('shows error message when join fails', async () => {
    mockResolveJoinToken.mockResolvedValue({ group_id: 1, group_name: 'Engineering' })
    mockJoinGroup.mockRejectedValue(new Error('Gone'))
    renderJoinPage(fakeUser)
    fireEvent.click(await screen.findByText('Join Engineering'))
    expect(await screen.findByText('Failed to join group. The invite may have expired.')).toBeInTheDocument()
  })
})
