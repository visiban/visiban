import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardView from '../components/Board/BoardView'
import type { BoardFull, User } from '../types'

// Controllable search params for deep-link tests
let mockSearchParams = new URLSearchParams()
const mockSetSearchParams = vi.fn()

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
  arrayMove: vi.fn(),
}))

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [mockSearchParams, mockSetSearchParams],
}))

vi.mock('../hooks/useBoardSocket', () => ({
  useBoardSocket: () => ({ connected: true }),
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
vi.mock('../components/Board/ColumnHeader', () => ({
  default: ({ column }: { column: { id: number; name: string } }) => <div data-testid={`col-${column.id}`}>{column.name}</div>,
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
  default: () => <div data-testid="add-column-modal">Add Column Modal</div>,
}))
vi.mock('../components/Swimlane/AddSwimlaneModal', () => ({
  default: () => <div data-testid="add-swimlane-modal">Add Swimlane Modal</div>,
}))
vi.mock('../components/Board/BoardSettingsModal', () => ({
  default: () => <div data-testid="settings-modal">Settings Modal</div>,
}))
vi.mock('../components/Board/FilterBar', () => ({
  default: () => <div data-testid="filter-bar">FilterBar</div>,
  EMPTY_FILTER: { search: '', assigneeId: null, labelIds: [], priorities: [], dueDate: null },
  countActiveFilters: () => 0,
}))
vi.mock('../components/Board/KeyboardShortcutsOverlay', () => ({
  default: ({ onClose }: { onClose: () => void }) => <div data-testid="shortcuts-overlay"><button onClick={onClose}>Close Shortcuts</button></div>,
}))
vi.mock('../components/Board/BulkActionToolbar', () => ({
  default: () => <div data-testid="bulk-toolbar">Bulk Actions</div>,
}))

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, has_usable_password: true,
}

function makeBoard(overrides: Partial<BoardFull> = {}): BoardFull {
  return {
    id: 1, name: 'Test Board', description: '', group: null, group_name: null,
    columns: [
      { id: 10, name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true },
      { id: 11, name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true },
    ],
    swimlanes: [
      { id: 20, name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01' },
    ],
    cards: [],
    labels: [{ id: 100, name: 'Bug', color: '#EF4444' }],
    members: [{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }],
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
  onColumnAdded: vi.fn(),
  onColumnUpdated: vi.fn(),
  onColumnDeleted: vi.fn(),
  onColumnsReordered: vi.fn(),
  onSwimlaneAdded: vi.fn(),
  onSwimlaneUpdated: vi.fn(),
  onSwimlaneDeleted: vi.fn(),
  onLabelAdded: vi.fn(),
})

describe('BoardView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSearchParams = new URLSearchParams()
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

  it('renders Filters button', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText('Filters')).toBeInTheDocument()
  })

  it('renders Export button', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText('Export')).toBeInTheDocument()
  })

  it('renders Settings button', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('renders Settings button for viewer too', () => {
    const props = defaultProps()
    props.board = makeBoard({ current_user_role: 'viewer' })
    render(<BoardView {...props} />)
    expect(screen.getByText('Settings')).toBeInTheDocument()
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

  it('clicking Filters toggles filter bar', async () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.queryByTestId('filter-bar')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByText('Filters'))
    expect(screen.getByTestId('filter-bar')).toBeInTheDocument()
  })

  it('clicking Export shows CSV and JSON options', async () => {
    render(<BoardView {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('Export'))
    expect(screen.getByText('CSV')).toBeInTheDocument()
    expect(screen.getByText('JSON')).toBeInTheDocument()
  })

  it('renders + Col button for admin', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText('+ Col')).toBeInTheDocument()
  })

  it('renders + Swimlane button for admin', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText('+ Swimlane')).toBeInTheDocument()
  })

  it('hides + Col and + Swimlane for viewer', () => {
    const props = defaultProps()
    props.board = makeBoard({ current_user_role: 'viewer' })
    render(<BoardView {...props} />)
    expect(screen.queryByText('+ Col')).not.toBeInTheDocument()
    expect(screen.queryByText('+ Swimlane')).not.toBeInTheDocument()
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

  it('?card= param opens CardDetail for a matching card', () => {
    mockSearchParams = new URLSearchParams('card=1')
    const card = {
      id: 1, column: 10, swimlane: 20, title: 'Deep Link Card',
      description: '', priority: 'medium' as const, assignee: null,
      labels: [], due_date: null, weight: 1, position: 0, created_by: 1,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0,
      checklist_done: 0, is_stale: false,
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
})
