import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Dashboard from '../pages/Dashboard'
import { ShellNavDataContext, EMPTY_SHELL_NAV_DATA, type ShellNavData } from '../contexts/ShellNavContext'
import type { Board, User } from '../types'

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => mockNavigate,
}))
vi.mock('../api/boards', () => ({
  getChildrenSettingBlockers: vi.fn().mockResolvedValue({ child_cards: 0, parent_cards: 0, default_of: [] }),
  getDefaultChildBoardOptions: vi.fn().mockResolvedValue({ boards: [] }),
  getBoardDeleteImpact: vi.fn().mockResolvedValue({ child_cards: 0, parent_boards: [], hidden_parent_boards: false, parent_cards: 0 }),
  listSampleBoards: vi.fn().mockResolvedValue([]),
  listBoards: vi.fn(),
  createBoard: vi.fn(),
  deleteBoard: vi.fn(),
  importBoard: vi.fn(),
  starBoard: vi.fn(),
  unstarBoard: vi.fn(),
  listBoardTemplates: vi.fn().mockResolvedValue([]),
}))
vi.mock('../api/groups', () => ({ listGroups: vi.fn() }))
vi.mock('../api/notifications', () => ({
  getUnreadCount: vi.fn().mockResolvedValue(0), listNotifications: vi.fn().mockResolvedValue([]), markAllRead: vi.fn(), markRead: vi.fn(),
}))
vi.mock('../api/auth', () => ({ getVersion: vi.fn().mockResolvedValue('0.3.0') }))

import { listBoards, starBoard, unstarBoard } from '../api/boards'
import { listGroups } from '../api/groups'

const mockListBoards = listBoards as ReturnType<typeof vi.fn>
const mockListGroups = listGroups as ReturnType<typeof vi.fn>
const mockStar = starBoard as ReturnType<typeof vi.fn>
const mockUnstar = unstarBoard as ReturnType<typeof vi.fn>

const DAY = 24 * 60 * 60 * 1000
const user: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane', last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false,
}
const mk = (id: number, extra: Record<string, unknown> = {}): Board => ({
  id, name: `Board ${id}`, description: '', owner: user, group: null, group_name: null, member_count: 1, card_count: 12,
  created_at: '', updated_at: new Date(Date.now() - 2 * 3600_000).toISOString(), is_starred: false,
  effective_health_status: null, health_auto_enabled: false, health_computed_counts: null, ...extra,
} as unknown as Board)
const auto = (stale: number, blocked: number) => ({ health_auto_enabled: true, health_computed_counts: { open: 9, overdue: 0, stale, blocked, flagged: 0 } })

function renderHome(shell: Partial<ShellNavData> = {}, onStarToggled?: () => void) {
  return render(
    <ShellNavDataContext.Provider value={{ ...EMPTY_SHELL_NAV_DATA, ...shell }}>
      <MemoryRouter>
        <Dashboard user={user} onLogout={vi.fn()} onUserUpdated={vi.fn()} onStarToggled={onStarToggled} />
      </MemoryRouter>
    </ShellNavDataContext.Provider>,
  )
}

