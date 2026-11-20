/**
 * BoardView wiring of the card peek sheet (#2273): Shift+click, Shift+Enter or Show summary peeks, Open card
 * hands off to the detail sheet, and the peek never shows with the activity
 * drawer or the detail sheet. Mock setup mirrors boardViewGridOverlay.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardView from '../components/Board/BoardView'
import type { BoardFull, Card, User } from '../types'
import type { BoardContextType } from '../contexts/BoardContext'
import type { CollisionDetection } from '@dnd-kit/core'


let mockSearchParams = new URLSearchParams()
const mockSetSearchParams = vi.fn()

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, sensors }: { children: React.ReactNode; sensors?: unknown[] }) => <div data-testid="dnd" data-sensors={sensors?.length ?? 0}>{children}</div>,
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MouseSensor: class { static activators = [] },
  TouchSensor: class {},
  KeyboardSensor: class {},
  closestCenter: vi.fn((_args: Parameters<CollisionDetection>[0]) => []),
  useSensor: () => ({}),
  useSensors: (...a: unknown[]) => a,
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
  default: ({ swimlane, cards, onCardClick, currentCardId, onOpenCardMenu }: { swimlane: { id: number }; cards: Array<{ id: number; title: string }>; onCardClick: (c: unknown, opts?: { peek?: boolean }) => void; currentCardId: number | null; onOpenCardMenu?: unknown }) => (
    <div data-testid={`swim-${swimlane.id}`} data-current={String(currentCardId)} data-menu={onOpenCardMenu ? '1' : '0'}>
      {cards.map((c) => <button key={c.id} data-card-id={c.id} onClick={(e) => onCardClick(c, e.shiftKey ? { peek: true } : undefined)}>{`open ${c.title}`}</button>)}
    </div>
  ),
}))
vi.mock('../api/cards', async (orig) => ({
  ...(await orig<typeof import('../api/cards')>()),
  getCardMovements: vi.fn().mockResolvedValue([]),
  // The peek history's sub-column moves (#2365).
  getCardTimeline: vi.fn().mockResolvedValue({ count: 0, next: null, previous: null, results: [] }),
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
// Helpers
// ---------------------------------------------------------------------------

function makeCard(id: number, column: number, swimlane: number): Card {
  return {
    id, uid: `carduid0000${id}`, column, swimlane, title: `Card ${id}`, description: '',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: 0, created_by: fakeUser, created_at: '', updated_at: '', last_moved_at: null,
    attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false,
    archived_at: null, version: 1, custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
  }
}

async function peekClick(name: string) {
  fireEvent.click(screen.getByRole('button', { name }), { shiftKey: true })
}
async function plainClick(name: string) {
  await userEvent.click(screen.getByRole('button', { name }))
}

describe('BoardView card peek (#2273)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSearchParams = new URLSearchParams()
    localStorage.clear()
    mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [makeCard(1, 10, 20), makeCard(2, 10, 20)] }) })
  })

  it('opens the peek on a Shift+click, marks the card current, and Escape closes it', async () => {
    render(<BoardView />)
    expect(screen.queryByTestId('card-peek-sheet')).not.toBeInTheDocument()
    await peekClick('open Card 1')
    expect(screen.getByTestId('card-peek-sheet')).toBeInTheDocument()
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-current', '1')
    expect(screen.queryByTestId('card-detail')).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('card-peek-sheet')).not.toBeInTheDocument()
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-current', 'null')
  })

  it('swaps the peek when another card is clicked', async () => {
    render(<BoardView />)
    await peekClick('open Card 1')
    await plainClick('open Card 2')
    expect(screen.getAllByTestId('card-peek-sheet')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Card 2' })).toBeInTheDocument()
    expect(screen.queryByTestId('card-detail')).not.toBeInTheDocument()
    await peekClick('open Card 1')
    expect(screen.getByRole('heading', { name: 'Card 1' })).toBeInTheDocument()
  })

  it('the Show summary menu action opens the peek (#2358)', async () => {
    render(<BoardView />)
    act(() => {
      window.dispatchEvent(new CustomEvent('visiban:card-action', { detail: { cardIds: [2], action: 'summary' } }))
    })
    expect(await screen.findByTestId('card-peek-sheet')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Card 2' })).toBeInTheDocument()
  })

  it('a plain click opens the detail sheet, not the peek', async () => {
    render(<BoardView />)
    await plainClick('open Card 1')
    expect(screen.getByTestId('card-detail')).toHaveTextContent('Card 1')
    expect(screen.queryByTestId('card-peek-sheet')).not.toBeInTheDocument()
  })

  it('Shift+click while the detail panel is open swaps the panel, not the peek (#2358)', async () => {
    render(<BoardView />)
    await plainClick('open Card 1')
    await peekClick('open Card 2')
    expect(screen.getByTestId('card-detail')).toHaveTextContent('Card 2')
    expect(screen.queryByTestId('card-peek-sheet')).not.toBeInTheDocument()
  })

  it('Open card closes the peek and opens the detail sheet', async () => {
    render(<BoardView />)
    await peekClick('open Card 1')
    await userEvent.click(screen.getByRole('button', { name: 'Open card' }))
    expect(screen.queryByTestId('card-peek-sheet')).not.toBeInTheDocument()
    expect(screen.getByTestId('card-detail')).toHaveTextContent('Card 1')
    // With the detail sheet open, a card click swaps it rather than peeking.
    await plainClick('open Card 2')
    expect(screen.getByTestId('card-detail')).toHaveTextContent('Card 2')
    expect(screen.queryByTestId('card-peek-sheet')).not.toBeInTheDocument()
  })

  it('never shows with the activity drawer: opening the peek closes it and the drawer closes the peek', async () => {
    render(<BoardView />)
    await userEvent.click(screen.getByLabelText('Open activity drawer'))
    expect(screen.getAllByLabelText('Close activity drawer').length).toBeGreaterThan(0)
    await peekClick('open Card 1')
    expect(screen.getByLabelText('Open activity drawer')).toBeInTheDocument()
    expect(screen.getByTestId('card-peek-sheet')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Open activity drawer'))
    expect(screen.queryByTestId('card-peek-sheet')).not.toBeInTheDocument()
  })

  it('closes when the card disappears from the board', async () => {
    const { rerender } = render(<BoardView />)
    await peekClick('open Card 1')
    mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [makeCard(2, 10, 20)] }) })
    rerender(<BoardView />)
    expect(screen.queryByTestId('card-peek-sheet')).not.toBeInTheDocument()
  })

  it('suspends drag-and-drop while the peek is open and restores it on close', async () => {
    render(<BoardView />)
    const live = Number(screen.getByTestId('dnd').getAttribute('data-sensors'))
    expect(live).toBeGreaterThan(0)
    await peekClick('open Card 1')
    expect(screen.getByTestId('dnd')).toHaveAttribute('data-sensors', '0')
    await userEvent.keyboard('{Escape}')
    expect(screen.getByTestId('dnd')).toHaveAttribute('data-sensors', String(live))
  })

  it('never shows with the Archived panel: it closes the peek, and a card click closes it', async () => {
    render(<BoardView />)
    await peekClick('open Card 1')
    expect(screen.getByTestId('card-peek-sheet')).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'y' })
    expect(await screen.findByTestId('archived-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('card-peek-sheet')).not.toBeInTheDocument()
    await plainClick('open Card 2')
    expect(screen.getByTestId('card-detail')).toHaveTextContent('Card 2')
    expect(screen.queryByTestId('archived-panel')).not.toBeInTheDocument()
  })

  it('makes the peeked card the command palette target while the peek is open', async () => {
    render(<BoardView />)
    await peekClick('open Card 2')
    const detail: { focusedCardId: null; response?: { cardIds: number[]; source: string } | null } = { focusedCardId: null }
    window.dispatchEvent(new CustomEvent('visiban:card-target-query', { detail }))
    expect(detail.response?.cardIds).toEqual([2])
  })

  it('clears the peek when the view leaves the board, so returning does not reopen it', async () => {
    render(<BoardView />)
    await peekClick('open Card 1')
    expect(screen.getByTestId('card-peek-sheet')).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'a' })
    expect(await screen.findByTestId('analytics-view')).toBeInTheDocument()
    expect(screen.queryByTestId('card-peek-sheet')).not.toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'b' })
    expect(await screen.findByTestId('swim-20')).toBeInTheDocument()
    expect(screen.queryByTestId('card-peek-sheet')).not.toBeInTheDocument()
  })

  it('withholds the card context menu while the peek is open and restores it on close', async () => {
    render(<BoardView />)
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-menu', '1')
    await peekClick('open Card 1')
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-menu', '0')
    await userEvent.keyboard('{Escape}')
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-menu', '1')
  })

  it('shows the lane notice when a teammate edit hides the peeked card lane', async () => {
    const aeField = {
      id: 7, uid: 'slf000000007', name: 'AE', field_type: 'dropdown' as const, choices: ['Priya', 'Sam'], position: 0,
      show_on_row: true, is_admin_only: false, is_required: false, help_text: '', number_prefix: '', number_suffix: '',
      number_decimals: null, choice_colors: {}, created_at: '',
    }
    const laneWith = (ae: string) => ({
      ...makeBoard().swimlanes[0], custom_field_values: [{ field_definition: 7, value: ae }],
    })
    mockSearchParams = new URLSearchParams(`f_lanes=${encodeURIComponent('1.[{"f":7,"o":"is","v":"Priya"}]')}`)
    const boardFor = (ae: string) => makeBoard({
      swimlanes: [laneWith(ae), { ...laneWith('Priya'), id: 21, uid: 'laneuid00002', name: 'Customer B', position: 1 }],
      swimlane_custom_field_definitions: [aeField],
      cards: [makeCard(1, 10, 20), makeCard(2, 10, 21)],
    })
    mockBoardContextValue = defaultContext({ board: boardFor('Priya') })
    const { rerender } = render(<BoardView />)
    await peekClick('open Card 1')
    expect(screen.getByTestId('card-peek-sheet')).toBeInTheDocument()
    mockBoardContextValue = defaultContext({ board: boardFor('Sam') })
    rerender(<BoardView />)
    expect(screen.queryByTestId('swim-20')).not.toBeInTheDocument()
    expect(screen.getAllByText(/is now hidden because it no longer matches your lane filters/).length).toBeGreaterThan(0)
  })
})
