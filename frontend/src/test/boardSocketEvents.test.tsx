/**
 * Tests for BoardView's handleSocketEvent — verifying that each new broadcast
 * event type (label.*, member.*, columns.reordered, swimlanes.reordered) is
 * routed to the correct prop callback.
 *
 * useBoardSocket is mocked to capture the onEvent callback so individual tests
 * can dispatch synthetic WebSocket events and assert which prop was called.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import BoardView from '../components/Board/BoardView'
import type { BoardEvent } from '../hooks/useBoardSocket'
import type { BoardFull, Column, Label, BoardMembership, Swimlane, User } from '../types'
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
  PointerSensor: class {},
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
vi.mock('react-router-dom', () => ({
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
vi.mock('../components/Card/CardDetail', () => ({ default: () => <div /> }))
vi.mock('../components/Board/AddColumnModal', () => ({ default: () => <div /> }))
vi.mock('../components/Swimlane/AddSwimlaneModal', () => ({ default: () => <div /> }))
vi.mock('../components/Board/BoardSettingsModal', () => ({ default: () => <div /> }))
vi.mock('../components/Board/FilterBar', () => ({
  default: () => <div />,
  EMPTY_FILTER: { search: '', assigneeIds: [], labelIds: [], priorities: [], dueDate: null },
  countActiveFilters: () => 0,
}))
vi.mock('../components/Board/KeyboardShortcutsOverlay', () => ({ default: () => <div /> }))
vi.mock('../components/Board/BulkActionToolbar', () => ({ default: () => <div /> }))
vi.mock('../hooks/useSavedFilters', () => ({
  useSavedFilters: () => ({
    savedFilters: [],
    loading: false,
    saveFilter: vi.fn(),
    removeFilter: vi.fn(),
    hydrateFilter: vi.fn(),
  }),
}))
vi.mock('../hooks/useCardSearch', () => ({
  useCardSearch: () => ({ searchMatchIds: null, isSearching: false }),
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
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    columns: [
      { id: 10, uid: 'col001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
      { id: 11, uid: 'col002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
    ],
    swimlanes: [
      { id: 20, uid: 'lane001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01' },
    ],
    cards: [],
    labels: [{ id: 100, uid: 'lbl001', name: 'Bug', color: '#EF4444' }],
    members: [{ id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7,
    stale_warning_pct: 50,
    allowed_priorities: ['low', 'medium', 'high', 'urgent'],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, export_min_role: 'viewer',
    is_starred: false,
    created_at: '', updated_at: '',
    current_user_role: 'admin',
    owner: fakeUser,
    capabilities: { movement_export: false },
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
    forceMoveCard: vi.fn(),
    moveError: null,
    clearMoveError: vi.fn(),
    addCard: vi.fn(),
    removeCard: vi.fn(),
    addColumn: vi.fn(),
    removeColumn: vi.fn(),
    addSwimlane: vi.fn(),
    updateCard: vi.fn(),
    updateColumn: vi.fn(),
    addLabel: vi.fn(),
    updateLabel: vi.fn(),
    removeLabel: vi.fn(),
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

  it('card.archived routes to evictCardByUid with card_uid (#595)', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'card.archived', data: { card_uid: 'crd001' } }) })
    expect(ctx.evictCardByUid).toHaveBeenCalledWith('crd001')
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

  it('columns.reordered routes to applyColumnOrder with column list', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const columns: Column[] = [
      { id: 11, uid: 'col002', name: 'Done', position: 0, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
      { id: 10, uid: 'col001', name: 'To Do', position: 1, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
    ]
    act(() => { getOnEvent.dispatch({ event: 'columns.reordered', data: { columns } }) })
    expect(ctx.applyColumnOrder).toHaveBeenCalledWith(columns)
  })

  it('column.reordered (singular, since 1.1) routes to applyColumnOrder with column list', async () => {
    // #807 — backend emits both plural (legacy) and singular (canonical) names during the
    // deprecation window; the client must accept either.
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const columns: Column[] = [
      { id: 11, uid: 'col002', name: 'Done', position: 0, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
    ]
    act(() => { getOnEvent.dispatch({ event: 'column.reordered', data: { columns } }) })
    expect(ctx.applyColumnOrder).toHaveBeenCalledWith(columns)
  })

  it('swimlanes.reordered routes to applySwimlaneOrder with swimlane list', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const swimlanes: Swimlane[] = [
      { id: 20, uid: 'lane001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '' },
    ]
    act(() => { getOnEvent.dispatch({ event: 'swimlanes.reordered', data: { swimlanes } }) })
    expect(ctx.applySwimlaneOrder).toHaveBeenCalledWith(swimlanes)
  })

  it('swimlane.reordered (singular, since 1.1) routes to applySwimlaneOrder with swimlane list', async () => {
    // #807 — see column.reordered test above for the dual-emission rationale.
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView />)
    await act(async () => {})
    const swimlanes: Swimlane[] = [
      { id: 21, uid: 'lane002', name: 'Customer B', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '' },
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

  it('board.updated does not throw when mergeBoardState is provided', async () => {
    mockBoardContextValue = makeContext()
    render(<BoardView />)
    await act(async () => {})
    // Should not throw
    act(() => { getOnEvent.dispatch({ event: 'board.updated', data: { name: 'New name' } }) })
  })

  it('board.deleted routes to onBoardDeleted', async () => {
    const onBoardDeleted = vi.fn()
    mockBoardContextValue = makeContext()
    render(<BoardView onBoardDeleted={onBoardDeleted} />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'board.deleted', data: { board_uid: 'abc123', board_id: 1 } }) })
    expect(onBoardDeleted).toHaveBeenCalledTimes(1)
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
    act(() => { getOnEvent.dispatch({ event: 'board.star_changed', data: { board_id: 1, user_id: fakeUser.id, is_starred: true } }) })
    expect(ctx.mergeBoardState).toHaveBeenCalledWith({ is_starred: true })
  })

  it('board.star_changed is ignored when user_id is a different user (#814)', async () => {
    const ctx = makeContext()
    mockBoardContextValue = ctx
    render(<BoardView currentUser={fakeUser} />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'board.star_changed', data: { board_id: 1, user_id: 999, is_starred: true } }) })
    expect(ctx.mergeBoardState).not.toHaveBeenCalled()
  })
})
