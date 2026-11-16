/**
 * BoardView wiring for the column-header add-card button (#2270, #2317): one lane adds directly,
 * several lanes ask which one, and a collapsed lane is expanded first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ADD_CARD_EVENT } from '../utils/addCardEvent'
import BoardView from '../components/Board/BoardView'
import type { BoardFull, User } from '../types'
import type { BoardContextType } from '../contexts/BoardContext'
import type { CollisionDetection } from '@dnd-kit/core'

let mockSearchParams = new URLSearchParams()
const mockSetSearchParams = vi.fn()

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MouseSensor: class { static activators = [] },
  TouchSensor: class {},
  KeyboardSensor: class {},
  closestCenter: vi.fn((_args: Parameters<CollisionDetection>[0]) => []),
  useSensor: () => ({}),
  useSensors: () => [],
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  horizontalListSortingStrategy: {},
  verticalListSortingStrategy: {},
  arrayMove: vi.fn(),
  useSortable: () => ({ setNodeRef: () => {}, attributes: {}, listeners: {}, transform: null, transition: undefined, isDragging: false }),
}))

vi.mock('react-router-dom', () => ({
  // BoardView reads navigation state for the board-invite joined notice (#1444).
  useLocation: () => ({ pathname: '/', search: '', hash: '', state: null, key: 'default' }),
  useSearchParams: () => {
    const [params, setParams] = React.useState<URLSearchParams>(() => new URLSearchParams(mockSearchParams))
    const setter = (next: URLSearchParams | Record<string, string> | ((prev: URLSearchParams) => URLSearchParams), _opts?: unknown) => {
      mockSetSearchParams(next, _opts)
      const resolved = typeof next === 'function'
        ? next(params)
        : next instanceof URLSearchParams
          ? next
          : new URLSearchParams(next as Record<string, string>)
      setParams(new URLSearchParams(resolved))
    }
    return [params, setter] as const
  },
  useNavigate: () => vi.fn(),
  MemoryRouter: ({ children }: { children: React.ReactNode }) => children,
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => <a href={to} className={className}>{children}</a>,
}))

const mockGetGroup = vi.hoisted(() => vi.fn())
vi.mock('../api/groups', () => ({ getGroup: mockGetGroup }))

const socketState = vi.hoisted(() => ({ status: 'connected' }))
vi.mock('../hooks/useBoardSocket', () => ({
  useBoardSocket: () => ({ connected: true, status: socketState.status, lastEventAt: null, reconnectAttempt: 0 }),
}))

vi.mock('../hooks/useBoardPan', () => ({
  useBoardPan: () => {},
}))

let mockBoardContextValue: BoardContextType
vi.mock('../contexts/BoardContext', () => ({
  useBoardContext: () => mockBoardContextValue,
}))

vi.mock('../api/boards', () => ({
  exportBoardCsv: vi.fn(),
  exportBoardJson: vi.fn(),
}))

vi.mock('../components/Board/SummaryView', () => ({
  default: () => <div data-testid="summary-view">Summary</div>,
}))
vi.mock('../components/Board/AnalyticsView', () => ({
  default: () => <div data-testid="analytics-view">Analytics</div>,
}))
// SwimlaneRow double: one cell per column, exposing the same data attributes as BoardCell and
// recording the add-card request the header sends (#2317). A collapsed lane renders no cells.
// `lateCells.on` makes a lane mount its cells one commit after it expands, to exercise the
// requestAnimationFrame fallback in BoardView's pending add-card effect.
const lateCells = vi.hoisted(() => ({ on: false }))
vi.mock('../components/Board/SwimlaneRow', () => ({
  default: function SwimlaneRowDouble({ swimlane, columns, collapsed, noMatch }: { swimlane: { id: number; name: string }; columns: { id: number }[]; collapsed: boolean; noMatch?: boolean }) {
    // While collapsed, arm the delay; on expand the effect below flips it one commit after the
    // parent's effect has already looked for the cells.
    const [ready, setReady] = React.useState(true)
    React.useEffect(() => { setReady(!collapsed || !lateCells.on) }, [collapsed])
    return (
    <div data-testid={`swim-${swimlane.id}`} data-no-match={noMatch ? 'true' : undefined}>
      {!collapsed && ready && !noMatch && columns.map((c) => (
        <div
          key={c.id}
          data-board-cell
          data-column-id={c.id}
          data-swimlane-id={swimlane.id}
          data-testid={`cell-${swimlane.id}-${c.id}`}
          ref={(el) => {
            if (el && !(el as HTMLElement & { _wired?: boolean })._wired) {
              (el as HTMLElement & { _wired?: boolean })._wired = true
              el.addEventListener(ADD_CARD_EVENT, () => el.setAttribute('data-adding', 'true'))
            }
          }}
        />
      ))}
    </div>
    )
  },
}))
vi.mock('../components/Card/CardItem', () => ({
  default: ({ card }: { card: { title: string } }) => <div>{card.title}</div>,
}))
vi.mock('../components/Card/CardDetail', () => ({
  default: ({ card, onClose }: { card: { title: string }; onClose: () => void }) => (
    <div data-testid="card-detail">{card.title}<button onClick={onClose}>Close Detail</button></div>
  ),
}))
vi.mock('../components/Board/AddColumnModal', () => ({
  default: () => <div data-testid="add-column-modal" />,
}))
vi.mock('../components/Swimlane/AddSwimlaneModal', () => ({
  default: () => <div data-testid="add-swimlane-modal" />,
}))
vi.mock('../components/Board/BoardSettingsModal', () => ({
  default: () => <div data-testid="settings-modal" />,
}))
const filterBarProps = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('../components/Board/FilterBar', () => ({
  default: (p: Record<string, unknown>) => { filterBarProps.current = p; return <div data-testid="filter-bar">FilterBar</div> },
  EMPTY_FILTER: { search: '', assigneeIds: [], labelIds: [], priorities: [], dueDate: null, customFields: {}, visibleCustomFieldFilterIds: [] },
  countActiveFilters: () => 0,
  isCustomFieldFilterActive: () => false,
}))
vi.mock('../components/Board/KeyboardShortcutsOverlay', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="shortcuts-overlay"><button onClick={onClose}>Close Shortcuts</button></div>
  ),
}))
vi.mock('../components/Common/Tooltip', () => ({
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for Tooltip's loosely-typed children prop, see Tooltip.tsx */
  default: ({ content, children }: { content: string; children: React.ReactElement<any> }) =>
    React.cloneElement(children, { 'data-tooltip': content }),
}))
vi.mock('../components/Board/BulkActionToolbar', () => ({
  default: () => <div data-testid="bulk-toolbar" />,
}))
vi.mock('../components/Board/ArchivedCardsPanel', () => ({
  default: () => <div data-testid="archived-panel">Archived</div>,
}))
vi.mock('../hooks/useSavedFilters', () => ({
  useSavedFilters: () => ({
    savedFilters: [],
    loading: false,
    saveFilter: vi.fn(),
    removeFilter: vi.fn(),
    hydrateFilter: vi.fn(),
  }),
}))
vi.mock('../components/Board/MovementHistoryView', () => ({
  default: () => <div data-testid="movement-history-view" />,
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false, has_usable_password: true,
  has_completed_tour: true,
}

function makeBoard(overrides: Partial<BoardFull> = {}): BoardFull {
  return {
    health_status: null, effective_health_status: null, health_status_source: null, health_status_changed_at: null, health_status_changed_by: null, health_status_note: null, health_review_days: null, health_review_due_at: null, health_auto_enabled: false, health_off_track_cards: 3, computed_health_status: null, health_computed_at: null, health_computed_counts: null, health_status_origin: null, default_preset: null,
    swimlane_rollup_field: null,
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0,
    columns: [
      { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
    ],
    swimlanes: [
      { id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null },
    ],
    cards: [],
    labels: [],
    members: [{ id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7,
    stale_warning_pct: 50,
    allowed_priorities: ['low', 'medium', 'high', 'critical'] as BoardFull['allowed_priorities'],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false, show_row_chip_field_names: true, export_min_role: 'viewer', card_density: 'comfortable',
    is_starred: false,
    created_at: '', updated_at: '',
    current_user_role: 'admin',
    custom_field_definitions: [],
    swimlane_custom_field_definitions: [],
    owner: fakeUser,
    capabilities: { movement_export: false },
    share_token: null,
    share_token_expires_at: null,
    share_link_active: false,
    ...overrides,
  }
}

function defaultContext(overrides: Partial<BoardContextType> = {}): BoardContextType {
  return {
    board: makeBoard(),
    loading: false,
    error: null,
    reload: vi.fn(),
    silentReload: vi.fn(),
    moveCard: vi.fn(),
    forceMoveCard: vi.fn(), forceMoveCardTo: vi.fn(),
    moveError: null,
    clearMoveError: vi.fn(),
    addCard: vi.fn(),
    removeCard: vi.fn(),
    archiveCard: vi.fn(),
    archiveCardByUid: vi.fn(),
    unarchiveCard: vi.fn(),
    addColumn: vi.fn(),
    removeColumn: vi.fn(),
    addSwimlane: vi.fn(),
    updateCard: vi.fn(),
    updateColumn: vi.fn(),
    addLabel: vi.fn(),
    updateLabel: vi.fn(),
    removeLabel: vi.fn(),
    applyCustomFieldDefinitions: vi.fn(),
    applySwimlaneFieldDefinitions: vi.fn(),
    addMember: vi.fn(),
    updateMember: vi.fn(),
    removeMember: vi.fn(),
    applyColumnOrder: vi.fn(),
    applySwimlaneOrder: vi.fn(),
    reorderColumns: vi.fn(),
    reorderSwimlanes: vi.fn(),
    updateSwimlane: vi.fn(),
    removeSwimlane: vi.fn(),
    updateBoardSettings: vi.fn(),
    evictColumn: vi.fn(),
    evictSwimlane: vi.fn(),
    evictCardByUid: vi.fn(),
    mergeBoardState: vi.fn(),
    ...overrides,
  }
}



const CARD = {
  id: 100, uid: 'carduid00001', title: 'Ship it', column: 10, swimlane: 20, position: 0, priority: 'low',
  assignees: [], labels: [], due_date: null, archived_at: null,
} as unknown as BoardFull['cards'][number]

describe('BoardView states (#2276)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSearchParams = new URLSearchParams()
    socketState.status = 'connected'
    localStorage.clear()
    mockBoardContextValue = defaultContext()
  })

  it('empty board shows No cards yet and Add a card opens the first cell', async () => {
    render(<BoardView />)
    expect(screen.getByText('No cards yet')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Add a card' }))
    expect(screen.getByTestId('cell-20-10')).toHaveAttribute('data-adding', 'true')
  })

  it('a board with cards has no empty state', () => {
    mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [CARD] }) })
    render(<BoardView />)
    expect(screen.queryByText('No cards yet')).not.toBeInTheDocument()
  })

  it('a viewer sees the view-only line and no Add a card', () => {
    mockBoardContextValue = defaultContext({ board: makeBoard({ current_user_role: 'viewer' }) })
    render(<BoardView />)
    expect(screen.getByTestId('board-view-only')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add a card' })).not.toBeInTheDocument()
  })

  it('an editor sees no view-only line', () => {
    render(<BoardView />)
    expect(screen.queryByTestId('board-view-only')).not.toBeInTheDocument()
  })

  it.each(['reconnecting', 'failed'])('shows the offline banner when the socket is %s', (status) => {
    socketState.status = status
    render(<BoardView />)
    expect(screen.getByTestId('board-offline-banner')).toBeInTheDocument()
    expect(screen.getByTestId('board-offline-banner')).toHaveTextContent(status === 'failed' ? 'Live updates are off' : 'Changes may not save')
  })

  it('no offline banner while connected', () => {
    render(<BoardView />)
    expect(screen.queryByTestId('board-offline-banner')).not.toBeInTheDocument()
  })

  it('filters matching nothing offer Show all cards, which clears the Show chip', async () => {
    mockSearchParams = new URLSearchParams('show=due_soon')
    mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [CARD] }) })
    render(<BoardView />)
    await userEvent.click(screen.getByRole('button', { name: 'Show all cards' }))
    expect(mockSetSearchParams).toHaveBeenCalled()
  })

  it('an empty board with a filter active shows only the empty-board notice (#2276)', () => {
    mockSearchParams = new URLSearchParams('show=due_soon')
    render(<BoardView />)
    expect(screen.getByText('No cards yet')).toBeInTheDocument()
    expect(screen.queryByText(/No cards match/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show all cards' })).not.toBeInTheDocument()
  })
})

