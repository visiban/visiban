/**
 * #2500: BoardView's `card.children_bulk_changed` handler. A child-board
 * column change sends one frame per parent board, `{parent_ids}` or
 * `{parent_ids: [], reload: true}` above the cap; the parent cards shown here
 * re-read their per-viewer rollup, exactly as on `card.children_changed`.
 *
 * Kept out of boardSocketEvents.test.tsx so it does not collide with other
 * open branches editing that file; the mock setup below is copied from it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, screen, within, fireEvent } from '@testing-library/react'
import { boardStateMessage } from '../hooks/useLiveAnnouncer'
import BoardView from '../components/Board/BoardView'
import * as cardsApi from '../api/cards'
import type { BoardEvent } from '../hooks/useBoardSocket'
import type { BoardFull, Card, User } from '../types'
import type { BoardContextType } from '../contexts/BoardContext'

// ---------------------------------------------------------------------------
// Capture onEvent from useBoardSocket so tests can dispatch events
// ---------------------------------------------------------------------------

const { getOnEvent } = vi.hoisted(() => {
  let _onEvent: ((e: BoardEvent) => void) | null = null
  let _onReconnected: (() => void) | undefined
  return {
    getOnEvent: {
      capture: (cb: (e: BoardEvent) => void, onReconnected?: () => void) => { _onEvent = cb; _onReconnected = onReconnected },
      dispatch: (e: BoardEvent) => _onEvent?.(e),
      reconnect: () => _onReconnected?.(),
    },
  }
})

let mockSearchParams = new URLSearchParams()
vi.mock('../hooks/useBoardSocket', () => ({
  useBoardSocket: (_boardId: number, onEvent: (e: BoardEvent) => void, options?: { onReconnected?: () => void }) => {
    getOnEvent.capture(onEvent, options?.onReconnected)
    return { connected: true, status: 'connected', lastEventAt: null, reconnectAttempt: 0 }
  },
}))

// ---------------------------------------------------------------------------
// Standard test infrastructure mocks (same as boardView.test.tsx)
// ---------------------------------------------------------------------------

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
const { mockLocationState, liveParams } = vi.hoisted(() => ({
  mockLocationState: { current: null as unknown },
  // Opt-in (#2370 audit): when `on`, setSearchParams really updates `mockSearchParams` and re-renders, so a test
  // can walk Cards -> Focus -> Children -> back. Off, the setter is a no-op as every other test here expects.
  liveParams: { on: false, version: 0, listeners: new Set<() => void>() },
}))
vi.mock('react-router-dom', async () => {
  const React = await import('react')
  const subscribe = (l: () => void) => { liveParams.listeners.add(l); return () => { liveParams.listeners.delete(l) } }
  const set = (next: URLSearchParams | ((p: URLSearchParams) => URLSearchParams)) => {
    mockSearchParams = typeof next === 'function' ? next(new URLSearchParams(mockSearchParams)) : new URLSearchParams(next)
    liveParams.version += 1
    liveParams.listeners.forEach((l) => l())
  }
  return {
  // BoardView reads navigation state for the board-invite joined notice (#1444).
  useLocation: () => ({ pathname: '/', search: '', hash: '', state: mockLocationState.current, key: 'default' }),
  useSearchParams: () => {
    React.useSyncExternalStore(subscribe, () => liveParams.version)
    return [mockSearchParams, liveParams.on ? set : vi.fn()]
  },
  useNavigate: () => vi.fn(),
  useInRouterContext: () => false,
  Link: ({ to, children, ...rest }: { to: string; children?: React.ReactNode }) => <a href={to} {...rest}>{children}</a>,
  }
})
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
  default: ({ swimlane, collapsed, onFocus, childrenAction, onExitFocus: _onExitFocus, compact: _compact }: { swimlane: { id: number; name: string }; collapsed?: boolean; onFocus?: (id: number) => void; childrenAction?: { onOpen: () => void }; onExitFocus?: () => void; compact?: boolean }) => (
    <div data-testid={`lane-${swimlane.id}`} data-collapsed={String(!!collapsed)}>
      {swimlane.name}
      <button type="button" data-testid={`lane-focus-${swimlane.id}`} onClick={() => onFocus?.(swimlane.id)} />
      <button type="button" data-testid={`lane-children-${swimlane.id}`} onClick={() => childrenAction?.onOpen()} />
    </div>
  ),
}))
vi.mock('../components/Card/CardItem', () => ({ default: () => <div /> }))
vi.mock('../components/Card/CardDetail', () => ({
  default: ({ refreshSignal, childrenRefreshSignal }: { refreshSignal?: number; childrenRefreshSignal?: number }) => (
    <div data-testid="card-detail" data-refresh-signal={refreshSignal ?? 0} data-children-refresh-signal={childrenRefreshSignal ?? 0} />
  ),
}))
const settingsDeleteHooks: { deleting?: () => void; failed?: () => void } = {}
vi.mock('../components/Board/AddColumnModal', () => ({ default: () => <div /> }))
vi.mock('../components/Swimlane/AddSwimlaneModal', () => ({ default: () => <div /> }))
vi.mock('../components/Board/BoardSettingsModal', () => ({
  default: ({ inviteReloadSignal, shareLinkIssuedAt, webhookChange, webhookReconnectSignal, onBoardDeleting, onBoardDeleteFailed }: { inviteReloadSignal?: number; shareLinkIssuedAt?: string | null; webhookChange?: { id: number; seq: number } | null; webhookReconnectSignal?: number; onBoardDeleting?: () => void; onBoardDeleteFailed?: () => void }) => (
    <div
      data-testid="settings-modal"
      data-on-deleting={String(!!onBoardDeleting)}
      ref={() => { settingsDeleteHooks.deleting = onBoardDeleting; settingsDeleteHooks.failed = onBoardDeleteFailed }}
      data-invite-signal={inviteReloadSignal ?? 0}
      data-share-issued-at={shareLinkIssuedAt ?? ''}
      data-webhook-change={webhookChange ? `${webhookChange.id}:${webhookChange.seq}` : ''}
      data-webhook-reconnect={String(webhookReconnectSignal ?? '')}
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
    health_status: null, effective_health_status: null, health_status_source: null, health_status_changed_at: null, health_status_changed_by: null, health_status_note: null, health_review_days: null, health_review_due_at: null, health_auto_enabled: false, health_off_track_cards: 3, computed_health_status: null, health_computed_at: null, health_computed_counts: null, health_status_origin: null, default_preset: null,
    swimlane_rollup_field: null,
    commitment_column_uid: null,
    time_zone: null,
    cards_can_have_children: false,
    default_child_board: null,
    parent_name_singular: "",
    parent_name_plural: "",
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0,
    columns: [
      { id: 10, uid: 'col001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
      { id: 11, uid: 'col002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
    ],
    swimlanes: [
      { id: 20, uid: 'lane001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null },
    ],
    cards: [],
    labels: [{ id: 100, uid: 'lbl001', name: 'Bug', color: '#EF4444' }],
    members: [{ id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7,
    stale_warning_pct: 50,
    allowed_priorities: ['low', 'medium', 'high', 'urgent'],
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

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'crd001', column: 10, swimlane: 20, title: 'Test Card', description: '',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: 0, created_by: fakeUser, created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z', last_moved_at: null,
    attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
    version: 1, custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
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
    applyFieldSets: vi.fn(),
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
    applyCardParents: vi.fn(),
    applyCardChildrenRollups: vi.fn(),
    silentReload: vi.fn(),
    ...overrides,
  }
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BoardView — card.children_bulk_changed (#2500)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const rollup = { visible: true as const, total: 2, done: 2, doing: 0, todo: 0, blocked: 0, last_moved_at: null }
  const parentBoard = () => makeBoard({
    cards_can_have_children: true,
    cards: [makeCard({ id: 7 }), makeCard({ id: 8, uid: 'crd008' })],
  })

  it('re-reads the rollup of each listed parent shown on the board, and only those', async () => {
    const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue(rollup)
    const ctx = makeContext({ board: parentBoard() })
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    await act(async () => {
      getOnEvent.dispatch({ event: 'card.children_bulk_changed', data: { parent_ids: [7, 8, 99, 'x'] } })
    })
    expect(spy.mock.calls.map((c) => c[1]).sort()).toEqual([7, 8])
    expect(ctx.applyCardChildrenRollups).toHaveBeenCalledWith(new Map([[7, rollup]]))
    expect(ctx.applyCardChildrenRollups).toHaveBeenCalledWith(new Map([[8, rollup]]))
    expect(ctx.silentReload).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('reloads the board silently above the cap and reads no single rollup', async () => {
    const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue(rollup)
    const ctx = makeContext({ board: parentBoard() })
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'card.children_bulk_changed', data: { parent_ids: [], reload: true } }) })
    expect(ctx.silentReload).toHaveBeenCalledTimes(1)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('ignores a malformed frame', async () => {
    const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue(rollup)
    const ctx = makeContext({ board: parentBoard() })
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'card.children_bulk_changed', data: { parent_ids: 7 } }) })
    act(() => { getOnEvent.dispatch({ event: 'card.children_bulk_changed', data: { reload: 'yes' } }) })
    expect(spy).not.toHaveBeenCalled()
    expect(ctx.silentReload).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('reads each shown parent once however often it is listed', async () => {
    const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue(rollup)
    const ctx = makeContext({ board: parentBoard() })
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    await act(async () => {
      getOnEvent.dispatch({ event: 'card.children_bulk_changed', data: { parent_ids: [7, 7, 8, 7, 8] } })
    })
    expect(spy.mock.calls.map((c) => c[1]).sort()).toEqual([7, 8])
    spy.mockRestore()
  })

  it('reloads instead of reading card by card when more than 20 listed parents are shown', async () => {
    const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue(rollup)
    const cards = Array.from({ length: 21 }, (_, i) => makeCard({ id: 100 + i, uid: `crd1${i}` }))
    const ctx = makeContext({ board: makeBoard({ cards_can_have_children: true, cards }) })
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const ids = cards.map((c) => c.id)
    act(() => { getOnEvent.dispatch({ event: 'card.children_bulk_changed', data: { parent_ids: ids.slice(0, 20) } }) })
    expect(ctx.silentReload).not.toHaveBeenCalled()
    expect(spy).toHaveBeenCalledTimes(20)
    spy.mockClear()
    act(() => { getOnEvent.dispatch({ event: 'card.children_bulk_changed', data: { parent_ids: [...ids, ...ids, 9999] } }) })
    expect(ctx.silentReload).toHaveBeenCalledTimes(1)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it("refreshes the open parent's Children tab when listed, or on reload, and not otherwise", async () => {
    const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue(rollup)
    mockBoardContextValue = makeContext({ board: parentBoard() })
    render(<BoardView />)
    await act(async () => {})
    act(() => { window.dispatchEvent(new CustomEvent('visiban:open-card', { detail: { cardId: 7 } })) })
    const signal = () => screen.getByTestId('card-detail').getAttribute('data-children-refresh-signal')
    await act(async () => { getOnEvent.dispatch({ event: 'card.children_bulk_changed', data: { parent_ids: [8] } }) })
    expect(signal()).toBe('0')
    await act(async () => { getOnEvent.dispatch({ event: 'card.children_bulk_changed', data: { parent_ids: [7, 8] } }) })
    expect(signal()).toBe('1')
    await act(async () => { getOnEvent.dispatch({ event: 'card.children_bulk_changed', data: { parent_ids: [], reload: true } }) })
    expect(signal()).toBe('2')
    expect(screen.getByTestId('card-detail').getAttribute('data-refresh-signal')).toBe('0')
    spy.mockRestore()
  })
})

describe('BoardView — Children lane counts re-read live, throttled (#2370 item 9)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('re-reads the children view once for a burst of count-changing events, and not for card.updated', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // Pin the up-to-500ms jitter to 0: two random waits can sum past the 2,100ms this test advances (a real flake).
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const empty = { board_total: { in_progress: 0, total: 0, blocked: 0, hidden: 0, planned: 0 }, lanes: [], rows: [], child_boards: [], next_cursor: null }
    const spy = vi.spyOn(cardsApi, 'getChildrenView').mockResolvedValue(empty)
    vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue({ visible: true, total: 0, done: 0, doing: 0, todo: 0, blocked: 0, last_moved_at: null })
    try {
      mockBoardContextValue = makeContext({ board: makeBoard({ cards_can_have_children: true, cards: [makeCard({ id: 7 })] }) })
      render(<BoardView />)
      await act(async () => {})
      const before = spy.mock.calls.length
      expect(before).toBeGreaterThan(0)
      await act(async () => {
        getOnEvent.dispatch({ event: 'card.children_bulk_changed', data: { parent_ids: [7] } })
        getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 7 } })
        getOnEvent.dispatch({ event: 'card.parent_changed', data: { card_ids: [7] } })
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(510) })
      expect(spy.mock.calls.length).toBe(before + 1)
      // Within the window a second burst waits for its trailing read.
      await act(async () => { getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 7 } }) })
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      expect(spy.mock.calls.length).toBe(before + 1)
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(spy.mock.calls.length).toBe(before + 2)
      await act(async () => { getOnEvent.dispatch({ event: 'card.updated', data: makeCard({ id: 7 }) as never }) })
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(spy.mock.calls.length).toBe(before + 2)
    } finally {
      vi.useRealTimers()
      spy.mockRestore()
      random.mockRestore()
    }
  })

  it('a card without children moving, or a new card, reads nothing; a parent moving reads once (#2370 fix A12)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const empty = { board_total: { in_progress: 0, total: 0, blocked: 0, hidden: 0, planned: 0 }, lanes: [], rows: [], child_boards: [], next_cursor: null }
    const spy = vi.spyOn(cardsApi, 'getChildrenView').mockResolvedValue(empty)
    vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue({ visible: true, total: 0, done: 0, doing: 0, todo: 0, blocked: 0, last_moved_at: null })
    try {
      const leaf = makeCard({ id: 7, children_rollup: { visible: true, total: 0, done: 0, doing: 0, todo: 0, blocked: 0, last_moved_at: null } })
      const parent = makeCard({ id: 8, children_rollup: { visible: true, total: 2, done: 0, doing: 1, todo: 1, blocked: 0, last_moved_at: null } })
      mockBoardContextValue = makeContext({ board: makeBoard({ cards_can_have_children: true, cards: [leaf, parent] }) })
      render(<BoardView />)
      await act(async () => {})
      const before = spy.mock.calls.length
      // The Cards-mode lane counts read counts only.
      expect(spy.mock.calls[0][1]).toEqual({ lane: null, countsOnly: true })
      await act(async () => {
        getOnEvent.dispatch({ event: 'card.moved', data: { card: leaf, movement: {} } as never })
        getOnEvent.dispatch({ event: 'card.created', data: makeCard({ id: 9 }) as never })
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(spy.mock.calls.length).toBe(before)
      await act(async () => { getOnEvent.dispatch({ event: 'card.moved', data: { card: parent, movement: {} } as never }) })
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(spy.mock.calls.length).toBe(before + 1)
    } finally {
      vi.useRealTimers()
      spy.mockRestore()
      random.mockRestore()
    }
  })

  // #2370 broadcast audit: a parent column's reorder can release planned children, a delete drops rows, a rename
  // changes each row's column name; each re-reads once.
  it.each([
    ['column.reordered', { order: [11, 10] }],
    ['column.deleted', { id: 11 }],
    ['column.updated', { id: 10, uid: 'col001', name: 'Backlog', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null }],
  ])('%s re-reads the children view once (#2370 audit)', async (evt, data) => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const empty = { board_total: { in_progress: 0, total: 0, blocked: 0, hidden: 0, planned: 0 }, lanes: [], rows: [], child_boards: [], next_cursor: null }
    const spy = vi.spyOn(cardsApi, 'getChildrenView').mockResolvedValue(empty)
    vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue({ visible: true, total: 0, done: 0, doing: 0, todo: 0, blocked: 0, last_moved_at: null })
    try {
      mockBoardContextValue = makeContext({ board: makeBoard({ cards_can_have_children: true, cards: [makeCard({ id: 7 })] }) })
      render(<BoardView />)
      await act(async () => {})
      const before = spy.mock.calls.length
      await act(async () => { getOnEvent.dispatch({ event: evt, data } as never) })
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(spy.mock.calls.length).toBe(before + 1)
    } finally {
      vi.useRealTimers()
      spy.mockRestore()
      random.mockRestore()
    }
  })

  it("card.updated re-reads only when a parent's title or assignee changed, judged before the frame applies (#2370 audit)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const empty = { board_total: { in_progress: 0, total: 0, blocked: 0, hidden: 0, planned: 0 }, lanes: [], rows: [], child_boards: [], next_cursor: null }
    const spy = vi.spyOn(cardsApi, 'getChildrenView').mockResolvedValue(empty)
    vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue({ visible: true, total: 0, done: 0, doing: 0, todo: 0, blocked: 0, last_moved_at: null })
    try {
      const leaf = makeCard({ id: 7, children_rollup: { visible: true, total: 0, done: 0, doing: 0, todo: 0, blocked: 0, last_moved_at: null } })
      const parent = makeCard({ id: 8, uid: 'crd008', children_rollup: { visible: true, total: 2, done: 0, doing: 1, todo: 1, blocked: 0, last_moved_at: null } })
      const ctx = makeContext({ board: makeBoard({ cards_can_have_children: true, cards: [leaf, parent] }) })
      mockBoardContextValue = ctx
      render(<BoardView />)
      await act(async () => {})
      const before = spy.mock.calls.length
      const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(3000) }) }
      // A comment on the parent (same title and assignee) and a leaf renamed: nothing.
      await act(async () => { getOnEvent.dispatch({ event: 'card.updated', data: { ...parent } as never }) })
      await act(async () => { getOnEvent.dispatch({ event: 'card.updated', data: { ...leaf, title: 'Renamed leaf' } as never }) })
      await settle()
      expect(spy.mock.calls.length).toBe(before)
      // The frame is still applied either way.
      expect(ctx.updateCard).toHaveBeenCalled()
      // The parent renamed: one re-read.
      await act(async () => { getOnEvent.dispatch({ event: 'card.updated', data: { ...parent, title: 'Hooli: rollout' } as never }) })
      await settle()
      expect(spy.mock.calls.length).toBe(before + 1)
      // The parent reassigned: one more.
      await act(async () => { getOnEvent.dispatch({ event: 'card.updated', data: { ...parent, assignee: fakeUser } as never }) })
      await settle()
      expect(spy.mock.calls.length).toBe(before + 2)
    } finally {
      vi.useRealTimers()
      spy.mockRestore()
      random.mockRestore()
    }
  })

  it('a hidden tab reads nothing until it is shown again, then reads once', async () => {
    const empty = { board_total: { in_progress: 0, total: 0, blocked: 0, hidden: 0, planned: 0 }, lanes: [], rows: [], child_boards: [], next_cursor: null }
    const spy = vi.spyOn(cardsApi, 'getChildrenView').mockResolvedValue(empty)
    vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue({ visible: true, total: 0, done: 0, doing: 0, todo: 0, blocked: 0, last_moved_at: null })
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    try {
      mockBoardContextValue = makeContext({ board: makeBoard({ cards_can_have_children: true, cards: [makeCard({ id: 7 })] }) })
      render(<BoardView />)
      await act(async () => {})
      const before = spy.mock.calls.length
      await act(async () => { getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 7 } }) })
      await act(async () => { await new Promise((r) => setTimeout(r, 600)) })
      expect(spy.mock.calls.length).toBe(before)
      hidden.mockReturnValue(false)
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      await act(async () => { await new Promise((r) => setTimeout(r, 600)) })
      expect(spy.mock.calls.length).toBe(before + 1)
    } finally {
      hidden.mockRestore()
      spy.mockRestore()
    }
  })

  it('never re-reads on a board where cards cannot have children', async () => {
    const spy = vi.spyOn(cardsApi, 'getChildrenView')
    mockBoardContextValue = makeContext({ board: makeBoard({ cards: [makeCard({ id: 7 })] }) })
    render(<BoardView />)
    await act(async () => {})
    await act(async () => { getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 7 } }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('BoardView — Children mode shows only the controls it honors (#2370 regression-check)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockSearchParams = new URLSearchParams() })

  it('hides the Show chips in Children mode and keeps them in Cards mode', async () => {
    const empty = { board_total: { in_progress: 0, total: 0, blocked: 0, hidden: 0, planned: 0 }, lanes: [], rows: [], child_boards: [], next_cursor: null }
    const spy = vi.spyOn(cardsApi, 'getChildrenView').mockResolvedValue(empty)
    vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue({ visible: true, total: 0, done: 0, doing: 0, todo: 0, blocked: 0, last_moved_at: null })
    try {
      mockBoardContextValue = makeContext({ board: makeBoard({ cards_can_have_children: true, cards: [makeCard({ id: 7 })] }) })
      const { unmount } = render(<BoardView />)
      await act(async () => {})
      expect(screen.getByTestId('show-chips')).toBeInTheDocument()
      unmount()
      mockSearchParams = new URLSearchParams('show=children')
      render(<BoardView />)
      await act(async () => {})
      expect(screen.queryByTestId('show-chips')).toBeNull()
    } finally {
      spy.mockRestore()
      mockSearchParams = new URLSearchParams()
    }
  })

  it('hides the "Focused on" banner in Children mode and keeps it in Cards mode (#2370)', async () => {
    const empty = { board_total: { in_progress: 0, total: 0, blocked: 0, hidden: 0, planned: 0 }, lanes: [], rows: [], child_boards: [], next_cursor: null }
    const spy = vi.spyOn(cardsApi, 'getChildrenView').mockResolvedValue(empty)
    vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue({ visible: true, total: 0, done: 0, doing: 0, todo: 0, blocked: 0, last_moved_at: null })
    try {
      mockBoardContextValue = makeContext({ board: makeBoard({ cards_can_have_children: true, cards: [makeCard({ id: 7 })] }) })
      mockSearchParams = new URLSearchParams('focus=20')
      const { unmount } = render(<BoardView />)
      await act(async () => {})
      expect(screen.getByText('Focused on:')).toBeInTheDocument()
      unmount()
      mockSearchParams = new URLSearchParams('show=children&focus=20')
      render(<BoardView />)
      await act(async () => {})
      expect(screen.getByTestId('children-mode')).toBeInTheDocument()
      expect(screen.queryByText('Focused on:')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Exit focus' })).toBeNull()
    } finally {
      spy.mockRestore()
      mockSearchParams = new URLSearchParams()
    }
  })

  it('hides the Filters button, the filter row and the grid shortcuts in Children mode; the Show control carries ActiveMark (#2370 fix A8, A9, A11)', async () => {
    const empty = { board_total: { in_progress: 0, total: 0, blocked: 0, hidden: 0, planned: 0 }, lanes: [], rows: [], child_boards: [], next_cursor: null }
    const spy = vi.spyOn(cardsApi, 'getChildrenView').mockResolvedValue(empty)
    vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue({ visible: true, total: 0, done: 0, doing: 0, todo: 0, blocked: 0, last_moved_at: null })
    const board = makeBoard({ cards_can_have_children: true, cards: [makeCard({ id: 7 })] })
    const collapsedAll = boardStateMessage(true, board.swimlanes.length, board.columns.length)
    try {
      mockBoardContextValue = makeContext({ board })
      const { unmount } = render(<BoardView />)
      await act(async () => {})
      expect(screen.getByRole('button', { name: /^Filters/ })).toBeInTheDocument()
      unmount()
      mockSearchParams = new URLSearchParams('show=children')
      render(<BoardView />)
      await act(async () => {})
      expect(screen.queryByRole('button', { name: /^Filters/ })).toBeNull()
      expect(within(within(screen.getByTestId('show-mode')).getByRole('button', { name: 'Children' })).getByTestId('active-mark')).toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'e' })
      fireEvent.keyDown(document, { key: 'c' })
      await act(async () => {})
      expect(screen.queryByText(collapsedAll)).toBeNull()
    } finally {
      spy.mockRestore()
      mockSearchParams = new URLSearchParams()
    }
  })

  it('a remembered Children mode renders Children mode at once and never reads the Cards-mode counts (#2370 fix A12)', async () => {
    const empty = { board_total: { in_progress: 0, total: 0, blocked: 0, hidden: 0, planned: 0 }, lanes: [], rows: [], child_boards: [], next_cursor: null }
    const spy = vi.spyOn(cardsApi, 'getChildrenView').mockResolvedValue(empty)
    vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue({ visible: true, total: 0, done: 0, doing: 0, todo: 0, blocked: 0, last_moved_at: null })
    const board = makeBoard({ cards_can_have_children: true, cards: [makeCard({ id: 7 })] })
    localStorage.setItem(`board:${board.id}:show-mode`, 'children')
    try {
      mockBoardContextValue = makeContext({ board })
      render(<BoardView />)
      await act(async () => {})
      expect(screen.getByTestId('children-mode')).toBeInTheDocument()
      expect(spy.mock.calls.some((c) => (c[1] as { countsOnly?: boolean }).countsOnly)).toBe(false)
    } finally {
      localStorage.clear()
      spy.mockRestore()
    }
  })
})

// The audit suspected these paths left the grid collapsed; they do not (the focusedSwimlaneId effect runs exitFocus
// on every focused-to-none change). Kept as regression guards: nothing else walked Cards -> Focus -> Children -> Cards.
describe('BoardView — leaving Focus from Children mode restores the grid (#2370 audit)', () => {
  const lanes = [
    { id: 20, uid: 'lane001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null },
    { id: 21, uid: 'lane002', name: 'Customer B', contact_email: '', notes: '', position: 1, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null },
  ]
  const laneRow = { id: 20, name: 'Customer A', position: 0, parents: 1, child_boards: 1, total: 1, in_progress: 1, done: 0, doing: 0, todo: 1, blocked: 0, hidden: 0, folded: 0, planned_only: 0, planned: 0, last_moved_at: null }
  const view = { board_total: { in_progress: 1, total: 1, blocked: 0, hidden: 0, planned: 0 }, lanes: [laneRow], rows: [], child_boards: [], next_cursor: null }
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); mockSearchParams = new URLSearchParams(); liveParams.on = true })
  afterEach(() => { liveParams.on = false; mockSearchParams = new URLSearchParams(); localStorage.clear() })

  const setup = async () => {
    vi.spyOn(cardsApi, 'getChildrenView').mockResolvedValue(view as never)
    vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue({ visible: true, total: 0, done: 0, doing: 0, todo: 0, blocked: 0, last_moved_at: null })
    mockBoardContextValue = makeContext({ board: makeBoard({ cards_can_have_children: true, swimlanes: lanes, cards: [makeCard({ id: 7 })] }) })
    render(<BoardView />)
    await act(async () => {})
    expect(screen.getByTestId('lane-21').dataset.collapsed).toBe('false')
    // Focus on Customer A in Cards mode collapses Customer B.
    await act(async () => { fireEvent.click(screen.getByTestId('lane-focus-20')) })
    expect(mockSearchParams.get('focus')).toBe('20')
  }
  const show = (name: 'Cards' | 'Children') => within(screen.getByTestId('show-mode')).getByRole('button', { name })
  const backToCards = async () => {
    await act(async () => { fireEvent.click(show('Cards')) })
    expect(mockSearchParams.get('focus')).toBeNull()
    expect(screen.getByTestId('lane-21').dataset.collapsed).toBe('false')
    expect(screen.getByTestId('lane-20').dataset.collapsed).toBe('false')
  }

  it('un-pressing Focus in Children mode restores the pre-focus collapse state', async () => {
    await setup()
    await act(async () => { fireEvent.click(show('Children')) })
    const focus = await screen.findByRole('button', { name: 'Focus on Customer A' })
    expect(focus).toHaveAttribute('aria-pressed', 'true')
    await act(async () => { fireEvent.click(focus) })
    await backToCards()
  })

  it("a lane's Children action, which clears Focus, restores it too", async () => {
    await setup()
    await act(async () => { fireEvent.click(screen.getByTestId('lane-children-20')) })
    expect(mockSearchParams.get('show')).toBe('children')
    await backToCards()
  })
})
