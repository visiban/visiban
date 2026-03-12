import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AppSidebar from '../components/Layout/AppSidebar'
import type { User, Group, Board } from '../types'

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, has_usable_password: true,
}

const fakeGroup: Group = {
  id: 10, name: 'Alpha', owner: fakeUser, parent: null, parent_name: null,
  member_count: 1, board_count: 1, subgroup_count: 0, created_at: '',
  default_board_member_role: 'member', allowed_priorities: [], shared_labels: [],
}

const fakeBoard: Board = {
  id: 42, name: 'Sprint Board', description: '', owner: fakeUser,
  group: 10, group_name: 'Alpha', member_count: 1, created_at: '', updated_at: '',
}

const personalBoard: Board = {
  id: 99, name: 'My Board', description: '', owner: fakeUser,
  group: null, group_name: null, member_count: 1, created_at: '', updated_at: '',
}

const mockUseLocation = vi.fn(() => ({ pathname: '/' }))
const mockNavigate = vi.fn()

vi.mock('react-router-dom', () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode; [k: string]: unknown }) =>
    <a href={to} {...props}>{children}</a>,
  useLocation: () => mockUseLocation(),
  useNavigate: () => mockNavigate,
}))

vi.mock('../api/groups', () => ({
  listGroups: vi.fn(),
}))
vi.mock('../api/boards', () => ({
  listBoards: vi.fn(),
  exportBoardCsv: vi.fn(),
  exportBoardJson: vi.fn(),
}))

import { listGroups } from '../api/groups'
import { listBoards } from '../api/boards'

describe('AppSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNavigate.mockReset()
    localStorage.clear()
    vi.mocked(listGroups).mockResolvedValue([fakeGroup])
    vi.mocked(listBoards).mockResolvedValue([fakeBoard, personalBoard])
  })

  it('renders the collapse toggle button', async () => {
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={fakeUser} />)
    expect(screen.getByTitle('Collapse sidebar')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())
  })

  it('shows group names after loading', async () => {
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
  })

  it('shows Personal section for ungrouped boards', async () => {
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument())
    expect(screen.getByText('My Board')).toBeInTheDocument()
  })

  it('expanding a group reveals its boards', async () => {
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByText('Alpha'))
    await userEvent.setup().click(screen.getByLabelText('Expand group'))
    expect(screen.getByText('Sprint Board')).toBeInTheDocument()
  })

  it('clicking group name collapses sidebar and navigates to group', async () => {
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByText('Alpha'))
    await userEvent.setup().click(screen.getByText('Alpha'))
    expect(mockNavigate).toHaveBeenCalledWith('/groups/10')
    expect(localStorage.getItem('sidebar-collapsed')).toBe('true')
  })

  it('clicking a board link collapses the sidebar', async () => {
    localStorage.setItem('sidebar-groups-expanded', JSON.stringify([10]))
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByText('Sprint Board'))
    await userEvent.setup().click(screen.getByText('Sprint Board'))
    expect(localStorage.getItem('sidebar-collapsed')).toBe('true')
  })

  it('collapses sidebar when toggle is clicked', async () => {
    render(<AppSidebar user={fakeUser} />)
    const toggle = screen.getByTitle('Collapse sidebar')
    await userEvent.setup().click(toggle)
    expect(localStorage.getItem('sidebar-collapsed')).toBe('true')
    expect(screen.getByTitle('Expand sidebar')).toBeInTheDocument()
  })

  it('restores collapsed state from localStorage', async () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={fakeUser} />)
    expect(screen.getByTitle('Expand sidebar')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('…')).not.toBeInTheDocument())
  })

  it('highlights active board by route', async () => {
    mockUseLocation.mockReturnValue({ pathname: '/boards/42' })
    localStorage.setItem('sidebar-groups-expanded', JSON.stringify([10]))
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByText('Sprint Board'))
    const link = screen.getByText('Sprint Board').closest('a')
    expect(link?.className).toMatch(/blue/)
  })

  it('persists group expanded state in localStorage', async () => {
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByText('Alpha'))
    await userEvent.setup().click(screen.getByLabelText('Expand group'))
    const stored = JSON.parse(localStorage.getItem('sidebar-groups-expanded') || '[]')
    expect(stored).toContain(10)
  })
})