describe('Home status page (#2474)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListGroups.mockResolvedValue([])
    mockStar.mockResolvedValue(undefined)
    mockUnstar.mockResolvedValue(undefined)
  })

  it('greets by first name in an h2 under the header h1 "Home"', async () => {
    mockListBoards.mockResolvedValue([mk(1)])
    renderHome()
    const h2 = await screen.findByRole('heading', { level: 2, name: /^Good (morning|afternoon|evening), Jane$/ })
    expect(h2).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Home')
  })

  it('writes the summary line with an at-risk clause in warning text and no zero clauses', async () => {
    mockListBoards.mockResolvedValue([mk(1, { ...auto(4, 1), effective_health_status: 'at_risk' }), mk(2)])
    mockListGroups.mockResolvedValue([{ id: 9, name: 'Eng', parent: null, navigation_only: false, owner: user, member_count: 2, board_count: 1 }])
    renderHome()
    const lead = await screen.findByText(/2 boards across 1 group\./)
    expect(within(lead).getByText('1 board is at risk.')).toHaveClass('font-semibold')
    expect(lead).toHaveTextContent('4 stale and 1 blocked cards on the 1 board with auto health on.')
    expect(lead).not.toHaveTextContent(/this week/i)
  })

  it('shows Stale, blocked: no data where auto health is off, and counts where it is on', async () => {
    mockListBoards.mockResolvedValue([mk(1, { name: 'Auto Board', ...auto(0, 0) }), mk(2, { name: 'Manual Board' })])
    renderHome()
    const rows = await screen.findAllByRole('listitem')
    const autoRow = rows.find((r) => r.textContent?.includes('Auto Board'))!
    const manualRow = rows.find((r) => r.textContent?.includes('Manual Board'))!
    expect(autoRow).toHaveTextContent('0 stale')
    expect(autoRow).not.toHaveTextContent('no data')
    const noData = within(manualRow).getByText('Stale, blocked: no data')
    expect(noData).toHaveAttribute('title', 'Turn on auto health in Board settings to see stale and blocked counts')
  })

  it('rows show the status pill only when there is a status, plus "Updated <time>"', async () => {
    mockListBoards.mockResolvedValue([mk(1, { name: 'Red', effective_health_status: 'off_track' }), mk(2, { name: 'Quiet' })])
    renderHome()
    const rows = await screen.findAllByRole('listitem')
    const red = rows.find((r) => r.textContent?.includes('Red'))!
    const quiet = rows.find((r) => r.textContent?.includes('Quiet'))!
    expect(red).toHaveTextContent('Off track')
    expect(quiet).not.toHaveTextContent(/No status/)
    expect(quiet).toHaveTextContent('Updated 2h ago')
  })

  it('rows draw the stage bar on desktop only (hidden on phones), between the signals and the status (#2483)', async () => {
    const stage_counts = [{ uid: 'c1', name: 'Todo', color: '#111111', card_count: 1 }, { uid: 'c2', name: 'Shipped', color: '#222222', card_count: 1 }]
    mockListBoards.mockResolvedValue([mk(1, { name: 'Staged', stage_counts }), mk(2, { name: 'Bare', stage_counts: [] })])
    renderHome()
    const rows = await screen.findAllByRole('listitem')
    const staged = rows.find((r) => r.textContent?.includes('Staged'))!
    const bare = rows.find((r) => r.textContent?.includes('Bare'))!
    const bar = within(staged).getByTestId('stage-bar')
    expect(bar).toHaveClass('max-sm:hidden')
    expect(within(bar).getByRole('img')).toHaveAccessibleName('Cards by stage: Todo 1, Shipped 1')
    expect(within(bar).getByRole('img')).toHaveAttribute('title', 'Cards by stage: Todo 1, Shipped 1')
    expect(bar).toHaveTextContent('Todo')
    expect(bar).toHaveTextContent('Shipped')
    expect(within(bare).queryByTestId('stage-bar')).not.toBeInTheDocument()
  })

  it('shows the not-reviewed cue on a row', async () => {
    mockListBoards.mockResolvedValue([mk(1, {
      health_status: 'at_risk', effective_health_status: 'at_risk', health_status_origin: 'manual',
      health_status_changed_at: new Date(Date.now() - 18 * DAY).toISOString(), health_review_due_at: new Date(Date.now() - 4 * DAY).toISOString(),
    })])
    renderHome()
    expect((await screen.findAllByText('Not reviewed in 18 days')).length).toBeGreaterThan(0)
  })

  describe('filters', () => {
    const boards = () => [
      mk(1, { name: 'Starred One', is_starred: true }),
      mk(2, { name: 'Group Two', group: 5, group_name: 'Eng', effective_health_status: 'at_risk' }),
      mk(3, { name: 'Plain Three' }),
    ]

    it('has All, Starred, Personal and At risk pills with counts', async () => {
      mockListBoards.mockResolvedValue(boards())
      renderHome()
      await screen.findByText('Group Two')
      for (const [name, n] of [['All', '3'], ['Starred', '1'], ['Personal', '2'], ['At risk', '1']]) {
        expect(screen.getByRole('button', { name: `${name} ${n}` })).toBeInTheDocument()
      }
    })

    it('filters the list and switches to the per-filter empty copy', async () => {
      mockListBoards.mockResolvedValue([mk(1, { name: 'Group Two', group: 5, group_name: 'Eng' })])
      const u = userEvent.setup()
      renderHome()
      await screen.findByText('Group Two')
      await u.click(screen.getByRole('button', { name: 'Personal 0' }))
      expect(screen.getByTestId('boards-empty')).toHaveTextContent('No personal boards. Boards you create outside a group appear here.')
      await u.click(screen.getByRole('button', { name: 'Starred 0' }))
      expect(screen.getByTestId('boards-empty')).toHaveTextContent('No starred boards yet. Star a board to pin it here and in the drawer.')
      await u.click(screen.getByRole('button', { name: 'At risk 0' }))
      expect(screen.getByTestId('boards-empty')).toHaveTextContent('No boards are at risk.')
      await u.click(screen.getByRole('button', { name: 'All 1' }))
      expect(screen.getByText('Group Two')).toBeInTheDocument()
    })

    it('the phone filter is a select with counts that drives the same list', async () => {
      mockListBoards.mockResolvedValue(boards())
      const u = userEvent.setup()
      renderHome()
      await screen.findByText('Group Two')
      const select = screen.getByRole('combobox', { name: 'Filter boards' })
      expect(within(select).getByRole('option', { name: 'Personal (2)' })).toBeInTheDocument()
      await u.selectOptions(select, 'at_risk')
      // The section's heading names it; the list carries no second "All boards" label (#2487).
      const section = screen.getByRole('region', { name: 'All boards' })
      const list = within(section).getByRole('list')
      expect(list).not.toHaveAttribute('aria-label')
      expect(within(list).getAllByRole('listitem')).toHaveLength(1)
      expect(within(list).getByText('Group Two')).toBeInTheDocument()
    })
  })

  describe('star toggle', () => {
    it('stars optimistically, tells the shell, and exposes aria-pressed', async () => {
      mockListBoards.mockResolvedValue([mk(1, { name: 'Alpha' })])
      const onStarToggled = vi.fn()
      const u = userEvent.setup()
      renderHome({}, onStarToggled)
      const star = await screen.findByRole('button', { name: 'Star Alpha' })
      expect(star).toHaveAttribute('aria-pressed', 'false')
      await u.click(star)
      expect(mockStar).toHaveBeenCalledWith(1)
      expect(await screen.findByRole('button', { name: 'Unstar Alpha' })).toHaveAttribute('aria-pressed', 'true')
      await waitFor(() => expect(onStarToggled).toHaveBeenCalledOnce())
      await u.click(screen.getByRole('button', { name: 'Unstar Alpha' }))
      expect(mockUnstar).toHaveBeenCalledWith(1)
    })

    it('reverts and says so when the request fails', async () => {
      mockListBoards.mockResolvedValue([mk(1, { name: 'Alpha' })])
      mockStar.mockRejectedValue(new Error('x'))
      const u = userEvent.setup()
      renderHome()
      await u.click(await screen.findByRole('button', { name: 'Star Alpha' }))
      expect(await screen.findByTestId('dashboard-action-error')).toHaveTextContent('Failed to star the board. Please try again.')
      expect(screen.getByRole('button', { name: 'Star Alpha' })).toHaveAttribute('aria-pressed', 'false')
    })

    it('the phone row menu holds Star, Move to group and Delete', async () => {
      mockListBoards.mockResolvedValue([mk(1, { name: 'Alpha' })])
      const u = userEvent.setup()
      renderHome()
      await u.click(await screen.findByRole('button', { name: 'More actions for Alpha' }))
      expect(screen.getByRole('menuitem', { name: 'Star' })).toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: 'Move to group' })).toBeInTheDocument()
      await u.click(screen.getByRole('menuitem', { name: 'Star' }))
      expect(mockStar).toHaveBeenCalledWith(1)
    })
  })

  describe('Jump back in', () => {
    it('is hidden when this device has no recents', async () => {
      mockListBoards.mockResolvedValue([mk(1)])
      renderHome({ recentBoards: [] })
      await screen.findByRole('heading', { name: 'All boards' })
      expect(screen.queryByRole('heading', { name: 'Jump back in' })).not.toBeInTheDocument()
    })

    it('is hidden when no recent resolves to a loaded board (deleted since)', async () => {
      mockListBoards.mockResolvedValue([mk(1)])
      renderHome({ recentBoards: [{ id: 99, name: 'Gone' }] })
      await screen.findByRole('heading', { name: 'All boards' })
      expect(screen.queryByRole('heading', { name: 'Jump back in' })).not.toBeInTheDocument()
    })

    it('shows up to 3 tiles labeled "on this device" with group, status, cards, signals and age', async () => {
      mockListBoards.mockResolvedValue([
        mk(1, { name: 'Alpha', group: 5, group_name: 'Eng', effective_health_status: 'at_risk', ...auto(2, 1) }),
        mk(2, { name: 'Beta' }),
        mk(3, { name: 'Gamma' }),
        mk(4, { name: 'Delta' }),
      ])
      const recents = [1, 2, 3, 4].map((id, i) => ({ id, name: `B${id}`, openedAt: Date.now() - (i + 1) * 3600_000 }))
      const u = userEvent.setup()
      renderHome({ recentBoards: recents })
      const section = (await screen.findByRole('heading', { name: 'Jump back in' })).closest('section')!
      expect(within(section).getByText('Recently opened on this device')).toBeInTheDocument()
      const tiles = within(section).getAllByRole('listitem')
      expect(tiles).toHaveLength(3)
      expect(tiles[0]).toHaveTextContent('Eng')
      expect(tiles[0]).toHaveTextContent('Alpha')
      expect(tiles[0]).toHaveTextContent('At risk')
      expect(tiles[0]).toHaveTextContent('Cards 12')
      expect(tiles[0]).toHaveTextContent('2 stale')
      expect(tiles[0]).toHaveTextContent('Opened 1h ago')
      expect(tiles[1]).toHaveTextContent('Personal')
      expect(tiles[1]).toHaveTextContent('Stale, blocked: no data')
      await u.click(within(tiles[0]).getByRole('button'))
      expect(mockNavigate).toHaveBeenCalledWith('/boards/1')
    })

    it('draws the stage bar with its end names, and none when the server sends no stage_counts (#2483)', async () => {
      const stage_counts = [
        { uid: 'c1', name: 'Backlog', color: '#111111', card_count: 2 },
        { uid: 'c2', name: 'Doing', color: '#222222', card_count: 0 },
        { uid: 'c3', name: 'Done', color: '#333333', card_count: 6 },
      ]
      mockListBoards.mockResolvedValue([mk(1, { name: 'Alpha', stage_counts }), mk(2, { name: 'Beta' })])
      renderHome({ recentBoards: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }] })
      const section = (await screen.findByRole('heading', { name: 'Jump back in' })).closest('section')!
      const [alpha, beta] = within(section).getAllByRole('listitem')
      const bar = within(alpha).getByRole('img', { name: 'Cards by stage: Backlog 2, Doing 0, Done 6' })
      const segments = within(alpha).getAllByTestId('stage-bar-segment')
      expect(segments).toHaveLength(2)
      expect(segments[0]).toHaveStyle({ flexGrow: '2', backgroundColor: '#111111' })
      expect(segments[1]).toHaveStyle({ flexGrow: '6', backgroundColor: '#333333' })
      expect(segments[0]).toHaveStyle({ minWidth: '2px' })
      expect(bar).toHaveClass('ring-1', 'ring-line-boundary')
      expect(bar).not.toHaveAttribute('title')
      expect(bar.parentElement).toHaveTextContent('Backlog')
      expect(bar.parentElement).toHaveTextContent('Done')
      expect(within(beta).queryByTestId('stage-bar')).not.toBeInTheDocument()
    })

    it('omits the age for an entry stored before openedAt existed', async () => {
      mockListBoards.mockResolvedValue([mk(1, { name: 'Alpha' })])
      renderHome({ recentBoards: [{ id: 1, name: 'Alpha' }] })
      const section = (await screen.findByRole('heading', { name: 'Jump back in' })).closest('section')!
      expect(section).not.toHaveTextContent('Opened')
    })
  })

  describe('Groups and Needs attention', () => {
    it('lists groups with board and member counts', async () => {
      mockListBoards.mockResolvedValue([mk(1)])
      mockListGroups.mockResolvedValue([
        { id: 9, name: 'Eng', parent: null, navigation_only: false, owner: user, member_count: 1, board_count: 1 },
        { id: 10, name: 'Hidden', parent: null, navigation_only: true, owner: user, member_count: 0, board_count: 0 },
      ])
      const u = userEvent.setup()
      renderHome()
      expect(await screen.findByText('1 board · 1 member')).toBeInTheDocument()
      expect(screen.queryByText('Hidden')).not.toBeInTheDocument()
      await u.click(screen.getByRole('button', { name: /^Eng/ }))
      expect(mockNavigate).toHaveBeenCalledWith('/groups/9')
    })

    it('ranks boards and subgroups worst first with a severity dot and meta line', async () => {
      const overdueGroup = {
        id: 11, name: 'Late Sub', parent: 9, parent_name: 'Eng', navigation_only: false, owner: user, member_count: 1, board_count: 0,
        health_status: 'at_risk', effective_health_status: 'at_risk', health_status_source: null,
        health_status_changed_at: new Date(Date.now() - 18 * DAY).toISOString(), health_review_due_at: new Date(Date.now() - 4 * DAY).toISOString(),
      }
      mockListBoards.mockResolvedValue([
        mk(1, { name: 'Stale Board', ...auto(2, 0) }),
        mk(2, { name: 'Blocked Board', effective_health_status: 'at_risk', ...auto(5, 3) }),
        mk(3, { name: 'Fine Board', ...auto(0, 0) }),
      ])
      mockListGroups.mockResolvedValue([{ ...overdueGroup, id: 9, name: 'Eng', parent: null, health_review_due_at: null }, overdueGroup])
      const u = userEvent.setup()
      renderHome()
      const section = await screen.findByRole('region', { name: 'Needs attention' })
      const items = within(section).getAllByRole('listitem')
      expect(items.map((i) => i.textContent)).toEqual([
        'Blocked Board5 stale, 3 blocked · At risk',
        'Stale Board2 stale',
        'Late SubHealth status not reviewed in 18 days',
      ])
      await u.click(within(items[2]).getByRole('button'))
      expect(mockNavigate).toHaveBeenCalledWith('/groups/11')
    })

    it('is absent when nothing needs attention', async () => {
      mockListBoards.mockResolvedValue([mk(1, auto(0, 0))])
      renderHome()
      await screen.findByRole('heading', { name: 'All boards' })
      expect(screen.queryByRole('region', { name: 'Needs attention' })).not.toBeInTheDocument()
    })
  })

  it('shows skeletons while loading', () => {
    mockListBoards.mockReturnValue(new Promise(() => undefined))
    mockListGroups.mockReturnValue(new Promise(() => undefined))
    renderHome()
    expect(screen.getByTestId('home-skeleton')).toBeInTheDocument()
  })

  describe('side lists and group avatars (#2487)', () => {
    const grp = (id: number, extra: Record<string, unknown> = {}) => ({
      id, name: `G${String(id).padStart(2, '0')}`, parent: null, navigation_only: false, owner: user, member_count: 1, board_count: 0, ...extra,
    })

    it('caps Groups at five with a Show all toggle that expands and collapses in place', async () => {
      const u = userEvent.setup()
      mockListBoards.mockResolvedValue([mk(1)])
      mockListGroups.mockResolvedValue(Array.from({ length: 7 }, (_, i) => grp(i + 1)))
      renderHome()
      const section = await screen.findByRole('region', { name: 'Groups' })
      expect(within(section).getAllByRole('listitem')).toHaveLength(5)
      const toggle = within(section).getByRole('button', { name: 'Show all 7' })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(toggle).toHaveAttribute('aria-controls', 'home-groups-list')
      expect(toggle).toHaveAccessibleDescription('Groups')
      await u.click(toggle)
      expect(within(section).getAllByRole('listitem')).toHaveLength(7)
      const fewer = within(section).getByRole('button', { name: 'Show fewer' })
      expect(fewer).toHaveAttribute('aria-expanded', 'true')
      expect(fewer).toHaveFocus()
      await u.click(fewer)
      expect(within(section).getAllByRole('listitem')).toHaveLength(5)
    })

    it('shows no toggle when a side list fits under the cap', async () => {
      mockListBoards.mockResolvedValue([mk(1)])
      mockListGroups.mockResolvedValue([grp(1), grp(2)])
      renderHome()
      const section = await screen.findByRole('region', { name: 'Groups' })
      expect(within(section).queryByRole('button', { name: /^Show/ })).not.toBeInTheDocument()
    })

    it('caps Needs attention at five with its own toggle', async () => {
      const u = userEvent.setup()
      mockListBoards.mockResolvedValue(Array.from({ length: 6 }, (_, i) => mk(i + 1, auto(i + 1, 0))))
      mockListGroups.mockResolvedValue([])
      renderHome()
      const section = await screen.findByRole('region', { name: 'Needs attention' })
      expect(within(section).getAllByRole('listitem')).toHaveLength(5)
      const toggle = within(section).getByRole('button', { name: 'Show all 6' })
      expect(toggle).toHaveAccessibleDescription('Needs attention')
      await u.click(toggle)
      expect(within(section).getAllByRole('listitem')).toHaveLength(6)
    })

    it('draws member_preview avatars (at most three) and a +N for the rest', async () => {
      mockListBoards.mockResolvedValue([mk(1)])
      const members = [1, 2, 3, 4].map((id) => ({ id, username: `u${id}`, display_name: `User ${id}`, avatar_url: '' }))
      mockListGroups.mockResolvedValue([grp(1, { member_count: 9, member_preview: members })])
      renderHome()
      const section = await screen.findByRole('region', { name: 'Groups' })
      const stack = within(section).getByTestId('group-avatar-stack')
      expect(stack).toHaveAttribute('aria-hidden', 'true')
      expect(stack.children).toHaveLength(4)
      expect(stack).toHaveTextContent('+6')
    })

    it('falls back to the owner alone when the server sends no member_preview', async () => {
      mockListBoards.mockResolvedValue([mk(1)])
      mockListGroups.mockResolvedValue([grp(1, { member_count: 3 })])
      renderHome()
      const stack = within(await screen.findByRole('region', { name: 'Groups' })).getByTestId('group-avatar-stack')
      expect(stack.children).toHaveLength(2)
      expect(stack).toHaveTextContent('+2')
    })
  })
})
