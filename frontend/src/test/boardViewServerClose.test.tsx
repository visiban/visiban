/**
 * BoardView drives the REAL useBoardSocket here (a fake WebSocket), to prove a
 * server-sent normal close (member removed, #2041) re-reads the board, and that
 * BoardView's own unmount close does not. Also covers the first-open resync
 * (#1968): a socket that opens long after `/full/` returned re-reads once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import BoardView from '../components/Board/BoardView'
import type { BoardFull, User } from '../types'
import type { BoardContextType } from '../contexts/BoardContext'


// ---------------------------------------------------------------------------
// Standard test infrastructure mocks (same as boardView.test.tsx)
// ---------------------------------------------------------------------------

// The DndContext mock records its drag handlers so the first-open resync test
// (#1968) can start and end a column drag directly.
const { dndHandlers } = vi.hoisted(() => ({
  dndHandlers: {} as { start?: (e: unknown) => void; end?: (e: unknown) => void },
}))
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragStart, onDragEnd }: { children: React.ReactNode; onDragStart?: (e: unknown) => void; onDragEnd?: (e: unknown) => void }) => {
    dndHandlers.start = onDragStart
    dndHandlers.end = onDragEnd
    return <div>{children}</div>
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MouseSensor: class { static activators = [] },
  TouchSensor: class {},
  KeyboardSensor: class {},
  closestCenter: vi.fn(),
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
const { mockLocationState } = vi.hoisted(() => ({ mockLocationState: { current: null as unknown } }))
vi.mock('react-router-dom', () => ({
  // BoardView reads navigation state for the board-invite joined notice (#1444).
  useLocation: () => ({ pathname: '/', search: '', hash: '', state: mockLocationState.current, key: 'default' }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => vi.fn(),
}))
vi.mock('../api/boards', () => ({
  exportBoardCsv: vi.fn(),
  exportBoardJson: vi.fn(),
}))
vi.mock('../components/Board/SummaryView', () => ({ default: () => <div /> }))
vi.mock('../components/Board/AnalyticsView', () => ({ default: () => <div /> }))
vi.mock('../components/Board/ColumnHeader', () => ({
  default: ({ column }: { column: { name: string } }) => <div>{column.name}</div>,
}))
vi.mock('../components/Board/SwimlaneRow', () => ({
  default: ({ swimlane, onExitFocus: _onExitFocus, compact: _compact }: { swimlane: { name: string }; onExitFocus?: () => void; compact?: boolean }) => <div>{swimlane.name}</div>,
}))
vi.mock('../components/Card/CardItem', () => ({ default: () => <div /> }))
vi.mock('../components/Card/CardDetail', () => ({
  default: ({ refreshSignal }: { refreshSignal?: number }) => (
    <div data-testid="card-detail" data-refresh-signal={refreshSignal ?? 0} />
  ),
}))
const settingsDeleteHooks: { deleting?: () => void; failed?: () => void } = {}
vi.mock('../components/Board/AddColumnModal', () => ({ default: () => <div /> }))
vi.mock('../components/Swimlane/AddSwimlaneModal', () => ({ default: () => <div /> }))
vi.mock('../components/Board/BoardSettingsModal', () => ({
  default: ({ inviteReloadSignal, shareLinkIssuedAt, onBoardDeleting, onBoardDeleteFailed }: { inviteReloadSignal?: number; shareLinkIssuedAt?: string | null; onBoardDeleting?: () => void; onBoardDeleteFailed?: () => void }) => (
    <div
      data-testid="settings-modal"
      data-on-deleting={String(!!onBoardDeleting)}
      ref={() => { settingsDeleteHooks.deleting = onBoardDeleting; settingsDeleteHooks.failed = onBoardDeleteFailed }}
      data-invite-signal={inviteReloadSignal ?? 0}
      data-share-issued-at={shareLinkIssuedAt ?? ''}
    />
  ),
}))
vi.mock('../components/Board/FilterBar', () => ({
  default: () => <div />,
  EMPTY_FILTER: { search: '', assigneeIds: [], labelIds: [], priorities: [], dueDate: null, customFields: {}, visibleCustomFieldFilterIds: [] },
  countActiveFilters: () => 0,
  isCustomFieldFilterActive: () => false,
}))
vi.mock('../components/Board/KeyboardShortcutsOverlay', () => ({ default: () => <div /> }))
vi.mock('../components/Board/BulkActionToolbar', () => ({ default: () => <div /> }))
// Hoisted spies so saved_filter.* socket tests can assert on the hook's
// refreshFilters / onSavedFilterEvicted callbacks (#1054).
const { mockRefreshFilters, mockOnSavedFilterEvicted } = vi.hoisted(() => ({
  mockRefreshFilters: vi.fn(),
  mockOnSavedFilterEvicted: vi.fn(),
}))
vi.mock('../hooks/useSavedFilters', () => ({
  useSavedFilters: () => ({
    savedFilters: [],
    loading: false,
    saveFilter: vi.fn(),
    removeFilter: vi.fn(),
    hydrateFilter: vi.fn(),
    refreshFilters: mockRefreshFilters,
    onSavedFilterEvicted: mockOnSavedFilterEvicted,
  }),
}))
vi.mock('../hooks/useCardSearch', () => ({
  useCardSearch: () => ({ searchMatchIds: null, isSearching: false, truncation: null }),
}))

// Board context mock — lets tests control what useBoardContext returns.
vi.mock('../utils/sessionProbe', () => ({ probeSession: vi.fn().mockResolvedValue(undefined) }))

let mockBoardContextValue: BoardContextType
vi.mock('../contexts/BoardContext', () => ({
  useBoardContext: () => mockBoardContextValue,
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeUser: User = {
  id: 1, username: 'alice', email: 'a@example.com', first_name: 'Alice',
  last_name: 'Smith', avatar_url: '', display_name: 'Alice Smith',
  is_site_admin: false, must_change_password: false, must_change_username: false,
  has_completed_tour: true,
}

function makeBoard(overrides: Partial<BoardFull> = {}): BoardFull {
  return {
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0,
    health_status: null, effective_health_status: null, health_status_source: null, health_status_changed_at: null, health_status_changed_by: null, health_status_note: null, default_preset: null,
    columns: [
      { id: 10, uid: 'col001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
      { id: 11, uid: 'col002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
    ],
    swimlanes: [
      { id: 20, uid: 'lane001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null },
    ],
    cards: [],
    labels: [{ id: 100, uid: 'lbl001', name: 'Bug', color: '#EF4444' }],
    members: [{ id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7,
    stale_warning_pct: 50,
    allowed_priorities: ['low', 'medium', 'high', 'urgent'],
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

function makeContext(overrides: Partial<BoardContextType> = {}): BoardContextType {
  return {
    board: makeBoard(),
    loading: false,
    error: null,
    reload: vi.fn(),
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
    silentReload: vi.fn(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------


type FakeWS = { onclose: ((e: { code: number }) => void) | null; onopen: (() => void) | null; close: ReturnType<typeof vi.fn> }
let sockets: FakeWS[]
class FakeWebSocket {
  onopen: (() => void) | null = null
  onmessage: unknown = null
  onclose: ((e: { code: number }) => void) | null = null
  close = vi.fn()
  constructor() { sockets.push(this as unknown as FakeWS) }
}

describe('BoardView with the real board socket (#2041)', () => {
  beforeEach(() => {
    sockets = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('re-reads the board when the server closes the socket with 1000', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    act(() => { sockets[0].onclose?.({ code: 1000 }) })
    expect(ctx.silentReload).toHaveBeenCalledTimes(1)
  })

  it("does not re-read while this session's own delete is in flight", async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    act(() => { window.dispatchEvent(new Event('visiban:open-settings')) })
    act(() => { settingsDeleteHooks.deleting?.() })
    act(() => { sockets[0].onclose?.({ code: 1000 }) })
    expect(ctx.silentReload).not.toHaveBeenCalled()
  })

  it('does not re-read for 4003 while this session is deleting the board', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    act(() => { window.dispatchEvent(new Event('visiban:open-settings')) })
    act(() => { settingsDeleteHooks.deleting?.() })
    act(() => { sockets[0].onclose?.({ code: 4003 }) })
    expect(ctx.silentReload).not.toHaveBeenCalled()
  })

  it('does not re-read when BoardView itself unmounts', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    const { unmount } = render(<BoardView />)
    await act(async () => {})
    unmount()
    expect(sockets[0].close).toHaveBeenCalledWith(1000)
    act(() => { sockets[0].onclose?.({ code: 1000 }) })
    expect(ctx.silentReload).not.toHaveBeenCalled()
  })
})

describe('BoardView first-open resync (#1968)', () => {
  const FETCHED_AT = 100_000
  let now: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    sockets = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    now = vi.spyOn(Date, 'now').mockReturnValue(FETCHED_AT)
  })
  afterEach(() => {
    now.mockRestore()
    vi.unstubAllGlobals()
  })

  async function openAfter(ms: number, overrides: Partial<BoardContextType> = {}) {
    const ctx = makeContext({ getLastFullFetchAt: () => FETCHED_AT, ...overrides })
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    now.mockReturnValue(FETCHED_AT + ms)
    act(() => { sockets[0].onopen?.() })
    return ctx
  }

  it('re-reads once when the socket first opens more than 1s after /full/', async () => {
    const ctx = await openAfter(1500)
    expect(ctx.silentReload).toHaveBeenCalledTimes(1)
  })

  it('does not re-read when the socket opens promptly after /full/', async () => {
    const ctx = await openAfter(200)
    expect(ctx.silentReload).not.toHaveBeenCalled()
  })

  it('does not re-read at exactly the threshold', async () => {
    const ctx = await openAfter(1000)
    expect(ctx.silentReload).not.toHaveBeenCalled()
  })

  it('re-reads when no /full/ time is known', async () => {
    const ctx = await openAfter(0, { getLastFullFetchAt: () => null })
    expect(ctx.silentReload).toHaveBeenCalledTimes(1)
  })

  it('re-reads when the context does not provide the fetch time', async () => {
    const ctx = await openAfter(0, { getLastFullFetchAt: undefined })
    expect(ctx.silentReload).toHaveBeenCalledTimes(1)
  })

  it('waits for an in-flight drag to end, then re-reads once', async () => {
    const ctx = makeContext({ getLastFullFetchAt: () => FETCHED_AT })
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    act(() => { dndHandlers.start?.({ active: { id: 'col:10' } }) })
    now.mockReturnValue(FETCHED_AT + 1500)
    act(() => { sockets[0].onopen?.() })
    expect(ctx.silentReload).not.toHaveBeenCalled()
    act(() => { dndHandlers.end?.({ active: { id: 'col:10' }, over: null }) })
    expect(ctx.silentReload).toHaveBeenCalledTimes(1)
  })

  it('leaves later reconnects to the reconnect resync, which always re-reads', async () => {
    const ctx = await openAfter(200)
    expect(ctx.silentReload).not.toHaveBeenCalled()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      act(() => { sockets[0].onclose?.({ code: 1006 }) })
      act(() => { vi.advanceTimersByTime(3000) })
      act(() => { sockets[1].onopen?.() })
      expect(ctx.silentReload).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
