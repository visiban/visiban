import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AppSidebar from '../components/Layout/AppSidebar'
import type { User, Group, Board } from '../types'

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false, has_usable_password: true,
}

const fakeGroup: Group = {
  id: 10, name: 'Alpha', description: '', owner: fakeUser, parent: null, parent_name: null,
  member_count: 1, board_count: 1, subgroup_count: 0, created_at: '',
  default_board_member_role: 'member', allowed_priorities: [], shared_labels: [],
  is_starred: false,
}

const fakeBoard: Board = {
  id: 42, uid: 'boarduid0001', name: 'Sprint Board', description: '', owner: fakeUser,
  group: 10, group_name: 'Alpha', member_count: 1, card_count: 0,
  staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [], enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false,
  is_starred: false, created_at: '', updated_at: '',
}

const personalBoard: Board = {
  id: 99, uid: 'boarduid0002', name: 'My Board', description: '', owner: fakeUser,
  group: null, group_name: null, member_count: 1, card_count: 0,
  staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [], enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false,
  is_starred: false, created_at: '', updated_at: '',
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
  listStarredGroups: vi.fn(),
}))
vi.mock('../api/boards', () => ({
  listBoards: vi.fn(),
  listStarredBoards: vi.fn(),
  exportBoardCsv: vi.fn(),
  exportBoardJson: vi.fn(),
  createBoard: vi.fn(),
  listBoardTemplates: vi.fn().mockResolvedValue([]),
}))

vi.mock('../components/Board/CreateBoardModal', () => ({
  default: ({ onConfirm, onCancel }: { onConfirm: (n: string, t: string, s: string, d: boolean) => void; onCancel: () => void }) => (
    <div data-testid="create-board-modal">
      <button onClick={() => onConfirm('New Board', 'simple_kanban', '', false)}>Confirm create board</button>
      <button onClick={onCancel}>Cancel create board</button>
    </div>
  ),
}))

vi.mock('../components/Group/CreateGroupModal', () => ({
  default: ({ onCreated, onClose }: { onCreated: (g: Group) => void; onClose: () => void }) => (
    <div data-testid="create-group-modal">
      <button onClick={() => onCreated({ ...fakeGroup, id: 99, name: 'New Group' })}>Confirm create group</button>
      <button onClick={onClose}>Cancel create group</button>
    </div>
  ),
}))

import { listGroups, listStarredGroups } from '../api/groups'
import { listBoards, listStarredBoards, createBoard } from '../api/boards'

