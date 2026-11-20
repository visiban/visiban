/**
 * BoardView wiring for the column-header add-card button (#2270, #2317): one lane adds directly,
 * several lanes ask which one, and a collapsed lane is expanded first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
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
}))

vi.mock('../hooks/useBoardSocket', () => ({
  useBoardSocket: () => ({ connected: true, status: 'connected', lastEventAt: null, reconnectAttempt: 0 }),
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
  default: function SwimlaneRowDouble({ swimlane, columns, collapsed }: { swimlane: { id: number; name: string }; columns: { id: number }[]; collapsed: boolean }) {
    // While collapsed, arm the delay; on expand the effect below flips it one commit after the
    // parent's effect has already looked for the cells.
    const [ready, setReady] = React.useState(true)
    React.useEffect(() => { setReady(!collapsed || !lateCells.on) }, [collapsed])
    return (
    <div data-testid={`swim-${swimlane.id}`}>
      {!collapsed && ready && columns.map((c) => (
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
vi.mock('../components/Board/FilterBar', () => ({
  default: () => <div data-testid="filter-bar">FilterBar</div>,
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
    commitment_column_uid: null,
    cards_can_have_children: false,
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
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false, show_row_chip_field_names: true, lane_details_cap: 6, export_min_role: 'viewer', card_density: 'comfortable',
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


const LANES = [
  { id: 20, uid: 'laneuid00001', name: 'Web App', contact_email: '', notes: '', position: 0, color: '#3B82F6', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null },
  { id: 21, uid: 'laneuid00002', name: 'Mobile', contact_email: '', notes: '', position: 1, color: '#10B981', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null },
]

function setBoard(swimlanes: BoardFull['swimlanes'], overrides: Partial<BoardFull> = {}) {
  mockBoardContextValue = defaultContext({ board: makeBoard({ swimlanes, ...overrides }) })
}

describe('BoardView — column-header add card (#2317)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSearchParams = new URLSearchParams()
    localStorage.clear()
  })

  it('single lane: + opens the input in that lane directly, with no menu', async () => {
    setBoard([LANES[0]])
    render(<BoardView />)
    const plus = screen.getByTestId('column-add-card')
    expect(plus).not.toHaveAttribute('aria-haspopup')
    await userEvent.click(plus)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('cell-20-10')).toHaveAttribute('data-adding', 'true')
  })

  it('several lanes: + opens a lane menu and picking lane 2 targets lane 2, not lane 1', async () => {
    setBoard(LANES)
    render(<BoardView />)
    const plus = screen.getByTestId('column-add-card')
    expect(plus).toHaveAttribute('aria-haspopup', 'menu')
    expect(plus).toHaveAttribute('aria-expanded', 'false')
    expect(plus).toHaveAccessibleName('Add card to To Do')
    await userEvent.click(plus)
    expect(plus).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu', { name: 'Add card to which swimlane?' })
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Web App', 'Mobile'])
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Mobile' }))
    expect(screen.getByTestId('cell-21-10')).toHaveAttribute('data-adding', 'true')
    expect(screen.getByTestId('cell-20-10')).not.toHaveAttribute('data-adding')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('Escape closes the menu and returns focus to +', async () => {
    setBoard(LANES)
    render(<BoardView />)
    const plus = screen.getByTestId('column-add-card')
    await userEvent.click(plus)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(plus).toHaveFocus()
  })

  it('a collapsed lane is listed as collapsed; picking it expands it, then opens the input', async () => {
    setBoard([LANES[0], { ...LANES[1], is_collapsed: true }])
    localStorage.setItem('board:1:view-prefs', JSON.stringify({ collapsedSwimlaneIds: [21] }))
    render(<BoardView />)
    expect(screen.queryByTestId('cell-21-10')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('column-add-card'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Mobile (collapsed)' }))
    expect(await screen.findByTestId('cell-21-10')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('cell-21-10')).toHaveAttribute('data-adding', 'true'))
  })

  it('+ still shows when every lane is collapsed (single lane expands then opens)', async () => {
    setBoard([{ ...LANES[0], is_collapsed: true }])
    localStorage.setItem('board:1:view-prefs', JSON.stringify({ collapsedSwimlaneIds: [20] }))
    render(<BoardView />)
    await userEvent.click(screen.getByTestId('column-add-card'))
    await waitFor(() => expect(screen.getByTestId('cell-20-10')).toHaveAttribute('data-adding', 'true'))
  })

  it('flips the lane menu to right-aligned when it would run past the viewport edge', async () => {
    setBoard(LANES)
    const prev = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 200, configurable: true })
    try {
      render(<BoardView />)
      await userEvent.click(screen.getByTestId('column-add-card'))
      const menu = screen.getByRole('menu', { name: 'Add card to which swimlane?' })
      expect(menu.style.right).not.toBe('')
      expect(menu.style.left).toBe('')
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: prev, configurable: true })
    }
  })

  describe('lane cells that mount a frame late', () => {
    afterEach(() => { lateCells.on = false; vi.restoreAllMocks() })

    function collapsedLaneBoard() {
      setBoard([LANES[0], { ...LANES[1], is_collapsed: true }])
      localStorage.setItem('board:1:view-prefs', JSON.stringify({ collapsedSwimlaneIds: [21] }))
    }

    it('retries on the next animation frame, then opens the input', async () => {
      collapsedLaneBoard()
      lateCells.on = true
      render(<BoardView />)
      const frames: FrameRequestCallback[] = []
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb))
      await userEvent.click(screen.getByTestId('column-add-card'))
      await userEvent.click(screen.getByRole('menuitem', { name: 'Mobile (collapsed)' }))
      await screen.findByTestId('cell-21-10')
      expect(frames.length).toBeGreaterThan(0)
      expect(screen.getByTestId('cell-21-10')).not.toHaveAttribute('data-adding')
      act(() => { frames.forEach((cb) => cb(0)) })
      expect(screen.getByTestId('cell-21-10')).toHaveAttribute('data-adding', 'true')
    })

    it('cancels the pending frame when the board unmounts first', async () => {
      collapsedLaneBoard()
      lateCells.on = true
      const view = render(<BoardView />)
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 4242)
      const cancel = vi.spyOn(window, 'cancelAnimationFrame')
      await userEvent.click(screen.getByTestId('column-add-card'))
      await userEvent.click(screen.getByRole('menuitem', { name: 'Mobile (collapsed)' }))
      await screen.findByTestId('cell-21-10')
      // Clear first: the effect cleanup also runs on dependency changes, so only a call made by
      // the unmount itself proves the pending frame is canceled with the board.
      cancel.mockClear()
      view.unmount()
      expect(cancel).toHaveBeenCalledWith(4242)
    })
  })

  it('keeps arrow-key focus in the lane menu when the board reloads with new swimlane objects', async () => {
    setBoard(LANES)
    const { rerender } = render(<BoardView />)
    await userEvent.click(screen.getByTestId('column-add-card'))
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Mobile' })).toHaveFocus()
    // A WebSocket update replaces board.swimlanes with equal-content copies.
    setBoard(LANES.map((l) => ({ ...l })))
    rerender(<BoardView />)
    // The menu's focus-first-item effect runs on a 0ms timer; let it fire before asserting.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.getByRole('menuitem', { name: 'Mobile' })).toHaveFocus()
  })

  it('no + for a column that disallows card creation', () => {
    setBoard(LANES, { columns: [{ ...makeBoard().columns[0], allow_card_creation: false }] })
    render(<BoardView />)
    expect(screen.queryByTestId('column-add-card')).not.toBeInTheDocument()
  })
})
