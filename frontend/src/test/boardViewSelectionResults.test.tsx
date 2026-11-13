import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import BoardView from '../components/Board/BoardView'
import { ToastProvider } from '../contexts/ToastContext'
import type { BoardFull, User } from '../types'
import type { BoardContextType } from '../contexts/BoardContext'
import type { CollisionDetection } from '@dnd-kit/core'

// Controllable search params — initial params can be set before render; the stateful mock
// updates them on setSearchParams calls so the component re-renders with the new params.
let mockSearchParams = new URLSearchParams()
// Spy on setSearchParams calls so tests can assert the arguments passed (e.g. replace:true).
const mockSetSearchParams = vi.fn()

// Capture DndContext props (onDragStart, onDragEnd, collisionDetection) so tests can invoke them directly.

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => {
    return <div>{children}</div>
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MouseSensor: class { static activators = [] },
  TouchSensor: class {},
  KeyboardSensor: class {},
  closestCenter: vi.fn((_args: Parameters<CollisionDetection>[0]) => []),
  useSensor: () => ({}),
  // Mirrors the real useSensors closely enough to tell "no sensors" apart (#1914).
  useSensors: (...sensors: unknown[]) => sensors.filter(Boolean),
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
  useNavigate: () => vi.fn(),
  MemoryRouter: ({ children }: { children: React.ReactNode }) => children,
}))

const socketOptionsSpy = vi.fn()
const mockSocketStatus = 'connected'
vi.mock('../hooks/useBoardSocket', () => ({
  useBoardSocket: (_id: unknown, _onEvent: unknown, options?: unknown) => { socketOptionsSpy(options); return { connected: true, status: mockSocketStatus, lastEventAt: null, reconnectAttempt: 0 } },
}))

vi.mock('../hooks/useBoardPan', () => ({
  useBoardPan: () => {},
}))

// Board context mock — lets tests control what useBoardContext returns.
let mockBoardContextValue: BoardContextType
vi.mock('../contexts/BoardContext', () => ({
  useBoardContext: () => mockBoardContextValue,
}))

