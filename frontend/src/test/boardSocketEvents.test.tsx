/**
 * Tests for BoardView's handleSocketEvent — verifying that each new broadcast
 * event type (label.*, member.*, column.reordered, swimlane.reordered) is
 * routed to the correct prop callback.
 *
 * useBoardSocket is mocked to capture the onEvent callback so individual tests
 * can dispatch synthetic WebSocket events and assert which prop was called.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, screen } from '@testing-library/react'
import BoardView from '../components/Board/BoardView'
import * as cardsApi from '../api/cards'
import { useRollupLoading } from '../components/Card/rollupLoading'
import { ToastProvider } from '../contexts/ToastContext'
import type { BoardEvent } from '../hooks/useBoardSocket'
import type { BoardFull, Card, CardParent, Column, Label, BoardMembership, Swimlane, User } from '../types'
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
// Stands in for the card the rollup loading context feeds (#2210): parent 7.
function RollupProbe() {
  return useRollupLoading(7) ? <span data-testid="card-children-rollup-loading" /> : null
}
vi.mock('../components/Board/SwimlaneRow', () => ({
  default: ({ swimlane, onExitFocus: _onExitFocus, compact: _compact }: { swimlane: { name: string }; onExitFocus?: () => void; compact?: boolean }) => <div>{swimlane.name}<RollupProbe /></div>,
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

describe('BoardView socket event routing — new event types', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBoardContextValue = makeContext()
  })

  it('label.created routes to addLabel', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const label: Label = { id: 200, uid: 'lbl002', name: 'Feature', color: '#22C55E' }
    act(() => { getOnEvent.dispatch({ event: 'label.created', data: label as unknown as Record<string, unknown> }) })
    expect(ctx.addLabel).toHaveBeenCalledWith(expect.objectContaining({ id: 200, name: 'Feature' }))
  })

  it('label.updated routes to updateLabel', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const label: Label = { id: 100, uid: 'lbl001', name: 'Bug (renamed)', color: '#EF4444' }
    act(() => { getOnEvent.dispatch({ event: 'label.updated', data: label as unknown as Record<string, unknown> }) })
    expect(ctx.updateLabel).toHaveBeenCalledWith(expect.objectContaining({ id: 100, name: 'Bug (renamed)' }))
  })

  it('label.deleted routes to removeLabel with label_uid', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'label.deleted', data: { label_uid: 'lbl001' } }) })
    expect(ctx.removeLabel).toHaveBeenCalledWith('lbl001')
  })

  it('card.deleted routes to evictCardByUid with card_uid', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'card.deleted', data: { card_uid: 'crd001' } }) })
    expect(ctx.evictCardByUid).toHaveBeenCalledWith('crd001')
  })

  it('card.archived routes to archiveCardByUid with card_uid (#595, #1289)', async () => {
    // archiveCardByUid (not evictCardByUid) so the card moves into
    // archived_card_count, which the settings modal's delete gate reads.
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'card.archived', data: { card_uid: 'crd001' } }) })
    expect(ctx.archiveCardByUid).toHaveBeenCalledWith('crd001')
    expect(ctx.evictCardByUid).not.toHaveBeenCalled()
  })

  it('card.unarchived routes the restored card to unarchiveCard (#1054, #1289)', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const restored = { id: 5, uid: 'crd005', title: 'Restored card', column: 10, swimlane: 20 }
    act(() => { getOnEvent.dispatch({ event: 'card.unarchived', data: restored as unknown as Record<string, unknown> }) })
    expect(ctx.unarchiveCard).toHaveBeenCalledWith(expect.objectContaining({ id: 5, uid: 'crd005' }))
  })

  it('card.moved routes its nested card to updateCard, which owns the stale-version guard (#1969)', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const moved = { id: 5, uid: 'crd005', title: 'Moved card', column: 11, swimlane: 20, version: 4 }
    act(() => { getOnEvent.dispatch({ event: 'card.moved', data: { card: moved, movement: null } as unknown as Record<string, unknown> }) })
    // A frame from a pre-1.3 server has no sibling_positions: the card alone.
    expect(ctx.updateCard).toHaveBeenCalledWith(expect.objectContaining({ id: 5, version: 4 }), undefined, undefined)
  })

  it('card.moved passes sibling_positions to updateCard with the card (#1890)', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const moved = { id: 5, uid: 'crd005', title: 'Moved card', column: 11, swimlane: 20, version: 4 }
    const siblings = [{ id: 6, position: 2, version: 1 }, { id: 7, position: 0, version: 3 }]
    act(() => { getOnEvent.dispatch({ event: 'card.moved', data: { card: moved, sibling_positions: siblings } as unknown as Record<string, unknown>, event_id: 84213 }) })
    expect(ctx.updateCard).toHaveBeenCalledTimes(1)
    // The frame's event_id rides along: it orders frames that set one card's
    // position at the same version.
    expect(ctx.updateCard).toHaveBeenCalledWith(expect.objectContaining({ id: 5, version: 4 }), siblings, 84213)
  })

  it('custom_field frames pass updaters, so two frames before a re-render both survive (#1970)', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const def = (id: number, name: string) => ({ id, uid: `cf${id}`, name }) as unknown as Record<string, unknown>
    // created then updated, dispatched back-to-back with no re-render between.
    act(() => {
      getOnEvent.dispatch({ event: 'custom_field.created', data: def(1, 'A') })
      getOnEvent.dispatch({ event: 'custom_field.created', data: def(2, 'B') })
      getOnEvent.dispatch({ event: 'custom_field.updated', data: def(1, 'A2') })
    })
    const calls = (ctx.applyCustomFieldDefinitions as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(3)
    // Fold the updaters over a state the way React's setBoard queue would.
    let state: unknown[] = []
    for (const [arg] of calls) {
      expect(typeof arg).toBe('function')
      state = arg(state)
    }
    expect(state.map((f) => (f as { name: string }).name)).toEqual(['A2', 'B'])
    act(() => { getOnEvent.dispatch({ event: 'custom_field.deleted', data: { custom_field_uid: 'cf1' } }) })
    const last = (ctx.applyCustomFieldDefinitions as ReturnType<typeof vi.fn>).mock.calls[3][0]
    expect((last(state) as { id: number }[]).map((f) => f.id)).toEqual([2])
  })

  it('swimlane_custom_field frames pass updaters, so two frames before a re-render both survive (#1970)', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const def = (id: number, name: string) => ({ id, uid: `sf${id}`, name }) as unknown as Record<string, unknown>
    act(() => {
      getOnEvent.dispatch({ event: 'swimlane_custom_field.created', data: def(1, 'A') })
      getOnEvent.dispatch({ event: 'swimlane_custom_field.created', data: def(2, 'B') })
      getOnEvent.dispatch({ event: 'swimlane_custom_field.updated', data: def(2, 'B2') })
    })
    const calls = (ctx.applySwimlaneFieldDefinitions as ReturnType<typeof vi.fn>).mock.calls
    let state: unknown[] = []
    for (const [arg] of calls) {
      expect(typeof arg).toBe('function')
      state = arg(state)
    }
    expect(state.map((f) => (f as { name: string }).name)).toEqual(['A', 'B2'])
  })

  // useBoard replays these updaters over a /full/ snapshot that may already
  // list the field (#2130), so a created frame must replace, not duplicate.
  for (const [event, apply, prefix] of [
    ['custom_field.created', 'applyCustomFieldDefinitions', 'cf'],
    ['swimlane_custom_field.created', 'applySwimlaneFieldDefinitions', 'sf'],
  ] as const) {
    it(`${event} upserts, so replaying it over a list that has the field does not duplicate it (#2130)`, async () => {
      const ctx = makeContext()
      mockBoardContextValue = ctx
      render(<BoardView />)
      await act(async () => {})
      const def = (id: number, name: string) => ({ id, uid: `${prefix}${id}`, name }) as unknown as Record<string, unknown>
      act(() => { getOnEvent.dispatch({ event, data: def(1, 'Frame') }) })
      const updater = (ctx[apply] as ReturnType<typeof vi.fn>).mock.calls[0][0] as (prev: unknown[]) => unknown[]
      expect(updater([def(1, 'Snapshot'), def(2, 'B')]).map((f) => (f as { name: string }).name)).toEqual(['Frame', 'B'])
      expect(updater([def(2, 'B')]).map((f) => (f as { name: string }).name)).toEqual(['B', 'Frame'])
    })
  }

  it('swimlane.updated resolves the merge against the latest board, not a render capture (#1970)', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const incoming = { id: 7, uid: 'sl7', name: 'Renamed' } as unknown as Record<string, unknown>
    act(() => { getOnEvent.dispatch({ event: 'swimlane.updated', data: incoming }) })
    const arg = (ctx.updateSwimlane as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(typeof arg).toBe('function')
    const latest = makeBoard({
      swimlanes: [{ id: 7, uid: 'sl7', name: 'Old', contact_email: 'ops@acme.test' } as unknown as Swimlane],
    })
    expect(arg(latest)).toMatchObject({ id: 7, name: 'Renamed', contact_email: 'ops@acme.test' })
  })

  it('saved_filter.created refreshes the filter list for the owning user (#1054)', async () => {
    mockBoardContextValue = makeContext()
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'saved_filter.created', data: { filter_id: 9, user_id: fakeUser.id } }) })
    expect(mockRefreshFilters).toHaveBeenCalled()
  })

  it('saved_filter.created is ignored when the owning user is someone else (#1054)', async () => {
    mockBoardContextValue = makeContext()
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'saved_filter.created', data: { filter_id: 9, user_id: 999 } }) })
    expect(mockRefreshFilters).not.toHaveBeenCalled()
  })

  it('saved_filter.deleted evicts the filter for the owning user (#1054)', async () => {
    mockBoardContextValue = makeContext()
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'saved_filter.deleted', data: { filter_id: 9, user_id: fakeUser.id } }) })
    expect(mockOnSavedFilterEvicted).toHaveBeenCalledWith(9)
  })

  it('saved_filter.deleted is ignored when the owning user is someone else (#1054)', async () => {
    mockBoardContextValue = makeContext()
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'saved_filter.deleted', data: { filter_id: 9, user_id: 999 } }) })
    expect(mockOnSavedFilterEvicted).not.toHaveBeenCalled()
  })

  it('column.deleted routes to evictColumn with column_uid', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'column.deleted', data: { column_uid: 'col001' } }) })
    expect(ctx.evictColumn).toHaveBeenCalledWith('col001')
  })

  it('swimlane.deleted routes to evictSwimlane with swimlane_uid', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'swimlane.deleted', data: { swimlane_uid: 'lane001' } }) })
    expect(ctx.evictSwimlane).toHaveBeenCalledWith('lane001')
  })

  it('member.added routes to addMember', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const membership: BoardMembership = { id: 2, user: { ...fakeUser, id: 2, username: 'bob' }, role: 'member', is_moderator: false, joined_at: '' }
    act(() => { getOnEvent.dispatch({ event: 'member.added', data: membership as unknown as Record<string, unknown> }) })
    expect(ctx.addMember).toHaveBeenCalledWith(expect.objectContaining({ role: 'member' }))
  })

  it('member.updated routes to updateMember', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const membership: BoardMembership = { id: 1, user: fakeUser, role: 'viewer', is_moderator: false, joined_at: '' }
    act(() => { getOnEvent.dispatch({ event: 'member.updated', data: membership as unknown as Record<string, unknown> }) })
    expect(ctx.updateMember).toHaveBeenCalledWith(expect.objectContaining({ role: 'viewer' }))
  })

  it('member.updated syncs current_user_role when the updated member is the current user', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    // Admin is downgraded to viewer — their own membership is updated
    const membership: BoardMembership = { id: 1, user: fakeUser, role: 'viewer', is_moderator: false, joined_at: '' }
    act(() => { getOnEvent.dispatch({ event: 'member.updated', data: membership as unknown as Record<string, unknown> }) })
    expect(ctx.mergeBoardState).toHaveBeenCalledWith(expect.objectContaining({ current_user_role: 'viewer' }))
  })

  it('member.updated refetches the board when the current user own role changes (#1140)', async () => {
    // Swimlane state is merged from broadcasts, not replaced, so that an admin
    // does not lose their admin-only row values on an unrelated edit. That
    // same merge would otherwise keep those values alive in the tab of a user
    // who has just been demoted, since the socket is only closed on removal
    // from the board, never on a downgrade. The refetch reissues /full/ under
    // the new role and the server decides again what they may see.
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    const membership: BoardMembership = { id: 1, user: fakeUser, role: 'viewer', is_moderator: false, joined_at: '' }
    act(() => { getOnEvent.dispatch({ event: 'member.updated', data: membership as unknown as Record<string, unknown> }) })
    expect(ctx.silentReload).toHaveBeenCalled()
  })

  it('member.updated does not refetch when a different user role changes', async () => {
    const otherUser: User = { ...fakeUser, id: 99, username: 'bob', display_name: 'Bob' }
    // The subject's all-content flag is already known, so the frame needs no re-read.
    const ctx = makeContext({
      board: makeBoard({
        members: [{ id: 2, user: otherUser, role: 'viewer', is_moderator: false, has_all_content_access: false, joined_at: '' }],
      }),
    })
    mockBoardContextValue = ctx
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    const membership: BoardMembership = { id: 2, user: otherUser, role: 'viewer', is_moderator: false, is_site_admin: false, joined_at: '' }
    act(() => { getOnEvent.dispatch({ event: 'member.updated', data: membership as unknown as Record<string, unknown> }) })
    expect(ctx.silentReload).not.toHaveBeenCalled()
  })

  const flaglessMembership = (): BoardMembership => {
    const otherUser: User = { ...fakeUser, id: 99, username: 'bob', display_name: 'Bob' }
    return { id: 2, user: otherUser, role: 'viewer', is_moderator: false, joined_at: '' }
  }

  it('member.updated does not refetch for a viewer below admin when a different user role changes (flagless payload)', async () => {
    const ctx = makeContext({ board: makeBoard({ current_user_role: 'member' }) })
    mockBoardContextValue = ctx
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'member.updated', data: flaglessMembership() as unknown as Record<string, unknown> }) })
    act(() => { getOnEvent.dispatch({ event: 'member.added', data: flaglessMembership() as unknown as Record<string, unknown> }) })
    expect(ctx.silentReload).not.toHaveBeenCalled()
  })

  it('a flagless member.added / member.updated makes a board admin re-read the board once (#1706)', async () => {
    const ctx = makeContext({ board: makeBoard({ current_user_role: 'admin' }) })
    mockBoardContextValue = ctx
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'member.added', data: flaglessMembership() as unknown as Record<string, unknown> }) })
    expect(ctx.silentReload).toHaveBeenCalledTimes(1)
    // A second event inside the echo window does not re-read again.
    act(() => { getOnEvent.dispatch({ event: 'member.updated', data: flaglessMembership() as unknown as Record<string, unknown> }) })
    expect(ctx.silentReload).toHaveBeenCalledTimes(1)
  })

  it('a frame for a second unknown member inside the window earns one trailing re-read (#1301)', async () => {
    vi.useFakeTimers()
    try {
      const ctx = makeContext({ board: makeBoard({ current_user_role: 'admin' }) })
      mockBoardContextValue = ctx
      const view = render(<BoardView currentUser={fakeUser} />)
      await act(async () => {})
      const other: User = { ...fakeUser, id: 98, username: 'carol', display_name: 'Carol' }
      const second: BoardMembership = { id: 3, user: other, role: 'viewer', is_moderator: false, joined_at: '' }
      act(() => { getOnEvent.dispatch({ event: 'member.added', data: flaglessMembership() as unknown as Record<string, unknown> }) })
      expect(ctx.silentReload).toHaveBeenCalledTimes(1)
      // Same member again: an echo, no extra request even after the window closes.
      act(() => { getOnEvent.dispatch({ event: 'member.updated', data: flaglessMembership() as unknown as Record<string, unknown> }) })
      // A different member inside the window is not dropped: one request when it closes.
      act(() => { getOnEvent.dispatch({ event: 'member.added', data: second as unknown as Record<string, unknown> }) })
      act(() => { getOnEvent.dispatch({ event: 'member.updated', data: second as unknown as Record<string, unknown> }) })
      expect(ctx.silentReload).toHaveBeenCalledTimes(1)
      act(() => { vi.advanceTimersByTime(2100) })
      expect(ctx.silentReload).toHaveBeenCalledTimes(2)
      act(() => { vi.advanceTimersByTime(5000) })
      expect(ctx.silentReload).toHaveBeenCalledTimes(2)
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a pending trailing re-read on unmount (#1301)', async () => {
    vi.useFakeTimers()
    try {
      const ctx = makeContext({ board: makeBoard({ current_user_role: 'admin' }) })
      mockBoardContextValue = ctx
      const view = render(<BoardView currentUser={fakeUser} />)
      await act(async () => {})
      const other: User = { ...fakeUser, id: 98, username: 'carol', display_name: 'Carol' }
      act(() => { getOnEvent.dispatch({ event: 'member.added', data: flaglessMembership() as unknown as Record<string, unknown> }) })
      act(() => { getOnEvent.dispatch({ event: 'member.added', data: { id: 3, user: other, role: 'viewer', is_moderator: false, joined_at: '' } as unknown as Record<string, unknown> }) })
      view.unmount()
      act(() => { vi.advanceTimersByTime(5000) })
      expect(ctx.silentReload).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // #1301 — a membership frame never carries has_all_content_access. An admin
  // re-reads for a subject whose value is unknown, even when the frame carries
  // is_site_admin (invite redemption, a site admin's members POST).
  it('a member event with is_site_admin but an unknown all-content flag re-reads the board (#1301)', async () => {
    const ctx = makeContext({ board: makeBoard({ current_user_role: 'admin' }) })
    mockBoardContextValue = ctx
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    const withFlag = { ...flaglessMembership(), is_site_admin: false }
    act(() => { getOnEvent.dispatch({ event: 'member.added', data: withFlag as unknown as Record<string, unknown> }) })
    expect(ctx.silentReload).toHaveBeenCalledTimes(1)
  })

  it('member.updated with is_site_admin and an unknown all-content flag re-reads for an admin (#1301)', async () => {
    const ctx = makeContext({ board: makeBoard({ current_user_role: 'admin' }) })
    mockBoardContextValue = ctx
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    const withFlag = { ...flaglessMembership(), is_site_admin: false }
    act(() => { getOnEvent.dispatch({ event: 'member.updated', data: withFlag as unknown as Record<string, unknown> }) })
    expect(ctx.silentReload).toHaveBeenCalledTimes(1)
  })

  it('a member event that carries is_site_admin and a known all-content flag does not re-read', async () => {
    const known = { ...flaglessMembership(), is_site_admin: false }
    const ctx = makeContext({
      board: makeBoard({
        current_user_role: 'site_admin',
        members: [{ ...known, has_all_content_access: false }],
      }),
    })
    mockBoardContextValue = ctx
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'member.added', data: known as unknown as Record<string, unknown> }) })
    act(() => { getOnEvent.dispatch({ event: 'member.updated', data: known as unknown as Record<string, unknown> }) })
    expect(ctx.silentReload).not.toHaveBeenCalled()
  })

  it('member.updated does not sync current_user_role when a different user is updated', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    const otherUser: User = { ...fakeUser, id: 99, username: 'bob', display_name: 'Bob' }
    const membership: BoardMembership = { id: 2, user: otherUser, role: 'viewer', is_moderator: false, joined_at: '' }
    act(() => { getOnEvent.dispatch({ event: 'member.updated', data: membership as unknown as Record<string, unknown> }) })
    expect(ctx.mergeBoardState).not.toHaveBeenCalled()
  })

  it('member.removed routes to removeMember with user_id', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'member.removed', data: { user_id: 1 } }) })
    expect(ctx.removeMember).toHaveBeenCalledWith(1)
  })

  it('column.reordered routes to applyColumnOrder with column list', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const columns: Column[] = [
      { id: 11, uid: 'col002', name: 'Done', position: 0, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
      { id: 10, uid: 'col001', name: 'To Do', position: 1, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
    ]
    act(() => { getOnEvent.dispatch({ event: 'column.reordered', data: { columns } }) })
    expect(ctx.applyColumnOrder).toHaveBeenCalledWith(columns)
  })

  describe('column events refresh the sibling lines (#2443)', () => {
    const parentRef = { hidden: true as const }
    const col = (id: number, position: number, is_done: boolean): Column => (
      { id, uid: `col${id}`, name: `C${id}`, position, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done, policy: null }
    )
    const setup = async (withChild: boolean) => {
      const cards = [makeCard({ id: 5, ...(withChild ? { parent: parentRef } : {}) })]
      const ctx = makeContext({ board: makeBoard({ cards, columns: [col(10, 0, false), col(11, 1, false)] }) })
      mockBoardContextValue = ctx
      render(<BoardView />)
      await act(async () => {})
      return ctx
    }

    it('reloads when a column is_done flips and the board has linked children', async () => {
      const ctx = await setup(true)
      act(() => { getOnEvent.dispatch({ event: 'column.updated', data: col(11, 1, true) as unknown as Record<string, unknown> }) })
      expect(ctx.silentReload).toHaveBeenCalledTimes(1)
    })

    it('does not reload for a done flip without linked children, or an edit that leaves is_done alone', async () => {
      const bare = await setup(false)
      act(() => { getOnEvent.dispatch({ event: 'column.updated', data: col(11, 1, true) as unknown as Record<string, unknown> }) })
      expect(bare.silentReload).not.toHaveBeenCalled()
      const linked = await setup(true)
      act(() => { getOnEvent.dispatch({ event: 'column.updated', data: { ...col(11, 1, false), name: 'Renamed' } as unknown as Record<string, unknown> }) })
      expect(linked.silentReload).not.toHaveBeenCalled()
    })

    it('does not reload for a reorder, even one that changes the first column', async () => {
      // Sibling counts depend on is_done and blocked only, never on column order.
      const ctx = await setup(true)
      act(() => { getOnEvent.dispatch({ event: 'column.reordered', data: { columns: [col(11, 0, false), col(10, 1, false)] } }) })
      expect(ctx.applyColumnOrder).toHaveBeenCalled()
      expect(ctx.silentReload).not.toHaveBeenCalled()
    })
  })

  it('swimlane.reordered routes to applySwimlaneOrder with swimlane list', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const swimlanes: Swimlane[] = [
      { id: 20, uid: 'lane001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null },
    ]
    act(() => { getOnEvent.dispatch({ event: 'swimlane.reordered', data: { swimlanes } }) })
    expect(ctx.applySwimlaneOrder).toHaveBeenCalledWith(swimlanes)
  })

  it('swimlane.reordered (second session) routes to applySwimlaneOrder with swimlane list', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const swimlanes: Swimlane[] = [
      { id: 21, uid: 'lane002', name: 'Customer B', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null },
    ]
    act(() => { getOnEvent.dispatch({ event: 'swimlane.reordered', data: { swimlanes } }) })
    expect(ctx.applySwimlaneOrder).toHaveBeenCalledWith(swimlanes)
  })

  it('board.updated routes to mergeBoardState (no API call)', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const patch = { name: 'Renamed Board', enforce_wip_limits: true }
    act(() => { getOnEvent.dispatch({ event: 'board.updated', data: patch }) })
    // Must use the state-only mergeBoardState, not updateBoardSettings which
    // would fire a redundant PATCH API call on the receiving client.
    expect(ctx.mergeBoardState).toHaveBeenCalledWith(patch)
    expect(ctx.updateBoardSettings).not.toHaveBeenCalled()
  })

  it('board.updated carrying export_min_role forwards the field to mergeBoardState (#843)', async () => {
    // #843 — raising export_min_role on an admin client must propagate via
    // board.updated to every other connected user, so canExport recomputes
    // and the Export button hides without a reload.
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const patch = { export_min_role: 'admin' as const }
    act(() => { getOnEvent.dispatch({ event: 'board.updated', data: patch }) })
    expect(ctx.mergeBoardState).toHaveBeenCalledWith(patch)
  })

  it('board.updated carrying show_row_chip_field_names forwards the field to mergeBoardState (#1418)', async () => {
    // An admin hiding row-chip field names must update every open viewer live.
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const patch = { show_row_chip_field_names: false }
    act(() => { getOnEvent.dispatch({ event: 'board.updated', data: patch }) })
    expect(ctx.mergeBoardState).toHaveBeenCalledWith(patch)
    expect(ctx.updateBoardSettings).not.toHaveBeenCalled()
  })

  it('board.updated carrying health status forwards all three fields to mergeBoardState (#1133)', async () => {
    // They are not per-user fields, so they must not be stripped: Row 1's
    // health pill reads them from the merged context board.
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const patch = {
      health_status: null,
      effective_health_status: 'off_track',
      health_status_source: { id: 3, name: 'Platform' },
    }
    act(() => { getOnEvent.dispatch({ event: 'board.updated', data: patch }) })
    expect(ctx.mergeBoardState).toHaveBeenCalledWith(patch)
  })

  it('board.updated drops the acting user is_starred before merging (#1559)', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'board.updated', data: { name: 'Renamed', is_starred: true } }) })
    expect(ctx.mergeBoardState).toHaveBeenCalledWith({ name: 'Renamed' })
    expect(ctx.mergeBoardState).not.toHaveBeenCalledWith(expect.objectContaining({ is_starred: expect.anything() }))
    // board.star_changed for this user still updates the star.
    act(() => { getOnEvent.dispatch({ event: 'board.star_changed', data: { uid: 'board-uid-1', user_id: fakeUser.id, is_starred: true } }) })
    expect(ctx.mergeBoardState).toHaveBeenCalledWith({ is_starred: true })
  })

  it('share_link.updated merges the share state under its /full/ field names (#1967)', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    act(() => {
      getOnEvent.dispatch({
        event: 'share_link.updated',
        data: { board_uid: 'board-uid-1', active: true, expires_at: '2999-01-01T00:00:00Z', issued_at: '2026-11-01T10:00:00+00:00' },
      })
    })
    expect(ctx.mergeBoardState).toHaveBeenCalledWith({
      share_link_active: true, share_token_expires_at: '2999-01-01T00:00:00Z',
    })
    act(() => {
      getOnEvent.dispatch({
        event: 'share_link.updated',
        data: { board_uid: 'board-uid-1', active: false, expires_at: null, issued_at: null },
      })
    })
    expect(ctx.mergeBoardState).toHaveBeenLastCalledWith({ share_link_active: false, share_token_expires_at: null })
    expect(ctx.updateBoardSettings).not.toHaveBeenCalled()
  })

  it('board.updated does not throw when mergeBoardState is provided', async () => {
    mockBoardContextValue = makeContext()
    render(<BoardView />)
    await act(async () => {})
    // Should not throw
    act(() => { getOnEvent.dispatch({ event: 'board.updated', data: { name: 'New name' } }) })
  })

  it('board.deleted by someone else re-reads the board instead of navigating (#2041)', async () => {
    const onBoardDeleted = vi.fn()
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView onBoardDeleted={onBoardDeleted} />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'board.deleted', data: { board_uid: 'abc123', board_id: 1 } }) })
    expect(ctx.silentReload).toHaveBeenCalledTimes(1)
    expect(onBoardDeleted).not.toHaveBeenCalled()
  })

  it("board.deleted echoing this session's own delete keeps the old path, no reload (#2041)", async () => {
    const onBoardDeleted = vi.fn()
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView onBoardDeleted={onBoardDeleted} />)
    await act(async () => {})
    act(() => { window.dispatchEvent(new Event('visiban:open-settings')) })
    act(() => { settingsDeleteHooks.deleting?.() })
    act(() => { getOnEvent.dispatch({ event: 'board.deleted', data: { board_uid: 'abc123', board_id: 1 } }) })
    expect(onBoardDeleted).toHaveBeenCalledTimes(1)
    expect(ctx.silentReload).not.toHaveBeenCalled()
  })

  it('a failed own delete re-arms the reload path for a later board.deleted (#2041)', async () => {
    const onBoardDeleted = vi.fn()
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView onBoardDeleted={onBoardDeleted} />)
    await act(async () => {})
    act(() => { window.dispatchEvent(new Event('visiban:open-settings')) })
    act(() => { settingsDeleteHooks.deleting?.() })
    act(() => { settingsDeleteHooks.failed?.() })
    act(() => { getOnEvent.dispatch({ event: 'board.deleted', data: { board_uid: 'abc123', board_id: 1 } }) })
    expect(ctx.silentReload).toHaveBeenCalledTimes(1)
    expect(onBoardDeleted).not.toHaveBeenCalled()
  })

  it('board.deleted is a no-op when onBoardDeleted is not provided', async () => {
    mockBoardContextValue = makeContext()
    render(<BoardView />)
    await act(async () => {})
    // Should not throw when the optional callback is absent
    act(() => { getOnEvent.dispatch({ event: 'board.deleted', data: { board_uid: 'abc123', board_id: 1 } }) })
  })

  it('board.star_changed merges is_starred when user_id matches current user (#814)', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'board.star_changed', data: { uid: 'board-uid-1', user_id: fakeUser.id, is_starred: true } }) })
    expect(ctx.mergeBoardState).toHaveBeenCalledWith({ is_starred: true })
  })

  it('board.star_changed is ignored when user_id is a different user (#814)', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'board.star_changed', data: { uid: 'board-uid-1', user_id: 999, is_starred: true } }) })
    expect(ctx.mergeBoardState).not.toHaveBeenCalled()
  })
})

describe('BoardView — CardDetail live refresh on card.updated (#1310)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('bumps refreshSignal when card.updated matches the open card, so its comments/checklist/attachments refetch', async () => {
    const card = makeCard({ id: 1, uid: 'crd001' })
    mockBoardContextValue = makeContext({ board: makeBoard({ cards: [card] }) })
    render(<BoardView />)
    await act(async () => {})

    act(() => { window.dispatchEvent(new CustomEvent('visiban:open-card', { detail: { cardId: 1 } })) })
    expect(screen.getByTestId('card-detail')).toHaveAttribute('data-refresh-signal', '0')

    // Another session added a comment/checklist item/attachment to this card.
    act(() => { getOnEvent.dispatch({ event: 'card.updated', data: { ...card, checklist_total: 1 } as unknown as Record<string, unknown> }) })
    expect(screen.getByTestId('card-detail')).toHaveAttribute('data-refresh-signal', '1')
  })

  it('does not bump refreshSignal when card.updated is for a different card', async () => {
    const openCard = makeCard({ id: 1, uid: 'crd001' })
    const otherCard = makeCard({ id: 2, uid: 'crd002' })
    mockBoardContextValue = makeContext({ board: makeBoard({ cards: [openCard, otherCard] }) })
    render(<BoardView />)
    await act(async () => {})

    act(() => { window.dispatchEvent(new CustomEvent('visiban:open-card', { detail: { cardId: 1 } })) })
    expect(screen.getByTestId('card-detail')).toHaveAttribute('data-refresh-signal', '0')

    act(() => { getOnEvent.dispatch({ event: 'card.updated', data: { ...otherCard, checklist_total: 1 } as unknown as Record<string, unknown> }) })
    expect(screen.getByTestId('card-detail')).toHaveAttribute('data-refresh-signal', '0')
  })

  it('does not render CardDetail (or bump anything) when no card is open', async () => {
    const card = makeCard({ id: 1, uid: 'crd001' })
    mockBoardContextValue = makeContext({ board: makeBoard({ cards: [card] }) })
    render(<BoardView />)
    await act(async () => {})
    expect(screen.queryByTestId('card-detail')).not.toBeInTheDocument()
    // Should not throw with no card open.
    act(() => { getOnEvent.dispatch({ event: 'card.updated', data: { ...card, checklist_total: 1 } as unknown as Record<string, unknown> }) })
  })
})

describe('BoardView — board invites (#1444)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLocationState.current = null
    mockBoardContextValue = makeContext()
  })

  async function openSettings() {
    render(<BoardView />)
    await act(async () => {})
    act(() => { window.dispatchEvent(new Event('visiban:open-settings')) })
    return screen.getByTestId('settings-modal')
  }

  it('invite_link.created / invite_link.revoked bump the settings invite signal', async () => {
    const modal = await openSettings()
    expect(modal).toHaveAttribute('data-invite-signal', '0')
    act(() => { getOnEvent.dispatch({ event: 'invite_link.created', data: { id: 1 } }) })
    expect(screen.getByTestId('settings-modal')).toHaveAttribute('data-invite-signal', '1')
    act(() => { getOnEvent.dispatch({ event: 'invite_link.revoked', data: { id: 1 } }) })
    expect(screen.getByTestId('settings-modal')).toHaveAttribute('data-invite-signal', '2')
  })

  // #1967 — the rotation signal reaches the open Sharing tab. The modal's own
  // tests (boardSettingsModal.test.tsx, "rotation elsewhere") prove that a
  // changed value withdraws the reveal; this proves BoardView feeds it from
  // the socket frame, and keeps the last issued value across non-issuing frames.
  it('share_link.updated passes issued_at to the settings modal as shareLinkIssuedAt', async () => {
    await openSettings()
    expect(screen.getByTestId('settings-modal')).toHaveAttribute('data-share-issued-at', '')
    act(() => {
      getOnEvent.dispatch({
        event: 'share_link.updated',
        data: { board_uid: 'board-uid-1', active: true, expires_at: null, issued_at: '2026-11-01T10:00:00+00:00' },
      })
    })
    expect(screen.getByTestId('settings-modal')).toHaveAttribute('data-share-issued-at', '2026-11-01T10:00:00+00:00')
    // Another admin rotates: the modal sees the new value.
    act(() => {
      getOnEvent.dispatch({
        event: 'share_link.updated',
        data: { board_uid: 'board-uid-1', active: true, expires_at: null, issued_at: '2026-11-01T10:05:00+00:00' },
      })
    })
    expect(screen.getByTestId('settings-modal')).toHaveAttribute('data-share-issued-at', '2026-11-01T10:05:00+00:00')
    // A frame that issued no link (an expiry edit) leaves the last value.
    act(() => {
      getOnEvent.dispatch({
        event: 'share_link.updated',
        data: { board_uid: 'board-uid-1', active: true, expires_at: '2999-01-01T00:00:00Z', issued_at: null },
      })
    })
    expect(screen.getByTestId('settings-modal')).toHaveAttribute('data-share-issued-at', '2026-11-01T10:05:00+00:00')
  })

  it('webhook.changed reaches the settings modal, one new seq per frame (#2057)', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    await openSettings()
    expect(screen.getByTestId('settings-modal')).toHaveAttribute('data-webhook-change', '')
    const frame = { id: 4, status: 'failing', reason_code: '', consecutive_failures: 1, changed_by: null, at: '2026-11-19T12:00:00Z' }
    act(() => { getOnEvent.dispatch({ event: 'webhook.changed', data: frame }) })
    expect(screen.getByTestId('settings-modal')).toHaveAttribute('data-webhook-change', '4:1')
    // An identical frame is still a new change.
    act(() => { getOnEvent.dispatch({ event: 'webhook.changed', data: frame }) })
    expect(screen.getByTestId('settings-modal')).toHaveAttribute('data-webhook-change', '4:2')
    // Never merged into board state.
    expect(ctx.mergeBoardState).not.toHaveBeenCalled()
  })

  it('a socket reconnect bumps the webhook reconnect signal, so an open Webhooks tab re-reads (#2057)', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    await openSettings()
    expect(screen.getByTestId('settings-modal')).toHaveAttribute('data-webhook-reconnect', '0')
    act(() => { getOnEvent.reconnect() })
    expect(screen.getByTestId('settings-modal')).toHaveAttribute('data-webhook-reconnect', '1')
    act(() => { getOnEvent.reconnect() })
    expect(screen.getByTestId('settings-modal')).toHaveAttribute('data-webhook-reconnect', '2')
  })

  it('member.added carrying an invite bumps the signal; a plain member.added does not', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    await openSettings()
    const member = { id: 50, user: { ...fakeUser, id: 9 }, role: 'member', is_moderator: false, joined_at: '' }
    act(() => { getOnEvent.dispatch({ event: 'member.added', data: member as unknown as Record<string, unknown> }) })
    expect(screen.getByTestId('settings-modal')).toHaveAttribute('data-invite-signal', '0')
    act(() => {
      getOnEvent.dispatch({ event: 'member.added', data: { ...member, invite: { id: 3, created_by_id: 1 } } as unknown as Record<string, unknown> })
    })
    expect(screen.getByTestId('settings-modal')).toHaveAttribute('data-invite-signal', '1')
    expect(ctx.addMember).toHaveBeenCalledTimes(2)
  })

  it('shows the joined notice from navigation state, and dismisses it', async () => {
    mockLocationState.current = { joinedBoard: 'Launch Plan', joinedRole: 'collaborator', created: true }
    render(<ToastProvider><BoardView /></ToastProvider>)
    await act(async () => {})
    expect(screen.getByTestId('joined-notice')).toHaveTextContent("You've joined Launch Plan as a collaborator. Welcome!")
    act(() => { screen.getByRole('button', { name: 'Dismiss notification' }).click() })
    expect(screen.queryByTestId('joined-notice')).not.toBeInTheDocument()
  })

  it('says "already have access" when the invite created nothing', async () => {
    mockLocationState.current = { joinedBoard: 'Launch Plan', joinedRole: 'viewer', created: false }
    render(<ToastProvider><BoardView /></ToastProvider>)
    await act(async () => {})
    expect(screen.getByTestId('joined-notice')).toHaveTextContent('You already have access to Launch Plan.')
  })

  it('no notice without navigation state', async () => {
    render(<BoardView />)
    await act(async () => {})
    expect(screen.queryByRole('button', { name: 'Dismiss notification' })).not.toBeInTheDocument()
  })
})

/**
 * The parent refetch reads `getCardParentState` (parent plus the #2371 planned fields, one card read). These tests
 * drive its `parent` half through a plain mock; the planned half is left out, as a read that sent none.
 */
