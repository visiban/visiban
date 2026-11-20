/**
 * Tests for the card layout control in BoardView (#626), now a segmented control
 * in the View menu (#2269).
 * Covers rendering, toggle behaviour, aria-pressed state, and tooltip text.
 *
 * These tests reuse the same mock infrastructure as boardView.test.tsx but live
 * in their own file to keep the card-layout concern isolated and easy to locate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardView from '../components/Board/BoardView'
import type { BoardFull, User } from '../types'
import type { BoardContextType } from '../contexts/BoardContext'
import type { CollisionDetection } from '@dnd-kit/core'

const LAYOUT_KEY = 'user:prefs:card-layout'

let mockSearchParams = new URLSearchParams()
const mockSetSearchParams = vi.fn()

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MouseSensor: class { static activators = [] },
  TouchSensor: class {},
  KeyboardSensor: class {},
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
  // BoardView reads navigation state for the board-invite joined notice (#1444).
  useLocation: () => ({ pathname: '/', search: '', hash: '', state: null, key: 'default' }),
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
  useNavigate: () => vi.fn(),
  MemoryRouter: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('../hooks/useBoardSocket', () => ({
  useBoardSocket: () => ({ connected: true, status: 'connected', lastEventAt: null, reconnectAttempt: 0 }),
}))

vi.mock('../hooks/useBoardPan', () => ({
  useBoardPan: () => {},
}))

let mockBoardContextValue: BoardContextType
vi.mock('../contexts/BoardContext', () => ({
  useBoardContext: () => mockBoardContextValue,
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
  default: ({ column }: { column: { id: number; name: string } }) => (
    <div data-testid={`col-${column.id}`}>{column.name}</div>
  ),
}))
vi.mock('../components/Board/SwimlaneRow', () => ({
  default: ({ swimlane, compact }: { swimlane: { id: number; name: string }; compact?: boolean }) => (
    <div data-testid={`swim-${swimlane.id}`} data-compact={String(compact ?? false)}>
      {swimlane.name}
    </div>
  ),
}))
vi.mock('../components/Card/CardItem', () => ({
  default: ({ card }: { card: { title: string } }) => <div>{card.title}</div>,
}))
vi.mock('../components/Card/CardDetail', () => ({
  default: ({ card, onClose }: { card: { title: string }; onClose: () => void }) => (
    <div data-testid="card-detail">{card.title}<button onClick={onClose}>Close Detail</button></div>
  ),
}))
vi.mock('../components/Board/AddColumnModal', () => ({
  default: () => <div data-testid="add-column-modal" />,
}))
vi.mock('../components/Swimlane/AddSwimlaneModal', () => ({
  default: () => <div data-testid="add-swimlane-modal" />,
}))
vi.mock('../components/Board/BoardSettingsModal', () => ({
  default: () => <div data-testid="settings-modal" />,
}))
vi.mock('../components/Board/FilterBar', () => ({
  default: () => <div data-testid="filter-bar">FilterBar</div>,
  EMPTY_FILTER: { search: '', assigneeIds: [], labelIds: [], priorities: [], dueDate: null, customFields: {}, visibleCustomFieldFilterIds: [] },
  countActiveFilters: () => 0,
  isCustomFieldFilterActive: () => false,
}))
vi.mock('../components/Board/KeyboardShortcutsOverlay', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="shortcuts-overlay"><button onClick={onClose}>Close Shortcuts</button></div>
  ),
}))
vi.mock('../components/Common/Tooltip', () => ({
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for Tooltip's loosely-typed children prop, see Tooltip.tsx */
  default: ({ content, children }: { content: string; children: React.ReactElement<any> }) =>
    React.cloneElement(children, { 'data-tooltip': content }),
}))
vi.mock('../components/Board/BulkActionToolbar', () => ({
  default: () => <div data-testid="bulk-toolbar" />,
}))
vi.mock('../components/Board/ArchivedCardsPanel', () => ({
  default: () => <div data-testid="archived-panel">Archived</div>,
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
vi.mock('../components/Board/MovementHistoryView', () => ({
  default: () => <div data-testid="movement-history-view" />,
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false, has_usable_password: true,
  has_completed_tour: true,
}

function makeBoard(overrides: Partial<BoardFull> = {}): BoardFull {
  return {
    health_status: null, effective_health_status: null, health_status_source: null, health_status_changed_at: null, health_status_changed_by: null, health_status_note: null, health_review_days: null, health_review_due_at: null, health_auto_enabled: false, health_off_track_cards: 3, computed_health_status: null, health_computed_at: null, health_computed_counts: null, health_status_origin: null, default_preset: null,
    swimlane_rollup_field: null,
    commitment_column_uid: null,
    cards_can_have_children: false,
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0,
    columns: [
      { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
    ],
    swimlanes: [
      { id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null },
    ],
    cards: [],
    labels: [],
    members: [{ id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7,
    stale_warning_pct: 50,
    allowed_priorities: ['low', 'medium', 'high', 'critical'] as BoardFull['allowed_priorities'],
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

function defaultContext(overrides: Partial<BoardContextType> = {}): BoardContextType {
  return {
    board: makeBoard(),
    loading: false,
    error: null,
    reload: vi.fn(),
    silentReload: vi.fn(),
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
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helpers: the layout control is a two-segment group inside the View menu
// ---------------------------------------------------------------------------
function openView() {
  if (!screen.queryByTestId('view-menu-panel')) fireEvent.click(screen.getByRole('button', { name: 'View' }))
  return within(screen.getByRole('group', { name: 'Card layout' }))
}
const expandedBtn = () => openView().getByRole('button', { name: /Expanded/ })
const compactBtn = () => openView().getByRole('button', { name: /Compact/ })

describe('BoardView — card layout control (View menu)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSearchParams = new URLSearchParams()
    localStorage.clear()
    mockBoardContextValue = defaultContext()
  })

  it('no longer renders a layout button in the toolbar itself', () => {
    render(<BoardView />)
    expect(screen.queryByLabelText('Switch to compact card layout')).not.toBeInTheDocument()
    expect(screen.queryByTestId('view-menu-panel')).not.toBeInTheDocument()
  })

  it('starts in expanded mode by default', () => {
    render(<BoardView />)
    expect(expandedBtn()).toHaveAttribute('aria-pressed', 'true')
    expect(compactBtn()).toHaveAttribute('aria-pressed', 'false')
  })

  it('starts in compact mode when localStorage has compact', () => {
    localStorage.setItem(LAYOUT_KEY, 'compact')
    render(<BoardView />)
    expect(compactBtn()).toHaveAttribute('aria-pressed', 'true')
    expect(expandedBtn()).toHaveAttribute('aria-pressed', 'false')
  })

  it('marks the active segment with a check, not color alone', () => {
    render(<BoardView />)
    expect(within(expandedBtn()).getByTestId('active-mark')).toBeInTheDocument()
    expect(within(compactBtn()).queryByTestId('active-mark')).not.toBeInTheDocument()
  })

  it('choosing Compact persists compact and switching back persists expanded', async () => {
    render(<BoardView />)
    const user = userEvent.setup()
    await user.click(compactBtn())
    expect(localStorage.getItem(LAYOUT_KEY)).toBe('compact')
    expect(compactBtn()).toHaveAttribute('aria-pressed', 'true')
    await user.click(expandedBtn())
    expect(localStorage.getItem(LAYOUT_KEY)).toBe('expanded')
  })

  it('compact mode propagates to swimlane rows via data-compact attribute', async () => {
    render(<BoardView />)
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-compact', 'false')
    await userEvent.setup().click(compactBtn())
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-compact', 'true')
  })

  it('returning to expanded mode propagates to swimlane rows', async () => {
    localStorage.setItem(LAYOUT_KEY, 'compact')
    render(<BoardView />)
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-compact', 'true')
    await userEvent.setup().click(expandedBtn())
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-compact', 'false')
  })

  it('toolbar toggles that keep a pressed state expose aria-pressed', async () => {
    render(<BoardView />)
    const user = userEvent.setup()
    for (const [before, after] of [['Open activity drawer', 'Close activity drawer']]) {
      const btn = screen.getByRole('button', { name: before })
      expect(btn).toHaveAttribute('aria-pressed', 'false')
      await user.click(btn)
      expect(screen.getAllByRole('button', { name: after }).some((b) => b.getAttribute('aria-pressed') === 'true')).toBe(true)
    }
  })

  it('the Filter button reports its panel with aria-expanded', async () => {
    render(<BoardView />)
    const btn = screen.getByRole('button', { name: 'Filters' })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    await userEvent.setup().click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
  })

  it('Escape closes the View menu and returns focus to its button', async () => {
    render(<BoardView />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'View' }))
    expect(screen.getByTestId('view-menu-panel')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('view-menu-panel')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View' })).toHaveFocus()
  })

  it('collapse/expand, density, and archived controls live in the View menu', async () => {
    render(<BoardView />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'View' }))
    const panel = within(screen.getByTestId('view-menu-panel'))
    await user.click(panel.getByRole('button', { name: 'Dense' }))
    expect(panel.getByRole('button', { name: 'Dense' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(panel.getByRole('button', { name: 'Collapse all' }))
    expect(panel.getByRole('button', { name: 'Collapse all' })).toBeDisabled()
    await user.click(panel.getByRole('button', { name: 'Expand all' }))
    await user.click(panel.getByRole('button', { name: 'Hide all' }))
    await user.click(panel.getByRole('button', { name: 'Show all' }))
    await user.click(panel.getByRole('button', { name: 'Show archived cards' }))
    expect(panel.getByRole('button', { name: 'Hide archived cards' })).toHaveAttribute('aria-pressed', 'true')
  })
})