vi.mock('../api/boards', () => ({
  exportBoardCsv: vi.fn(),
  exportBoardJson: vi.fn(),
  // CommandPalette fetches board list when opened; resolve with empty list so tests
  // that open the palette don't hit an unmocked API call.
  listBoards: vi.fn(() => Promise.resolve([])),
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
  default: ({ column, collapsed }: { column: { id: number; name: string }; collapsed: boolean }) => {
    return <div data-testid={`col-${column.id}`} data-collapsed={String(collapsed)}>{column.name}</div>
  },
}))
// SwimlaneRow mock renders name + focus/exit buttons so focus tests can fire onFocus/onExitFocus via click.
// data-can-edit surfaces the canEdit prop (#783 — maintenance mode folds into the
// existing per-board write gate) so tests can assert on it without rendering the
// real SwimlaneRow tree.
vi.mock('../components/Board/SwimlaneRow', () => ({
  default: ({ swimlane, cards, onFocus, onExitFocus, isFocused, compact, canEdit, onEditFieldOrder, hideRowChipFieldNames, sidebarWidth, onToggleCardSelection, currentCardId, onOpenCardMenu, contextTargetCardId }: { swimlane: { id: number; name: string }; cards?: { id: number }[]; onFocus?: (id: number) => void; onExitFocus?: () => void; isFocused?: boolean; compact?: boolean; canEdit?: boolean; onEditFieldOrder?: () => void; hideRowChipFieldNames?: boolean; sidebarWidth?: number; onToggleCardSelection?: (cardId: number) => void; currentCardId?: number | null; onOpenCardMenu?: (card: never, anchor: { top: number; bottom: number; left: number }) => void; contextTargetCardId?: number | null }) => {
    return (
      <div data-testid={`swim-${swimlane.id}`} data-current-card-id={String(currentCardId ?? '')} data-context-target={String(contextTargetCardId ?? '')} data-focused={String(isFocused ?? false)} data-compact={String(compact ?? false)} data-can-edit={String(canEdit ?? false)} data-hide-row-chip-names={String(hideRowChipFieldNames ?? false)} data-sidebar-width={String(sidebarWidth)}>
        {swimlane.name}
        <button data-testid={`focus-btn-${swimlane.id}`} onClick={() => onFocus?.(swimlane.id)}>Focus</button>
        <button data-testid={`exit-focus-btn-${swimlane.id}`} onClick={() => onExitFocus?.()}>ExitFocusMock</button>
        {onEditFieldOrder && <button data-testid={`edit-order-${swimlane.id}`} onClick={onEditFieldOrder}>EditOrderMock</button>}
        {onToggleCardSelection && <button data-testid={`select-card-1-${swimlane.id}`} onClick={() => onToggleCardSelection(1)}>SelectCardMock</button>}
        {onOpenCardMenu && (cards ?? []).map((c) => (
          <button key={c.id} data-testid={`open-menu-${c.id}`} onClick={() => onOpenCardMenu(c as never, { top: 10, bottom: 10, left: 10 })}>OpenMenuMock</button>
        ))}
      </div>
    )
  },
}))
vi.mock('../components/Card/CardItem', () => ({
  default: ({ card, compact, overlay, inDoneColumn }: { card: { title: string }; compact?: boolean; overlay?: boolean; inDoneColumn?: boolean }) => <div data-compact={String(compact ?? false)} data-overlay={String(!!overlay)} data-in-done-column={String(inDoneColumn ?? false)}>{card.title}</div>,
}))
vi.mock('../components/Card/CardDetail', () => ({
  default: ({ card, onClose, onDeleted, onForceMoveCard, blockFormRequest, tabRequest }: { card: { id: number; title: string }; onClose: () => void; onDeleted?: (id: number) => void; onForceMoveCard?: (cardId: number, columnId: number, swimlaneId: number, position: number) => Promise<unknown>; blockFormRequest?: { mode: string } | null; tabRequest?: { tab: string; n: number } }) => <div data-testid="card-detail" data-block-form={blockFormRequest?.mode ?? ''} data-tab-request={tabRequest ? `${tabRequest.tab}:${tabRequest.n}` : ''}>{card.title}<button onClick={onClose}>Close Detail</button><button onClick={() => onDeleted?.(card.id)}>Delete From Detail</button>{onForceMoveCard && <button onClick={() => { void onForceMoveCard(card.id, 11, 21, 9999) }}>Force From Detail</button>}</div>,
}))
vi.mock('../components/Board/AddColumnModal', () => ({
  default: ({ onAdded }: { onAdded: (col: { id: number; name: string; position: number; color: string; wip_limit: null; weight_limit: null; allow_card_creation: true; is_done: false }) => void }) => (
    <div data-testid="add-column-modal">
      <button onClick={() => onAdded({ id: 99, name: 'New Column', position: 2, color: '#000', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false })}>
        Confirm Add
      </button>
    </div>
  ),
}))
vi.mock('../components/Swimlane/AddSwimlaneModal', () => ({
  default: () => <div data-testid="add-swimlane-modal">Add Swimlane Modal</div>,
}))
// Captures the props BoardView hands the settings modal (#1290).
vi.mock('../components/Board/BoardSettingsModal', () => ({
  default: (props: { currentUserIsSiteAdmin?: boolean; initialTab?: string; focusFirstStoppedWebhook?: boolean; onClose?: () => void; onManageLens?: () => void }) => {
    return (
      <div data-testid="settings-modal">
        Settings Modal
        <button onClick={props.onClose}>MockSettingsClose</button>
        <button onClick={props.onManageLens}>MockManageLens</button>
      </div>
    )
  },
}))
// Capture props passed into FilterBar so tests can assert on `scope` and `onScopeChange`
// without rendering the real component (kept mocked to avoid touching dropdown/avatar
// dependencies here — FilterBar has its own dedicated suite).
vi.mock('../components/Board/FilterBar', () => ({
  default: (props: { userDateFormat?: string; scope?: 'board' | 'all'; onScopeChange?: (s: 'board' | 'all') => void; filters?: { labelIds: number[]; assigneeIds: number[]; customFields?: Record<number, unknown>; visibleCustomFieldFilterIds?: number[] } }) => {
    return <div data-testid="filter-bar" data-scope={props.scope}>FilterBar</div>
  },
  EMPTY_FILTER: { search: '', assigneeIds: [], labelIds: [], priorities: [], dueDate: null, customFields: {}, visibleCustomFieldFilterIds: [] },
  countActiveFilters: () => 0,
  // Real enough for the #1928 tests: only a non-empty text query counts as active.
  isCustomFieldFilterActive: (v: { kind: string; query?: string }) => v.kind === 'text' && !!v.query,
}))
vi.mock('../components/Board/KeyboardShortcutsOverlay', () => ({
  default: ({ onClose }: { onClose: () => void }) => <div data-testid="shortcuts-overlay"><button onClick={onClose}>Close Shortcuts</button></div>,
}))
vi.mock('../api/gitLens', () => ({ getLensConnection: vi.fn() }))
vi.mock('../components/Board/Lens/LensView', () => ({
  default: () => <div data-testid="lens-view">Lens</div>,
}))
vi.mock('../components/Board/Lens/LensToolbar', () => ({
  default: () => <div data-testid="lens-toolbar" />,
}))