function spyParentRead() {
  const parent = vi.fn<(boardId: number, cardId: number) => Promise<CardParent | null>>()
  const state = vi.spyOn(cardsApi, 'getCardParentState').mockImplementation((b, id) => parent(b, id).then((p) => ({ parent: p })))
  const restore = parent.mockRestore.bind(parent)
  parent.mockRestore = () => { state.mockRestore(); restore() }
  return parent
}

// #2371: a parent reaching the column, a column delete and a Needed change all ping `card.parent_changed`
// (ids only); the re-read carries the planned fields, which the frame never does.
describe('BoardView — planned children refresh (#2371)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const released = { planned: false, needed_now: true, needed_at_column: 31, needed_at_column_name: 'Proposal', planned_released_at: '2026-11-22T10:00:00Z' }
  const nowAgain = { planned: false, needed_now: false, needed_at_column: null, needed_at_column_name: null, planned_released_at: null }

  it.each([
    ['the parent reached the column (release)', released],
    ['the Needed column was deleted', nowAgain],
  ])('applies the planned fields with the parent when %s', async (_name, fields) => {
    const spy = vi.spyOn(cardsApi, 'getCardParentState').mockResolvedValue({ parent: { hidden: true }, ...fields })
    const ctx = makeContext({ board: makeBoard({ cards: [makeCard({ id: 5, planned: true })] }) })
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    await act(async () => { getOnEvent.dispatch({ event: 'card.parent_changed', data: { card_ids: [5] } }) })
    expect(spy).toHaveBeenCalledWith(1, 5)
    expect(ctx.applyCardParents).toHaveBeenCalledWith(new Map([[5, { hidden: true }]]), new Map([[5, fields]]))
    spy.mockRestore()
  })

  it('a planned card\'s own card.moved re-reads its planned fields; an ordinary card\'s does not', async () => {
    const spy = vi.spyOn(cardsApi, 'getCardParentState').mockResolvedValue({ parent: null, ...nowAgain })
    const ctx = makeContext({ board: makeBoard({ cards: [makeCard({ id: 5, planned: true }), makeCard({ id: 6, uid: 'crd006' })] }) })
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    await act(async () => {
      getOnEvent.dispatch({ event: 'card.moved', data: { card: makeCard({ id: 6, uid: 'crd006', column: 11 }), movement: null } as unknown as Record<string, unknown> })
    })
    expect(spy).not.toHaveBeenCalled()
    await act(async () => {
      getOnEvent.dispatch({ event: 'card.moved', data: { card: makeCard({ id: 5, column: 11 }), movement: null } as unknown as Record<string, unknown> })
    })
    expect(spy).toHaveBeenCalledWith(1, 5)
    expect(ctx.applyCardParents).toHaveBeenCalledWith(new Map([[5, null]]), new Map([[5, nowAgain]]))
    spy.mockRestore()
  })
})

