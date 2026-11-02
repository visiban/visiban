import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import App from '../App'
import type { User } from '../types'
import { useInstanceFlagsState } from '../hooks/useInstanceFlagsState'
import { DEFAULT_INSTANCE_FLAGS, type InstanceFlags } from '../contexts/InstanceFlagsContext'

// #1133 — the board health control rides in Row 1's breadcrumb suffix after
// the star, so this file reuses boardPageStarButton.test.tsx's harness: a
// Navbar stand-in that renders only `breadcrumb[].suffix`.

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

vi.mock('../api/boards', () => ({
  starBoard: vi.fn().mockResolvedValue({}),
  unstarBoard: vi.fn().mockResolvedValue({}),
  patchBoard: vi.fn(),
}))
vi.mock('../api/groups', () => ({
  joinGroup: vi.fn(),
}))

import { useAuth } from '../hooks/useAuth'
import { useBoardContext } from '../contexts/BoardContext'
import { patchBoard } from '../api/boards'

const mockUseAuth = useAuth as ReturnType<typeof vi.fn>
const mockUseBoardContext = useBoardContext as ReturnType<typeof vi.fn>
const mockPatchBoard = patchBoard as ReturnType<typeof vi.fn>

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
  health_status: null, effective_health_status: null, health_status_source: null,
}

const mockUseInstanceFlagsState = useInstanceFlagsState as ReturnType<typeof vi.fn>

const mergeBoardState = vi.fn()

function contextFor(board: object) {
  return {
    board, loading: false, error: null,
    moveCard: vi.fn(), forceMoveCard: vi.fn(), forceMoveCardTo: vi.fn(), moveError: null, clearMoveError: vi.fn(),
    updateBoardSettings: vi.fn(), mergeBoardState,
  }
}

function renderBoardPage(board: object = fakeBoard, flags: Partial<InstanceFlags> = {}) {
  mockUseInstanceFlagsState.mockReturnValue({ flags: { ...DEFAULT_INSTANCE_FLAGS, ...flags }, loaded: true })
  mockUseAuth.mockReturnValue({ user: fakeUser, loading: false, logout: vi.fn(), updateUser: vi.fn() })
  mockUseBoardContext.mockReturnValue(contextFor(board))
  return render(<MemoryRouter initialEntries={['/boards/1']}><App /></MemoryRouter>)
}

describe('BoardPage Row 1 health status (#1133)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('an admin gets the trigger after the star, collapsed to its shape below md', () => {
    renderBoardPage()
    const navbar = screen.getByTestId('navbar')
    const buttons = within(navbar).getAllByRole('button')
    expect(buttons[0]).toHaveAccessibleName('Star board')
    expect(buttons[1]).toHaveAccessibleName('Health status: No status')
    expect(within(buttons[1]).getByText('No status')).toHaveClass('sr-only', 'md:not-sr-only')
    expect(buttons[1]).toHaveClass('ml-2')
  })

  it('a non-admin with no status sees nothing, and a plain pill when one is inherited', () => {
    const viewer = { ...fakeBoard, current_user_role: 'viewer' as const }
    const { unmount } = renderBoardPage(viewer)
    expect(screen.queryByText('No status')).not.toBeInTheDocument()
    unmount()
    renderBoardPage({
      ...viewer, group: 4, group_name: 'Platform',
      effective_health_status: 'at_risk', health_status_source: { id: 4, name: 'Platform' },
    })
    expect(screen.queryByRole('button', { name: /^Health status/ })).not.toBeInTheDocument()
    expect(screen.getByTitle('Health status: At risk (inherited from Platform).')).toBeInTheDocument()
  })

  it('saves with patchBoard and merges the three fields from the response', async () => {
    const user = userEvent.setup()
    mockPatchBoard.mockResolvedValue({
      ...fakeBoard, health_status: 'off_track', effective_health_status: 'off_track', health_status_source: null,
    })
    renderBoardPage({ ...fakeBoard, group: 4, group_name: 'Platform' })
    await user.click(screen.getByRole('button', { name: /^Health status/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Health status for Sprint Board' })
    expect(within(dialog).getByText('No status set here or in a group above.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: /Off track/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockPatchBoard).toHaveBeenCalledWith(1, { health_status: 'off_track' }))
    expect(mergeBoardState).toHaveBeenCalledWith({
      health_status: 'off_track', effective_health_status: 'off_track', health_status_source: null,
    })
  })

  it('a merged board.updated changes the Row 1 pill', () => {
    const { rerender } = renderBoardPage()
    expect(screen.getByRole('button', { name: /^Health status/ })).toHaveAttribute('data-health-status', 'none')
    // BoardView merges board.updated into the context board (mergeBoardState).
    mockUseBoardContext.mockReturnValue(contextFor({
      ...fakeBoard, effective_health_status: 'off_track', health_status: 'off_track',
    }))
    rerender(<MemoryRouter initialEntries={['/boards/1']}><App /></MemoryRouter>)
    expect(screen.getByRole('button', { name: /^Health status/ })).toHaveAttribute('data-health-status', 'off_track')
  })
})