vi.mock('../components/Common/Tooltip', () => ({
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for Tooltip's loosely-typed children prop, see Tooltip.tsx */
  default: ({ content, children }: { content: string; children: React.ReactElement<any> }) =>
    React.cloneElement(children, { 'data-tooltip': content }),
}))
// The real toolbar has its own suite; here it only shows the slot text BoardView
// controls, so the routing of context-menu / palette results can be asserted (#2173).
vi.mock('../components/Board/BulkActionToolbar', () => ({
  default: ({ message }: { message: string | null }) => (
    <div data-testid="bulk-toolbar"><span data-testid="bulk-message">{message}</span></div>
  ),
}))
const archivedPanelCalls: string[] = []
vi.mock('../components/Board/ArchivedCardsPanel', async () => {
  const { useEffect } = await import('react')
  function ArchivedPanelMock({ subscribeCardEvents }: { subscribeCardEvents?: (l: (e: { event: string }) => void) => () => void }) {
    useEffect(
      () => subscribeCardEvents?.((e) => { archivedPanelCalls.push(`panel:${e.event}`) }),
      [subscribeCardEvents],
    )
    return <div data-testid="archived-panel">Archived</div>
  }
  return { default: ArchivedPanelMock }
})
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
  default: () => <div data-testid="movement-history-view">Movement History</div>,
}))
const mockSearchTruncation: { shown: number; total: number } | null = null
vi.mock('../hooks/useCardSearch', () => ({
  useCardSearch: () => ({ searchMatchIds: null, isSearching: false, truncation: mockSearchTruncation }),
}))
vi.mock('../api/cards', () => ({
  getCardStatus: vi.fn(),
  // Card context menu / palette card actions (#2059).
  moveCard: vi.fn(),
  updateCard: vi.fn(),
  archiveCard: vi.fn(),
  deleteCard: vi.fn(),
}))

import { archiveCard, getCardStatus } from '../api/cards'

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false, has_usable_password: true,
  has_completed_tour: true,
}