describe('BoardView — card.parent_changed (#1104)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('re-reads each listed card and applies only its parent', async () => {
    const spy = spyParentRead().mockImplementation(async (_b, id) => (id === 5 ? { hidden: true } : null))
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    await act(async () => { getOnEvent.dispatch({ event: 'card.parent_changed', data: { card_ids: [5, 6, 'x'] } }) })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(ctx.applyCardParents).toHaveBeenCalledWith(new Map([[5, { hidden: true }], [6, null]]))
    expect(ctx.silentReload).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('applies only the newest read for a card when two re-reads resolve out of order (#1104)', async () => {
    const resolvers: Array<(p: { hidden: true } | null) => void> = []
    const spy = spyParentRead().mockImplementation(
      () => new Promise((res) => { resolvers.push(res as (p: { hidden: true } | null) => void) }),
    )
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'card.parent_changed', data: { card_ids: [5] } }) })
    act(() => { getOnEvent.dispatch({ event: 'card.parent_changed', data: { card_ids: [5] } }) })
    expect(resolvers).toHaveLength(2)
    // The newer read (unlinked) lands first, then the older one (still linked).
    await act(async () => { resolvers[1](null) })
    await act(async () => { resolvers[0]({ hidden: true }) })
    const calls = (ctx.applyCardParents as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[calls.length - 1][0]).toEqual(new Map([[5, null]]))
    spy.mockRestore()
  })

  it('re-reads the board instead when more than 20 cards are listed', async () => {
    const spy = spyParentRead()
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const ids = Array.from({ length: 21 }, (_, i) => i + 1)
    act(() => { getOnEvent.dispatch({ event: 'card.parent_changed', data: { card_ids: ids } }) })
    expect(ctx.silentReload).toHaveBeenCalled()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('card.unarchived re-reads the restored card parent, which the frame never carries', async () => {
    const parent = { hidden: true as const }
    const spy = spyParentRead().mockResolvedValue(parent)
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const restored = { id: 5, uid: 'crd005', title: 'Restored card', column: 10, swimlane: 20 }
    await act(async () => { getOnEvent.dispatch({ event: 'card.unarchived', data: restored as unknown as Record<string, unknown> }) })
    expect(ctx.unarchiveCard).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }))
    expect(spy).toHaveBeenCalledWith(expect.anything(), 5)
    expect(ctx.applyCardParents).toHaveBeenCalledWith(new Map([[5, parent]]))
    spy.mockRestore()
  })

  describe('siblings frame (#2443)', () => {
    const shared = { hidden: false as const, id: 70, title: 'Epic', siblings_total: 3, siblings_done: 2 } as unknown as CardParent
    const siblingsBoard = () => makeBoard({ cards: [makeCard({ id: 5 }), makeCard({ id: 6 }), makeCard({ id: 8 })] })

    it('reads one listed card on this board and applies its parent to every listed sibling', async () => {
      const spy = spyParentRead().mockResolvedValue(shared)
      const ctx = makeContext({ board: siblingsBoard() })
      mockBoardContextValue = ctx
      render(<BoardView />)
      await act(async () => {})
      // 99 is not on this board: never read, never applied. Way above the per-card cap, no reload.
      const ids = [99, 5, 6, 8, ...Array.from({ length: 30 }, (_, i) => 1000 + i)]
      await act(async () => { getOnEvent.dispatch({ event: 'card.parent_changed', data: { card_ids: ids, siblings: true } }) })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(1, 5)
      expect(ctx.applyCardParents).toHaveBeenCalledWith(new Map([[5, shared], [6, shared], [8, shared]]))
      expect(ctx.silentReload).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    it('falls back to per-card reads when the representative is no longer a child', async () => {
      const spy = spyParentRead().mockImplementation(async (_b, id) => (id === 5 ? null : shared))
      const ctx = makeContext({ board: siblingsBoard() })
      mockBoardContextValue = ctx
      render(<BoardView />)
      await act(async () => {})
      await act(async () => { getOnEvent.dispatch({ event: 'card.parent_changed', data: { card_ids: [5, 6, 8], siblings: true } }) })
      await act(async () => {})
      expect(ctx.applyCardParents).toHaveBeenCalledWith(new Map([[5, null]]))
      expect(ctx.applyCardParents).toHaveBeenCalledWith(new Map([[6, shared], [8, shared]]))
      expect(spy).toHaveBeenCalledTimes(3)
      spy.mockRestore()
    })

    it('reads nothing for ids not on this board, keeps the last value on a failed read, and drops a stale read', async () => {
      const resolvers: Array<(p: CardParent | null) => void> = []
      const spy = spyParentRead()
        .mockRejectedValueOnce(new Error('x'))
        .mockImplementation(() => new Promise((res) => { resolvers.push(res) }))
      const ctx = makeContext({ board: siblingsBoard() })
      mockBoardContextValue = ctx
      render(<BoardView />)
      await act(async () => {})
      await act(async () => { getOnEvent.dispatch({ event: 'card.parent_changed', data: { card_ids: [41, 42], siblings: true } }) })
      expect(spy).not.toHaveBeenCalled()
      await act(async () => { getOnEvent.dispatch({ event: 'card.parent_changed', data: { card_ids: [5, 6], siblings: true } }) })
      expect(ctx.applyCardParents).not.toHaveBeenCalled()
      act(() => { getOnEvent.dispatch({ event: 'card.parent_changed', data: { card_ids: [5, 6], siblings: true } }) })
      act(() => { getOnEvent.dispatch({ event: 'card.parent_changed', data: { card_ids: [5, 6], siblings: true } }) })
      const newer = { ...shared, siblings_done: 3 } as CardParent
      await act(async () => { resolvers[1](newer) })
      await act(async () => { resolvers[0](shared) })
      const calls = (ctx.applyCardParents as unknown as ReturnType<typeof vi.fn>).mock.calls
      expect(calls).toHaveLength(1)
      expect(calls[0][0]).toEqual(new Map([[5, newer], [6, newer]]))
      spy.mockRestore()
    })
  })

  it('answers the card detail refetch event, and skips a failed read', async () => {
    const spy = spyParentRead().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(null)
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    await act(async () => { window.dispatchEvent(new CustomEvent('visiban:card-parent-refetch', { detail: { cardIds: [8, 9] } })) })
    expect(ctx.applyCardParents).toHaveBeenCalledWith(new Map([[9, null]]))
    spy.mockRestore()
  })
})

