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
import type { BoardEvent } from '../hooks/useBoardSocket'
import type { BoardFull, Card, Column, Label, BoardMembership, Swimlane, User } from '../types'
import type { BoardContextType } from '../contexts/BoardContext'

// ---------------------------------------------------------------------------
// Capture onEvent from useBoardSocket so tests can dispatch events
// ---------------------------------------------------------------------------

const { getOnEvent } = vi.hoisted(() => {
  let _onEvent: ((e: BoardEvent) => void) | null = null
  return {
    getOnEvent: {
      capture: (cb: (e: BoardEvent) => void) => { _onEvent = cb },
      dispatch: (e: BoardEvent) => _onEvent?.(e),
    },
  }
})

vi.mock('../hooks/useBoardSocket', () => ({
  useBoardSocket: (_boardId: number, onEvent: (e: BoardEvent) => void) => {
    getOnEvent.capture(onEvent)
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
    health_status: null, effective_health_status: null, health_status_source: null, default_preset: null,
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0,
    columns: [
      { id: 10, uid: 'col001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
      { id: 11, uid: 'col002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
    ],
    swimlanes: [
      { id: 20, uid: 'lane001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null },
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

  it('swimlane.reordered routes to applySwimlaneOrder with swimlane list', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const swimlanes: Swimlane[] = [
      { id: 20, uid: 'lane001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null },
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
      { id: 21, uid: 'lane002', name: 'Customer B', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null },
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
    render(<BoardView />)
    await act(async () => {})
    expect(screen.getByText(/You've joined/)).toHaveTextContent("You've joined Launch Plan as a collaborator. Welcome!")
    act(() => { screen.getByRole('button', { name: 'Dismiss notification' }).click() })
    expect(screen.queryByText(/You've joined/)).not.toBeInTheDocument()
  })

  it('says "already have access" when the invite created nothing', async () => {
    mockLocationState.current = { joinedBoard: 'Launch Plan', joinedRole: 'viewer', created: false }
    render(<BoardView />)
    await act(async () => {})
    expect(screen.getByText(/You already have access to/)).toHaveTextContent('You already have access to Launch Plan.')
  })

  it('no notice without navigation state', async () => {
    render(<BoardView />)
    await act(async () => {})
    expect(screen.queryByRole('button', { name: 'Dismiss notification' })).not.toBeInTheDocument()
  })
})