function makeBoard(overrides: Partial<BoardFull> = {}): BoardFull {
  return {
    health_status: null, effective_health_status: null, health_status_source: null, default_preset: null,
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0,
    columns: [
      { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
      { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
    ],
    swimlanes: [
      { id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null },
    ],
    cards: [],
    labels: [{ id: 100, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }],
    members: [{ id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7,
    stale_warning_pct: 50,
    allowed_priorities: ['low', 'medium', 'high', 'urgent'] as BoardFull['allowed_priorities'],
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


// Results of context-menu and palette actions over the current selection report
// in the toolbar's status slot while it is up, and in the toast otherwise (#2173).
describe('BoardView selection results (#2173)', () => {
  const card1 = {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Fix payout rounding',
    description: '', priority: 'medium' as const, assignee: null,
    labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: 'jdoe', display_name: 'Jane Doe', avatar_url: '' },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    last_moved_at: null, attachment_count: 0, checklist_total: 0,
    checklist_done: 0, is_stale: false, archived_at: null, version: 1,
    custom_field_values: [],
    blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
  }
  const card2 = { ...card1, id: 2, uid: 'carduid00002', title: 'Second card' }
  const forbidden = () => Object.assign(new Error('x'), { isAxiosError: true, response: { status: 403, data: {} } })
  const archiveVia = (cardIds: number[]) =>
    act(() => { window.dispatchEvent(new CustomEvent('visiban:card-action', { detail: { cardIds, action: 'archive' } })) })

  beforeEach(() => {
    vi.clearAllMocks()
    mockSearchParams = new URLSearchParams()
    localStorage.clear()
    vi.mocked(getCardStatus).mockResolvedValue(null)
    mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card1, card2] }) })
  })

  it('a failure over the whole selection goes to the toolbar slot, not a toast', async () => {
    vi.mocked(archiveCard).mockRejectedValue(forbidden())
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    fireEvent.click(screen.getByTestId('select-card-1-20'))
    archiveVia([1])
    await waitFor(() => expect(screen.getByTestId('bulk-message')).toHaveTextContent('1 of 1 card could not be archived — you can only archive cards you created.'))
    expect(screen.queryByTestId('card-action-toast')).not.toBeInTheDocument()
    // The selection is kept so the user can retry.
    expect(screen.getByTestId('bulk-toolbar')).toBeInTheDocument()
  })

  it('with no selection the same failure is a toast', async () => {
    vi.mocked(archiveCard).mockRejectedValue(forbidden())
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    archiveVia([2])
    expect(await screen.findByTestId('card-action-toast')).toHaveTextContent('1 of 1 card could not be archived')
    expect(screen.queryByTestId('bulk-toolbar')).not.toBeInTheDocument()
  })

  it('a card outside the selection keeps the toast while the toolbar is up', async () => {
    vi.mocked(archiveCard).mockRejectedValue(forbidden())
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    fireEvent.click(screen.getByTestId('select-card-1-20'))
    archiveVia([2])
    expect(await screen.findByTestId('card-action-toast')).toHaveAttribute('data-variant', 'danger')
    expect(screen.getByTestId('bulk-message')).toHaveTextContent('')
  })

  it('a full success clears the selection and writes nothing to the slot', async () => {
    vi.mocked(archiveCard).mockResolvedValue(undefined as never)
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    fireEvent.click(screen.getByTestId('select-card-1-20'))
    archiveVia([1])
    await waitFor(() => expect(screen.queryByTestId('bulk-toolbar')).not.toBeInTheDocument())
  })

  it('the slot is empty again after the selection is cleared and rebuilt', async () => {
    vi.mocked(archiveCard).mockRejectedValue(forbidden())
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    fireEvent.click(screen.getByTestId('select-card-1-20'))
    archiveVia([1])
    await waitFor(() => expect(screen.getByTestId('bulk-message')).not.toHaveTextContent(/^$/))
    fireEvent.click(screen.getByTestId('select-card-1-20')) // deselect: toolbar unmounts
    expect(screen.queryByTestId('bulk-toolbar')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('select-card-1-20'))
    expect(screen.getByTestId('bulk-message')).toHaveTextContent('')
  })

  it('changing the selection retires the message', async () => {
    vi.mocked(archiveCard).mockRejectedValue(forbidden())
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    fireEvent.click(screen.getByTestId('select-card-1-20'))
    archiveVia([1])
    await waitFor(() => expect(screen.getByTestId('bulk-message')).not.toHaveTextContent(/^$/))
    // Selection changes via the same mock toggle only for card 1; a context-menu
    // action that selects nothing new cannot change it, so deselect and reselect.
    fireEvent.click(screen.getByTestId('select-card-1-20'))
    fireEvent.click(screen.getByTestId('select-card-1-20'))
    expect(screen.getByTestId('bulk-message')).toHaveTextContent('')
  })
})