describe('BoardView — card.children_changed (#2210) and rename reload (#2416)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const rollup = { visible: true as const, total: 2, done: 1, doing: 1, todo: 0, blocked: 0, last_moved_at: null }

  it('re-reads the parent card and applies only its children_rollup', async () => {
    const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue(rollup)
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    await act(async () => { getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 7 } }) })
    expect(spy).toHaveBeenCalledWith(expect.any(Number), 7)
    expect(ctx.applyCardChildrenRollups).toHaveBeenCalledWith(new Map([[7, rollup]]))
    spy.mockRestore()
  })

  it("re-reads the open parent's Children tab only, and only for that parent (#2209 row 13)", async () => {
    const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue(rollup)
    const card = makeCard({ id: 7, uid: 'crd007' })
    mockBoardContextValue = makeContext({ board: makeBoard({ cards: [card] }) })
    render(<BoardView />)
    await act(async () => {})
    act(() => { window.dispatchEvent(new CustomEvent('visiban:open-card', { detail: { cardId: 7 } })) })
    const detail = () => screen.getByTestId('card-detail')
    await act(async () => { getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 8 } }) })
    expect(detail()).toHaveAttribute('data-children-refresh-signal', '0')
    await act(async () => { getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 7 } }) })
    expect(detail()).toHaveAttribute('data-children-refresh-signal', '1')
    // The ping does not refetch comments, checklist or attachments.
    expect(detail()).toHaveAttribute('data-refresh-signal', '0')
    spy.mockRestore()
  })

  describe('first-read loading ids (#2210)', () => {
    const parentCard = { id: 7, uid: 'crd007', title: 'Parent', column: 10, swimlane: 20 } as unknown as Card

    it('shows the loading state for a parent with no rollup, then clears it when the read resolves', async () => {
      let resolve: (r: typeof rollup) => void = () => {}
      const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup').mockImplementation(() => new Promise((res) => { resolve = res }))
      mockBoardContextValue = makeContext({ board: makeBoard({ cards_can_have_children: true, cards: [parentCard] }) })
      render(<BoardView />)
      await act(async () => {})
      expect(screen.queryByTestId('card-children-rollup-loading')).toBeNull()
      await act(async () => { getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 7 } }) })
      expect(screen.getByTestId('card-children-rollup-loading')).toBeInTheDocument()
      await act(async () => { resolve(rollup) })
      expect(screen.queryByTestId('card-children-rollup-loading')).toBeNull()
      spy.mockRestore()
    })

    it('clears the loading state when the read fails, without crashing', async () => {
      let reject: (e: Error) => void = () => {}
      const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup').mockImplementation(() => new Promise((_res, rej) => { reject = rej }))
      mockBoardContextValue = makeContext({ board: makeBoard({ cards_can_have_children: true, cards: [parentCard] }) })
      render(<BoardView />)
      await act(async () => {})
      await act(async () => { getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 7 } }) })
      expect(screen.getByTestId('card-children-rollup-loading')).toBeInTheDocument()
      await act(async () => { reject(new Error('x')) })
      expect(screen.queryByTestId('card-children-rollup-loading')).toBeNull()
      spy.mockRestore()
    })

    it('does not show loading when the parent already has a rollup or the board cannot have children', async () => {
      const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup').mockImplementation(() => new Promise(() => {}))
      mockBoardContextValue = makeContext({ board: makeBoard({ cards_can_have_children: true, cards: [{ ...parentCard, children_rollup: rollup } as Card] }) })
      const { unmount } = render(<BoardView />)
      await act(async () => {})
      await act(async () => { getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 7 } }) })
      expect(screen.queryByTestId('card-children-rollup-loading')).toBeNull()
      unmount()
      mockBoardContextValue = makeContext({ board: makeBoard({ cards_can_have_children: false, cards: [parentCard] }) })
      render(<BoardView />)
      await act(async () => {})
      await act(async () => { getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 7 } }) })
      expect(screen.queryByTestId('card-children-rollup-loading')).toBeNull()
      spy.mockRestore()
    })
  })

  it('ignores a malformed ping, an absent rollup, a failed read and a stale read', async () => {
    const resolvers: Array<(r: typeof rollup | undefined) => void> = []
    const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup')
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValueOnce(undefined)
      .mockImplementation(() => new Promise((res) => { resolvers.push(res) }))
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    await act(async () => { getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 'x' } }) })
    expect(spy).not.toHaveBeenCalled()
    await act(async () => { getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 7 } }) })
    await act(async () => { getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 7 } }) })
    expect(ctx.applyCardChildrenRollups).not.toHaveBeenCalled()
    act(() => { getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 7 } }) })
    act(() => { getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 7 } }) })
    await act(async () => { resolvers[1]({ ...rollup, done: 2, doing: 0 }) })
    await act(async () => { resolvers[0](rollup) })
    const calls = (ctx.applyCardChildrenRollups as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toEqual(new Map([[7, { ...rollup, done: 2, doing: 0 }]]))
    spy.mockRestore()
  })

  it('drops the rollup of a leftover parent on a flag-off board when the re-read has none (#2446)', async () => {
    const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue(undefined)
    try {
      const leftover = { id: 7, uid: 'crd007', title: 'Leftover parent', column: 10, swimlane: 20, children_rollup: rollup }
      const ctx = makeContext({ board: makeBoard({ cards_can_have_children: false, cards: [leftover as never] }) })
      mockBoardContextValue = ctx
      render(<BoardView />)
      await act(async () => {})
      await act(async () => { getOnEvent.dispatch({ event: 'card.children_changed', data: { parent_id: 7 } }) })
      expect(ctx.applyCardChildrenRollups).toHaveBeenCalledWith(new Map([[7, null]]))
    } finally {
      spy.mockRestore()
    }
  })

  it.each(['card.created', 'card.unarchived'])(
    '%s on a parent-tier board reads the card rollup, which the frame never carries',
    async (name) => {
      const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue(rollup)
      const ctx = makeContext({ board: makeBoard({ cards_can_have_children: true }) })
      mockBoardContextValue = ctx
      render(<BoardView />)
      await act(async () => {})
      const card = { id: 5, uid: 'crd005', title: 'Parent', column: 10, swimlane: 20 }
      await act(async () => { getOnEvent.dispatch({ event: name, data: card as unknown as Record<string, unknown> }) })
      expect(spy).toHaveBeenCalledWith(expect.any(Number), 5)
      expect(ctx.applyCardChildrenRollups).toHaveBeenCalledWith(new Map([[5, rollup]]))
      spy.mockRestore()
    },
  )

  it('card.unarchived on a flag-off board reads the rollup, so a restored leftover parent keeps it (#2446)', async () => {
    const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue(rollup)
    const ctx = makeContext({ board: makeBoard({ cards_can_have_children: false }) })
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const card = { id: 5, uid: 'crd005', title: 'Leftover parent', column: 10, swimlane: 20 }
    await act(async () => { getOnEvent.dispatch({ event: 'card.unarchived', data: card as unknown as Record<string, unknown> }) })
    expect(spy).toHaveBeenCalledWith(expect.any(Number), 5)
    expect(ctx.applyCardChildrenRollups).toHaveBeenCalledWith(new Map([[5, rollup]]))
    spy.mockRestore()
  })

  it('card.unarchived of a plain card on a flag-off board applies nothing', async () => {
    const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue(undefined)
    const ctx = makeContext({ board: makeBoard({ cards_can_have_children: false }) })
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const card = { id: 5, uid: 'crd005', title: 'Child', column: 10, swimlane: 20 }
    await act(async () => { getOnEvent.dispatch({ event: 'card.unarchived', data: card as unknown as Record<string, unknown> }) })
    expect(ctx.applyCardChildrenRollups).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it.each(['card.created'])('%s on a child-tier board does not read a rollup', async (name) => {
    const spy = vi.spyOn(cardsApi, 'getCardChildrenRollup').mockResolvedValue(rollup)
    const ctx = makeContext({ board: makeBoard({ cards_can_have_children: false }) })
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const card = { id: 5, uid: 'crd005', title: 'Child', column: 10, swimlane: 20 }
    await act(async () => { getOnEvent.dispatch({ event: name, data: card as unknown as Record<string, unknown> }) })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('a card.parent_changed with reload re-reads the board (#2416)', async () => {
    const spy = spyParentRead()
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'card.parent_changed', data: { card_ids: [], reload: true } }) })
    expect(ctx.silentReload).toHaveBeenCalled()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
