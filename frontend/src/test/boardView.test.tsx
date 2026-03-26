import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardView from '../components/Board/BoardView'
import type { BoardFull, User } from '../types'
import type { CollisionDetection, DragEndEvent } from '@dnd-kit/core'
import * as dndCore from '@dnd-kit/core'

// Controllable search params — initial params can be set before render; the stateful mock
// updates them on setSearchParams calls so the component re-renders with the new params.
let mockSearchParams = new URLSearchParams()
// Spy on setSearchParams calls so tests can assert the arguments passed (e.g. replace:true).
const mockSetSearchParams = vi.fn()

// Capture DndContext props (onDragEnd, collisionDetection) so tests can invoke them directly.
let capturedOnDragEnd: ((e: DragEndEvent) => void) | undefined
let capturedCollisionDetection: ((args: Parameters<CollisionDetection>[0]) => ReturnType<CollisionDetection>) | undefined

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd, collisionDetection }: { children: React.ReactNode; onDragEnd?: (e: DragEndEvent) => void; collisionDetection?: (args: Parameters<CollisionDetection>[0]) => ReturnType<CollisionDetection> }) => {
    capturedOnDragEnd = onDragEnd
    capturedCollisionDetection = collisionDetection
    return <div>{children}</div>
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PointerSensor: class {},
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
  // Stateful mock: useSearchParams returns live params backed by React state so that
  // setSearchParams calls (from tab switches / Escape) trigger re-renders in tests.
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
}))

vi.mock('../hooks/useBoardSocket', () => ({
  useBoardSocket: () => ({ connected: true, status: 'connected' }),
}))

vi.mock('../hooks/useBoardPan', () => ({
  useBoardPan: () => {},
}))

vi.mock('../api/boards', () => ({
  exportBoardCsv: vi.fn(),
  exportBoardJson: vi.fn(),
}))

