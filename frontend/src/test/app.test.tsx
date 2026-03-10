import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from '../App'
import type { User } from '../types'

vi.mock('../hooks/useAuth', () => ({
  useAuth: vi.fn(),
}))

vi.mock('../hooks/useBoard', () => ({
  useBoard: vi.fn().mockReturnValue({
    board: null, loading: true, error: null,
    moveCard: vi.fn(), addCard: vi.fn(), removeCard: vi.fn(),
    addColumn: vi.fn(), removeColumn: vi.fn(), addSwimlane: vi.fn(),
    updateCard: vi.fn(), updateColumn: vi.fn(), addLabel: vi.fn(),
    reorderColumns: vi.fn(), updateSwimlane: vi.fn(), removeSwimlane: vi.fn(),
  }),
}))

vi.mock('../components/Auth/LoginPage', () => ({
  default: ({ onLogin }: { onLogin: (u: User) => void }) => <div data-testid="login-page">Login</div>,
}))

vi.mock('../components/Auth/ForceChangePasswordModal', () => ({
  default: () => <div data-testid="force-password">Change Password</div>,
}))

vi.mock('../components/Layout/Navbar', () => ({
  default: () => <div data-testid="navbar">Navbar</div>,
}))

vi.mock('../components/Board/BoardView', () => ({
  default: () => <div data-testid="board-view">Board</div>,
}))

vi.mock('../pages/Dashboard', () => ({
  default: () => <div data-testid="dashboard">Dashboard</div>,
}))

vi.mock('../pages/GroupDetail', () => ({
  default: () => <div data-testid="group-detail">Group</div>,
}))

vi.mock('../pages/JoinPage', () => ({
  default: () => <div data-testid="join-page">Join</div>,
}))

import { useAuth } from '../hooks/useAuth'
const mockUseAuth = useAuth as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false,
}

describe('App', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows loading state', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: true, logout: vi.fn(), updateUser: vi.fn() })
    render(<MemoryRouter><App /></MemoryRouter>)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('shows login page when unauthenticated', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false, logout: vi.fn(), updateUser: vi.fn() })
    render(<MemoryRouter><App /></MemoryRouter>)
    expect(screen.getByTestId('login-page')).toBeInTheDocument()
  })

  it('shows dashboard when authenticated at /', () => {
    mockUseAuth.mockReturnValue({ user: fakeUser, loading: false, logout: vi.fn(), updateUser: vi.fn() })
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>)
    expect(screen.getByTestId('dashboard')).toBeInTheDocument()
  })

  it('shows join page accessible regardless of auth', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false, logout: vi.fn(), updateUser: vi.fn() })
    render(<MemoryRouter initialEntries={['/join/abc123']}><App /></MemoryRouter>)
    expect(screen.getByTestId('join-page')).toBeInTheDocument()
  })

  it('shows force change password modal when must_change_password', () => {
    mockUseAuth.mockReturnValue({
      user: { ...fakeUser, must_change_password: true },
      loading: false, logout: vi.fn(), updateUser: vi.fn(),
    })
    render(<MemoryRouter><App /></MemoryRouter>)
    expect(screen.getByTestId('force-password')).toBeInTheDocument()
  })

  it('redirects unknown paths to / when authenticated', () => {
    mockUseAuth.mockReturnValue({ user: fakeUser, loading: false, logout: vi.fn(), updateUser: vi.fn() })
    render(<MemoryRouter initialEntries={['/nonexistent']}><App /></MemoryRouter>)
    expect(screen.getByTestId('dashboard')).toBeInTheDocument()
  })
})
