import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from '../App'
import type { User } from '../types'
import { useInstanceFlagsState } from '../hooks/useInstanceFlagsState'
import { DEFAULT_INSTANCE_FLAGS } from '../contexts/InstanceFlagsContext'

// BoardPage swaps to the shared unavailable page on 404/403 (#2041). Own file
// so the Navbar mock can stay minimal.

vi.mock('../hooks/useAuth', () => ({
  useAuth: vi.fn(),
}))

vi.mock('../hooks/useInstanceFlagsState', () => ({
  useInstanceFlagsState: vi.fn(),
}))

vi.mock('../contexts/BoardContext', () => {
  const stubContext = {
    board: null, loading: true, error: null,
    moveCard: vi.fn(), forceMoveCard: vi.fn(), forceMoveCardTo: vi.fn(), moveError: null, clearMoveError: vi.fn(),
    addCard: vi.fn(), removeCard: vi.fn(),
    addColumn: vi.fn(), removeColumn: vi.fn(), addSwimlane: vi.fn(),
    updateCard: vi.fn(), updateColumn: vi.fn(), addLabel: vi.fn(),
    updateLabel: vi.fn(), removeLabel: vi.fn(),
    addMember: vi.fn(), updateMember: vi.fn(), removeMember: vi.fn(),
    applyColumnOrder: vi.fn(), applySwimlaneOrder: vi.fn(),
    reorderColumns: vi.fn(), reorderSwimlanes: vi.fn(),
    updateSwimlane: vi.fn(), removeSwimlane: vi.fn(),
    updateBoardSettings: vi.fn(), reload: vi.fn(),
  };
  return {
    BoardProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useBoardContext: vi.fn().mockReturnValue(stubContext),
    useOptionalBoardContext: vi.fn().mockReturnValue(null),
  };
})

vi.mock('../components/Auth/LoginPage', () => ({
  default: () => <div data-testid="login-page">Login</div>,
}))
vi.mock('../components/Auth/ForceChangePasswordModal', () => ({
  default: () => <div data-testid="force-password">Change Password</div>,
}))
vi.mock('../components/Auth/ForceRenameUsernameModal', () => ({
  default: () => <div data-testid="force-username">Choose Username</div>,
}))

// Minimal stand-in: renders only the breadcrumb suffix (the star button) so
// this file can assert on it, matching Navbar's real prop shape.
vi.mock('../components/Layout/Navbar', () => ({
  default: ({ breadcrumb }: { breadcrumb?: { suffix?: React.ReactNode }[] }) => (
    <div data-testid="navbar">{breadcrumb?.map((b, i) => <React.Fragment key={i}>{b.suffix}</React.Fragment>)}</div>
  ),
}))

vi.mock('../components/Layout/AppSidebar', () => ({
  default: () => <div data-testid="sidebar" />,
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
vi.mock('../pages/SettingsPage', () => ({
  default: () => <div data-testid="settings-page">Settings</div>,
}))
vi.mock('../pages/AdminPage', () => ({
  default: () => <div data-testid="admin-page">Admin</div>,
}))

vi.mock('../api/groups', () => ({
  joinGroup: vi.fn(),
}))

import { useAuth } from '../hooks/useAuth'
import { useBoardContext } from '../contexts/BoardContext'

const mockUseAuth = useAuth as ReturnType<typeof vi.fn>
const mockUseBoardContext = useBoardContext as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false,
}

const fakeBoard = {
  id: 1, name: 'Sprint Board', description: '', group: null, group_name: null,
  columns: [], swimlanes: [], cards: [], labels: [], members: [],
  created_at: '', updated_at: '', current_user_role: 'admin' as const,
  is_starred: false,
}

const mockUseInstanceFlagsState = useInstanceFlagsState as ReturnType<typeof vi.fn>

function renderBoardPage(ctx: Record<string, unknown>) {
  mockUseInstanceFlagsState.mockReturnValue({ flags: { ...DEFAULT_INSTANCE_FLAGS }, loaded: true })
  mockUseAuth.mockReturnValue({ user: fakeUser, loading: false, logout: vi.fn(), updateUser: vi.fn() })
  mockUseBoardContext.mockReturnValue({
    board: null, loading: false, error: null,
    moveCard: vi.fn(), forceMoveCard: vi.fn(), forceMoveCardTo: vi.fn(), moveError: null, clearMoveError: vi.fn(),
    updateBoardSettings: vi.fn(),
    ...ctx,
  })
  return render(<MemoryRouter initialEntries={['/boards/1']}><App /></MemoryRouter>)
}

describe('BoardPage unavailable state (#2041)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the unavailable page instead of redirecting when the board is gone', () => {
    renderBoardPage({ unavailable: true })
    const h1 = screen.getByRole('heading', { level: 1, name: "This board isn't available" })
    expect(h1).toHaveFocus()
    expect(document.title).toBe('Not available – Visiban')
    expect(screen.getByText(/It may have been deleted, or you may not have access to it/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute('href', '/')
    expect(screen.queryByTestId('board-view')).toBeNull()
    expect(screen.queryByTestId('dashboard')).toBeNull()
  })

  it('swaps a loaded board for the same page when access is lost mid-session', () => {
    const { rerender } = renderBoardPage({ board: fakeBoard })
    expect(screen.getByTestId('board-view')).toBeInTheDocument()
    mockUseBoardContext.mockReturnValue({
      board: fakeBoard, loading: false, error: null, unavailable: true,
      moveCard: vi.fn(), forceMoveCard: vi.fn(), forceMoveCardTo: vi.fn(), moveError: null, clearMoveError: vi.fn(),
      updateBoardSettings: vi.fn(),
    })
    rerender(<MemoryRouter initialEntries={['/boards/1']}><App /></MemoryRouter>)
    expect(screen.getByRole('heading', { level: 1, name: "This board isn't available" })).toBeInTheDocument()
    expect(screen.queryByTestId('board-view')).toBeNull()
  })

  it('keeps the existing Failed to load error for other failures', () => {
    renderBoardPage({ error: 'Failed to load board' })
    expect(screen.getByText('Failed to load board')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /isn't available/ })).toBeNull()
  })
})