vi.mock('../components/Board/SummaryView', () => ({
  default: () => <div data-testid="summary-view">Summary</div>,
}))
vi.mock('../components/Board/AnalyticsView', () => ({
  default: ({ onOpenCard }: { onOpenCard?: (id: number) => void }) => (
    <div data-testid="analytics-view">
      Analytics
      <button data-testid="open-card-btn" onClick={() => onOpenCard?.(1)}>Open Card</button>
    </div>
  ),
}))
vi.mock('../components/Board/ColumnHeader', () => ({
  default: ({ column, collapsed }: { column: { id: number; name: string }; collapsed: boolean }) => (
    <div data-testid={`col-${column.id}`} data-collapsed={String(collapsed)}>{column.name}</div>
  ),
}))
vi.mock('../components/Board/SwimlaneRow', () => ({
  default: ({ swimlane }: { swimlane: { id: number; name: string } }) => <div data-testid={`swim-${swimlane.id}`}>{swimlane.name}</div>,
}))
vi.mock('../components/Card/CardItem', () => ({
  default: ({ card }: { card: { title: string } }) => <div>{card.title}</div>,
}))
vi.mock('../components/Card/CardDetail', () => ({
  default: ({ card, onClose }: { card: { title: string }; onClose: () => void }) => <div data-testid="card-detail">{card.title}<button onClick={onClose}>Close Detail</button></div>,
}))
vi.mock('../components/Board/AddColumnModal', () => ({
  default: ({ onAdded }: { onAdded: (col: { id: number; name: string; position: number; color: string; wip_limit: null; weight_limit: null; allow_card_creation: true }) => void }) => (
    <div data-testid="add-column-modal">
      <button onClick={() => onAdded({ id: 99, name: 'New Column', position: 2, color: '#000', wip_limit: null, weight_limit: null, allow_card_creation: true })}>
        Confirm Add
      </button>
    </div>
  ),
}))
vi.mock('../components/Swimlane/AddSwimlaneModal', () => ({
  default: () => <div data-testid="add-swimlane-modal">Add Swimlane Modal</div>,
}))
vi.mock('../components/Board/BoardSettingsModal', () => ({
  default: () => <div data-testid="settings-modal">Settings Modal</div>,
}))
vi.mock('../components/Board/FilterBar', () => ({
  default: () => <div data-testid="filter-bar">FilterBar</div>,
  EMPTY_FILTER: { search: '', assigneeIds: [], labelIds: [], priorities: [], dueDate: null },
  countActiveFilters: () => 0,
}))
vi.mock('../components/Board/KeyboardShortcutsOverlay', () => ({
  default: ({ onClose }: { onClose: () => void }) => <div data-testid="shortcuts-overlay"><button onClick={onClose}>Close Shortcuts</button></div>,
}))
vi.mock('../components/Board/BulkActionToolbar', () => ({
  default: () => <div data-testid="bulk-toolbar">Bulk Actions</div>,
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

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, has_usable_password: true,
}

function makeBoard(overrides: Partial<BoardFull> = {}): BoardFull {
  return {
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    columns: [
      { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true },
      { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true },
    ],
    swimlanes: [
      { id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01' },
    ],
    cards: [],
    labels: [{ id: 100, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }],
    members: [{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }],
    staleness_threshold_days: 7,
    stale_warning_pct: 50,
    allowed_priorities: ['low', 'medium', 'high', 'critical'] as BoardFull['allowed_priorities'],
    enforce_wip_limits: false, enforce_weight_limits: false,
    is_starred: false,
    created_at: '', updated_at: '',
    current_user_role: 'admin',
    ...overrides,
  }
}

const defaultProps = () => ({
  board: makeBoard(),
  onMoveCard: vi.fn(),
  onCardAdded: vi.fn(),
  onCardDeleted: vi.fn(),
  onCardUpdated: vi.fn(),
  onCardArchived: vi.fn(),
  onCardUnarchived: vi.fn(),
  onColumnAdded: vi.fn(),
  onColumnUpdated: vi.fn(),
  onColumnDeleted: vi.fn(),
  onColumnsReordered: vi.fn(),
  onSwimlaneAdded: vi.fn(),
  onSwimlaneUpdated: vi.fn(),
  onSwimlaneDeleted: vi.fn(),
  onSwimlanesReordered: vi.fn(),
  onLabelAdded: vi.fn(),
  onLabelUpdated: vi.fn(),
  onLabelDeleted: vi.fn(),
  onMemberAdded: vi.fn(),
  onMemberUpdated: vi.fn(),
  onMemberRemoved: vi.fn(),
  onColumnOrderApplied: vi.fn(),
  onSwimlaneOrderApplied: vi.fn(),
})

describe('BoardView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSearchParams = new URLSearchParams()
    localStorage.clear()
  })

  it('renders view toggle buttons', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText('Board')).toBeInTheDocument()
    expect(screen.getByText('Summary')).toBeInTheDocument()
    expect(screen.getByText('Analytics')).toBeInTheDocument()
  })

  it('renders Live status when connected', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText('Live')).toBeInTheDocument()
  })

  it('live dot is green and pulsing when connected', () => {
    const { container } = render(<BoardView {...defaultProps()} />)
    const dot = container.querySelector('.bg-green-400')
    expect(dot).toBeInTheDocument()
    expect(dot?.className).toMatch(/animate-pulse/)
  })

  it('FilterBar renders in its own row below the toolbar', async () => {
    render(<BoardView {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('Filters'))
    const filterBar = screen.getByTestId('filter-bar')
    const toolbar = screen.getByText('Board').closest('div[class*="h-10"]')
    // FilterBar should not be a descendant of the fixed-height toolbar row
    expect(toolbar?.contains(filterBar)).toBe(false)
  })

  it('renders Filters button', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText('Filters')).toBeInTheDocument()
  })

  it('does not render Export button in toolbar (export is in board settings)', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.queryByText('Export')).not.toBeInTheDocument()
  })

  it('renders Settings button', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('hides Settings button for viewer', () => {
    const props = defaultProps()
    props.board = makeBoard({ current_user_role: 'viewer' })
    render(<BoardView {...props} />)
    expect(screen.queryByText('Settings')).not.toBeInTheDocument()
  })

  it('renders column headers', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('col-10')).toBeInTheDocument()
    expect(screen.getByTestId('col-11')).toBeInTheDocument()
  })

  it('renders swimlane rows', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('swim-20')).toBeInTheDocument()
  })

  it('shows empty state when no columns', () => {
    const props = defaultProps()
    props.board = makeBoard({ columns: [] })
    render(<BoardView {...props} />)
    expect(screen.getByText(/No columns/)).toBeInTheDocument()
  })

  it('shows + Add column button in empty state for admin', () => {
    const props = defaultProps()
    props.board = makeBoard({ columns: [] })
    render(<BoardView {...props} />)
    expect(screen.getByText('+ Add column')).toBeInTheDocument()
  })

  it('shows empty state when no swimlanes', () => {
    const props = defaultProps()
    props.board = makeBoard({ swimlanes: [] })
    render(<BoardView {...props} />)
    expect(screen.getByText(/No swimlanes/)).toBeInTheDocument()
  })

  it('switches to Summary view', async () => {
    render(<BoardView {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('Summary'))
    expect(screen.getByTestId('summary-view')).toBeInTheDocument()
  })

  it('switches to Analytics view', async () => {
    render(<BoardView {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('Analytics'))
    expect(screen.getByTestId('analytics-view')).toBeInTheDocument()
  })

  it('opens CardDetail from analytics view when onOpenCard is triggered', async () => {
    const stalledCard = {
      id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Stalled Card',
      description: '', priority: 'medium' as const, assignee: null, labels: [], due_date: null, weight: 1,
      position: 0, created_by: 1, created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z', last_moved_at: null,
      attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
    }
    const props = defaultProps()
    props.board = makeBoard({ cards: [stalledCard] })
    render(<BoardView {...props} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('Analytics'))
    expect(screen.getByTestId('analytics-view')).toBeInTheDocument()
    // Simulate analytics view calling onOpenCard with the card's id
    await user.click(screen.getByTestId('open-card-btn'))
    // CardDetail must render inside the analytics view return branch
    expect(screen.getByTestId('card-detail')).toBeInTheDocument()
    expect(screen.getByText('Stalled Card')).toBeInTheDocument()
  })

  it('clicking Filters toggles filter bar', async () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.queryByTestId('filter-bar')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByText('Filters'))
    expect(screen.getByTestId('filter-bar')).toBeInTheDocument()
  })

  it('Escape from analytics view goes back to summary', async () => {
    render(<BoardView {...defaultProps()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('Analytics'))
    expect(screen.getByTestId('analytics-view')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.getByTestId('summary-view')).toBeInTheDocument()
  })

  it('Escape from summary view goes back to board', async () => {
    render(<BoardView {...defaultProps()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('Summary'))
    expect(screen.getByTestId('summary-view')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('summary-view')).not.toBeInTheDocument()
    expect(screen.queryByTestId('analytics-view')).not.toBeInTheDocument()
  })

  it('Escape from analytics goes to summary then to board on second press', async () => {
    render(<BoardView {...defaultProps()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('Analytics'))
    expect(screen.getByTestId('analytics-view')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.getByTestId('summary-view')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('summary-view')).not.toBeInTheDocument()
    expect(screen.queryByTestId('analytics-view')).not.toBeInTheDocument()
  })

  it('clicking Settings opens the settings modal', async () => {
    render(<BoardView {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('Settings'))
    expect(screen.getByTestId('settings-modal')).toBeInTheDocument()
  })

  it('renders board density stats in the corner cell', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText(/col/)).toBeInTheDocument()
    expect(screen.getByText(/lane/)).toBeInTheDocument()
  })

  it('renders ? keyboard shortcuts button', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByTitle('Keyboard shortcuts (?)')).toBeInTheDocument()
  })

  it('clicking ? shows shortcuts overlay', async () => {
    render(<BoardView {...defaultProps()} />)
    await userEvent.setup().click(screen.getByTitle('Keyboard shortcuts (?)'))
    expect(screen.getByTestId('shortcuts-overlay')).toBeInTheDocument()
  })

  it('reads view from ?view=summary param on mount and renders SummaryView', () => {
    mockSearchParams = new URLSearchParams('view=summary')
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('summary-view')).toBeInTheDocument()
  })

  it('reads view from ?view=analytics param on mount and renders AnalyticsView', () => {
    mockSearchParams = new URLSearchParams('view=analytics')
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('analytics-view')).toBeInTheDocument()
  })

  it('invalid ?view= param falls back to board view', () => {
    mockSearchParams = new URLSearchParams('view=invalid')
    render(<BoardView {...defaultProps()} />)
    expect(screen.queryByTestId('summary-view')).not.toBeInTheDocument()
    expect(screen.queryByTestId('analytics-view')).not.toBeInTheDocument()
    // Board view columns should be visible
    expect(screen.getByTestId('col-10')).toBeInTheDocument()
  })

  it('absent ?view= param renders board view', () => {
    mockSearchParams = new URLSearchParams()
    render(<BoardView {...defaultProps()} />)
    expect(screen.queryByTestId('summary-view')).not.toBeInTheDocument()
    expect(screen.queryByTestId('analytics-view')).not.toBeInTheDocument()
  })

  it('switching to Summary tab calls setSearchParams with { view: summary } and replace: true', async () => {
    render(<BoardView {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('Summary'))
    expect(mockSetSearchParams).toHaveBeenCalledWith({ view: 'summary' }, { replace: true })
  })

  it('switching to Analytics tab calls setSearchParams with { view: analytics } and replace: true', async () => {
    render(<BoardView {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('Analytics'))
    expect(mockSetSearchParams).toHaveBeenCalledWith({ view: 'analytics' }, { replace: true })
  })

  it('switching to Board tab calls setSearchParams with { view: board } and replace: true', async () => {
    mockSearchParams = new URLSearchParams('view=summary')
    render(<BoardView {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('Board'))
    expect(mockSetSearchParams).toHaveBeenCalledWith({ view: 'board' }, { replace: true })
  })

  it('?card= param opens CardDetail for a matching card', () => {
    mockSearchParams = new URLSearchParams('card=1')
    const card = {
      id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Deep Link Card',
      description: '', priority: 'medium' as const, assignee: null,
      labels: [], due_date: null, weight: 1, position: 0, created_by: 1,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0,
      checklist_done: 0, is_stale: false, archived_at: null,
    }
    const props = defaultProps()
    props.board = makeBoard({ cards: [card] })
    render(<BoardView {...props} />)
    expect(screen.getByTestId('card-detail')).toBeInTheDocument()
    expect(screen.getByText('Deep Link Card')).toBeInTheDocument()
    expect(mockSetSearchParams).toHaveBeenCalled()
  })

  it('?card= param shows "Card not found" banner when card is missing', () => {
    mockSearchParams = new URLSearchParams('card=999')
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText(/Card not found/)).toBeInTheDocument()
    expect(mockSetSearchParams).toHaveBeenCalled()
  })

  it('"Card not found" banner auto-dismisses after 4s', async () => {
    vi.useFakeTimers()
    mockSearchParams = new URLSearchParams('card=999')
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText(/Card not found/)).toBeInTheDocument()
    await act(async () => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByText(/Card not found/)).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('fresh board with no stored prefs renders all columns expanded', async () => {
    // localStorage is cleared in beforeEach — no stored view prefs for this board.
    // Columns are expanded by default (collapsedColumnIds is empty), so no effect needed.
    render(<BoardView {...defaultProps()} />)
    await act(async () => {})
    expect(screen.getByTestId('col-10')).toHaveAttribute('data-collapsed', 'false')
    expect(screen.getByTestId('col-11')).toHaveAttribute('data-collapsed', 'false')
  })

  it('imported board with a new id renders all columns expanded', async () => {
    // Imported boards get a new board id with no localStorage entry — all columns must be expanded.
    localStorage.clear()
    render(<BoardView {...defaultProps()} />)
    await act(async () => {})
    expect(screen.getByTestId('col-10')).toHaveAttribute('data-collapsed', 'false')
    expect(screen.getByTestId('col-11')).toHaveAttribute('data-collapsed', 'false')
  })

  it('column added via AddColumnModal is immediately expanded', async () => {
    const props = defaultProps()
    // Start with no columns so the empty-state "+ Add column" button is visible
    props.board = makeBoard({ columns: [] })
    render(<BoardView {...props} />)
    await act(async () => {})
    await userEvent.setup().click(screen.getByText('+ Add column'))
    expect(screen.getByTestId('add-column-modal')).toBeInTheDocument()
    // Simulate the modal confirming a new column (id=99)
    await userEvent.setup().click(screen.getByText('Confirm Add'))
    // New columns are expanded by default — they are not added to collapsedColumnIds.
    const stored = JSON.parse(localStorage.getItem('board:1:view-prefs') ?? '{}')
    expect((stored.collapsedColumnIds ?? [])).not.toContain(99)
  })

  it('clicking a column separator opens AddColumnModal', async () => {
    const { container } = render(<BoardView {...defaultProps()} />)
    await act(async () => {})
    // ColumnSeparators are 16px-wide divs with cursor-col-resize; trigger mousedown+mouseup (no drag)
    const separators = container.querySelectorAll('.cursor-col-resize')
    expect(separators.length).toBeGreaterThan(0)
    const sep = separators[0] as HTMLElement
    fireEvent.mouseDown(sep, { clientX: 100 })
    fireEvent.mouseUp(window, { clientX: 100 })
    expect(screen.getByTestId('add-column-modal')).toBeInTheDocument()
  })

  it('collisionDetection for card drag only returns cell: containers', () => {
    render(<BoardView {...defaultProps()} />)
    expect(capturedCollisionDetection).toBeDefined()

    const containers = [
      { id: 'col:10', data: { current: {} }, rect: { current: null } },
      { id: 'swim:20', data: { current: {} }, rect: { current: null } },
      { id: 'cell:10:20', data: { current: {} }, rect: { current: null } },
      { id: 'cell:11:20', data: { current: {} }, rect: { current: null } },
    ]

    // Simulate a card drag (active id is a plain number, not col: or swim:)
    const args = {
      active: { id: 228, data: { current: {} }, rect: { current: { translated: null, initial: null } } },
      droppableContainers: containers as Parameters<CollisionDetection>[0]['droppableContainers'],
      droppableRects: new Map(),
      collisionRect: { top: 0, left: 0, bottom: 10, right: 10, width: 10, height: 10 },
      pointerCoordinates: null,
    } as Parameters<CollisionDetection>[0]

    capturedCollisionDetection!(args)

    // closestCenter should have been called with only cell: containers
    const mockClosestCenter = vi.mocked(dndCore.closestCenter)
    const lastCall = mockClosestCenter.mock.calls[mockClosestCenter.mock.calls.length - 1]
    const filteredContainers: typeof containers = lastCall[0].droppableContainers as typeof containers
    expect(filteredContainers.every((c: (typeof containers)[0]) => String(c.id).startsWith('cell:'))).toBe(true)
    expect(filteredContainers).toHaveLength(2)
  })

  it('handleDragEnd does not call onMoveCard when card is dropped on a column header', async () => {
    const props = defaultProps()
    const card = {
      id: 228, uid: 'carduid00228', column: 10, swimlane: 20, title: 'Test Card',
      description: '', priority: 'medium' as const, assignee: null,
      labels: [], due_date: null, weight: 1, position: 0, created_by: 1,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0,
      checklist_done: 0, is_stale: false, archived_at: null,
    }
    props.board = makeBoard({ cards: [card] })
    render(<BoardView {...props} />)
    expect(capturedOnDragEnd).toBeDefined()

    // Simulate dropping a card (id=228) onto a column header zone (over.id="col:11")
    // This is the scenario that causes swimId = undefined → NaN → null → backend 404
    const dragEndEvent = {
      active: { id: 228, data: { current: {} }, rect: { current: { translated: null, initial: null } } },
      over: { id: 'col:11', data: { current: {} }, rect: { top: 0, left: 0, bottom: 10, right: 10, width: 10, height: 10 } },
      delta: { x: 0, y: 0 },
      activatorEvent: new MouseEvent('mousedown'),
    } as unknown as DragEndEvent

    act(() => { capturedOnDragEnd!(dragEndEvent) })

    // The guard should prevent onMoveCard from being called
    expect(props.onMoveCard).not.toHaveBeenCalled()
  })
})