const LANE_B = { id: 21, uid: 'laneuid00002', name: 'Customer B', contact_email: '', notes: '', position: 1, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null } as BoardFull['swimlanes'][number]
const OVERDUE = { ...CARD, id: 101, due_date: '2020-01-02' } as BoardFull['cards'][number]
const twoLanes = (cards: BoardFull['cards']) => makeBoard({ swimlanes: [makeBoard().swimlanes[0], LANE_B], cards })
const follows = (a: HTMLElement, b: HTMLElement) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

describe('BoardView states (#2324, #2214, #2337)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSearchParams = new URLSearchParams()
    socketState.status = 'connected'
    localStorage.clear()
    mockBoardContextValue = defaultContext()
    mockGetGroup.mockResolvedValue({ id: 5, can_place_boards: false })
  })

  it('the empty-board panel sits below the column headers and above the lanes', () => {
    render(<BoardView />)
    const panel = screen.getByTestId('board-empty-state')
    expect(follows(screen.getByTestId('board-header-row'), panel)).toBe(true)
    expect(follows(panel, screen.getByTestId('swim-20'))).toBe(true)
  })

  it('offers Import cards, linking to the group import, when the viewer can place boards there', async () => {
    mockGetGroup.mockResolvedValue({ id: 5, can_place_boards: true })
    mockBoardContextValue = defaultContext({ board: makeBoard({ group: 5 }) })
    render(<BoardView />)
    expect(await screen.findByRole('link', { name: 'Import cards' })).toHaveAttribute('href', '/groups/5?import=1')
    expect(mockGetGroup).toHaveBeenCalledWith(5)
    expect(screen.getByText('Add the first card to To Do, or import cards from a file.')).toBeInTheDocument()
  })

  it.each([
    ['cannot place boards', () => mockGetGroup.mockResolvedValue({ id: 5, can_place_boards: false })],
    ['group fetch fails', () => mockGetGroup.mockRejectedValue(new Error('403'))],
  ])('no Import cards when the viewer %s', async (_label, arrange) => {
    arrange()
    mockBoardContextValue = defaultContext({ board: makeBoard({ group: 5 }) })
    render(<BoardView />)
    await waitFor(() => expect(mockGetGroup).toHaveBeenCalled())
    expect(screen.queryByRole('link', { name: 'Import cards' })).not.toBeInTheDocument()
    expect(screen.getByText('Add the first card to To Do.')).toBeInTheDocument()
  })

  it('does not look up the group for a board with cards or no group', () => {
    mockBoardContextValue = defaultContext({ board: makeBoard({ group: 5, cards: [CARD] }) })
    const { unmount } = render(<BoardView />)
    unmount()
    mockBoardContextValue = defaultContext()
    render(<BoardView />)
    expect(mockGetGroup).not.toHaveBeenCalled()
  })

  it('a chip matching nothing shrinks every lane to its band and puts the chip line below the lanes', () => {
    mockSearchParams = new URLSearchParams('show=due_soon')
    mockBoardContextValue = defaultContext({ board: twoLanes([CARD]) })
    render(<BoardView />)
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-no-match', 'true')
    expect(screen.getByTestId('swim-21')).toHaveAttribute('data-no-match', 'true')
    const panel = screen.getByTestId('board-no-match')
    expect(panel).toHaveTextContent('No cards are due soon')
    expect(follows(screen.getByTestId('swim-21'), panel)).toBe(true)
    expect(screen.queryByText('No cards yet')).not.toBeInTheDocument()
  })

  it('lanes keep their cells when something matches', () => {
    mockSearchParams = new URLSearchParams('show=overdue')
    mockBoardContextValue = defaultContext({ board: twoLanes([OVERDUE]) })
    render(<BoardView />)
    expect(screen.getByTestId('swim-20')).not.toHaveAttribute('data-no-match')
    expect(screen.getByTestId('swim-21')).toBeInTheDocument()
    expect(screen.queryByTestId('board-no-match')).not.toBeInTheDocument()
  })

  it('hideUnmatched (f_hide_unmatched=1) hides lanes with no matching card', () => {
    mockSearchParams = new URLSearchParams('show=overdue&f_hide_unmatched=1')
    mockBoardContextValue = defaultContext({ board: twoLanes([OVERDUE]) })
    render(<BoardView />)
    expect(screen.getByTestId('swim-20')).toBeInTheDocument()
    expect(screen.queryByTestId('swim-21')).not.toBeInTheDocument()
  })

  it('hideUnmatched hides the No matching cards bands too, leaving the panel', () => {
    mockSearchParams = new URLSearchParams('show=due_soon&f_hide_unmatched=1')
    mockBoardContextValue = defaultContext({ board: twoLanes([CARD]) })
    render(<BoardView />)
    expect(screen.queryByTestId('swim-20')).not.toBeInTheDocument()
    expect(screen.queryByTestId('swim-21')).not.toBeInTheDocument()
    expect(screen.getByTestId('board-no-match')).toHaveTextContent('No cards are due soon')
  })

  it('hideUnmatched has no effect with no card filter or chip', async () => {
    mockSearchParams = new URLSearchParams('f_hide_unmatched=1')
    mockBoardContextValue = defaultContext({ board: twoLanes([OVERDUE]) })
    render(<BoardView />)
    await userEvent.keyboard('/')
    expect(screen.getByTestId('swim-21')).toBeInTheDocument()
    expect(filterBarProps.current.cardFilterActive).toBe(false)
    expect((filterBarProps.current.filters as { laneFilter?: unknown }).laneFilter).toEqual({ items: [], hideUnmatched: true })
  })

  it('Show all cards clears the chip and the card filters but keeps the lane settings (hide flag)', async () => {
    mockSearchParams = new URLSearchParams('show=due_soon&f_hide_unmatched=1')
    mockBoardContextValue = defaultContext({ board: twoLanes([CARD]) })
    render(<BoardView />)
    await userEvent.keyboard('/')
    expect(filterBarProps.current.cardFilterActive).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Show all cards' }))
    const last = mockSetSearchParams.mock.calls.map((c) => c[0]).filter((x) => typeof x === 'function')
    const params = new URLSearchParams('show=due_soon&f_hide_unmatched=1')
    for (const fn of last) fn(params)
    expect(params.get('f_hide_unmatched')).toBe('1')
    expect(params.get('show')).toBeNull()
    expect(screen.queryByTestId('board-no-match')).not.toBeInTheDocument()
  })

  it('shows the No lanes match notice when rules hide one lane and hideUnmatched hides the other (#2324)', async () => {
    const rule = JSON.stringify([{ f: 'name', o: 'is', v: 'Customer B' }])
    mockSearchParams = new URLSearchParams(`show=overdue&f_hide_unmatched=1&f_lanes=1.${rule}`)
    mockBoardContextValue = defaultContext({ board: twoLanes([OVERDUE]) })
    render(<BoardView />)
    expect(screen.queryByTestId('swim-20')).not.toBeInTheDocument()
    expect(screen.queryByTestId('swim-21')).not.toBeInTheDocument()
    expect(screen.getByText('No lanes match your lane filters.')).toBeInTheDocument()
    expect(screen.queryByTestId('board-no-match')).not.toBeInTheDocument()
    await userEvent.keyboard('/')
    expect(filterBarProps.current.hiddenLaneCount).toBe(2)
  })

  it('an empty board whose only lane is hidden by lane rules shows No lanes match, not No cards yet (#2324)', () => {
    const rule = JSON.stringify([{ f: 'name', o: 'is', v: 'Nobody' }])
    mockSearchParams = new URLSearchParams(`f_lanes=1.${rule}`)
    mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [] }) })
    render(<BoardView />)
    expect(screen.getByText('No lanes match your lane filters.')).toBeInTheDocument()
    expect(screen.queryByText('No cards yet')).not.toBeInTheDocument()
  })

  it('shows the no-match panel, not No lanes match, when no card matches and hideUnmatched hides the rest (#2214)', () => {
    const rule = JSON.stringify([{ f: 'name', o: 'is', v: 'Customer B' }])
    mockSearchParams = new URLSearchParams(`show=due_soon&f_hide_unmatched=1&f_lanes=1.${rule}`)
    mockBoardContextValue = defaultContext({ board: twoLanes([CARD]) })
    render(<BoardView />)
    expect(screen.queryByText('No lanes match your lane filters.')).not.toBeInTheDocument()
    expect(screen.getByTestId('board-no-match')).toHaveTextContent('No cards are due soon')
    expect(screen.getByRole('button', { name: 'Show all cards' })).toBeInTheDocument()
  })

  it('the collapsed-lanes strip does not count lanes hideUnmatched hides (#2251)', () => {
    mockSearchParams = new URLSearchParams('show=overdue&f_hide_unmatched=1')
    const collapsedB = { ...LANE_B, is_collapsed: true }
    mockBoardContextValue = defaultContext({
      board: makeBoard({ swimlanes: [makeBoard().swimlanes[0], collapsedB], cards: [OVERDUE] }),
    })
    render(<BoardView />)
    expect(screen.queryByTestId('swim-21')).not.toBeInTheDocument()
    expect(screen.queryByText(/swimlanes? collapsed/)).not.toBeInTheDocument()
  })

  it('passes the count of rules on fields the viewer cannot use to the filter bar (#2337)', async () => {
    mockSearchParams = new URLSearchParams(`f_lanes=1.${JSON.stringify([{ f: 'contact_email', o: 'contains', v: 'x' }, { f: 'name', o: 'is', v: 'A' }])}`)
    mockBoardContextValue = defaultContext({ board: makeBoard({ current_user_role: 'member', cards: [CARD] }) })
    const { unmount } = render(<BoardView />)
    await userEvent.keyboard('/')
    expect(filterBarProps.current.ignoredLaneRuleCount).toBe(1)
    unmount()
    mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [CARD] }) })
    render(<BoardView />)
    await userEvent.keyboard('/')
    expect(filterBarProps.current.ignoredLaneRuleCount).toBe(0)
  })
})
