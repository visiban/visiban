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
    return { connected: true }
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
  default: ({ swimlane, onExitFocus: _onExitFocus }: { swimlane: { name: string }; onExitFocus?: () => void }) => <div>{swimlane.name}</div>,
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeUser: User = {
  id: 1, username: 'alice', email: 'a@example.com', first_name: 'Alice',
  last_name: 'Smith', avatar_url: '', display_name: 'Alice Smith',
  is_site_admin: false, must_change_password: false,
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
    members: [{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }],
    staleness_threshold_days: 7,
    stale_warning_pct: 50,
    allowed_priorities: ['low', 'medium', 'high', 'urgent'],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false,
    is_starred: false,
    created_at: '', updated_at: '',
    current_user_role: 'admin',
    ...overrides,
  }
}

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    board: makeBoard(),
    onMoveCard: vi.fn(),
    onCardAdded: vi.fn(),
    onCardDeleted: vi.fn(),
    onCardUpdated: vi.fn(),
    onColumnAdded: vi.fn(),
    onColumnUpdated: vi.fn(),
    onColumnDeleted: vi.fn(),
    onColumnsReordered: vi.fn(),
    onSwimlaneAdded: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onSwimlaneDeleted: vi.fn(),
    onSwimlanesReordered: vi.fn(),
    onCardArchived: vi.fn(),
    onCardUnarchived: vi.fn(),
    onLabelAdded: vi.fn(),
    onLabelUpdated: vi.fn(),
    onLabelDeleted: vi.fn(),
    onMemberAdded: vi.fn(),
    onMemberUpdated: vi.fn(),
    onMemberRemoved: vi.fn(),
    onColumnOrderApplied: vi.fn(),
    onSwimlaneOrderApplied: vi.fn(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BoardView socket event routing — new event types', () => {
  beforeEach(() => vi.clearAllMocks())

  it('label.created routes to onLabelAdded', async () => {
    const props = makeProps()
    render(<BoardView {...props} />)
    await act(async () => {})
    const label: Label = { id: 200, uid: 'lbl002', name: 'Feature', color: '#22C55E' }
    act(() => { getOnEvent.dispatch({ event: 'label.created', data: label as unknown as Record<string, unknown> }) })
    expect(props.onLabelAdded).toHaveBeenCalledWith(expect.objectContaining({ id: 200, name: 'Feature' }))
  })

  it('label.updated routes to onLabelUpdated', async () => {
    const props = makeProps()
    render(<BoardView {...props} />)
    await act(async () => {})
    const label: Label = { id: 100, uid: 'lbl001', name: 'Bug (renamed)', color: '#EF4444' }
    act(() => { getOnEvent.dispatch({ event: 'label.updated', data: label as unknown as Record<string, unknown> }) })
    expect(props.onLabelUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: 100, name: 'Bug (renamed)' }))
  })

  it('label.deleted routes to onLabelDeleted with label_id', async () => {
    const props = makeProps()
    render(<BoardView {...props} />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'label.deleted', data: { label_id: 100 } }) })
    expect(props.onLabelDeleted).toHaveBeenCalledWith(100)
  })

  it('member.added routes to onMemberAdded', async () => {
    const props = makeProps()
    render(<BoardView {...props} />)
    await act(async () => {})
    const membership: BoardMembership = { id: 2, user: { ...fakeUser, id: 2, username: 'bob' }, role: 'member', joined_at: '' }
    act(() => { getOnEvent.dispatch({ event: 'member.added', data: membership as unknown as Record<string, unknown> }) })
    expect(props.onMemberAdded).toHaveBeenCalledWith(expect.objectContaining({ role: 'member' }))
  })

  it('member.updated routes to onMemberUpdated', async () => {
    const props = makeProps()
    render(<BoardView {...props} />)
    await act(async () => {})
    const membership: BoardMembership = { id: 1, user: fakeUser, role: 'viewer', joined_at: '' }
    act(() => { getOnEvent.dispatch({ event: 'member.updated', data: membership as unknown as Record<string, unknown> }) })
    expect(props.onMemberUpdated).toHaveBeenCalledWith(expect.objectContaining({ role: 'viewer' }))
  })

  it('member.removed routes to onMemberRemoved with user_id', async () => {
    const props = makeProps()
    render(<BoardView {...props} />)
    await act(async () => {})
    act(() => { getOnEvent.dispatch({ event: 'member.removed', data: { user_id: 1 } }) })
    expect(props.onMemberRemoved).toHaveBeenCalledWith(1)
  })

  it('columns.reordered routes to onColumnOrderApplied with column list', async () => {
    const props = makeProps()
    render(<BoardView {...props} />)
    await act(async () => {})
    const columns: Column[] = [
      { id: 11, uid: 'col002', name: 'Done', position: 0, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
      { id: 10, uid: 'col001', name: 'To Do', position: 1, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
    ]
    act(() => { getOnEvent.dispatch({ event: 'columns.reordered', data: { columns } }) })
    expect(props.onColumnOrderApplied).toHaveBeenCalledWith(columns)
  })

  it('swimlanes.reordered routes to onSwimlaneOrderApplied with swimlane list', async () => {
    const props = makeProps()
    render(<BoardView {...props} />)
    await act(async () => {})
    const swimlanes: Swimlane[] = [
      { id: 20, uid: 'lane001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '' },
    ]
    act(() => { getOnEvent.dispatch({ event: 'swimlanes.reordered', data: { swimlanes } }) })
    expect(props.onSwimlaneOrderApplied).toHaveBeenCalledWith(swimlanes)
  })
})
