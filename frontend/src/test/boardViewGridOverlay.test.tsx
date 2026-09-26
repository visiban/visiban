/**
 * Tests for the grid overlay slot's BoardView wiring (#1147) — the toolbar picker,
 * the legend, persistence, and the "None means nothing changes" default.
 *
 * Reuses the mock infrastructure of boardViewCardLayoutToggle.test.tsx, with the
 * SwimlaneRow double widened to expose the overlay props it receives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardView from '../components/Board/BoardView'
import type { BoardFull, Card, User } from '../types'
import type { BoardContextType } from '../contexts/BoardContext'
import type { CollisionDetection } from '@dnd-kit/core'

const OVERLAY_KEY = 'board:1:grid-overlay'

let mockSearchParams = new URLSearchParams()
const mockSetSearchParams = vi.fn()

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
  default: ({ swimlane, overlayLabel, overlayCells }: { swimlane: { id: number; name: string }; overlayLabel?: string; overlayCells?: Map<string, unknown> }) => (
    <div
      data-testid={`swim-${swimlane.id}`}
      data-overlay-label={overlayLabel ?? ''}
      data-overlay-cells={String(overlayCells ? overlayCells.size : -1)}
    >
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
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    columns: [
      { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
    ],
    swimlanes: [
      { id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01' },
    ],
    cards: [],
    labels: [],
    members: [{ id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7,
    stale_warning_pct: 50,
    allowed_priorities: ['low', 'medium', 'high', 'critical'] as BoardFull['allowed_priorities'],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false, export_min_role: 'viewer', card_density: 'comfortable',
    is_starred: false,
    created_at: '', updated_at: '',
    current_user_role: 'admin',
    custom_field_definitions: [],
    swimlane_custom_field_definitions: [],
    owner: fakeUser,
    capabilities: { movement_export: false },
    share_token: null,
    share_token_expires_at: null,
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
// Helpers
// ---------------------------------------------------------------------------

function makeCard(id: number, column: number, swimlane: number): Card {
  return {
    id, uid: `carduid0000${id}`, column, swimlane, title: `Card ${id}`, description: '',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: 0, created_by: fakeUser, created_at: '', updated_at: '', last_moved_at: null,
    attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false,
    archived_at: null, version: 1, custom_field_values: [], blocker_count: 0,
  }
}

/** The overlay picker's trigger — labeled "Overlay" until an overlay is chosen. */
function getPicker(): HTMLElement {
  return screen.queryByRole('button', { name: /^Overlay$/ }) ?? screen.getByRole('button', { name: 'Card count' })
}

async function selectCardCount() {
  await userEvent.click(getPicker())
  await userEvent.click(screen.getByRole('menuitem', { name: 'Card count' }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BoardView — grid overlay slot (#1147)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSearchParams = new URLSearchParams()
    localStorage.clear()
    mockBoardContextValue = defaultContext()
  })

  it('renders the overlay picker in the board toolbar, reading "Overlay" at rest', () => {
    render(<BoardView />)
    expect(screen.getByRole('button', { name: /^Overlay$/ })).toBeInTheDocument()
  })

  it('offers exactly the two registered overlays, None first', async () => {
    render(<BoardView />)
    await userEvent.click(getPicker())
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent)
    expect(items).toEqual(['None', 'Card count'])
  })

  it('defaults to None: no legend, and SwimlaneRow gets no overlay props', () => {
    render(<BoardView />)
    expect(screen.queryByRole('group', { name: /overlay scale/ })).not.toBeInTheDocument()
    const row = screen.getByTestId('swim-20')
    expect(row).toHaveAttribute('data-overlay-label', '')
    expect(row).toHaveAttribute('data-overlay-cells', '-1')
  })

  it('threads the overlay down to the swimlane rows once one is selected', async () => {
    mockBoardContextValue = defaultContext({
      board: makeBoard({ cards: [makeCard(1, 10, 20), makeCard(2, 10, 20)] }),
    })
    render(<BoardView />)
    await selectCardCount()
    const row = screen.getByTestId('swim-20')
    expect(row).toHaveAttribute('data-overlay-label', 'Card count')
    expect(row).toHaveAttribute('data-overlay-cells', '1')
  })

  it('shows the legend with the overlay name and its observed range', async () => {
    mockBoardContextValue = defaultContext({
      board: makeBoard({ cards: [makeCard(1, 10, 20), makeCard(2, 10, 20)] }),
    })
    render(<BoardView />)
    await selectCardCount()
    const legend = screen.getByRole('group', { name: 'Card count overlay scale' })
    expect(legend).toBeInTheDocument()
    expect(legend).toHaveTextContent('Card count')
    expect(legend).toHaveTextContent('2')
  })

  it('shows the legend empty state when the overlay has nothing to show', async () => {
    render(<BoardView />)
    await selectCardCount()
    expect(screen.getByRole('group', { name: 'Card count overlay scale' })).toHaveTextContent(
      'No values on this board yet.',
    )
  })

  it('persists the choice per board and announces it', async () => {
    render(<BoardView />)
    await selectCardCount()
    expect(localStorage.getItem(OVERLAY_KEY)).toBe('card-count')
    expect(screen.getByText('Overlay: Card count')).toBeInTheDocument()
  })

  it('restores a persisted overlay on mount', () => {
    localStorage.setItem(OVERLAY_KEY, 'card-count')
    render(<BoardView />)
    expect(screen.getByRole('button', { name: 'Card count' })).toBeInTheDocument()
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-overlay-label', 'Card count')
  })

  it('falls back to None when the persisted id is unknown to this build', () => {
    // What a #1146 board preset naming a newer overlay would look like here.
    localStorage.setItem(OVERLAY_KEY, 'dwell-time')
    render(<BoardView />)
    expect(screen.getByRole('button', { name: /^Overlay$/ })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /overlay scale/ })).not.toBeInTheDocument()
  })

  it('turns the overlay off again from the None option, and announces that too', async () => {
    localStorage.setItem(OVERLAY_KEY, 'card-count')
    render(<BoardView />)
    await userEvent.click(getPicker())
    await userEvent.click(screen.getByRole('menuitem', { name: 'None' }))
    expect(screen.queryByRole('group', { name: /overlay scale/ })).not.toBeInTheDocument()
    expect(screen.getByText('Overlay off')).toBeInTheDocument()
    expect(localStorage.getItem(OVERLAY_KEY)).toBe('none')
  })

  it('keeps the picker out of the overflow kebab — a menu item carries an action, not a selection', async () => {
    render(<BoardView />)
    await userEvent.click(screen.getByRole('button', { name: /More actions|More/ }))
    expect(screen.queryByRole('menuitem', { name: /Overlay/ })).not.toBeInTheDocument()
  })
})
