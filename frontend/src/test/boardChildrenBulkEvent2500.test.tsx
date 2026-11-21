/**
 * #2500: BoardView's `card.children_bulk_changed` handler. A child-board
 * column change sends one frame per parent board, `{parent_ids}` or
 * `{parent_ids: [], reload: true}` above the cap; the parent cards shown here
 * re-read their per-viewer rollup, exactly as on `card.children_changed`.
 *
 * Kept out of boardSocketEvents.test.tsx so it does not collide with other
 * open branches editing that file; the mock setup below is copied from it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
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
})
