/**
 * Coverage for BoardView.collectActivityEvent — the useCallback that turns
 * incoming socket events (card.moved, card.created, member.added,
 * member.removed) into ActivityEntry rows on the activity drawer feed.
 *
 * The function lives inside BoardView and isn't exported, so we mount
 * BoardView, mock BoardActivityDrawer to expose the `feed` prop it receives,
 * dispatch synthetic socket events, then assert the recorded entries.
 *
 * #839 — also locks in the current behaviour for member.removed: the WS
 * payload is `{user_id}` only (no display_name), so the actor falls back to
 * the literal "A member" string.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, screen } from '@testing-library/react'
import BoardView from '../components/Board/BoardView'
import type { BoardEvent } from '../hooks/useBoardSocket'
import type { BoardFull, User } from '../types'
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

// Capture the activityFeed prop the drawer receives. The drawer is rendered
// only when drawerOpen=true; we control that by clicking the drawer toggle.
const drawerCalls: { feed: { actor: string; headline: string; detail: string; kind: string }[] }[] = []
vi.mock('../components/Board/BoardActivityDrawer', () => ({
  default: (props: { feed: { actor: string; headline: string; detail: string; kind: string }[] }) => {
    drawerCalls.push({ feed: props.feed })
    return (
      <div data-testid="activity-drawer">
        {props.feed.map((e, i) => (
          <div key={i} data-testid="activity-entry" data-kind={e.kind}>
            <span data-testid="actor">{e.actor}</span>
            <span data-testid="headline">{e.headline}</span>
            <span data-testid="detail">{e.detail}</span>
          </div>
        ))}
      </div>
    )
  },
}))

// ---------------------------------------------------------------------------
// Standard test infrastructure mocks (mirrors boardSocketEvents.test.tsx)
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
  default: ({ swimlane }: { swimlane: { name: string } }) => <div>{swimlane.name}</div>,
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

// Board context mock
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

function makeBoard(): BoardFull {
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
    labels: [],
    members: [{ id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7,
    stale_warning_pct: 50,
    allowed_priorities: ['low', 'medium', 'high', 'urgent'],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, export_min_role: 'viewer', card_density: 'comfortable',
    is_starred: false,
    created_at: '', updated_at: '',
    current_user_role: 'admin',
    owner: fakeUser,
    capabilities: { movement_export: false },
    share_token: null,
    share_token_expires_at: null,
  }
}

function makeContext(): BoardContextType {
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
  }
}

async function openDrawer() {
  const toggle = await screen.findByRole('button', { name: /open activity drawer/i })
  await act(async () => { toggle.click() })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BoardView.collectActivityEvent', () => {
  beforeEach(() => {
    drawerCalls.length = 0
    mockBoardContextValue = makeContext()
  })

  it('card.moved produces a "move" entry with actor display name and column transition', async () => {
    render(<BoardView />)
    await act(async () => {})
    act(() => {
      getOnEvent.dispatch({
        event: 'card.moved',
        data: {
          card: { title: 'Fix nav bug' },
          movement: {
            from_column_name: 'To Do',
            to_column_name: 'In Progress',
            user: { display_name: 'Alice Smith' },
          },
        },
      })
    })
    await openDrawer()
    const entries = screen.getAllByTestId('activity-entry')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toHaveAttribute('data-kind', 'move')
    expect(entries[0].querySelector('[data-testid="actor"]')?.textContent).toBe('Alice Smith')
    expect(entries[0].querySelector('[data-testid="headline"]')?.textContent).toBe('moved Fix nav bug')
    expect(entries[0].querySelector('[data-testid="detail"]')?.textContent).toBe('To Do → In Progress')
  })

  it('card.moved falls back to "Someone" / "a card" / "" when payload fields are missing', async () => {
    render(<BoardView />)
    await act(async () => {})
    act(() => {
      getOnEvent.dispatch({ event: 'card.moved', data: {} })
    })
    await openDrawer()
    const entries = screen.getAllByTestId('activity-entry')
    expect(entries).toHaveLength(1)
    expect(entries[0].querySelector('[data-testid="actor"]')?.textContent).toBe('Someone')
    expect(entries[0].querySelector('[data-testid="headline"]')?.textContent).toBe('moved a card')
    expect(entries[0].querySelector('[data-testid="detail"]')?.textContent).toBe('')
  })

  it('card.created produces a "create" entry with actor and card title', async () => {
    render(<BoardView />)
    await act(async () => {})
    act(() => {
      getOnEvent.dispatch({
        event: 'card.created',
        data: { title: 'Ship 1.1', created_by: { display_name: 'Bob' } },
      })
    })
    await openDrawer()
    const entries = screen.getAllByTestId('activity-entry')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toHaveAttribute('data-kind', 'create')
    expect(entries[0].querySelector('[data-testid="actor"]')?.textContent).toBe('Bob')
    expect(entries[0].querySelector('[data-testid="headline"]')?.textContent).toBe('created Ship 1.1')
  })

  it('member.added produces a "member" entry with actor display name', async () => {
    render(<BoardView />)
    await act(async () => {})
    act(() => {
      getOnEvent.dispatch({
        event: 'member.added',
        data: { user: { display_name: 'Carol' } },
      })
    })
    await openDrawer()
    const entries = screen.getAllByTestId('activity-entry')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toHaveAttribute('data-kind', 'member')
    expect(entries[0].querySelector('[data-testid="actor"]')?.textContent).toBe('Carol')
    expect(entries[0].querySelector('[data-testid="headline"]')?.textContent).toBe('joined the board')
  })

  it('member.removed produces a "member" entry with the literal "A member" actor (#839)', async () => {
    // The backend payload for member.removed is {user_id} only — no
    // display_name — so collectActivityEvent intentionally renders a
    // generic actor. This test locks in that behaviour.
    render(<BoardView />)
    await act(async () => {})
    act(() => {
      getOnEvent.dispatch({ event: 'member.removed', data: { user_id: 99 } })
    })
    await openDrawer()
    const entries = screen.getAllByTestId('activity-entry')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toHaveAttribute('data-kind', 'member')
    expect(entries[0].querySelector('[data-testid="actor"]')?.textContent).toBe('A member')
    expect(entries[0].querySelector('[data-testid="headline"]')?.textContent).toBe('was removed from the board')
  })

  it('produces a unique id for every entry (#787 crypto.randomUUID regression)', async () => {
    render(<BoardView />)
    await act(async () => {})
    act(() => {
      getOnEvent.dispatch({ event: 'card.created', data: { title: 'A' } })
      getOnEvent.dispatch({ event: 'card.created', data: { title: 'B' } })
      getOnEvent.dispatch({ event: 'card.created', data: { title: 'C' } })
    })
    await openDrawer()
    // Most recent drawer render carries the full feed; assert there are 3
    // distinct entries (the keys would have collided if id wasn't unique).
    const lastFeed = drawerCalls[drawerCalls.length - 1].feed
    const ids = new Set(lastFeed.map((e) => (e as unknown as { id: string }).id))
    expect(ids.size).toBe(3)
  })

  it('ignores events that are not card.moved, card.created, member.added, or member.removed', async () => {
    render(<BoardView />)
    await act(async () => {})
    act(() => {
      // column.deleted is handled by handleSocketEvent but should not
      // produce an activity drawer entry.
      getOnEvent.dispatch({ event: 'column.deleted', data: { column_uid: 'col001' } })
    })
    await openDrawer()
    expect(screen.queryAllByTestId('activity-entry')).toHaveLength(0)
  })
})
