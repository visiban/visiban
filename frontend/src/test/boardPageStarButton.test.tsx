import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import App from '../App'
import type { User } from '../types'

// A dedicated test file (rather than adding to app.test.tsx) because that
// file's Navbar mock is a bare stub that drops the `breadcrumb` prop — its
// own comment says "Navbar is mocked so we can't check breadcrumb content
// directly". The board star button (#1193) rides in as `breadcrumb[].suffix`,
// so this file mocks Navbar just enough to render that prop instead.

vi.mock('../hooks/useAuth', () => ({
  useAuth: vi.fn(),
}))

vi.mock('../contexts/BoardContext', () => {
  const stubContext = {
    board: null, loading: true, error: null,
    moveCard: vi.fn(), forceMoveCard: vi.fn(), moveError: null, clearMoveError: vi.fn(),
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

vi.mock('../api/boards', () => ({
  starBoard: vi.fn().mockResolvedValue({}),
  unstarBoard: vi.fn().mockResolvedValue({}),
}))
vi.mock('../api/groups', () => ({
  joinGroup: vi.fn(),
}))

import { useAuth } from '../hooks/useAuth'
import { useBoardContext } from '../contexts/BoardContext'
import { starBoard, unstarBoard } from '../api/boards'

const mockUseAuth = useAuth as ReturnType<typeof vi.fn>
const mockUseBoardContext = useBoardContext as ReturnType<typeof vi.fn>
const mockStarBoard = starBoard as ReturnType<typeof vi.fn>
const mockUnstarBoard = unstarBoard as ReturnType<typeof vi.fn>

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

function renderBoardPage(user: User) {
  mockUseAuth.mockReturnValue({ user, loading: false, logout: vi.fn(), updateUser: vi.fn() })
  mockUseBoardContext.mockReturnValue({
    board: fakeBoard, loading: false, error: null,
    moveCard: vi.fn(), forceMoveCard: vi.fn(), moveError: null, clearMoveError: vi.fn(),
    updateBoardSettings: vi.fn(),
  })
  return render(<MemoryRouter initialEntries={['/boards/1']}><App /></MemoryRouter>)
}

describe('BoardPage star button — hosted demo (#1193)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('outside demo mode, stars and unstars normally', async () => {
    const user = userEvent.setup()
    renderBoardPage(fakeUser)
    const btn = screen.getByRole('button', { name: 'Star board' })
    expect(btn).not.toHaveAttribute('aria-disabled')
    await user.click(btn)
    expect(mockStarBoard).toHaveBeenCalledWith(1)
  })

  it('in demo mode, the star button is aria-disabled, keyboard-reachable, explains why, and never calls the API', async () => {
    const user = userEvent.setup()
    renderBoardPage({ ...fakeUser, demo_mode: true })
    const btn = screen.getByRole('button', { name: /Star board/ })
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    expect(btn).not.toBeDisabled()
    expect(btn).toHaveAccessibleName("Star board. This is a shared demo — boards can't be starred here.")
    btn.focus()
    expect(btn).toHaveFocus()
    await user.click(btn)
    expect(mockStarBoard).not.toHaveBeenCalled()
    expect(mockUnstarBoard).not.toHaveBeenCalled()
  })
})