describe('AppSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNavigate.mockReset()
    localStorage.clear()
    vi.mocked(listGroups).mockResolvedValue([fakeGroup])
    vi.mocked(listStarredGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([fakeBoard, personalBoard])
    vi.mocked(listStarredBoards).mockResolvedValue([])
  })

  it('renders the collapse toggle button', async () => {
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={fakeUser} />)
    expect(screen.getByTitle('Collapse sidebar')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument())
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
    expect(link?.className).toMatch(/info/)
  })

  it('renders Dashboard link', async () => {
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={fakeUser} />)
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    const homeLink = screen.getByText('Dashboard').closest('a')
    expect(homeLink?.getAttribute('href')).toBe('/')
  })

  it('highlights Dashboard link when at root path', async () => {
    mockUseLocation.mockReturnValue({ pathname: '/' })
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={fakeUser} />)
    const homeLink = screen.getByText('Dashboard').closest('a')
    expect(homeLink?.className).toMatch(/info/)
  })

  it('shows Dashboard icon in collapsed mode', async () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={fakeUser} />)
    expect(screen.getByTitle('Dashboard')).toBeInTheDocument()
  })

  it('does not show Site Admin link for non-admin users', async () => {
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument())
    expect(screen.queryByText('Site Admin')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Site Admin')).not.toBeInTheDocument()
  })

  it('shows Site Admin link for site admin users', async () => {
    const adminUser: typeof fakeUser = { ...fakeUser, is_site_admin: true }
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={adminUser} />)
    await waitFor(() => expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument())
    const link = screen.getByText('Site Admin').closest('a')
    expect(link?.getAttribute('href')).toBe('/admin')
  })

  it('shows Site Admin icon in collapsed mode for site admins', async () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    const adminUser: typeof fakeUser = { ...fakeUser, is_site_admin: true }
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={adminUser} />)
    const link = screen.getByTitle('Site Admin').closest('a')
    expect(link?.getAttribute('href')).toBe('/admin')
  })

  // ── Collapsed flyout tests ─────────────────────────────────────────────────

  it('shows Favorites trigger button in collapsed mode when starred boards exist', async () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    const starredBoard: Board = { ...fakeBoard, id: 77, name: 'Starred One', is_starred: true }
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    vi.mocked(listStarredBoards).mockResolvedValue([starredBoard])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.getByTitle('Favorites')).toBeInTheDocument())
    expect(screen.queryByTitle('Starred One')).not.toBeInTheDocument()
  })

  it('clicking Favorites trigger opens flyout listing starred boards', async () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    const starredBoard: Board = { ...fakeBoard, id: 77, name: 'Starred One', is_starred: true }
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    vi.mocked(listStarredBoards).mockResolvedValue([starredBoard])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByTitle('Favorites'))
    await userEvent.setup().click(screen.getByTitle('Favorites'))
    const flyout = screen.getByTestId('collapsed-flyout')
    expect(flyout).toBeInTheDocument()
    expect(screen.getByText('Starred One')).toBeInTheDocument()
    const link = screen.getByText('Starred One').closest('a')
    expect(link?.getAttribute('href')).toBe('/boards/77')
  })

  it('clicking Favorites trigger again closes the flyout', async () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    const starredBoard: Board = { ...fakeBoard, id: 77, name: 'Starred One', is_starred: true }
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    vi.mocked(listStarredBoards).mockResolvedValue([starredBoard])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByTitle('Favorites'))
    const user = userEvent.setup()
    await user.click(screen.getByTitle('Favorites'))
    expect(screen.getByTestId('collapsed-flyout')).toBeInTheDocument()
    await user.click(screen.getByTitle('Favorites'))
    expect(screen.queryByTestId('collapsed-flyout')).not.toBeInTheDocument()
  })

  it('Favorites flyout closes on Escape key', async () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    const starredBoard: Board = { ...fakeBoard, id: 77, name: 'Starred One', is_starred: true }
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    vi.mocked(listStarredBoards).mockResolvedValue([starredBoard])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByTitle('Favorites'))
    const user = userEvent.setup()
    await user.click(screen.getByTitle('Favorites'))
    expect(screen.getByTestId('collapsed-flyout')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('collapsed-flyout')).not.toBeInTheDocument()
  })

  it('Favorites flyout includes starred groups in a separate section', async () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    const starredBoard: Board = { ...fakeBoard, id: 77, name: 'Star Board', is_starred: true }
    const starredGroup: Group = { ...fakeGroup, id: 55, name: 'Star Group', is_starred: true }
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    vi.mocked(listStarredBoards).mockResolvedValue([starredBoard])
    vi.mocked(listStarredGroups).mockResolvedValue([starredGroup])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByTitle('Favorites'))
    await userEvent.setup().click(screen.getByTitle('Favorites'))
    expect(screen.getByText('Star Board')).toBeInTheDocument()
    expect(screen.getByText('Star Group')).toBeInTheDocument()
  })

  it('shows Personal boards trigger in collapsed mode', async () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([personalBoard])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.getByTitle('Personal boards')).toBeInTheDocument())
  })

  it('clicking Personal boards trigger opens flyout listing personal boards', async () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([personalBoard])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByTitle('Personal boards'))
    await userEvent.setup().click(screen.getByTitle('Personal boards'))
    const flyout = screen.getByTestId('collapsed-flyout')
    expect(flyout).toBeInTheDocument()
    expect(screen.getByText('My Board')).toBeInTheDocument()
  })

  it('opening Favorites flyout closes Personal flyout', async () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    const starredBoard: Board = { ...fakeBoard, id: 77, name: 'Starred One', is_starred: true }
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([personalBoard])
    vi.mocked(listStarredBoards).mockResolvedValue([starredBoard])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByTitle('Personal boards'))
    const user = userEvent.setup()
    await user.click(screen.getByTitle('Personal boards'))
    expect(screen.getByText('My Board')).toBeInTheDocument()
    await user.click(screen.getByTitle('Favorites'))
    expect(screen.queryByText('My Board')).not.toBeInTheDocument()
    expect(screen.getByText('Starred One')).toBeInTheDocument()
  })

  it('active personal board highlights the Personal trigger in collapsed mode', async () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    mockUseLocation.mockReturnValue({ pathname: '/boards/99' })
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([personalBoard])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByTitle('Personal boards'))
    const btn = screen.getByTitle('Personal boards')
    expect(btn.className).toMatch(/info/)
  })

  it('persists group expanded state in localStorage', async () => {
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByText('Alpha'))
    await userEvent.setup().click(screen.getByLabelText('Expand group'))
    const stored = JSON.parse(localStorage.getItem('sidebar-groups-expanded') || '[]')
    expect(stored).toContain(10)
  })

  // ── Nested group explorer tree tests ──────────────────────────────────────

  it('shows a nested subgroup under its parent when parent is expanded', async () => {
    const subgroup: Group = { ...fakeGroup, id: 20, name: 'Frontend', parent: 10, parent_name: 'Alpha' }
    vi.mocked(listGroups).mockResolvedValue([fakeGroup, subgroup])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByText('Alpha'))
    // Subgroup not visible until parent is expanded
    expect(screen.queryByText('Frontend')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByLabelText('Expand group'))
    expect(screen.getByText('Frontend')).toBeInTheDocument()
  })

  it('shows boards belonging to a subgroup under that subgroup when both are expanded', async () => {
    const subgroup: Group = { ...fakeGroup, id: 20, name: 'Frontend', parent: 10, parent_name: 'Alpha' }
    const subBoard: Board = { ...fakeBoard, id: 55, name: 'Design System', group: 20, group_name: 'Frontend' }
    vi.mocked(listGroups).mockResolvedValue([fakeGroup, subgroup])
    vi.mocked(listBoards).mockResolvedValue([subBoard])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByText('Alpha'))
    const user = userEvent.setup()
    // Expand Alpha → reveals Frontend subgroup
    await user.click(screen.getByLabelText('Expand group'))
    expect(screen.getByText('Frontend')).toBeInTheDocument()
    // Expand Frontend → reveals Design System board
    const expandBtns = screen.getAllByLabelText('Expand group')
    await user.click(expandBtns[expandBtns.length - 1])
    expect(screen.getByText('Design System')).toBeInTheDocument()
  })

  it('shows a single Groups trigger in the collapsed rail when groups exist', async () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.getByTitle('Groups')).toBeInTheDocument())
    // Individual group names are not rendered as separate icons
    expect(screen.queryByTitle('Alpha')).not.toBeInTheDocument()
  })

  it('Groups flyout lists all groups including subgroups', async () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    const subgroup: Group = { ...fakeGroup, id: 20, name: 'Frontend', parent: 10, parent_name: 'Alpha' }
    vi.mocked(listGroups).mockResolvedValue([fakeGroup, subgroup])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByTitle('Groups'))
    await userEvent.setup().click(screen.getByTitle('Groups'))
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Frontend')).toBeInTheDocument()
  })

  it('clicking New board opens CreateBoardModal', async () => {
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument())
    await userEvent.setup().click(screen.getByText('New board'))
    expect(screen.getByTestId('create-board-modal')).toBeInTheDocument()
  })

  it('New board modal cancel hides the modal', async () => {
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument())
    await userEvent.setup().click(screen.getByText('New board'))
    await userEvent.setup().click(screen.getByText('Cancel create board'))
    expect(screen.queryByTestId('create-board-modal')).not.toBeInTheDocument()
  })

  it('New board modal confirm calls createBoard and navigates', async () => {
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    vi.mocked(createBoard).mockResolvedValue({ ...fakeBoard, id: 55 })
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument())
    await userEvent.setup().click(screen.getByText('New board'))
    await userEvent.setup().click(screen.getByText('Confirm create board'))
    expect(mockNavigate).toHaveBeenCalledWith('/boards/55')
  })

  it('clicking New group opens CreateGroupModal', async () => {
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument())
    await userEvent.setup().click(screen.getByText('New group'))
    expect(screen.getByTestId('create-group-modal')).toBeInTheDocument()
  })

  it('New group modal confirm does not navigate', async () => {
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument())
    await userEvent.setup().click(screen.getByText('New group'))
    await userEvent.setup().click(screen.getByText('Confirm create group'))
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(screen.getByTestId('create-group-modal')).toBeInTheDocument()
  })

  // ── Recent boards section ─────────────────────────────────────────────────

  it('shows RECENT section when localStorage has entries', async () => {
    localStorage.setItem('user:prefs:recent-boards', JSON.stringify([
      { id: 42, name: 'Sprint Board' },
    ]))
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([fakeBoard])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument())
    expect(screen.getByText('Recent')).toBeInTheDocument()
    expect(screen.getAllByText('Sprint Board').length).toBeGreaterThan(0)
  })

  it('prunes Recent entries whose board id is not in the accessible list (stale localStorage)', async () => {
    // id 999 is in localStorage but not returned by listBoards — simulates a deleted
    // board, revoked membership, or stale data from a prior instance.
    localStorage.setItem('user:prefs:recent-boards', JSON.stringify([
      { id: 999, name: 'Ghost Board' },
      { id: 42, name: 'Sprint Board' },
    ]))
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([fakeBoard])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument())
    expect(screen.queryByText('Ghost Board')).not.toBeInTheDocument()
    const stored = JSON.parse(localStorage.getItem('user:prefs:recent-boards') ?? '[]')
    expect(stored.map((e: { id: number }) => e.id)).toEqual([42])
  })

  it('hides Recent section entirely when all localStorage entries are stale', async () => {
    localStorage.setItem('user:prefs:recent-boards', JSON.stringify([
      { id: 999, name: 'Ghost Board' },
    ]))
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument())
    expect(screen.queryByText('Recent')).not.toBeInTheDocument()
    expect(screen.queryByText('Ghost Board')).not.toBeInTheDocument()
  })

  it('does not show RECENT section when localStorage is empty', async () => {
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument())
    expect(screen.queryByText('Recent')).not.toBeInTheDocument()
  })

  it('Recent section shows group breadcrumb when groupAncestors is present', async () => {
    localStorage.setItem('user:prefs:recent-boards', JSON.stringify([
      { id: 42, name: 'Design System', groupAncestors: ['Engineering'] },
    ]))
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([{ ...fakeBoard, name: 'Design System' }])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.getAllByText('Design System').length).toBeGreaterThan(0))
    expect(screen.getByText('Engineering')).toBeInTheDocument()
  })

  it('Recent board link points to the correct board URL', async () => {
    localStorage.setItem('user:prefs:recent-boards', JSON.stringify([
      { id: 55, name: 'My Recent Board' },
    ]))
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([{ ...fakeBoard, id: 55, name: 'My Recent Board' }])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getAllByText('My Recent Board'))
    const link = screen.getAllByText('My Recent Board')[0].closest('a')
    expect(link?.getAttribute('href')).toBe('/boards/55')
  })

  it('active recent board is highlighted', async () => {
    mockUseLocation.mockReturnValue({ pathname: '/boards/42' })
    localStorage.setItem('user:prefs:recent-boards', JSON.stringify([
      { id: 42, name: 'Sprint Board' },
    ]))
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([fakeBoard])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getAllByText('Sprint Board'))
    const link = screen.getAllByText('Sprint Board')[0].closest('a')
    expect(link?.className).toMatch(/info/)
  })

  it('shows Recent trigger in collapsed rail when recent boards exist', async () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    localStorage.setItem('user:prefs:recent-boards', JSON.stringify([
      { id: 42, name: 'Sprint Board' },
    ]))
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([fakeBoard])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => expect(screen.getByTitle('Recent boards')).toBeInTheDocument())
  })

  it('clicking Recent trigger opens flyout listing recent boards', async () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    localStorage.setItem('user:prefs:recent-boards', JSON.stringify([
      { id: 42, name: 'Sprint Board' },
    ]))
    vi.mocked(listGroups).mockResolvedValue([])
    vi.mocked(listBoards).mockResolvedValue([fakeBoard])
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByTitle('Recent boards'))
    await userEvent.setup().click(screen.getByTitle('Recent boards'))
    expect(screen.getByTestId('collapsed-flyout')).toBeInTheDocument()
    expect(screen.getAllByText('Sprint Board').length).toBeGreaterThan(0)
  })

  // ── Auto-expand ancestors ──────────────────────────────────────────────────

  it('auto-expands ancestor groups on mount when navigating to a board URL', async () => {
    mockUseLocation.mockReturnValue({ pathname: '/boards/42' })
    render(<AppSidebar user={fakeUser} />)
    // Wait for the auto-expand effect to fire and render the board under group Alpha
    await waitFor(() => screen.getByText('Sprint Board'))
  })

  it('does not auto-expand when the active route is not a board', async () => {
    mockUseLocation.mockReturnValue({ pathname: '/groups/10' })
    render(<AppSidebar user={fakeUser} />)
    await waitFor(() => screen.getByText('Alpha'))
    // Sprint Board should not be visible (group not expanded)
    expect(screen.queryByText('Sprint Board')).not.toBeInTheDocument()
  })
})
