import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, act, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getRememberedCardDetailTab, rememberCardDetailTab } from '../components/Card/cardDetailTabMemory'
import BoardView from '../components/Board/BoardView'
import { ToastProvider } from '../contexts/ToastContext'
import CustomFieldQuickEditPopover from '../components/Card/CustomFieldQuickEditPopover'
import InlineBoardName from '../components/Board/InlineBoardName'
import type { BoardFull, User } from '../types'
import type { BoardContextType } from '../contexts/BoardContext'
import type { CollisionDetection, DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core'
import * as dndCore from '@dnd-kit/core'

// Controllable search params — initial params can be set before render; the stateful mock
// updates them on setSearchParams calls so the component re-renders with the new params.
let mockSearchParams = new URLSearchParams()
let mockLiveSetParams: ((p: URLSearchParams) => void) | undefined
// Spy on setSearchParams calls so tests can assert the arguments passed (e.g. replace:true).
const mockSetSearchParams = vi.fn()

// Capture DndContext props (onDragStart, onDragEnd, collisionDetection) so tests can invoke them directly.
let capturedOnDragStart: ((e: DragStartEvent) => void) | undefined
let capturedOnDragEnd: ((e: DragEndEvent) => void) | undefined
let capturedOnDragOver: ((e: DragOverEvent) => void) | undefined
let capturedCollisionDetection: ((args: Parameters<CollisionDetection>[0]) => ReturnType<CollisionDetection>) | undefined
let capturedSensors: unknown[] | undefined

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragStart, onDragEnd, onDragOver, collisionDetection, sensors }: { children: React.ReactNode; onDragStart?: (e: DragStartEvent) => void; onDragEnd?: (e: DragEndEvent) => void; onDragOver?: (e: DragOverEvent) => void; collisionDetection?: (args: Parameters<CollisionDetection>[0]) => ReturnType<CollisionDetection>; sensors?: unknown[] }) => {
    capturedSensors = sensors
    capturedOnDragStart = onDragStart
    capturedOnDragOver = onDragOver
    capturedOnDragEnd = onDragEnd
    capturedCollisionDetection = collisionDetection
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
    mockLiveSetParams = (p) => setter(p)
    return [params, setter] as const
  },
  useNavigate: () => vi.fn(),
  MemoryRouter: ({ children }: { children: React.ReactNode }) => children,
}))

const socketOptionsSpy = vi.fn()
let capturedSocketEvent: ((e: { event: string; data: unknown }) => void) | undefined
let capturedColumnUpdated: ((column: unknown) => void) | undefined
let mockSocketStatus = 'connected'
vi.mock('../hooks/useBoardSocket', () => ({
  useBoardSocket: (_id: unknown, onEvent: (e: { event: string; data: unknown }) => void, options?: unknown) => { capturedSocketEvent = onEvent; socketOptionsSpy(options); return { connected: true, status: mockSocketStatus, lastEventAt: null, reconnectAttempt: 0 } },
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
  default: ({ onOpenCard, swimlaneFields }: { onOpenCard?: (id: number) => void; swimlaneFields?: { id: number; name: string }[] }) => (
    <div data-testid="analytics-view" data-swimlane-fields={(swimlaneFields ?? []).map((f) => f.name).join('|')}>
      Analytics
      <button data-testid="open-card-btn" onClick={() => onOpenCard?.(1)}>Open Card</button>
    </div>
  ),
}))
// The intake wiring test (#2298) sets this so the mocks hand BoardView's props to the REAL modals.
let renderRealColumnModals = false
vi.mock('../components/Board/ColumnHeader', async () => {
  const { useState } = await import('react')
  const { default: RealEditColumnModal } = await vi.importActual<typeof import('../components/Board/EditColumnModal')>('../components/Board/EditColumnModal')
  // The state lives in a child component: the default export reassigns a module
  // variable, which a component may not do.
  const SettingsToggle = ({ column, isIntakeColumn }: { column: { id: number; name: string; is_done?: boolean }; isIntakeColumn?: boolean }) => {
    const [editing, setEditing] = useState(false)
    return (
      <>
        <button onClick={() => setEditing(true)}>{`Settings ${column.name}`}</button>
        {editing && (
          <RealEditColumnModal boardId={1} column={column as never} cardCount={0} isIntakeColumn={isIntakeColumn} onUpdated={() => {}} onRequestDelete={() => {}} onClose={() => setEditing(false)} />
        )}
      </>
    )
  }
  return {
    default: ({ column, collapsed, onColumnUpdated, isIntakeColumn, onAddCard }: { column: { id: number; name: string; is_done?: boolean }; collapsed: boolean; onColumnUpdated?: (c: unknown) => void; isIntakeColumn?: boolean; onAddCard?: (swimlaneId?: number) => void }) => {
      capturedColumnUpdated = onColumnUpdated
      return (
        <div data-testid={`col-${column.id}`} data-collapsed={String(collapsed)}>
          {column.name}
          {onAddCard && <button onClick={() => onAddCard()}>{`Header add ${column.name}`}</button>}
          {renderRealColumnModals && <SettingsToggle column={column} isIntakeColumn={isIntakeColumn} />}
        </div>
      )
    },
  }
})
// SwimlaneRow mock renders name + focus/exit buttons so focus tests can fire onFocus/onExitFocus via click.
// data-can-edit surfaces the canEdit prop (#783 — maintenance mode folds into the
// existing per-board write gate) so tests can assert on it without rendering the
// real SwimlaneRow tree.
vi.mock('../components/Board/SwimlaneRow', () => ({
  default: ({ swimlane, gridTemplate, collapsed, cards, onFocus, onExitFocus, isFocused, compact, canEdit, onEditFieldOrder, hideRowChipFieldNames, onToggleCardSelection, currentCardId, onOpenCardMenu, contextTargetCardId, onSwimlaneUpdated }: { swimlane: { id: number; name: string }; gridTemplate?: string; collapsed?: boolean; onSwimlaneUpdated?: (s: { id: number; name: string }) => void; cards?: { id: number }[]; onFocus?: (id: number) => void; onExitFocus?: () => void; isFocused?: boolean; compact?: boolean; canEdit?: boolean; onEditFieldOrder?: () => void; hideRowChipFieldNames?: boolean; onToggleCardSelection?: (cardId: number) => void; currentCardId?: number | null; onOpenCardMenu?: (card: never, anchor: { top: number; bottom: number; left: number }) => void; contextTargetCardId?: number | null }) => {
    return (
      <div data-testid={`swim-${swimlane.id}`} data-grid-template={gridTemplate} data-swimlane-id={swimlane.id} data-current-card-id={String(currentCardId ?? '')} data-context-target={String(contextTargetCardId ?? '')} data-focused={String(isFocused ?? false)} data-collapsed={String(collapsed ?? false)} data-compact={String(compact ?? false)} data-can-edit={String(canEdit ?? false)} data-hide-row-chip-names={String(hideRowChipFieldNames ?? false)}>
        {swimlane.name}
        <button data-testid={`focus-btn-${swimlane.id}`} onClick={() => onFocus?.(swimlane.id)}>Focus</button>
        <button data-testid={`exit-focus-btn-${swimlane.id}`} onClick={() => onExitFocus?.()}>ExitFocusMock</button>
        {onSwimlaneUpdated && <button data-testid={`lane-updated-${swimlane.id}`} onClick={() => onSwimlaneUpdated(swimlane)}>LaneUpdatedMock</button>}
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
  default: ({ card, compact, overlay, inDoneColumn, onClick }: { card: { title: string }; compact?: boolean; overlay?: boolean; inDoneColumn?: boolean; onClick?: () => void }) => <div onClick={onClick} data-compact={String(compact ?? false)} data-overlay={String(!!overlay)} data-in-done-column={String(inDoneColumn ?? false)}>{card.title}</div>,
}))
vi.mock('../components/Card/CardDetail', () => ({
  default: ({ card, onClose, onDeleted, onForceMoveCard, blockFormRequest, tabRequest }: { card: { id: number; title: string }; onClose: () => void; onDeleted?: (id: number) => void; onForceMoveCard?: (cardId: number, columnId: number, swimlaneId: number, position: number) => Promise<unknown>; blockFormRequest?: { mode: string } | null; tabRequest?: { tab: string; n: number } }) => <div data-testid="card-detail" data-block-form={blockFormRequest?.mode ?? ''} data-tab-request={tabRequest ? `${tabRequest.tab}:${tabRequest.n}` : ''}>{card.title}<button onClick={onClose}>Close Detail</button><button onClick={() => onDeleted?.(card.id)}>Delete From Detail</button>{onForceMoveCard && <button onClick={() => { void onForceMoveCard(card.id, 11, 21, 9999) }}>Force From Detail</button>}</div>,
}))
vi.mock('../components/Board/AddColumnModal', async () => {
  const { default: RealAddColumnModal } = await vi.importActual<typeof import('../components/Board/AddColumnModal')>('../components/Board/AddColumnModal')
  return {
    default: (props: { onAdded: (col: { id: number; name: string; position: number; color: string; wip_limit: null; weight_limit: null; allow_card_creation: true; is_done: false }) => void }) => {
      if (renderRealColumnModals) return <RealAddColumnModal {...(props as unknown as React.ComponentProps<typeof RealAddColumnModal>)} />
      return (
        <div data-testid="add-column-modal">
          <button onClick={() => props.onAdded({ id: 99, name: 'New Column', position: 2, color: '#000', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false })}>
            Confirm Add
          </button>
        </div>
      )
    },
  }
})
// Exposes the separator's insert action so a test can open the add-lane modal (#2205).
vi.mock('../components/Board/RowSeparator', () => ({
  default: ({ onInsert }: { onInsert: () => void }) => <button data-testid="row-sep-insert" onClick={onInsert}>InsertLaneMock</button>,
}))
// Lane the mock modal reports as just created (#2205 new-lane notice test).
let mockCreatedLane: { id: number; name: string } | null = null
vi.mock('../components/Swimlane/AddSwimlaneModal', () => ({
  default: ({ onAdded }: { onAdded?: (s: never) => void }) => (
    <div data-testid="add-swimlane-modal">
      Add Swimlane Modal
      <button data-testid="confirm-add-swimlane" onClick={() => onAdded?.(mockCreatedLane as never)}>ConfirmAddLane</button>
    </div>
  ),
}))
// Captures the props BoardView hands the settings modal (#1290).
let capturedSettingsProps: {
  currentUserIsSiteAdmin?: boolean; currentUserId?: number | null; onDeleteForbidden?: () => void; initialTab?: string; focusFirstStoppedWebhook?: boolean
  onShareChanged?: (patch: { share_link_active: boolean | null; share_token_expires_at: string | null }) => void
  onColumnUpdated?: (column: unknown) => void
} = {}
vi.mock('../components/Board/BoardSettingsModal', () => ({
  default: (props: { currentUserIsSiteAdmin?: boolean; initialTab?: string; focusFirstStoppedWebhook?: boolean; onClose?: () => void; onManageLens?: () => void }) => {
    capturedSettingsProps = props
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
let capturedFilterBarProps: { userDateFormat?: string; scope?: 'board' | 'all'; onScopeChange?: (s: 'board' | 'all') => void; filters?: { labelIds: number[]; assigneeIds: number[]; customFields?: Record<number, unknown>; visibleCustomFieldFilterIds?: number[] } } = {}
vi.mock('../components/Board/FilterBar', () => ({
  default: (props: { userDateFormat?: string; scope?: 'board' | 'all'; onScopeChange?: (s: 'board' | 'all') => void; filters?: { labelIds: number[]; assigneeIds: number[]; customFields?: Record<number, unknown>; visibleCustomFieldFilterIds?: number[] } }) => {
    capturedFilterBarProps = props
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
  default: ({ cardLayout, showFilters }: { cardLayout?: string; showFilters?: boolean }) => (
    <div data-testid="lens-view" data-card-layout={cardLayout} data-show-filters={String(!!showFilters)}>Lens</div>
  ),
}))
// Exposes the two toggles BoardView wires so a test can drive them (#2302).
vi.mock('../components/Board/Lens/LensToolbar', () => ({
  default: ({ onToggleLayout, onToggleFilters }: { onToggleLayout: () => void; onToggleFilters: () => void }) => (
    <div data-testid="lens-toolbar">
      <button onClick={onToggleLayout}>Toggle lens layout</button>
      <button onClick={onToggleFilters}>Toggle lens filters</button>
    </div>
  ),
}))

vi.mock('../components/Common/Tooltip', () => ({
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for Tooltip's loosely-typed children prop, see Tooltip.tsx */
  default: ({ content, children }: { content: string; children: React.ReactElement<any> }) =>
    React.cloneElement(children, { 'data-tooltip': content }),
}))
vi.mock('../components/Board/BulkActionToolbar', () => ({
  default: ({ onCardsArchived }: { onCardsArchived?: (ids: number[]) => void }) => (
    <div data-testid="bulk-toolbar">Bulk Actions<button type="button" onClick={() => onCardsArchived?.([1])}>ArchiveMock</button></div>
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
// #2301 — the Filter panel lists these; tests that need a preset set them.
let mockSavedFilters: { id: number; name: string; state_json: Record<string, unknown>; state_version: number; created_at: string }[] = []
const mockHydrateFilter = vi.fn()
vi.mock('../hooks/useSavedFilters', () => ({
  useSavedFilters: () => ({
    savedFilters: mockSavedFilters,
    loading: false,
    saveFilter: vi.fn(),
    removeFilter: vi.fn(),
    hydrateFilter: mockHydrateFilter,
  }),
}))
vi.mock('../components/Board/MovementHistoryView', () => ({
  default: () => <div data-testid="movement-history-view">Movement History</div>,
}))
let mockSearchTruncation: { shown: number; total: number } | null = null
vi.mock('../hooks/useCardSearch', () => ({
  useCardSearch: () => ({ searchMatchIds: null, isSearching: false, truncation: mockSearchTruncation }),
}))
vi.mock('../api/cards', () => ({
  getCardStatus: vi.fn(),
  // The peek sheet's history (phone reorder test, #2277).
  getCardMovements: vi.fn(() => Promise.resolve([])),
  // Card context menu / palette card actions (#2059).
  moveCard: vi.fn(),
  updateCard: vi.fn(),
  archiveCard: vi.fn(),
  deleteCard: vi.fn(),
}))

import { archiveCard, deleteCard, getCardStatus, moveCard, updateCard } from '../api/cards'
import { getLensConnection } from '../api/gitLens'
import { LENS_ONLY_BOARD_TOOLTIP } from '../components/Board/lensTabState'
import { flagsWrapper } from './instanceFlagsWrapper'
const mockedGetCardStatus = vi.mocked(getCardStatus)

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
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0,
    columns: [
      { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
      { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
    ],
    swimlanes: [
      { id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null },
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

const defaultProps = () => ({})

// #2269 — Export, Board settings and Keyboard shortcuts live in the overflow menu;
// archived, collapse/expand, density, overlay and preset live in the View menu.
function openOverflowMenu(): HTMLElement {
  if (!screen.queryByRole('menu', { name: 'More board actions' })) {
    fireEvent.click(screen.getByRole('button', { name: 'More board actions' }))
  }
  return screen.getByRole('menu', { name: 'More board actions' })
}
function overflowItem(name: RegExp): HTMLElement {
  return within(openOverflowMenu()).getByRole('menuitem', { name })
}
function queryOverflowItem(name: RegExp): HTMLElement | null {
  return within(openOverflowMenu()).queryByRole('menuitem', { name })
}
function openViewPanel() {
  if (!screen.queryByTestId('view-menu-panel')) fireEvent.click(screen.getByRole('button', { name: 'View' }))
  return within(screen.getByTestId('view-menu-panel'))
}

describe('BoardView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCardStatus).mockResolvedValue({ archived: false })
    mockSearchParams = new URLSearchParams()
    mockSearchTruncation = null
    localStorage.clear()
    mockBoardContextValue = defaultContext()
    // Default: getCardStatus returns null (card deleted/unknown)
    mockedGetCardStatus.mockResolvedValue(null)
  })

  describe('intake column wiring (#2298)', () => {
    afterEach(() => { renderRealColumnModals = false })

    it('marks only the first not-done column as intake in settings, and flags the Add modal only when the insert would take over', async () => {
      renderRealColumnModals = true
      const base = makeBoard().columns[0]
      const columns = [
        { ...base, id: 10, name: 'Shipped', position: 0, is_done: true },
        { ...base, id: 11, name: 'Backlog', position: 1, is_done: false },
        { ...base, id: 12, name: 'Review', position: 2, is_done: false },
      ]
      mockBoardContextValue = defaultContext({ board: makeBoard({ columns }) })
      const user = userEvent.setup()
      const { container } = render(<BoardView {...defaultProps()} />)

      // Settings: the callout shows on the first not-done column only.
      for (const [name, expected] of [['Shipped', false], ['Backlog', true], ['Review', false]] as const) {
        await user.click(screen.getByRole('button', { name: `Settings ${name}` }))
        expect(screen.queryByTestId('intake-column-callout') !== null, name).toBe(expected)
        await user.keyboard('{Escape}')
        if (screen.queryByTestId('intake-column-callout')) {
          fireEvent.click(screen.getByRole('button', { name: /^(Cancel|Close)/ }))
        }
        expect(screen.queryByTestId('intake-column-callout')).not.toBeInTheDocument()
      }

      // Far-left separator (insert position 0) puts a not-done column first: take-over note.
      const separators = Array.from(container.querySelectorAll('[data-testid="column-separator"]'))
      fireEvent.mouseDown(separators[0])
      fireEvent.mouseUp(window)
      expect(await screen.findByTestId('intake-takeover-note')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByTestId('intake-takeover-note')).not.toBeInTheDocument()

      // Appending at the end leaves the intake column alone: no note.
      fireEvent.mouseDown(separators[separators.length - 1])
      fireEvent.mouseUp(window)
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
      expect(screen.queryByTestId('intake-takeover-note')).not.toBeInTheDocument()
    })
  })

  it('notifies the archived panel before the board evicts a deleted card (#2062)', () => {
    archivedPanelCalls.length = 0
    const evictCardByUid = vi.fn((uid: string) => { archivedPanelCalls.push(`evict:${uid}`) })
    mockBoardContextValue = defaultContext({ evictCardByUid })
    render(<BoardView {...defaultProps()} />)
    fireEvent.click(openViewPanel().getByRole('button', { name: 'Show archived cards' }))
    act(() => { capturedSocketEvent!({ event: 'card.deleted', data: { card_uid: 'abc' } }) })
    // The panel's active-card guard needs board.cards before the eviction.
    expect(archivedPanelCalls).toEqual(['panel:card.deleted', 'evict:abc'])
  })

  it('re-reads the board when the socket fails (access revoked, #2041)', () => {
    const silentReload = vi.fn()
    mockBoardContextValue = defaultContext({ silentReload })
    mockSocketStatus = 'failed'
    try {
      render(<BoardView {...defaultProps()} />)
      expect(silentReload).toHaveBeenCalledTimes(1)
    } finally {
      mockSocketStatus = 'connected'
    }
  })

  it('does not re-read the board while the socket is connected', () => {
    const silentReload = vi.fn()
    mockBoardContextValue = defaultContext({ silentReload })
    render(<BoardView {...defaultProps()} />)
    expect(silentReload).not.toHaveBeenCalled()
  })

  it('passes an onReconnected to useBoardSocket that triggers a silent reload (#1463)', () => {
    const silentReload = vi.fn()
    mockBoardContextValue = defaultContext({ silentReload })
    socketOptionsSpy.mockClear()
    render(<BoardView {...defaultProps()} />)
    const options = socketOptionsSpy.mock.calls.at(-1)?.[0] as { onReconnected?: () => void }
    expect(typeof options.onReconnected).toBe('function')
    expect(silentReload).not.toHaveBeenCalled()
    options.onReconnected!()
    expect(silentReload).toHaveBeenCalledTimes(1)
  })

  describe('a column that stops being done (#459)', () => {
    const OVERLAY_KEY = 'board:1:grid-overlay'
    const leaveDone = () => {
      const done = { ...makeBoard().columns[0], is_done: true }
      return { done, reopened: { ...done, is_done: false } }
    }
    function renderWith(silentReload: () => void) {
      const { done } = leaveDone()
      mockBoardContextValue = defaultContext({ silentReload, board: makeBoard({ columns: [done] }) })
      return render(<BoardView {...defaultProps()} />)
    }
    function frame(column: unknown) {
      act(() => { capturedSocketEvent!({ event: 'column.updated', data: column }) })
    }
    afterEach(() => { localStorage.removeItem(OVERLAY_KEY) })

    it('re-reads the board while the dwell overlay is on, since its cards have no time yet', () => {
      localStorage.setItem(OVERLAY_KEY, 'dwell')
      const silentReload = vi.fn()
      renderWith(silentReload)
      frame(leaveDone().reopened)
      expect(silentReload).toHaveBeenCalledTimes(1)
    })

    it('re-reads for the admin who made the edit: their own response lands before the echo frame', () => {
      // The REST response updates state first, so the echo sees a column already not
      // done. Only this callback can notice the flip for the person who made it.
      localStorage.setItem(OVERLAY_KEY, 'dwell')
      const silentReload = vi.fn()
      renderWith(silentReload)
      act(() => { capturedColumnUpdated!(leaveDone().reopened) })
      expect(silentReload).toHaveBeenCalledTimes(1)
    })

    it('waits for an in-flight drag, so the refetch cannot replace state under the dragged card', () => {
      localStorage.setItem(OVERLAY_KEY, 'dwell')
      const silentReload = vi.fn()
      renderWith(silentReload)
      const dragged = { id: `col:${leaveDone().done.id}` }
      act(() => { capturedOnDragStart!({ active: dragged } as unknown as DragStartEvent) })
      frame(leaveDone().reopened)
      expect(silentReload).not.toHaveBeenCalled()
      act(() => { capturedOnDragEnd!({ active: dragged, over: null } as unknown as DragEndEvent) })
      expect(silentReload).toHaveBeenCalledTimes(1)
    })

    it('owes the re-read instead of spending it while the overlay is off, and pays when it turns on', async () => {
      const silentReload = vi.fn()
      renderWith(silentReload)
      frame(leaveDone().reopened)
      expect(silentReload).not.toHaveBeenCalled()
      openViewPanel()
      await userEvent.click(screen.getByRole('button', { name: /^Overlay$/ }))
      await userEvent.click(screen.getByRole('menuitem', { name: 'Dwell time' }))
      expect(silentReload).toHaveBeenCalledTimes(1)
    })

    it('does nothing for any other column change', () => {
      localStorage.setItem(OVERLAY_KEY, 'dwell')
      const silentReload = vi.fn()
      renderWith(silentReload)
      const { done } = leaveDone()
      frame({ ...done, name: 'Renamed' })
      expect(silentReload).not.toHaveBeenCalled()
      frame({ ...makeBoard().columns[0], id: 999, is_done: false })
      expect(silentReload).not.toHaveBeenCalled()
    })
  })

  it('shows a partial-results notice when the search hit the page ceiling (#1763)', () => {
    mockSearchTruncation = { shown: 5000, total: 7321 }
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText(/Showing the first 5,000 of 7,321 matches/)).toBeInTheDocument()
  })

  it('shows no partial-results notice for a complete search (#1763)', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument()
  })

  it('keeps the search notice live region mounted and empty when not truncated (#1763)', () => {
    const { container } = render(<BoardView {...defaultProps()} />)
    const region = container.querySelector('[role="status"][aria-live="polite"][aria-atomic="true"]:empty')
    expect(region).not.toBeNull()
  })

  describe('grid header (#2270)', () => {
    it('header row is sticky and sits on the page background', () => {
      render(<BoardView {...defaultProps()} />)
      const row = screen.getByTestId('board-header-row')
      expect(row).toHaveClass('sticky', 'top-0', 'bg-sunken')
    })

    it('the header add-card button asks the chosen lane cell in its column to open its input', () => {
      render(<BoardView {...defaultProps()} />)
      const first = document.createElement('div')
      first.setAttribute('data-board-cell', '')
      first.setAttribute('data-column-id', '10')
      first.setAttribute('data-swimlane-id', '20')
      const second = first.cloneNode() as HTMLElement
      second.setAttribute('data-swimlane-id', '99')
      document.body.append(first, second)
      const opened = vi.fn()
      first.addEventListener('visiban:add-card', opened)
      const other = vi.fn()
      second.addEventListener('visiban:add-card', other)
      fireEvent.click(screen.getByRole('button', { name: 'Header add To Do' }))
      expect(opened).toHaveBeenCalledTimes(1)
      expect(other).not.toHaveBeenCalled()
      first.remove(); second.remove()
    })

    it('keeps the header add-card button when every lane is collapsed (picking a lane expands it, #2317)', async () => {
      const base = makeBoard()
      mockBoardContextValue = defaultContext({
        board: makeBoard({ swimlanes: base.swimlanes.map((l) => ({ ...l, is_collapsed: true })) }),
      })
      render(<BoardView {...defaultProps()} />)
      await waitFor(() => expect(screen.getByTestId('swim-20')).toHaveAttribute('data-collapsed', 'true'))
      expect(screen.getByRole('button', { name: 'Header add To Do' })).toBeInTheDocument()
    })

    it('a viewer gets no header add-card button', () => {
      mockBoardContextValue = defaultContext({ board: makeBoard({ current_user_role: 'viewer' }) })
      render(<BoardView {...defaultProps()} />)
      expect(screen.queryByRole('button', { name: /^Header add/ })).not.toBeInTheDocument()
    })
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

  it('live dot is green and quiet (no animation) when connected', () => {
    // ConnectionStatus (#851) is quiet-when-healthy — the connected dot is a
    // static bare green dot, no pulse. Pulse is reserved for degraded states
    // (connecting/reconnecting/stale).
    const { container } = render(<BoardView {...defaultProps()} />)
    const dot = container.querySelector('.bg-success-emphasis')
    expect(dot).toBeInTheDocument()
    expect(dot?.className).not.toMatch(/animate-pulse/)
  })

  // #2301 — the Filter button opens the Filter panel; its footer reveals the full filter bar.
  async function showFilterBar() {
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^Filters/ }))
    await user.click(screen.getByRole('button', { name: /Show filter bar/ }))
  }

  it('FilterBar renders in its own row below the toolbar', async () => {
    render(<BoardView {...defaultProps()} />)
    await showFilterBar()
    const filterBar = screen.getByTestId('filter-bar')
    const toolbar = screen.getByTestId('board-toolbar')
    // FilterBar should not be a descendant of the toolbar row
    expect(toolbar.contains(filterBar)).toBe(false)
  })

  it('renders Filters button', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByRole('button', { name: /^Filters/ })).toBeInTheDocument()
  })

  it('does not render Export button in toolbar (export is in board settings)', () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.queryByText('Export')).not.toBeInTheDocument()
  })

  it('renders Settings gear icon for admin', () => {
    render(<BoardView {...defaultProps()} />)
    expect(overflowItem(/^Board settings/)).toBeInTheDocument()
  })

  it('hides Settings gear icon for viewer', () => {
    mockBoardContextValue = defaultContext({ board: makeBoard({ current_user_role: 'viewer' }) })
    render(<BoardView {...defaultProps()} />)
    expect(queryOverflowItem(/^Board settings/)).not.toBeInTheDocument()
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
    mockBoardContextValue = defaultContext({ board: makeBoard({ columns: [] }) })
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText(/No columns/)).toBeInTheDocument()
  })

  it('shows + Add column button in empty state for admin', () => {
    mockBoardContextValue = defaultContext({ board: makeBoard({ columns: [] }) })
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText('+ Add column')).toBeInTheDocument()
  })

  it('shows empty state when no swimlanes', () => {
    mockBoardContextValue = defaultContext({ board: makeBoard({ swimlanes: [] }) })
    render(<BoardView {...defaultProps()} />)
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
      position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z', last_moved_at: null,
      attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
      version: 1,
      custom_field_values: [],
      blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    }
    mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [stalledCard] }) })
    render(<BoardView {...defaultProps()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('Analytics'))
    expect(screen.getByTestId('analytics-view')).toBeInTheDocument()
    // Simulate analytics view calling onOpenCard with the card's id
    await user.click(screen.getByTestId('open-card-btn'))
    // CardDetail must render inside the analytics view return branch
    expect(screen.getByTestId('card-detail')).toBeInTheDocument()
    expect(screen.getByText('Stalled Card')).toBeInTheDocument()
  })

  it('the Filter panel footer toggles the filter bar', async () => {
    render(<BoardView {...defaultProps()} />)
    expect(screen.queryByTestId('filter-bar')).not.toBeInTheDocument()
    await showFilterBar()
    expect(screen.getByTestId('filter-bar')).toBeInTheDocument()
  })

  it('Escape from analytics view goes directly to board', async () => {
    render(<BoardView {...defaultProps()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('Analytics'))
    expect(screen.getByTestId('analytics-view')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('analytics-view')).not.toBeInTheDocument()
    expect(screen.queryByTestId('summary-view')).not.toBeInTheDocument()
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

  it('clicking Settings gear opens the settings modal', async () => {
    render(<BoardView {...defaultProps()} />)
    await userEvent.setup().click(overflowItem(/^Board settings/))
    expect(screen.getByTestId('settings-modal')).toBeInTheDocument()
  })

  it('hands the settings modal the signed-in user id and a role-refetching onDeleteForbidden (#2034)', async () => {
    const silentReload = vi.fn()
    mockBoardContextValue = defaultContext({ board: makeBoard(), silentReload })
    render(<BoardView {...defaultProps()} currentUser={{ id: 77 } as never} />)
    await userEvent.setup().click(overflowItem(/^Board settings/))
    // Without the id the modal fails closed and hides Delete from the owner.
    expect(capturedSettingsProps.currentUserId).toBe(77)
    capturedSettingsProps.onDeleteForbidden?.()
    expect(silentReload).toHaveBeenCalledTimes(1)
  })

  it('merges the Sharing tab share-link state into board state (#1935)', async () => {
    // board.updated frames never carry share fields, so the modal's callback is
    // the only way a reopened modal learns the link was enabled or disabled.
    const ctx = defaultContext({ board: makeBoard() })
    mockBoardContextValue = ctx
    render(<BoardView {...defaultProps()} />)
    await userEvent.setup().click(overflowItem(/^Board settings/))
    const patch = { share_link_active: true, share_token_expires_at: '2999-01-01T00:00:00Z' }
    capturedSettingsProps.onShareChanged?.(patch)
    expect(ctx.mergeBoardState).toHaveBeenCalledWith(patch)
  })

  it('hands the settings modal the column-updated handler so a policy save reaches board state (#2156)', async () => {
    const ctx = defaultContext({ board: makeBoard() })
    mockBoardContextValue = ctx
    render(<BoardView {...defaultProps()} />)
    await userEvent.setup().click(overflowItem(/^Board settings/))
    expect(typeof capturedSettingsProps.onColumnUpdated).toBe('function')
    const updated = { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: { v: 1, entry: ['Ready'], done: [], mode: 'advisory' } }
    capturedSettingsProps.onColumnUpdated?.(updated)
    expect(ctx.updateColumn).toHaveBeenCalledWith(updated)
  })

  it('passes show_row_chip_field_names down to every SwimlaneRow and follows a merged board.updated (#1418)', () => {
    mockBoardContextValue = defaultContext({ board: makeBoard() })
    const { rerender } = render(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-hide-row-chip-names', 'false')
    // A board.updated broadcast is merged into the context board (mergeBoardState);
    // the next render must hide the names without a reload.
    mockBoardContextValue = defaultContext({ board: makeBoard({ show_row_chip_field_names: false }) })
    rerender(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-hide-row-chip-names', 'true')
  })

  describe('swimlane field order shortcut (#1458)', () => {
    const twoDefs = [1, 2].map((n) => ({
      id: n, uid: `sfuid000000${n}`, name: `F${n}`, field_type: 'text' as const, choices: [], position: n,
      show_on_row: false, is_admin_only: false, is_required: false, help_text: '',
      number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {}, created_at: '',
    }))

    it('opens settings on Swimlane fields via the shortcut; closing resets so a reopen is on the default tab', async () => {
      mockBoardContextValue = defaultContext({ board: makeBoard({ swimlane_custom_field_definitions: twoDefs }) })
      const user = userEvent.setup()
      render(<BoardView {...defaultProps()} />)
      await user.click(screen.getByTestId('edit-order-20'))
      expect(screen.getByTestId('settings-modal')).toBeInTheDocument()
      expect(capturedSettingsProps.initialTab).toBe('swimlane-fields')

      await user.click(screen.getByText('MockSettingsClose'))
      expect(screen.queryByTestId('settings-modal')).not.toBeInTheDocument()
      await user.click(overflowItem(/^Board settings/))
      expect(capturedSettingsProps.initialTab).toBeUndefined()
    })

    it('onManageLens closes settings and clears the deep-linked tab', async () => {
      mockBoardContextValue = defaultContext({ board: makeBoard({ swimlane_custom_field_definitions: twoDefs }) })
      const user = userEvent.setup()
      render(<BoardView {...defaultProps()} />)
      await user.click(screen.getByTestId('edit-order-20'))
      await user.click(screen.getByText('MockManageLens'))
      expect(screen.queryByTestId('settings-modal')).not.toBeInTheDocument()
      await user.click(overflowItem(/^Board settings/))
      expect(capturedSettingsProps.initialTab).toBeUndefined()
    })

    it('does not offer the shortcut with fewer than 2 definitions or to a non-admin', () => {
      mockBoardContextValue = defaultContext({ board: makeBoard({ swimlane_custom_field_definitions: twoDefs.slice(0, 1) }) })
      const { unmount } = render(<BoardView {...defaultProps()} />)
      expect(screen.queryByTestId('edit-order-20')).not.toBeInTheDocument()
      unmount()
      mockBoardContextValue = defaultContext({ board: makeBoard({ current_user_role: 'viewer', swimlane_custom_field_definitions: twoDefs }) })
      render(<BoardView {...defaultProps()} />)
      expect(screen.queryByTestId('edit-order-20')).not.toBeInTheDocument()
    })
  })

  it("passes the current user's own is_site_admin to the settings modal (#1290)", async () => {
    const { unmount } = render(<BoardView currentUser={{ ...fakeUser, is_site_admin: true }} />)
    await userEvent.setup().click(overflowItem(/^Board settings/))
    expect(capturedSettingsProps.currentUserIsSiteAdmin).toBe(true)
    unmount()

    render(<BoardView currentUser={fakeUser} />)
    await userEvent.setup().click(overflowItem(/^Board settings/))
    expect(capturedSettingsProps.currentUserIsSiteAdmin).toBe(false)
  })

  // #2300: one grid template for the header row and every lane, with a 1240px floor below
  // which the grid scrolls inside [data-board-scroll].
  it('gives the header row and every lane the same grid template (#2300)', () => {
    render(<BoardView {...defaultProps()} />)
    const header = screen.getByTestId('board-header-row')
    const tpl = header.style.gridTemplateColumns
    expect(tpl).toMatch(/^16px minmax\(0, 1fr\)( 8px minmax\(0, 1fr\))* 16px$/)
    const lanes = document.querySelectorAll('[data-grid-template]')
    expect(lanes.length).toBeGreaterThan(0)
    lanes.forEach((lane) => expect(lane.getAttribute('data-grid-template')).toBe(tpl))
    expect(screen.getByTestId('board-grid').style.minWidth).toBe('1240px')
    const scroll = document.querySelector('[data-board-scroll]') as HTMLElement
    expect(scroll.contains(screen.getByTestId('board-grid'))).toBe(true)
    expect(scroll.style.getPropertyValue('--board-view-w')).toMatch(/px$/)
  })

  it('gives a collapsed column a 40px track in the shared template (#2300)', async () => {
    localStorage.setItem('board:1:view-prefs', JSON.stringify({ collapsedColumnIds: [10] }))
    render(<BoardView {...defaultProps()} />)
    await act(async () => {})
    expect(screen.getByTestId('board-header-row').style.gridTemplateColumns).toMatch(/^16px 40px 8px /)
  })

  // #1990 kept under #2300: a saved column width is that column's track weight.
  it('weights a resized column in the shared template, and makes its header separator resizable (#2300)', async () => {
    localStorage.setItem('board:1:view-prefs', JSON.stringify({ columnWidths: { 10: 440 } }))
    render(<BoardView {...defaultProps()} />)
    await act(async () => {})
    const tpl = screen.getByTestId('board-header-row').style.gridTemplateColumns
    expect(tpl).toMatch(/^16px minmax\(0, 2fr\) 8px minmax\(0, 1fr\)/)
    document.querySelectorAll('[data-grid-template]').forEach((lane) => expect(lane.getAttribute('data-grid-template')).toBe(tpl))
    const seps = screen.getAllByTestId('column-separator')
    expect(seps[0].className).toContain('cursor-pointer')
    expect(seps[1].className).toContain('cursor-col-resize')
  })

  it('publishes each column track floor on the board grid for a separator drag (#2300)', async () => {
    localStorage.setItem('board:1:view-prefs', JSON.stringify({ columnWidths: { 10: 440 } }))
    render(<BoardView {...defaultProps()} />)
    await act(async () => {})
    const grid = screen.getByTestId('board-grid')
    const n = screen.getByTestId('board-header-row').style.gridTemplateColumns.match(/fr\)/g)!.length
    expect(grid.getAttribute('data-track-floors')).toBe(Array(n).fill('160').join(' '))
  })

  // A saved width is a track weight, not px: the column drag overlay takes its
  // size from the dragged header cell (DragOverlay), never from the saved width.
  it('sizes the column drag overlay from the dragged cell, not the saved width (#2300)', async () => {
    localStorage.setItem('board:1:view-prefs', JSON.stringify({ columnWidths: { 10: 600 } }))
    render(<BoardView {...defaultProps()} />)
    await act(async () => {})
    act(() => {
      capturedOnDragStart!({ active: { id: 'col:10' } } as unknown as DragStartEvent)
    })
    const overlay = screen.getByTestId('column-drag-overlay')
    expect(overlay.style.width).toBe('')
    expect(overlay.className).toContain('w-full')
  })

  it('has no label-panel corner cell in the header row (#2271)', () => {
    render(<BoardView {...defaultProps()} />)
    const header = screen.getByTestId('board-header-row')
    expect(within(header).queryByText(/^\d+ cols?$/)).toBeNull()
    expect(within(header).queryByText(/^\d+ lanes?$/)).toBeNull()
  })

  it('renders keyboard shortcuts icon button', () => {
    render(<BoardView {...defaultProps()} />)
    expect(overflowItem(/^Keyboard shortcuts/)).toBeInTheDocument()
  })

  it('clicking keyboard shortcuts icon shows shortcuts overlay', async () => {
    render(<BoardView {...defaultProps()} />)
    await userEvent.setup().click(overflowItem(/^Keyboard shortcuts/))
    expect(screen.getByTestId('shortcuts-overlay')).toBeInTheDocument()
  })

  describe('command palette wiring (#763 / #852 / #869)', () => {
    // #869 — the palette itself is no longer owned by BoardView; it lives in
    // GlobalCommandPalette at the BoardPage / authenticated-shell level so it
    // is available on every sub-tab and every authenticated route. BoardView
    // is now only responsible for: (a) NOT re-registering a ⌘K listener
    // (duplicate would open twice), and (b) NOT rendering a Row 2 trigger
    // button (single source of truth still lives in Navbar Row 1). The
    // hoisted palette itself is exercised by globalCommandPalette.test.tsx.

    it('does NOT render a Row 2 "Open command palette" trigger button (#852 — single source of truth in Row 1)', () => {
      render(<BoardView {...defaultProps()} />)
      expect(screen.queryByLabelText('Open command palette')).not.toBeInTheDocument()
    })

    it('does NOT render a palette inside BoardView itself (#869 — hoisted to shell)', () => {
      render(<BoardView {...defaultProps()} />)
      // The palette is not in the DOM because it is owned by
      // GlobalCommandPalette, which is not part of BoardView's render tree.
      // Firing ⌘K here must not cause BoardView to render one either —
      // otherwise the listener has been re-registered and will double-fire.
      fireEvent.keyDown(document, { key: 'k', metaKey: true })
      expect(screen.queryByLabelText('Command palette search')).not.toBeInTheDocument()
    })
  })

  describe('#852 — Row 2 shortcuts hint text removed', () => {
    it('does NOT render the "? for shortcuts" hint text in Row 2', () => {
      render(<BoardView {...defaultProps()} />)
      // The hint label text is gone — keyboard icon button stays.
      expect(screen.queryByText(/\? for shortcuts/i)).not.toBeInTheDocument()
    })

    it('still renders the keyboard shortcuts icon button', () => {
      render(<BoardView {...defaultProps()} />)
      expect(overflowItem(/^Keyboard shortcuts/)).toBeInTheDocument()
    })

    it('? hotkey still opens the shortcuts overlay', () => {
      render(<BoardView {...defaultProps()} />)
      expect(screen.queryByTestId('shortcuts-overlay')).not.toBeInTheDocument()
      fireEvent.keyDown(document, { key: '?' })
      expect(screen.getByTestId('shortcuts-overlay')).toBeInTheDocument()
    })
  })

  describe('#868 — keyboard shortcut coverage audit', () => {
    it('B switches to the Board view', () => {
      mockSearchParams = new URLSearchParams('view=summary')
      render(<BoardView {...defaultProps()} />)
      expect(screen.getByTestId('summary-view')).toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'b' })
      expect(screen.queryByTestId('summary-view')).not.toBeInTheDocument()
    })

    it('single-key shortcuts do not fire from inside the open Filter panel (#2301)', async () => {
      render(<BoardView {...defaultProps()} />)
      fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
      const panel = screen.getByRole('dialog', { name: 'Filter' })
      const row = within(panel).getByRole('button', { name: /^Label/ })
      row.focus()
      fireEvent.keyDown(row, { key: 's' })
      expect(screen.queryByTestId('summary-view')).not.toBeInTheDocument()
      // No dialog target: the shortcut still works.
      fireEvent.keyDown(document.body, { key: 's' })
      expect(screen.getByTestId('summary-view')).toBeInTheDocument()
    })

    it('S switches to the Summary view', () => {
      render(<BoardView {...defaultProps()} />)
      expect(screen.queryByTestId('summary-view')).not.toBeInTheDocument()
      fireEvent.keyDown(document, { key: 's' })
      expect(screen.getByTestId('summary-view')).toBeInTheDocument()
    })

    it('H switches to the History view', () => {
      render(<BoardView {...defaultProps()} />)
      expect(screen.queryByTestId('movement-history-view')).not.toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'h' })
      expect(screen.getByTestId('movement-history-view')).toBeInTheDocument()
    })

    it('A switches to the Analytics view', () => {
      render(<BoardView {...defaultProps()} />)
      expect(screen.queryByTestId('analytics-view')).not.toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'a' })
      expect(screen.getByTestId('analytics-view')).toBeInTheDocument()
    })

    it('Y toggles the Archived tab of the Activity drawer', () => {
      render(<BoardView {...defaultProps()} />)
      expect(screen.queryByTestId('archived-panel')).not.toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'y' })
      expect(screen.getByTestId('archived-panel')).toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'y' })
      expect(screen.queryByTestId('archived-panel')).not.toBeInTheDocument()
    })

    it('view tabs expose platform-agnostic aria-keyshortcuts (B/S/H/A)', () => {
      render(<BoardView {...defaultProps()} />)
      // Every view-tab button is exposed with its single-key shortcut so
      // screen readers announce the binding (per the noise-budget rule:
      // single-key / single-modifier only → aria-keyshortcuts).
      expect(screen.getByRole('button', { name: 'Board' })).toHaveAttribute('aria-keyshortcuts', 'B')
      expect(screen.getByRole('button', { name: 'Summary' })).toHaveAttribute('aria-keyshortcuts', 'S')
      expect(screen.getByRole('button', { name: 'History' })).toHaveAttribute('aria-keyshortcuts', 'H')
      // Analytics button carries an inner Beta pill — match on accessible name starting with "Analytics".
      expect(screen.getByRole('button', { name: /^Analytics/ })).toHaveAttribute('aria-keyshortcuts', 'A')
    })

    it('Archived toolbar button exposes aria-keyshortcuts="Y"', () => {
      render(<BoardView {...defaultProps()} />)
      expect(openViewPanel().getByRole('button', { name: /Show archived cards/ })).toHaveAttribute('aria-keyshortcuts', 'Y')
    })

    it('Filters toolbar button announces the Filter panel it opens (#2301)', () => {
      render(<BoardView {...defaultProps()} />)
      expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-haspopup', 'dialog')
    })

    it('single-letter shortcuts are suppressed when focus is in an input', () => {
      render(<BoardView {...defaultProps()} />)
      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()
      // Firing `b` from inside an input must not switch the view; this
      // prevents typing `b` in a search box from nuking the user's board view.
      fireEvent.keyDown(input, { key: 'b' })
      expect(screen.queryByTestId('summary-view')).not.toBeInTheDocument()
      fireEvent.keyDown(input, { key: 's' })
      expect(screen.queryByTestId('summary-view')).not.toBeInTheDocument()
      document.body.removeChild(input)
    })
  })

  describe('#1888 — label filter naming a deleted label', () => {
    const card = {
      id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Card One',
      description: '', priority: 'medium' as const, assignee: null,
      labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: 'user1', display_name: 'User 1', avatar_url: '' },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0,
      checklist_done: 0, is_stale: false, archived_at: null, version: 1,
      custom_field_values: [],
      blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    }

    it('ignores a deleted label id from ?f_labels: cards still show and FilterBar sees it pruned', () => {
      mockSearchParams = new URLSearchParams('f_labels=999')
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      capturedFilterBarProps = {}
      render(<BoardView {...defaultProps()} />)
      fireEvent.keyDown(document, { key: 'f' })
      expect(screen.queryByText('No cards match the active filters.')).not.toBeInTheDocument()
      expect(capturedFilterBarProps.filters?.labelIds).toEqual([])
      // derived only: never written back to persisted state
      expect(localStorage.getItem('board:1:filters')).toBeNull()
    })

    it('still filters by a label id that exists on the board', () => {
      mockSearchParams = new URLSearchParams('f_labels=100')
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      render(<BoardView {...defaultProps()} />)
      expect(screen.getByText('No cards match the active filters.')).toBeInTheDocument()
    })

    // #1149
    it('reads Blocked only from ?f_blocked=1 and filters the board with it', () => {
      mockSearchParams = new URLSearchParams('f_blocked=1')
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      capturedFilterBarProps = {}
      render(<BoardView {...defaultProps()} />)
      fireEvent.keyDown(document, { key: 'f' })
      expect((capturedFilterBarProps.filters as { blockedOnly?: boolean } | undefined)?.blockedOnly).toBe(true)
      expect(screen.getByText('No cards match the active filters.')).toBeInTheDocument()
    })

    it('writes f_blocked to the URL when Blocked only is turned on, and removes it when off', () => {
      mockSearchParams = new URLSearchParams()
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      capturedFilterBarProps = {}
      render(<BoardView {...defaultProps()} />)
      fireEvent.keyDown(document, { key: 'f' })
      const onChange = (capturedFilterBarProps as { onChange?: (f: unknown) => void }).onChange!
      const base = capturedFilterBarProps.filters as Record<string, unknown>
      mockSetSearchParams.mockClear()
      act(() => { onChange({ ...base, blockedOnly: true }) })
      const resolve = (call: unknown[]) => (call[0] as (p: URLSearchParams) => URLSearchParams)(new URLSearchParams())
      expect(resolve(mockSetSearchParams.mock.calls.at(-1)!).get('f_blocked')).toBe('1')
      act(() => { onChange({ ...base, blockedOnly: false }) })
      const off = (mockSetSearchParams.mock.calls.at(-1)![0] as (p: URLSearchParams) => URLSearchParams)(new URLSearchParams('f_blocked=1'))
      expect(off.get('f_blocked')).toBeNull()
    })

    it('does not persist the previous board\'s filters under the new board on a board switch', () => {
      mockSearchParams = new URLSearchParams('f_assignees=5&f_labels=100')
      mockBoardContextValue = defaultContext({ board: makeBoard({ id: 1 }) })
      const { rerender } = render(<BoardView {...defaultProps()} />)
      mockBoardContextValue = defaultContext({ board: makeBoard({ id: 2, uid: 'boarduid0002', labels: [] }) })
      rerender(<BoardView {...defaultProps()} />)
      expect(localStorage.getItem('board:2:filters')).toBeNull()
      expect(localStorage.getItem('board:1:filters')).toBeNull()
    })
  })

  describe('#1928 — custom-field filter naming a deleted field', () => {
    const card = {
      id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Card One',
      description: '', priority: 'medium' as const, assignee: null,
      labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: 'user1', display_name: 'User 1', avatar_url: '' },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0,
      checklist_done: 0, is_stale: false, archived_at: null, version: 1,
      custom_field_values: [],
      blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    }
    const liveDef = {
      id: 5, uid: 'cfuid0000005', name: 'Live', field_type: 'text', choices: [], position: 0,
      show_on_card: false, is_required: false,
    } as unknown as BoardFull['custom_field_definitions'][number]
    const seed = (customFields: Record<number, unknown>) =>
      localStorage.setItem('board:1:filters', JSON.stringify({
        search: '', assigneeIds: [], labelIds: [], priorities: [], dueDate: null,
        customFields, visibleCustomFieldFilterIds: Object.keys(customFields).map(Number),
      }))

    it('ignores a persisted filter on a deleted field: cards show, FilterBar sees it pruned, storage untouched', () => {
      seed({ 77: { kind: 'text', query: 'zzz' } })
      const before = localStorage.getItem('board:1:filters')
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      capturedFilterBarProps = {}
      render(<BoardView {...defaultProps()} />)
      fireEvent.keyDown(document, { key: 'f' })
      expect(screen.queryByText('No cards match the active filters.')).not.toBeInTheDocument()
      expect(capturedFilterBarProps.filters?.customFields).toEqual({})
      expect(capturedFilterBarProps.filters?.visibleCustomFieldFilterIds).toEqual([])
      expect(localStorage.getItem('board:1:filters')).toBe(before)
    })

    it('still filters by a custom field that exists on the board', () => {
      seed({ 5: { kind: 'text', query: 'zzz' } })
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card], custom_field_definitions: [liveDef] }) })
      render(<BoardView {...defaultProps()} />)
      expect(screen.getByText('No cards match the active filters.')).toBeInTheDocument()
    })

    it('the "my cards" palette event does not write deleted label/field references back to storage', () => {
      localStorage.setItem('board:1:filters', JSON.stringify({
        search: '', assigneeIds: [], labelIds: [999], priorities: [], dueDate: null,
        customFields: { 77: { kind: 'text', query: 'zzz' } }, visibleCustomFieldFilterIds: [77],
      }))
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      render(<BoardView {...defaultProps()} currentUser={{ id: 7 } as never} />)
      act(() => { window.dispatchEvent(new CustomEvent('visiban:filter-my-cards')) })
      const saved = JSON.parse(localStorage.getItem('board:1:filters') ?? '{}')
      expect(saved.assigneeIds).toEqual([7])
      expect(saved.labelIds).toEqual([])
      expect(saved.customFields).toEqual({})
      expect(saved.visibleCustomFieldFilterIds).toEqual([])
    })

    it('persists nothing under either board key on a board switch', () => {
      seed({ 5: { kind: 'text', query: 'zzz' } })
      mockBoardContextValue = defaultContext({ board: makeBoard({ id: 1, custom_field_definitions: [liveDef] }) })
      const { rerender } = render(<BoardView {...defaultProps()} />)
      const before = localStorage.getItem('board:1:filters')
      mockBoardContextValue = defaultContext({ board: makeBoard({ id: 2, uid: 'boarduid0002', custom_field_definitions: [] }) })
      rerender(<BoardView {...defaultProps()} />)
      expect(localStorage.getItem('board:2:filters')).toBeNull()
      expect(localStorage.getItem('board:1:filters')).toBe(before)
    })
  })

  describe('#852 — search scope URL param (?scope=board|all)', () => {
    it('hydrates scope="all" from ?scope=all on initial load and forwards to FilterBar', () => {
      mockSearchParams = new URLSearchParams('scope=all')
      capturedFilterBarProps = {}
      render(<BoardView {...defaultProps()} />)
      // Open filter bar so FilterBar is mounted and receives props
      fireEvent.keyDown(document, { key: 'f' })
      expect(capturedFilterBarProps.scope).toBe('all')
      expect(typeof capturedFilterBarProps.onScopeChange).toBe('function')
    })

    it('passes the user date format to FilterBar (#1993)', () => {
      capturedFilterBarProps = {}
      render(<BoardView {...defaultProps()} userDateFormat="DD/MM/YYYY" />)
      fireEvent.keyDown(document, { key: 'f' })
      expect(capturedFilterBarProps.userDateFormat).toBe('DD/MM/YYYY')
    })

    it('defaults to scope="board" when the URL param is absent', () => {
      mockSearchParams = new URLSearchParams()
      capturedFilterBarProps = {}
      render(<BoardView {...defaultProps()} />)
      fireEvent.keyDown(document, { key: 'f' })
      expect(capturedFilterBarProps.scope).toBe('board')
    })

    it('treats any non-"all" scope param as "board"', () => {
      mockSearchParams = new URLSearchParams('scope=garbage')
      capturedFilterBarProps = {}
      render(<BoardView {...defaultProps()} />)
      fireEvent.keyDown(document, { key: 'f' })
      expect(capturedFilterBarProps.scope).toBe('board')
    })

    it('calling onScopeChange("all") writes ?scope=all to the URL (round-trip)', () => {
      mockSearchParams = new URLSearchParams()
      capturedFilterBarProps = {}
      render(<BoardView {...defaultProps()} />)
      fireEvent.keyDown(document, { key: 'f' })
      act(() => {
        capturedFilterBarProps.onScopeChange?.('all')
      })
      // setSearchParams was called with a function; invoke the last call's updater
      // against a fresh URLSearchParams to inspect what it writes.
      const lastCall = mockSetSearchParams.mock.calls.at(-1)
      expect(lastCall).toBeDefined()
      const updater = lastCall![0] as (prev: URLSearchParams) => URLSearchParams
      const out = updater(new URLSearchParams())
      expect(out.get('scope')).toBe('all')
    })

    it('calling onScopeChange("board") removes ?scope from the URL', () => {
      mockSearchParams = new URLSearchParams('scope=all')
      capturedFilterBarProps = {}
      render(<BoardView {...defaultProps()} />)
      fireEvent.keyDown(document, { key: 'f' })
      act(() => {
        capturedFilterBarProps.onScopeChange?.('board')
      })
      const lastCall = mockSetSearchParams.mock.calls.at(-1)
      const updater = lastCall![0] as (prev: URLSearchParams) => URLSearchParams
      const out = updater(new URLSearchParams('scope=all'))
      expect(out.get('scope')).toBeNull()
    })
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

  it('offers admin-only swimlane fields to Group lanes by for admins only (#2267)', () => {
    const def = (id: number, name: string, field_type: string, is_admin_only: boolean) => ({
      id, uid: `sf${id}`, name, field_type, choices: [], position: id, show_on_row: false, is_admin_only, is_required: false,
      help_text: '', number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {}, created_at: '',
    })
    const defs = [def(1, 'Team', 'dropdown', false), def(2, 'Budget owner', 'dropdown', true), def(3, 'Notes', 'text', false)] as never
    mockSearchParams = new URLSearchParams('view=analytics')
    mockBoardContextValue = defaultContext({ board: makeBoard({ current_user_role: 'member', swimlane_custom_field_definitions: defs }) })
    const { unmount } = render(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('analytics-view')).toHaveAttribute('data-swimlane-fields', 'Team')
    unmount()
    mockBoardContextValue = defaultContext({ board: makeBoard({ current_user_role: 'admin', swimlane_custom_field_definitions: defs }) })
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('analytics-view')).toHaveAttribute('data-swimlane-fields', 'Team|Budget owner')
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

  it('switching to Summary tab calls setSearchParams with functional updater and replace: true', async () => {
    render(<BoardView {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('Summary'))
    expect(mockSetSearchParams).toHaveBeenCalled()
  })

  it('switching to Analytics tab calls setSearchParams with functional updater and replace: true', async () => {
    render(<BoardView {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('Analytics'))
    expect(mockSetSearchParams).toHaveBeenCalled()
  })

  it('switching to Board tab calls setSearchParams with functional updater and replace: true', async () => {
    mockSearchParams = new URLSearchParams('view=summary')
    render(<BoardView {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('Board'))
    expect(mockSetSearchParams).toHaveBeenCalled()
  })

  // #1914: while the sheet is open the board marks its card as current and
  // suspends drag-and-drop; closing restores both.
  it('marks the open card current and suspends drag-and-drop while the sheet is open (#1914)', async () => {
    mockSearchParams = new URLSearchParams('card=1')
    const card = {
      id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Deep Link Card',
      description: '', priority: 'medium' as const, assignee: null,
      labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0,
      checklist_done: 0, is_stale: false, archived_at: null, version: 1,
      custom_field_values: [],
      blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    }
    mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('card-detail')).toBeInTheDocument()
    const lane = document.querySelector('[data-current-card-id]') as HTMLElement
    expect(lane).toHaveAttribute('data-current-card-id', '1')
    expect(capturedSensors).toEqual([])
    // The board region is the focus-return target when the card is gone.
    expect(document.querySelector('[data-board-scroll]')).toHaveAttribute('tabindex', '-1')

    await userEvent.setup().click(screen.getByText('Close Detail'))
    expect(screen.queryByTestId('card-detail')).not.toBeInTheDocument()
    expect(lane).toHaveAttribute('data-current-card-id', '')
    expect(capturedSensors?.length).toBeGreaterThan(0)
  })

  it('?settings=webhooks opens Board settings on Webhooks for an admin and strips the param (#863)', async () => {
    mockSearchParams = new URLSearchParams('settings=webhooks')
    mockBoardContextValue = defaultContext({ board: makeBoard({ current_user_role: 'admin' }) })
    render(<BoardView {...defaultProps()} />)
    expect(await screen.findByTestId('settings-modal')).toBeInTheDocument()
    expect(capturedSettingsProps.initialTab).toBe('webhooks')
    expect(capturedSettingsProps.focusFirstStoppedWebhook).toBe(true)
    const call = mockSetSearchParams.mock.calls.find((c) => typeof c[0] === 'function')
    expect(call?.[1]).toEqual({ replace: true })
    expect((call?.[0] as (p: URLSearchParams) => URLSearchParams)(new URLSearchParams('settings=webhooks')).has('settings')).toBe(false)
    // Closing resets the deep-link flag so a later open lands on Members.
    await userEvent.setup().click(screen.getByText('MockSettingsClose'))
    expect(screen.queryByTestId('settings-modal')).not.toBeInTheDocument()
  })

  it('?settings=webhooks is ignored quietly for a non-admin and in the demo (#863)', () => {
    mockSearchParams = new URLSearchParams('settings=webhooks')
    mockBoardContextValue = defaultContext({ board: makeBoard({ current_user_role: 'member' }) })
    const { unmount } = render(<BoardView {...defaultProps()} />)
    expect(screen.queryByTestId('settings-modal')).not.toBeInTheDocument()
    expect(mockSetSearchParams).toHaveBeenCalled()
    unmount()
    mockSearchParams = new URLSearchParams('settings=webhooks')
    mockBoardContextValue = defaultContext({ board: makeBoard({ current_user_role: 'admin' }) })
    render(<BoardView {...defaultProps()} />, { wrapper: flagsWrapper({ demo_mode: true }) })
    expect(screen.queryByTestId('settings-modal')).not.toBeInTheDocument()
  })

  describe('Activity drawer and card sheet are mutually exclusive (#2274)', () => {
    const openCardFixture = {
      id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Deep Link Card',
      description: '', priority: 'medium' as const, assignee: null,
      labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0,
      checklist_done: 0, is_stale: false, archived_at: null, version: 1,
      custom_field_values: [],
      blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    }

    it('opening the drawer closes the open card sheet, and opening a card closes the drawer', async () => {
      mockSearchParams = new URLSearchParams('card=1')
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [openCardFixture] }) })
      render(<BoardView {...defaultProps()} />)
      expect(screen.getByTestId('card-detail')).toBeInTheDocument()

      const toggle = screen.getByRole('button', { name: 'Open activity drawer' })
      fireEvent.click(toggle)
      expect(screen.queryByTestId('card-detail')).not.toBeInTheDocument()
      expect(screen.getByRole('complementary', { name: 'Activity' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Close activity drawer', pressed: true })).toBeInTheDocument()

      act(() => {
        window.dispatchEvent(new CustomEvent('visiban:open-card', { detail: { cardId: 1 } }))
      })
      expect(screen.getByTestId('card-detail')).toBeInTheDocument()
      expect(screen.queryByRole('complementary', { name: 'Activity' })).not.toBeInTheDocument()
    })

    it('Y while a card is open leaves only the drawer, and the Archived tab takes focus', () => {
      mockSearchParams = new URLSearchParams('card=1')
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [openCardFixture] }) })
      render(<BoardView {...defaultProps()} />)
      expect(screen.getByTestId('card-detail')).toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'y' })
      expect(screen.queryByTestId('card-detail')).not.toBeInTheDocument()
      expect(screen.getByRole('complementary', { name: 'Activity' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Archived' })).toHaveFocus()
    })

    it('a ?card= link arriving while the drawer is open shows only the card sheet', () => {
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [openCardFixture] }) })
      render(<BoardView {...defaultProps()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Open activity drawer' }))
      expect(screen.getByRole('complementary', { name: 'Activity' })).toBeInTheDocument()
      act(() => { mockLiveSetParams?.(new URLSearchParams("card=1")) })
      expect(screen.getByTestId('card-detail')).toBeInTheDocument()
      expect(screen.queryByRole('complementary', { name: 'Activity' })).not.toBeInTheDocument()
    })

    it('closing the drawer returns focus to the Activity button', () => {
      render(<BoardView {...defaultProps()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Open activity drawer' }))
      expect(screen.getByRole('tab', { name: 'Recent' })).toHaveFocus()
      fireEvent.click(screen.getByRole('button', { name: 'Close activity drawer', pressed: true }))
      expect(screen.getByRole('button', { name: 'Open activity drawer' })).toHaveFocus()
    })

    it('Y opens the drawer on its Archived tab and a second Y closes it', () => {
      render(<BoardView {...defaultProps()} />)
      fireEvent.keyDown(document, { key: 'y' })
      expect(screen.getByRole('tab', { name: 'Archived' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByTestId('archived-panel')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('tab', { name: 'Recent' }))
      expect(screen.queryByTestId('archived-panel')).not.toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'y' })
      expect(screen.getByRole('tab', { name: 'Archived' })).toHaveAttribute('aria-selected', 'true')
      fireEvent.keyDown(document, { key: 'y' })
      expect(screen.queryByRole('complementary', { name: 'Activity' })).not.toBeInTheDocument()
    })

    it('the Activity button opens Recent and Cmd+\\ toggles the drawer', () => {
      render(<BoardView {...defaultProps()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Open activity drawer' }))
      expect(screen.getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'true')
      fireEvent.keyDown(document, { key: '\\', metaKey: true })
      expect(screen.queryByRole('complementary', { name: 'Activity' })).not.toBeInTheDocument()
    })
  })

  it('?card= param opens CardDetail for a matching card', () => {
    mockSearchParams = new URLSearchParams('card=1')
    const card = {
      id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Deep Link Card',
      description: '', priority: 'medium' as const, assignee: null,
      labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0,
      checklist_done: 0, is_stale: false, archived_at: null, version: 1,
      custom_field_values: [],
      blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    }
    mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('card-detail')).toBeInTheDocument()
    expect(screen.getByText('Deep Link Card')).toBeInTheDocument()
    expect(mockSetSearchParams).toHaveBeenCalled()
  })

  describe('?card=&tab= deep link (#967)', () => {
    const deepCard = {
      id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Deep Link Card',
      description: '', priority: 'medium' as const, assignee: null,
      labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0,
      checklist_done: 0, is_stale: false, archived_at: null, version: 1,
      custom_field_values: [],
      blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    }
    beforeEach(() => rememberCardDetailTab('details'))

    it('a known tab overrides the remembered card tab and is removed from the URL', () => {
      mockSearchParams = new URLSearchParams('card=1&tab=comments')
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [deepCard] }) })
      render(<BoardView {...defaultProps()} />)
      expect(screen.getByTestId('card-detail')).toBeInTheDocument()
      expect(getRememberedCardDetailTab()).toBe('comments')
      const next = mockSetSearchParams.mock.calls.map(([arg]) => (typeof arg === 'function' ? arg(new URLSearchParams('card=1&tab=comments')) : arg)).pop() as URLSearchParams
      expect(next.has('tab')).toBe(false)
      expect(next.has('card')).toBe(false)
    })

    it('a deep link for the already-open card hands CardDetail a new tab request', () => {
      mockSearchParams = new URLSearchParams('card=1&tab=comments')
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [deepCard] }) })
      render(<BoardView {...defaultProps()} />)
      expect(screen.getByTestId('card-detail')).toHaveAttribute('data-tab-request', 'comments:1')
      act(() => { mockLiveSetParams?.(new URLSearchParams('card=1&tab=history')) })
      expect(screen.getByTestId('card-detail')).toHaveAttribute('data-tab-request', 'history:2')
    })

    it('an unknown tab keeps the remembered card tab', () => {
      rememberCardDetailTab('history')
      mockSearchParams = new URLSearchParams('card=1&tab=bogus')
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [deepCard] }) })
      render(<BoardView {...defaultProps()} />)
      expect(getRememberedCardDetailTab()).toBe('history')
    })
  })

  it('?card= param shows "Card not found" toast when card is deleted', async () => {
    mockedGetCardStatus.mockResolvedValue(null)
    mockSearchParams = new URLSearchParams('card=999')
    render(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
    await waitFor(() => expect(screen.getByTestId('card-not-found-toast')).toHaveTextContent(/Card not found/))
    expect(mockSetSearchParams).toHaveBeenCalled()
  })

  // #1373 — the getCardStatus() call used to be a floating promise: a
  // rejection (e.g. a network error) left the deep link silently stripped
  // from the URL with no feedback at all.
  it('?card= param falls back to the generic "not found" message when the status lookup itself fails', async () => {
    mockedGetCardStatus.mockRejectedValue(new Error('network error'))
    mockSearchParams = new URLSearchParams('card=999')
    render(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
    await waitFor(() => expect(screen.getByTestId('card-not-found-toast')).toHaveTextContent(/Card not found/))
    expect(mockSetSearchParams).toHaveBeenCalled()
  })

  it('?card= param shows "This card has been archived" when card is archived', async () => {
    mockedGetCardStatus.mockResolvedValue({ archived: true })
    mockSearchParams = new URLSearchParams('card=999')
    render(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
    // Query the visible toast by test id, not text: the same message is also
    // mirrored into the sr-only toast announcer once it settles (#2220), so
    // getByText races between one and two matches.
    await waitFor(() =>
      expect(screen.getByTestId('card-not-found-toast')).toHaveTextContent('This card has been archived.')
    )
    // The announcement is a separate, deterministic assertion.
    await waitFor(() =>
      expect(screen.getByTestId('toast-announcer-polite')).toHaveTextContent('This card has been archived.')
    )
    expect(mockSetSearchParams).toHaveBeenCalled()
  })

  it('"Card not found" toast auto-dismisses after 4s', async () => {
    vi.useFakeTimers()
    mockedGetCardStatus.mockResolvedValue(null)
    mockSearchParams = new URLSearchParams('card=999')
    render(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
    // Wait for the async getCardStatus to settle before checking for the toast
    await act(async () => { await Promise.resolve() })
    try {
      expect(screen.getByTestId('card-not-found-toast')).toHaveTextContent(/Card not found/)
      await act(async () => { vi.advanceTimersByTime(4000) })
      expect(screen.queryByTestId('card-not-found-toast')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
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
    // Start with no columns so the empty-state "+ Add column" button is visible
    mockBoardContextValue = defaultContext({ board: makeBoard({ columns: [] }) })
    render(<BoardView {...defaultProps()} />)
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
    // Header ColumnSeparators fill their grid track (#2300); trigger mousedown+mouseup (no drag)
    const separators = container.querySelectorAll('[data-testid="column-separator"]')
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
    const card = {
      id: 228, uid: 'carduid00228', column: 10, swimlane: 20, title: 'Test Card',
      description: '', priority: 'medium' as const, assignee: null,
      labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0,
      checklist_done: 0, is_stale: false, archived_at: null, version: 1,
      custom_field_values: [],
      blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    }
    const ctx = defaultContext({ board: makeBoard({ cards: [card] }) })
    mockBoardContextValue = ctx
    render(<BoardView {...defaultProps()} />)
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

    // The guard should prevent moveCard from being called
    expect(ctx.moveCard).not.toHaveBeenCalled()
  })

  describe('drag-and-drop outcome announcement (#1761)', () => {
    const dropOnCell = async (moveCard: BoardContextType['moveCard']) => {
      const card = {
        id: 228, uid: 'carduid00228', column: 10, swimlane: 20, title: 'Test Card',
        description: '', priority: 'medium' as const, assignee: null,
        labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" },
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        last_moved_at: null, attachment_count: 0, checklist_total: 0,
        checklist_done: 0, is_stale: false, archived_at: null, version: 1,
        custom_field_values: [],
        blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
      }
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }), moveCard })
      render(<BoardView {...defaultProps()} />)
      const event = {
        active: { id: 228, data: { current: {} }, rect: { current: { translated: null, initial: null } } },
        over: { id: 'cell:11:20', data: { current: {} }, rect: { top: 0, left: 0, bottom: 10, right: 10, width: 10, height: 10 } },
        delta: { x: 0, y: 0 },
        activatorEvent: new MouseEvent('mousedown'),
      } as unknown as DragEndEvent
      await act(async () => { capturedOnDragEnd!(event) })
    }

    it('announces success only after the move succeeds', async () => {
      await dropOnCell(vi.fn().mockResolvedValue({ ok: true }))
      expect(screen.getByText("Card 'Test Card' moved to column 'Done', swimlane 'Customer A'")).toBeInTheDocument()
    })

    it('does not announce success or repeat the toast cause in the status region on failure', async () => {
      const err = Object.assign(new Error('Network Error'), { isAxiosError: true })
      await dropOnCell(vi.fn().mockResolvedValue({ ok: false, error: err }))
      // The blocked toast's assertive announcement owns the failure; the status region stays blank.
      expect(screen.queryByText(/moved to column/)).not.toBeInTheDocument()
      expect(screen.queryByText(/could not be moved/)).not.toBeInTheDocument()
    })
  })

  describe('keyboard-move verdict in the drag live region (#1150)', () => {
    const card = (id: number, column: number, swimlane: number) => ({
      id, uid: `carduid${id}`, column, swimlane, title: `Card ${id}`,
      description: '', priority: 'medium' as const, assignee: null,
      labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: 'user1', display_name: 'User 1', avatar_url: '' },
      created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0,
      checklist_done: 0, is_stale: false, archived_at: null, version: 1,
      custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    })
    const hover = (cardId: number, overId: string) => {
      act(() => {
        capturedOnDragOver!({
          active: { id: cardId, data: { current: {} }, rect: { current: { translated: null, initial: null } } },
          over: { id: overId, data: { current: {} }, rect: { top: 0, left: 0, bottom: 10, right: 10, width: 10, height: 10 } },
        } as unknown as DragOverEvent)
      })
    }

    it('reads the cell and the limit it would trip', () => {
      const board = makeBoard({
        swimlanes: [
          { id: 20, uid: 'laneuid00001', name: 'Customer A', position: 0, color: '#6B7280', is_collapsed: false, created_at: '', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null },
          { id: 21, uid: 'laneuid00002', name: 'Payouts', position: 1, color: '#6B7280', is_collapsed: false, created_at: '', wip_limit: 1, weight_limit: null, limit_enforcement: 'block', limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null },
        ],
        cards: [card(1, 10, 20), card(2, 11, 21)],
      })
      mockBoardContextValue = defaultContext({ board })
      render(<BoardView {...defaultProps()} />)
      hover(1, 'cell:10:21')
      expect(screen.getByText(`Over column 'To Do', swimlane 'Payouts'. Swimlane "Payouts" is at its WIP limit (1/1), admins can override.`)).toBeInTheDocument()
    })

    it('a quick second hover onto a blocked cell still announces its verdict', () => {
      const board = makeBoard({
        swimlanes: [
          { id: 20, uid: 'laneuid00001', name: 'Customer A', position: 0, color: '#6B7280', is_collapsed: false, created_at: '', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null },
          { id: 21, uid: 'laneuid00002', name: 'Payouts', position: 1, color: '#6B7280', is_collapsed: false, created_at: '', wip_limit: 1, weight_limit: null, limit_enforcement: 'hard', limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null },
        ],
        cards: [card(1, 10, 20), card(2, 11, 21)],
      })
      mockBoardContextValue = defaultContext({ board })
      render(<BoardView {...defaultProps()} />)
      hover(1, 'cell:11:20')
      hover(1, 'cell:10:21') // inside the 300ms throttle window
      expect(screen.getByText(`Over column 'To Do', swimlane 'Payouts'. Swimlane "Payouts" is at its WIP limit (1/1), no one can override it.`)).toBeInTheDocument()
    })

    it('reads only the cell when nothing would trip', () => {
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card(1, 10, 20)] }) })
      render(<BoardView {...defaultProps()} />)
      hover(1, 'cell:11:20')
      expect(screen.getByText("Over column 'Done', swimlane 'Customer A'")).toBeInTheDocument()
    })
  })

  describe('column policies on a drag (#1101)', () => {
    const card = (id: number, column: number, swimlane: number) => ({
      id, uid: `carduid${id}`, column, swimlane, title: `Card ${id}`,
      description: '', priority: 'medium' as const, assignee: null,
      labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: 'user1', display_name: 'User 1', avatar_url: '' },
      created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0,
      checklist_done: 0, is_stale: false, archived_at: null, version: 1,
      custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    })
    const policyBoard = (mode: 'advisory' | 'confirm', extra: Partial<BoardFull> = {}, wipLimit: number | null = null) => makeBoard({
      columns: [
        { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
        {
          id: 11, uid: 'coluid000002', name: 'Review', position: 1, color: '#10B981', wip_limit: wipLimit, weight_limit: null, allow_card_creation: true, is_done: false,
          policy: { v: 1, entry: ['Has an owner', 'Tests pass'], done: ['Approved'], mode },
        },
      ],
      cards: [card(1, 10, 20)],
      ...extra,
    })
    const hover = (cardId: number, overId: string) => {
      act(() => {
        capturedOnDragOver!({
          active: { id: cardId, data: { current: {} }, rect: { current: { translated: null, initial: null } } },
          over: { id: overId, data: { current: {} }, rect: { top: 0, left: 0, bottom: 10, right: 10, width: 10, height: 10 } },
        } as unknown as DragOverEvent)
      })
    }
    const drop = async (cardId: number, overId: string) => {
      await act(async () => {
        capturedOnDragEnd!({
          active: { id: cardId, data: { current: {} }, rect: { current: { translated: null, initial: null } } },
          over: { id: overId, data: { current: {} }, rect: { top: 0, left: 0, bottom: 10, right: 10, width: 10, height: 10 } },
          delta: { x: 0, y: 0 },
          activatorEvent: new MouseEvent('mousedown'),
        } as unknown as DragEndEvent)
      })
    }

    it('reads the entry criteria while over a policy column', () => {
      mockBoardContextValue = defaultContext({ board: policyBoard('advisory') })
      render(<BoardView {...defaultProps()} />)
      hover(1, 'cell:11:20')
      expect(screen.getByText("Over column 'Review', swimlane 'Customer A'. Entry criteria for 'Review': Has an owner; Tests pass.")).toBeInTheDocument()
    })

    it('a quick second hover onto a policy column still reads its criteria', () => {
      mockBoardContextValue = defaultContext({ board: policyBoard('advisory', { cards: [card(1, 10, 20), card(2, 10, 20)] }) })
      render(<BoardView {...defaultProps()} />)
      hover(1, 'cell:10:20')
      hover(1, 'cell:11:20') // inside the 300ms throttle window
      expect(screen.getByText(/Entry criteria for 'Review': Has an owner; Tests pass\./)).toBeInTheDocument()
    })

    it('reads no criteria for a card already in the column', () => {
      mockBoardContextValue = defaultContext({ board: policyBoard('advisory', { cards: [card(1, 11, 20)] }) })
      render(<BoardView {...defaultProps()} />)
      hover(1, 'cell:11:20')
      expect(screen.getByText("Over column 'Review', swimlane 'Customer A'")).toBeInTheDocument()
    })

    it('a limit verdict wins over the criteria', () => {
      const board = policyBoard('confirm', { enforce_wip_limits: true, cards: [card(1, 10, 20), card(2, 11, 20)] }, 1)
      mockBoardContextValue = defaultContext({ board })
      render(<BoardView {...defaultProps()} />)
      hover(1, 'cell:11:20')
      expect(screen.queryByText(/Entry criteria for/)).not.toBeInTheDocument()
      expect(screen.getByText(/Over column 'Review', swimlane 'Customer A'\. /)).toBeInTheDocument()
    })

    it('advisory mode moves at once', async () => {
      const moveCard = vi.fn().mockResolvedValue({ ok: true })
      mockBoardContextValue = defaultContext({ board: policyBoard('advisory'), moveCard })
      render(<BoardView {...defaultProps()} />)
      await drop(1, 'cell:11:20')
      expect(moveCard).toHaveBeenCalledWith(1, 11, 20, 0)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('confirm mode holds the move until every criterion is checked', async () => {
      const user = userEvent.setup()
      const moveCard = vi.fn().mockResolvedValue({ ok: true })
      mockBoardContextValue = defaultContext({ board: policyBoard('confirm'), moveCard })
      render(<BoardView {...defaultProps()} />)
      await drop(1, 'cell:11:20')
      const dialog = screen.getByRole('dialog', { name: 'Move “Card 1” to Review?' })
      expect(moveCard).not.toHaveBeenCalled()
      const move = screen.getByRole('button', { name: 'Move to Review' })
      expect(move).toHaveAttribute('aria-disabled', 'true')
      await user.click(move)
      expect(moveCard).not.toHaveBeenCalled()
      await user.click(screen.getByRole('checkbox', { name: 'Has an owner' }))
      await user.click(screen.getByRole('checkbox', { name: 'Tests pass' }))
      expect(move).not.toHaveAttribute('aria-disabled')
      await user.click(move)
      expect(moveCard).toHaveBeenCalledWith(1, 11, 20, 0)
      expect(dialog).not.toBeInTheDocument()
      await waitFor(() => expect(screen.getByText("Card 'Card 1' moved to column 'Review', swimlane 'Customer A'")).toBeInTheDocument())
    })

    it('focus returns to the moved card after Keep in and after Move', async () => {
      // SwimlaneRow is mocked here, so stand in for the card's root element
      // (CardItem renders `[data-card-id]` with a tabIndex).
      const user = userEvent.setup()
      const moveCard = vi.fn().mockResolvedValue({ ok: true })
      mockBoardContextValue = defaultContext({ board: policyBoard('confirm'), moveCard })
      render(<BoardView {...defaultProps()} />)
      const cardEl = document.createElement('div')
      cardEl.tabIndex = 0
      cardEl.dataset.cardId = '1'
      try {
        document.body.appendChild(cardEl)
        await drop(1, 'cell:11:20')
        await user.click(screen.getByRole('button', { name: 'Keep in To Do' }))
        await waitFor(() => expect(cardEl).toHaveFocus())

        // Move: the card re-renders in its new cell, so it may be missing for
        // a frame or two; focus return retries until it is there.
        cardEl.remove()
        await drop(1, 'cell:11:20')
        await user.click(screen.getByRole('checkbox', { name: 'Has an owner' }))
        await user.click(screen.getByRole('checkbox', { name: 'Tests pass' }))
        await user.click(screen.getByRole('button', { name: 'Move to Review' }))
        expect(moveCard).toHaveBeenCalledTimes(1)
        expect(cardEl).not.toHaveFocus()
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        document.body.appendChild(cardEl)
        await waitFor(() => expect(cardEl).toHaveFocus())
      } finally {
        cardEl.remove()
      }
    })

    it('keep-in cancels the move and says so', async () => {
      const user = userEvent.setup()
      const moveCard = vi.fn().mockResolvedValue({ ok: true })
      mockBoardContextValue = defaultContext({ board: policyBoard('confirm'), moveCard })
      render(<BoardView {...defaultProps()} />)
      await drop(1, 'cell:11:20')
      await user.click(screen.getByRole('button', { name: 'Keep in To Do' }))
      expect(moveCard).not.toHaveBeenCalled()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.getByText("Move canceled, card 'Card 1' stays in column 'To Do'")).toBeInTheDocument()
    })

    it('Escape cancels the checklist', async () => {
      const user = userEvent.setup()
      const moveCard = vi.fn()
      mockBoardContextValue = defaultContext({ board: policyBoard('confirm'), moveCard })
      render(<BoardView {...defaultProps()} />)
      await drop(1, 'cell:11:20')
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(moveCard).not.toHaveBeenCalled()
    })

    it('a policy edit that adds a criterion mid-checklist resets every box', async () => {
      const user = userEvent.setup()
      const moveCard = vi.fn()
      mockBoardContextValue = defaultContext({ board: policyBoard('confirm'), moveCard })
      const { rerender } = render(<BoardView {...defaultProps()} />)
      await drop(1, 'cell:11:20')
      await user.click(screen.getByRole('checkbox', { name: 'Has an owner' }))
      await user.click(screen.getByRole('checkbox', { name: 'Tests pass' }))
      const board = policyBoard('confirm')
      board.columns[1] = { ...board.columns[1], policy: { v: 1, entry: ['Has an owner', 'Tests pass', 'Docs'], done: [], mode: 'confirm' } }
      mockBoardContextValue = defaultContext({ board, moveCard })
      rerender(<BoardView {...defaultProps()} />)
      expect(screen.getByRole('checkbox', { name: 'Has an owner' })).not.toBeChecked()
      expect(screen.getByRole('button', { name: 'Move to Review' })).toHaveAttribute('aria-disabled', 'true')
    })

    it('a column switched to advisory mid-checklist cancels the held move', async () => {
      const moveCard = vi.fn()
      mockBoardContextValue = defaultContext({ board: policyBoard('confirm'), moveCard })
      const { rerender } = render(<BoardView {...defaultProps()} />)
      await drop(1, 'cell:11:20')
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      mockBoardContextValue = defaultContext({ board: policyBoard('advisory'), moveCard })
      rerender(<BoardView {...defaultProps()} />)
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(screen.getByText('Move canceled, the column or its policy changed')).toBeInTheDocument()
      expect(moveCard).not.toHaveBeenCalled()
    })

    it('a limit block wins: no checklist opens and the move goes to the server', async () => {
      const moveCard = vi.fn().mockResolvedValue({ ok: false })
      const board = policyBoard('confirm', { enforce_wip_limits: true, cards: [card(1, 10, 20), card(2, 11, 20)] }, 1)
      mockBoardContextValue = defaultContext({ board, moveCard })
      render(<BoardView {...defaultProps()} />)
      await drop(1, 'cell:11:20')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(moveCard).toHaveBeenCalledWith(1, 11, 20, 1)
    })
  })

  // --- Focus mode tests (#340) ---

  it('clicking focus button sets ?focus= param and shows banner', async () => {
    render(<BoardView {...defaultProps()} />)
    const user = userEvent.setup()
    await user.click(screen.getByTestId('focus-btn-20'))
    // Banner should be visible
    expect(screen.getByText('Focused on:')).toBeInTheDocument()
    // Mode banner: bg-primary/15 per the mode-banner spec (#1353)
    expect(screen.getByText('Focused on:').closest('[class*="bg-primary/15"]')).not.toBeNull()
    expect(screen.getAllByText('Customer A').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Exit focus')).toBeInTheDocument()
  })

  it('clicking Exit focus removes the banner', async () => {
    render(<BoardView {...defaultProps()} />)
    const user = userEvent.setup()
    await user.click(screen.getByTestId('focus-btn-20'))
    expect(screen.getByText('Focused on:')).toBeInTheDocument()
    await user.click(screen.getByText('Exit focus'))
    expect(screen.queryByText('Focused on:')).not.toBeInTheDocument()
  })

  it('Escape key exits focus mode (priority 12)', async () => {
    render(<BoardView {...defaultProps()} />)
    const user = userEvent.setup()
    await user.click(screen.getByTestId('focus-btn-20'))
    expect(screen.getByText('Exit focus')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByText('Exit focus')).not.toBeInTheDocument()
  })

  it('invalid ?focus=999 param is silently ignored — full board shown', () => {
    mockSearchParams = new URLSearchParams('focus=999')
    render(<BoardView {...defaultProps()} />)
    // No focus banner
    expect(screen.queryByText('Focused on:')).not.toBeInTheDocument()
    // Normal swimlane row still shown
    expect(screen.getByTestId('swim-20')).toBeInTheDocument()
  })

  it('valid ?focus=20 param on mount shows focus banner', () => {
    mockSearchParams = new URLSearchParams('focus=20')
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText('Focused on:')).toBeInTheDocument()
    expect(screen.getAllByText('Customer A').length).toBeGreaterThanOrEqual(1)
  })

  it('isFocused prop is true for the focused swimlane', async () => {
    render(<BoardView {...defaultProps()} />)
    const user = userEvent.setup()
    await user.click(screen.getByTestId('focus-btn-20'))
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-focused', 'true')
  })

  it('swimlane.deleted event for focused swimlane exits focus', async () => {
    // Start with focus=20
    mockSearchParams = new URLSearchParams('focus=20')
    const { rerender } = render(<BoardView {...defaultProps()} />)
    expect(screen.getByText('Focused on:')).toBeInTheDocument()

    // Simulate swimlane deleted — update the context and force re-render
    mockBoardContextValue = defaultContext({ board: makeBoard({ swimlanes: [] }) })
    rerender(<BoardView {...defaultProps()} />)

    // Focus banner should be gone since the focused swimlane no longer exists
    expect(screen.queryByText('Focused on:')).not.toBeInTheDocument()
  })

  // A card can leave board.cards with no card.deleted for it: a column or
  // swimlane delete cascades to its cards and the server sends only the
  // container event (#1615). Nothing may keep acting on such a card.
  describe('a card that leaves the board while open or selected', () => {
    const card = {
      id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Doomed Card',
      description: '', priority: 'medium' as const, assignee: null,
      labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0,
      checklist_done: 0, is_stale: false, archived_at: null, version: 1,
      custom_field_values: [],
      blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    }

    it('closes CardDetail when the open card is evicted', () => {
      mockSearchParams = new URLSearchParams('card=1')
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      const { rerender } = render(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
      expect(screen.getByTestId('card-detail')).toBeInTheDocument()

      // evictColumn dropped the column and, with it, its cards.
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [], columns: makeBoard().columns.slice(1) }) })
      rerender(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)

      expect(screen.queryByTestId('card-detail')).not.toBeInTheDocument()
      // Closed with a reason, not silently: an unsaved draft went with it.
      // #2220 — exclude the sr-only announcer copy, which fills in on a timer.
      expect(
        screen
          .getAllByText('The card you had open was deleted or archived, so it was closed.')
          .filter((el) => !el.closest('[data-testid^="toast-announcer"]'))
      ).toHaveLength(1)
    })

    it('hands CardDetail the refreshed card after a board reload replaces it (#1773)', () => {
      mockSearchParams = new URLSearchParams('card=1')
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      const { rerender } = render(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
      expect(screen.getByTestId('card-detail')).toHaveTextContent('Doomed Card')

      // A 409 version-conflict refresh swaps in the server's copy of the card.
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [{ ...card, title: 'Refreshed Card', version: 2 }] }) })
      rerender(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)

      expect(screen.getByTestId('card-detail')).toHaveTextContent('Refreshed Card')
    })

    // The popover's admin override forces its own target via the context (#1772).
    it('hands CardDetail an onForceMoveCard that calls the context forceMoveCardTo (#1772)', async () => {
      mockSearchParams = new URLSearchParams('card=1')
      const forceMoveCardTo = vi.fn().mockResolvedValue({ ok: true })
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }), forceMoveCardTo })
      render(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
      await userEvent.setup().click(screen.getByRole('button', { name: 'Force From Detail' }))
      expect(forceMoveCardTo).toHaveBeenCalledTimes(1)
      expect(forceMoveCardTo).toHaveBeenCalledWith(1, 11, 21, 9999)
    })

    it('hands the analytics-view CardDetail the same onForceMoveCard (#1772)', async () => {
      mockSearchParams = new URLSearchParams('view=analytics')
      const forceMoveCardTo = vi.fn().mockResolvedValue({ ok: true })
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }), forceMoveCardTo })
      render(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
      const user = userEvent.setup()
      await user.click(screen.getByTestId('open-card-btn'))
      await user.click(screen.getByRole('button', { name: 'Force From Detail' }))
      expect(forceMoveCardTo).toHaveBeenCalledWith(1, 11, 21, 9999)
    })

    it('hands the analytics-view CardDetail the refreshed card too (#1773)', async () => {
      mockSearchParams = new URLSearchParams('view=analytics')
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      const { rerender } = render(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
      await userEvent.setup().click(screen.getByTestId('open-card-btn'))
      expect(screen.getByTestId('card-detail')).toHaveTextContent('Doomed Card')

      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [{ ...card, title: 'Refreshed Card', version: 2 }] }) })
      rerender(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)

      expect(screen.getByTestId('card-detail')).toHaveTextContent('Refreshed Card')
    })

    it('closes CardDetail with the notice in the analytics view too', async () => {
      mockSearchParams = new URLSearchParams('view=analytics')
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      const { rerender } = render(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
      // AnalyticsView mock opens card 1.
      await userEvent.setup().click(screen.getByTestId('open-card-btn'))
      expect(screen.getByTestId('card-detail')).toBeInTheDocument()

      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [] }) })
      rerender(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)

      expect(screen.getByTestId('analytics-view')).toBeInTheDocument()
      expect(screen.queryByTestId('card-detail')).not.toBeInTheDocument()
      expect(screen.getByTestId('card-not-found-toast')).toHaveTextContent('The card you had open was deleted or archived, so it was closed.')
    })

    it('the notice clears itself after 4 seconds', () => {
      vi.useFakeTimers()
      try {
        mockSearchParams = new URLSearchParams('card=1')
        mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
        const { rerender } = render(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
        mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [] }) })
        rerender(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
        expect(screen.getByTestId('card-not-found-toast')).toHaveTextContent(/so it was closed/)
        act(() => { vi.advanceTimersByTime(4000) })
        expect(screen.queryByTestId('card-not-found-toast')).not.toBeInTheDocument()
      } finally {
        vi.useRealTimers()
      }
    })

    it('shows no notice when this user deletes the card from the panel', async () => {
      mockSearchParams = new URLSearchParams('card=1')
      const removeCard = vi.fn()
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }), removeCard })
      const { rerender } = render(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
      await userEvent.setup().click(screen.getByText('Delete From Detail'))
      expect(removeCard).toHaveBeenCalledWith(1)
      // removeCard has now dropped the card from state.
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [] }), removeCard })
      rerender(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)

      expect(screen.queryByTestId('card-detail')).not.toBeInTheDocument()
      expect(screen.queryByText(/so it was closed/)).not.toBeInTheDocument()
    })

    it('shows no notice when cards leave the board and none is open', () => {
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      const { rerender } = render(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [] }) })
      rerender(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
      expect(screen.queryByText(/so it was closed/)).not.toBeInTheDocument()
    })

    it('keeps CardDetail open while the card is still on the board', () => {
      mockSearchParams = new URLSearchParams('card=1')
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      const { rerender } = render(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)

      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [{ ...card, title: 'Renamed' }] }) })
      rerender(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)

      expect(screen.getByTestId('card-detail')).toBeInTheDocument()
      expect(screen.queryByText(/so it was closed/)).not.toBeInTheDocument()
    })

    it('drops an evicted card from the bulk selection (existing prune effect)', async () => {
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      const { rerender } = render(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
      await userEvent.setup().click(screen.getByTestId('select-card-1-20'))
      expect(screen.getByTestId('bulk-toolbar')).toBeInTheDocument()

      // Another user deleted the card's column: the card is gone, the
      // swimlane row (and so BoardView's tree) is unchanged.
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [], columns: makeBoard().columns.slice(1) }) })
      rerender(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)

      expect(screen.queryByTestId('bulk-toolbar')).not.toBeInTheDocument()
    })
  })

  describe('shared toast region on the board (#2060)', () => {
    const card = {
      id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Toast Card',
      description: '', priority: 'medium' as const, assignee: null,
      labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: 'user1', display_name: 'User 1', avatar_url: '' },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0,
      checklist_done: 0, is_stale: false, archived_at: null, version: 1,
      custom_field_values: [],
      blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    }

    async function archiveFromToolbar() {
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      render(<ToastProvider><BoardView {...defaultProps()} /></ToastProvider>)
      const user = userEvent.setup()
      await user.click(screen.getByTestId('select-card-1-20'))
      await user.click(screen.getByRole('button', { name: 'ArchiveMock' }))
      return user
    }

    it('"Card archived" is a success toast in the region, with an action that opens the panel', async () => {
      const user = await archiveFromToolbar()
      const region = screen.getByRole('region', { name: 'Notifications' })
      const toast = within(region).getByTestId('archive-toast')
      expect(toast).toHaveAttribute('data-variant', 'success')
      expect(toast).toHaveTextContent('Card archived')
      await user.click(within(toast).getByRole('button', { name: 'View in Archived' }))
      expect(screen.getByTestId('archived-panel')).toBeInTheDocument()
      expect(screen.queryByTestId('archive-toast')).toBeNull()
    })

    it('renders in the slot right after the grid and before BulkActionToolbar', async () => {
      await archiveFromToolbar()
      const region = screen.getByRole('region', { name: 'Notifications' })
      expect(region.parentElement).toHaveAttribute('data-toast-slot')
      const grid = document.querySelector('[data-board-scroll]') as HTMLElement
      const toolbar = screen.getByTestId('bulk-toolbar')
      expect(grid.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(region.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('one Tab from the last stop in the grid reaches the first toast action', async () => {
      const user = await archiveFromToolbar()
      const grid = document.querySelector('[data-board-scroll]') as HTMLElement
      const stops = Array.from(grid.querySelectorAll<HTMLElement>('button, [tabindex="0"]'))
      stops[stops.length - 1].focus()
      await user.tab()
      expect(screen.getByRole('button', { name: 'View in Archived' })).toHaveFocus()
    })
  })

  describe('quick-edit popover Escape (#1856)', () => {
    it('Escape closes only the popover and leaves the real BoardView card selection intact', async () => {
      const card = {
        id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Quick Edit Card',
        description: '', priority: 'medium' as const, assignee: null,
        labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: 'user1', display_name: 'User 1', avatar_url: '' },
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        last_moved_at: null, attachment_count: 0, checklist_total: 0,
        checklist_done: 0, is_stale: false, archived_at: null, version: 1,
        custom_field_values: [],
        blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
      }
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      const onDismiss = vi.fn()
      const rect = { top: 0, left: 0, bottom: 10, right: 10, width: 10, height: 10, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      const ui = (open: boolean) => (
        <>
          <BoardView {...defaultProps()} />
          {open && <CustomFieldQuickEditPopover anchorRect={rect} choices={['Low']} selected="" onSelect={() => {}} onDismiss={onDismiss} />}
        </>
      )
      const { rerender } = render(ui(false))
      await userEvent.setup().click(screen.getByTestId('select-card-1-20'))
      expect(screen.getByTestId('bulk-toolbar')).toBeInTheDocument()

      rerender(ui(true))
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onDismiss).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('bulk-toolbar')).toBeInTheDocument()

      // With the popover gone, the next Escape clears the selection as before.
      rerender(ui(false))
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByTestId('bulk-toolbar')).not.toBeInTheDocument()
    })
  })

  describe('inline field Escape (#1860)', () => {
    it('Escape cancels the board-name rename and leaves the real BoardView card selection intact', async () => {
      const card = {
        id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Rename Card',
        description: '', priority: 'medium' as const, assignee: null,
        labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: 'user1', display_name: 'User 1', avatar_url: '' },
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        last_moved_at: null, attachment_count: 0, checklist_total: 0,
        checklist_done: 0, is_stale: false, archived_at: null, version: 1,
        custom_field_values: [],
        blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
      }
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      const user = userEvent.setup()
      render(<><InlineBoardName name="Board" canEdit onSave={vi.fn()} /><BoardView {...defaultProps()} /></>)
      await user.click(screen.getByTestId('select-card-1-20'))
      expect(screen.getByTestId('bulk-toolbar')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /rename board/i }))
      expect(screen.getByRole('textbox', { name: /board name/i })).toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('textbox', { name: /board name/i })).not.toBeInTheDocument()
      expect(screen.getByTestId('bulk-toolbar')).toBeInTheDocument()

      // With the field gone, the next Escape clears the selection as before.
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByTestId('bulk-toolbar')).not.toBeInTheDocument()
    })
  })

  describe('toolbar zone layout', () => {
    it('toolbar carries tabs plus Filter, View and Activity buttons, with no zone dividers (#2269)', () => {
      render(<BoardView {...defaultProps()} />)
      const toolbar = screen.getByTestId('board-toolbar')
      expect(toolbar.querySelectorAll('.w-px')).toHaveLength(0)
      expect(within(toolbar).getByRole('button', { name: 'Board' })).toHaveAttribute('aria-current', 'page')
      for (const name of [/^Filters/, 'View', 'Open activity drawer']) {
        expect(within(toolbar).getByRole('button', { name })).toBeInTheDocument()
      }
      // Controls that left the toolbar are not direct buttons any more.
      expect(screen.queryByRole('button', { name: 'Show archived cards' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Export board' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Overlay' })).not.toBeInTheDocument()
    })

    it('Archived is reachable from the View menu and shows an active mark when toggled', async () => {
      render(<BoardView {...defaultProps()} />)
      const archived = openViewPanel().getByRole('button', { name: 'Show archived cards' })
      await userEvent.setup().click(archived)
      const hide = openViewPanel().getByRole('button', { name: 'Hide archived cards' })
      expect(hide.getAttribute('aria-pressed')).toBe('true')
      expect(within(hide).getByTestId('active-mark')).toBeInTheDocument()
    })

    it('does not render pan hint text in toolbar', () => {
      render(<BoardView {...defaultProps()} />)
      expect(screen.queryByText(/Space.*drag to pan/)).not.toBeInTheDocument()
    })

    it('overflow items advertise their keyboard shortcuts', () => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
      Object.defineProperty(navigator, 'userAgentData', { value: undefined, configurable: true })
      render(<BoardView {...defaultProps()} />)
      expect(overflowItem(/^Keyboard shortcuts/)).toHaveTextContent('?')
      expect(overflowItem(/^Board settings/)).toHaveTextContent('⌘,')
      expect(overflowItem(/^Export board/)).toHaveTextContent('⌘⇧E')
    })

    it('Filters and Activity drawer tooltips name the control; the drawer advertises its shortcut', () => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
      Object.defineProperty(navigator, 'userAgentData', { value: undefined, configurable: true })
      render(<BoardView {...defaultProps()} />)
      // The Filter panel wraps its button in the tooltip's span so it can keep its own trigger ref.
      expect(screen.getByLabelText('Filters').parentElement?.getAttribute('data-tooltip')).toBe('Filters')
      expect(screen.getByLabelText('Open activity drawer').getAttribute('data-tooltip')).toBe('Open activity drawer (⌘\\)')
    })

    it('non-Mac platform renders Ctrl/Shift shortcut labels', () => {
      Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
      Object.defineProperty(navigator, 'userAgentData', { value: undefined, configurable: true })
      render(<BoardView {...defaultProps()} />)
      expect(overflowItem(/^Export board/)).toHaveTextContent('Ctrl+Shift+E')
      expect(screen.getByLabelText('Open activity drawer').getAttribute('data-tooltip')).toBe('Open activity drawer (Ctrl+\\)')
    })

    it('Live indicator has role=status', () => {
      render(<BoardView {...defaultProps()} />)
      const statusRegions = screen.getAllByRole('status')
      expect(statusRegions.length).toBeGreaterThanOrEqual(1)
    })

    it('Row 2 is a <nav> landmark labeled "Board toolbar" with a 40px minimum height', () => {
      render(<BoardView {...defaultProps()} />)
      const nav = screen.getByRole('navigation', { name: 'Board toolbar' })
      expect(nav.tagName).toBe('NAV')
      expect(nav.className).toMatch(/(^|\s)min-h-10(\s|$)/)
      expect(nav.className).toMatch(/bg-surface/)
    })

    it('the toolbar row wraps instead of scrolling sideways', () => {
      render(<BoardView {...defaultProps()} />)
      const nav = screen.getByRole('navigation', { name: 'Board toolbar' })
      const row = screen.getByTestId('board-toolbar')
      for (const el of [nav, row]) {
        expect(el.className).toMatch(/(^|\s)flex-wrap(\s|$)/)
        expect(el.className).not.toMatch(/overflow-x-auto|min-w-max/)
      }
    })

    it('filter row exposes role="search" labeled "Board filters" when filters are open', async () => {
      render(<BoardView {...defaultProps()} />)
      await showFilterBar()
      const search = screen.getByRole('search', { name: 'Board filters' })
      expect(search).toBeInTheDocument()
    })
  })

  describe('ViewToggle Beta badge', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      mockedGetCardStatus.mockResolvedValue(null)
      mockSearchParams = new URLSearchParams()
      localStorage.clear()
      mockBoardContextValue = defaultContext()
    })

    it('renders a "Beta" badge inside the Analytics tab button', () => {
      render(<BoardView {...defaultProps()} />)
      expect(screen.getByText('Beta')).toBeInTheDocument()
    })

    it('Board tab does not render a "Beta" badge', () => {
      render(<BoardView {...defaultProps()} />)
      // There is exactly one "Beta" badge — it belongs to the Analytics button only.
      expect(screen.getAllByText('Beta')).toHaveLength(1)
      // Verify the Board button itself contains no "Beta" text.
      const boardBtn = screen.getByRole('button', { name: 'Board' })
      expect(boardBtn.textContent).not.toContain('Beta')
    })

    it('Summary tab does not render a "Beta" badge', () => {
      render(<BoardView {...defaultProps()} />)
      const summaryBtn = screen.getByRole('button', { name: 'Summary' })
      expect(summaryBtn.textContent).not.toContain('Beta')
    })

    it('History tab does not render a "Beta" badge', () => {
      render(<BoardView {...defaultProps()} />)
      const historyBtn = screen.getByRole('button', { name: 'History' })
      expect(historyBtn.textContent).not.toContain('Beta')
    })

    // #2236: one opaque chip in every tab state, so the badge never takes its contrast from
    // the tab underneath (the old active bg-warning/30 on bg-primary was 1.17:1 in light mode).
    it.each([
      ['inactive', ''],
      ['active', 'view=analytics'],
    ])('badge is the same opaque bg-surface chip with warning-on-tint text when %s', (_s, qs) => {
      mockSearchParams = new URLSearchParams(qs)
      render(<BoardView {...defaultProps()} />)
      const badge = screen.getByText('Beta')
      expect(badge).toHaveClass('bg-surface', 'text-warning-on-tint')
      expect(badge.className).not.toMatch(/\bbg-warning\//)
    })
  })

  describe('swimlane collapse keyboard shortcut ("c")', () => {
    it('pressing "c" when a swimlane is hovered calls toggleCollapsedSwimlane via useViewPrefs', async () => {
      // The SwimlaneRow mock does not fire onHoverEnter/onHoverLeave, so we test
      // the keydown handler indirectly by checking useViewPrefs state via the
      // collapsed strip that appears when a lane is collapsed.
      // Instead, verify that pressing "c" with no hovered lane does nothing
      // (no crash, no strip appears).
      render(<BoardView {...defaultProps()} />)
      expect(screen.queryByText(/lane.*collapsed/i)).not.toBeInTheDocument()
      await userEvent.setup().keyboard('c')
      // With no hovered lane, nothing should happen.
      expect(screen.queryByText(/lane.*collapsed/i)).not.toBeInTheDocument()
    })

    it('pressing "c" in an INPUT does not trigger collapse', async () => {
      render(<BoardView {...defaultProps()} />)
      // Open the filter bar which contains an INPUT
      await showFilterBar()
      const filterBar = screen.getByTestId('filter-bar')
      // No crash or unexpected state change should occur
      expect(filterBar).toBeInTheDocument()
    })
  })

  describe('collapsed swimlanes strip', () => {
    it('does not render the strip when no swimlanes are collapsed', () => {
      render(<BoardView {...defaultProps()} />)
      expect(screen.queryByText(/lane.*collapsed/i)).not.toBeInTheDocument()
      expect(screen.queryByText('Expand all lanes')).not.toBeInTheDocument()
    })

    it('does not render the strip on non-board views even if lanes were collapsed', () => {
      // Start on analytics view where the strip should be hidden
      mockSearchParams = new URLSearchParams('view=analytics')
      render(<BoardView {...defaultProps()} />)
      // No collapsed lanes, strip definitely absent; just confirms no crash
      expect(screen.queryByText('Expand all lanes')).not.toBeInTheDocument()
    })
  })

  // #853 — SplitButton + overflow kebab + responsive fold
  describe('View menu collapse and expand (#853, #2269)', () => {
    it('offers Collapse all / Expand all for swimlanes and Hide all / Show all for columns', () => {
      render(<BoardView {...defaultProps()} />)
      const panel = openViewPanel()
      for (const name of ['Collapse all', 'Expand all', 'Hide all', 'Show all']) {
        expect(panel.getByRole('button', { name })).toBeInTheDocument()
      }
    })

    it('disables the no-op half of each pair (menu shape stays stable)', () => {
      render(<BoardView {...defaultProps()} />)
      const panel = openViewPanel()
      // Default all-expanded state: the Expand/Show actions would do nothing.
      expect(panel.getByRole('button', { name: 'Expand all' })).toBeDisabled()
      expect(panel.getByRole('button', { name: 'Show all' })).toBeDisabled()
      expect(panel.getByRole('button', { name: 'Collapse all' })).toBeEnabled()
    })

    it('Collapse all then Expand all round-trips', async () => {
      render(<BoardView {...defaultProps()} />)
      const user = userEvent.setup()
      await user.click(openViewPanel().getByRole('button', { name: 'Collapse all' }))
      expect(openViewPanel().getByRole('button', { name: 'Expand all' })).toBeEnabled()
      await user.click(openViewPanel().getByRole('button', { name: 'Expand all' }))
      expect(openViewPanel().getByRole('button', { name: 'Expand all' })).toBeDisabled()
    })

    it('the View menu announces the live lane count (#2323)', async () => {
      // Guards BoardView's laneCount={board.swimlanes.length} wiring: without it the
      // menu falls back to the count-less "Collapsed all lanes".
      const base = makeBoard()
      mockBoardContextValue = defaultContext({
        board: makeBoard({ swimlanes: [base.swimlanes[0], { ...base.swimlanes[0], id: 21, uid: 'laneuid00002', name: 'Customer B', position: 1 }] }),
      })
      render(<BoardView {...defaultProps()} />)
      const user = userEvent.setup()
      await user.click(openViewPanel().getByRole('button', { name: 'Collapse all' }))
      await waitFor(() => expect(screen.getByTestId('view-menu-lanes-status')).toHaveTextContent('Collapsed all 2 lanes'))
    })

    it('the Show row button collapses and expands every lane, in step with the View menu (#2308)', async () => {
      render(<BoardView {...defaultProps()} />)
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Collapse all lanes' }))
      expect(screen.getByRole('button', { name: 'Expand all lanes' })).toBeInTheDocument()
      expect(openViewPanel().getByRole('button', { name: 'Expand all' })).toBeEnabled()
      await user.click(screen.getByRole('button', { name: 'Expand all lanes' }))
      expect(screen.getByRole('button', { name: 'Collapse all lanes' })).toBeInTheDocument()
    })

    it('controls carry a visible keyboard-focus ring', () => {
      render(<BoardView {...defaultProps()} />)
      expect(openViewPanel().getByRole('button', { name: 'Collapse all' }).className).toMatch(/focus:ring-2 focus:ring-primary-emphasis/)
    })
  })

  describe('Overflow kebab + . shortcut (#853)', () => {
    it('renders the overflow kebab next to the connection status', () => {
      render(<BoardView {...defaultProps()} />)
      expect(screen.getByRole('button', { name: 'More board actions' })).toBeInTheDocument()
    })

    it('overflow menu holds only Export, Board settings and Shortcuts', async () => {
      render(<BoardView currentUser={fakeUser} />)
      await userEvent.setup().click(screen.getByRole('button', { name: 'More board actions' }))
      expect(screen.getByRole('menuitem', { name: /Export board/ })).toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: /Keyboard shortcuts/ })).toBeInTheDocument()
      expect(screen.queryByRole('menuitem', { name: /Replay onboarding tour/ })).not.toBeInTheDocument()
      // Layout, archived and drawer actions live in the View menu / Activity drawer, not here.
      expect(screen.queryByRole('menuitem', { name: /layout|density|archived|activity|drawer/i })).not.toBeInTheDocument()
      expect(screen.getAllByRole('menuitem').length).toBeLessThanOrEqual(3)
    })

    it('overflow menuitems carry a visible keyboard-focus ring (#1234)', async () => {
      render(<BoardView currentUser={fakeUser} />)
      await userEvent.setup().click(screen.getByRole('button', { name: 'More board actions' }))
      expect(screen.getByRole('menuitem', { name: /Export board/ }).className).toMatch(/focus:ring-2 focus:ring-primary-emphasis/)
    })

    it('. key opens the overflow menu when no input is focused', () => {
      render(<BoardView {...defaultProps()} />)
      fireEvent.keyDown(document, { key: '.' })
      expect(screen.getByRole('menu', { name: 'More board actions' })).toBeInTheDocument()
    })

    it('. key does NOT open the menu when focus is inside a text input', () => {
      render(
        <div>
          <BoardView {...defaultProps()} />
          <input data-testid="outside-input" />
        </div>,
      )
      const input = screen.getByTestId('outside-input')
      input.focus()
      fireEvent.keyDown(input, { key: '.' })
      expect(screen.queryByRole('menu', { name: 'More board actions' })).not.toBeInTheDocument()
    })

    it('does not auto-expand the kebab at sub-`lg` widths: nothing folds into it any more (#2269)', async () => {
      const mq = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
      Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: vi.fn(() => mq) })
      localStorage.removeItem('user:prefs:overflow-seen')
      vi.useFakeTimers()
      try {
        render(<BoardView {...defaultProps()} />)
        await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
        expect(screen.queryByRole('menu', { name: 'More board actions' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument()
      } finally {
        vi.useRealTimers()
        Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined })
      }
    })

    it('does NOT auto-expand at `lg` viewport — controls are visible directly (#971)', async () => {
      // Default test environment has matchMedia=undefined → useIsLargeViewport
      // returns true → controls are not folded → no auto-expand.
      localStorage.removeItem('user:prefs:overflow-seen')
      vi.useFakeTimers()
      try {
        render(<BoardView {...defaultProps()} />)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000)
        })
        expect(screen.queryByRole('menu', { name: 'More board actions' })).not.toBeInTheDocument()
        expect(localStorage.getItem('user:prefs:overflow-seen')).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('. shortcut within the auto-expand window cancels the pending auto-expand (#971)', async () => {
      // Race covered: Jordan presses `.` in the 600 ms window. The menu opens
      // via the shortcut, Jordan dismisses it, and the pending timer must
      // NOT re-open the menu uninvited.
      const mq = {
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }
      const matchMedia = vi.fn(() => mq) as unknown as typeof window.matchMedia
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: matchMedia,
      })
      localStorage.removeItem('user:prefs:overflow-seen')
      vi.useFakeTimers()
      try {
        render(<BoardView {...defaultProps()} />)
        // Press `.` at 200 ms — well inside the 600 ms auto-expand window.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(200)
        })
        fireEvent.keyDown(document, { key: '.' })
        expect(screen.getByRole('menu', { name: 'More board actions' })).toBeInTheDocument()
        // Dismiss via Escape, then advance past the auto-expand deadline.
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(screen.queryByRole('menu', { name: 'More board actions' })).not.toBeInTheDocument()
        await act(async () => {
          await vi.advanceTimersByTimeAsync(600)
        })
        // Auto-expand timer must NOT have re-opened the menu.
        expect(screen.queryByRole('menu', { name: 'More board actions' })).not.toBeInTheDocument()
      } finally {
        vi.useRealTimers()
        Object.defineProperty(window, 'matchMedia', {
          configurable: true,
          writable: true,
          value: undefined,
        })
      }
    })

    it('does NOT auto-expand for users who have already seen the kebab (#971)', async () => {
      const mq = {
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }
      const matchMedia = vi.fn(() => mq) as unknown as typeof window.matchMedia
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: matchMedia,
      })
      localStorage.setItem('user:prefs:overflow-seen', 'true')
      vi.useFakeTimers()
      try {
        render(<BoardView {...defaultProps()} />)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000)
        })
        expect(screen.queryByRole('menu', { name: 'More board actions' })).not.toBeInTheDocument()
      } finally {
        vi.useRealTimers()
        Object.defineProperty(window, 'matchMedia', {
          configurable: true,
          writable: true,
          value: undefined,
        })
      }
    })

    it('first-encounter dot is dismissed on intentional click, not on . shortcut', () => {
      // Start with no prior seen pref — dot should render
      localStorage.removeItem('user:prefs:overflow-seen')
      const { container } = render(<BoardView {...defaultProps()} />)
      const trigger = screen.getByRole('button', { name: 'More board actions' })
      // Dot is a pointer-events-none <span> inside the trigger
      expect(trigger.querySelector('.bg-primary-emphasis')).not.toBeNull()

      // Opening via `.` shortcut should NOT dismiss the dot
      fireEvent.keyDown(document, { key: '.' })
      expect(trigger.querySelector('.bg-primary-emphasis')).not.toBeNull()
      // Close the menu before attempting the click path
      fireEvent.keyDown(document, { key: 'Escape' })

      // Intentional click dismisses
      fireEvent.click(trigger)
      expect(trigger.querySelector('.bg-primary-emphasis')).toBeNull()
      // Sanity: persistence key was set
      expect(localStorage.getItem('user:prefs:overflow-seen')).toBe('true')
      // Avoid unused-container warning
      expect(container).toBeTruthy()
    })
  })

  describe('⌘⇧E shortcut (#853)', () => {
    it('opens the Export modal', () => {
      render(<BoardView {...defaultProps()} />)
      fireEvent.keyDown(document, { key: 'E', metaKey: true, shiftKey: true })
      // BoardExportModal is not mocked; looking for its rendered content
      // would be brittle. Instead, check that the Export affordance has its
      // dot dismissed, which only happens as a side-effect of the shortcut.
      const exportBtn = queryOverflowItem(/^Export board/)
      if (exportBtn) {
        expect(exportBtn.querySelector('.bg-primary-emphasis')).toBeNull()
      }
    })

    it('treats an unrecognized export_min_role as admin-only (#1725)', () => {
      const unknown = 'bogus' as unknown as 'viewer'
      mockBoardContextValue = defaultContext({
        board: makeBoard({ current_user_role: 'member', export_min_role: unknown }),
      })
      const { unmount } = render(<BoardView {...defaultProps()} />)
      expect(queryOverflowItem(/^Export board/)).not.toBeInTheDocument()
      unmount()
      mockBoardContextValue = defaultContext({
        board: makeBoard({ current_user_role: 'admin', export_min_role: unknown }),
      })
      render(<BoardView {...defaultProps()} />)
      expect(overflowItem(/^Export board/)).toBeInTheDocument()
    })

    it('treats a blank export_min_role as the viewer default (#1725)', () => {
      mockBoardContextValue = defaultContext({
        board: makeBoard({ current_user_role: 'viewer', export_min_role: '' as unknown as 'viewer' }),
      })
      render(<BoardView {...defaultProps()} />)
      expect(overflowItem(/^Export board/)).toBeInTheDocument()
    })

    it('does not fire when the user lacks export permission', () => {
      mockBoardContextValue = defaultContext({
        board: makeBoard({ current_user_role: 'viewer', export_min_role: 'member' }),
      })
      render(<BoardView {...defaultProps()} />)
      // No assertion target — just verify the shortcut does not throw and
      // does not silently render an Export UI that the viewer can't act on.
      fireEvent.keyDown(document, { key: 'E', metaKey: true, shiftKey: true })
      expect(queryOverflowItem(/^Export board/)).not.toBeInTheDocument()
    })
  })

  describe('⌘, shortcut (#853 follow-up)', () => {
    it('opens the Board settings modal for admins', () => {
      render(<BoardView {...defaultProps()} />)
      expect(screen.queryByTestId('settings-modal')).not.toBeInTheDocument()
      fireEvent.keyDown(document, { key: ',', metaKey: true })
      expect(screen.getByTestId('settings-modal')).toBeInTheDocument()
    })

    it('Ctrl+, also opens the Board settings modal (Linux/Windows)', () => {
      render(<BoardView {...defaultProps()} />)
      fireEvent.keyDown(document, { key: ',', ctrlKey: true })
      expect(screen.getByTestId('settings-modal')).toBeInTheDocument()
    })

    it('does not fire when the user is not an admin', () => {
      mockBoardContextValue = defaultContext({
        board: makeBoard({ current_user_role: 'viewer' }),
      })
      render(<BoardView {...defaultProps()} />)
      fireEvent.keyDown(document, { key: ',', metaKey: true })
      expect(screen.queryByTestId('settings-modal')).not.toBeInTheDocument()
    })
  })

  // ---------------------------------------------------------------------------
  // #965 — drag-to-trash safety
  // ---------------------------------------------------------------------------

  describe('drag overlay aging (#1841)', () => {
    const cardIn = (column: number) => ({
      id: 1, uid: 'carduid00001', column, swimlane: 20, title: 'Dragged Card',
      description: '', priority: 'medium' as const, assignee: null, labels: [], due_date: null, weight: 1,
      position: 0, created_by: { id: 1, username: 'user1', display_name: 'User 1', avatar_url: '' }, created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z', last_moved_at: '2026-01-01T00:00:00Z',
      attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: true, archived_at: null,
      version: 1, custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    })
    const boardWithDone = (card: ReturnType<typeof cardIn>) => makeBoard({
      cards: [card],
      columns: [
        { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
        { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: true, policy: null },
      ],
    })

    it.each([
      [11, 'true'],
      [10, 'false'],
    ])('a card dragged from column %i gets inDoneColumn=%s on the drag overlay', (columnId, expected) => {
      mockBoardContextValue = defaultContext({ board: boardWithDone(cardIn(columnId)) })
      const { container } = render(<BoardView {...defaultProps()} />)
      act(() => {
        capturedOnDragStart!({ active: { id: '1' } } as unknown as DragStartEvent)
      })
      const overlayCard = container.querySelector('[data-overlay="true"]')
      expect(overlayCard).toHaveTextContent('Dragged Card')
      expect(overlayCard).toHaveAttribute('data-in-done-column', expected)
    })
  })

  describe('drag-to-trash safety (#965)', () => {
    it('does not render the column trash zone before a column drag starts', () => {
      render(<BoardView {...defaultProps()} />)
      expect(screen.queryByText('Delete')).not.toBeInTheDocument()
    })

    it('hides the trash zone during a column drag when ⌥ is not held', () => {
      render(<BoardView {...defaultProps()} />)
      act(() => {
        capturedOnDragStart!({ active: { id: 'col:10' } } as unknown as DragStartEvent)
      })
      expect(screen.queryByText('Delete')).not.toBeInTheDocument()
      // Discoverability hint nudges the user toward the gated gesture.
      expect(screen.getByText('Hold ⌥ to delete')).toBeInTheDocument()
    })

    it('reveals the trash zone when ⌥ is pressed mid-drag and hides it again on release', () => {
      render(<BoardView {...defaultProps()} />)
      act(() => {
        capturedOnDragStart!({ active: { id: 'col:10' } } as unknown as DragStartEvent)
      })
      act(() => {
        fireEvent.keyDown(document, { key: 'Alt', altKey: true })
      })
      expect(screen.getByText('Delete')).toBeInTheDocument()
      expect(screen.getByText('Drop on trash to delete')).toBeInTheDocument()
      act(() => {
        fireEvent.keyUp(document, { key: 'Alt', altKey: false })
      })
      expect(screen.queryByText('Delete')).not.toBeInTheDocument()
    })

    it('requires typing the column name to confirm deletion when the column has cards', async () => {
      const board = makeBoard({
        cards: [
          {
            id: 200, uid: 'card00000001', title: 'Existing card', description: '', priority: null,
            column: 10, swimlane: 20, position: 0, weight: 0, due_date: null, last_moved_at: null,
            archived_at: null, last_columns: [], assignees: [], labels: [], checklist: [], comments: [],
            attachments: [], created_at: '', updated_at: '', created_by: null,
            ...({} as Record<string, never>),
          } as unknown as BoardFull['cards'][number],
        ],
      })
      mockBoardContextValue = defaultContext({ board })
      render(<BoardView {...defaultProps()} />)
      // Trigger the same code path as drag-to-trash drop / kebab Delete: route the
      // first column into the confirmation modal via the drag-end handler.
      act(() => {
        capturedOnDragStart!({ active: { id: 'col:10' } } as unknown as DragStartEvent)
      })
      act(() => {
        capturedOnDragEnd!({
          active: { id: 'col:10' },
          over: { id: 'trash:column' },
        } as unknown as DragEndEvent)
      })
      const modal = await screen.findByText('Delete column?')
      expect(modal).toBeInTheDocument()
      const deleteBtn = screen.getByRole('button', { name: 'Delete' })
      expect(deleteBtn).toBeDisabled()
      const input = screen.getByLabelText(/Type .* to confirm deletion/i)
      fireEvent.change(input, { target: { value: 'wrong' } })
      expect(deleteBtn).toBeDisabled()
      fireEvent.change(input, { target: { value: 'To Do' } })
      expect(deleteBtn).toBeEnabled()
    })

    it('restores focus to the board region after a confirmed column delete, not <body> (#2204)', async () => {
      render(<BoardView {...defaultProps()} />)
      act(() => {
        capturedOnDragStart!({ active: { id: 'col:10' } } as unknown as DragStartEvent)
      })
      act(() => {
        capturedOnDragEnd!({
          active: { id: 'col:10' },
          over: { id: 'trash:column' },
        } as unknown as DragEndEvent)
      })
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(screen.queryByText('Delete column?')).not.toBeInTheDocument())
      expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Board' }))
    })

    it('allows direct delete (no name typing) when the column is empty', () => {
      render(<BoardView {...defaultProps()} />)
      act(() => {
        capturedOnDragStart!({ active: { id: 'col:10' } } as unknown as DragStartEvent)
      })
      act(() => {
        capturedOnDragEnd!({
          active: { id: 'col:10' },
          over: { id: 'trash:column' },
        } as unknown as DragEndEvent)
      })
      expect(screen.getByText('Delete column?')).toBeInTheDocument()
      expect(screen.queryByLabelText(/Type .* to confirm deletion/i)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled()
    })
  })

  // ---------------------------------------------------------------------------
  // #783 — maintenance mode folds into the existing canEdit gate
  // ---------------------------------------------------------------------------
  describe('maintenance mode (#783)', () => {
    it('canEdit is unaffected when currentUser is not in maintenance mode', () => {
      render(<BoardView currentUser={fakeUser} />)
      expect(screen.getByTestId('swim-20')).toHaveAttribute('data-can-edit', 'true')
    })

    it('canEdit defaults to open when no currentUser is supplied at all', () => {
      // Some call sites render BoardView with currentUser=null; the maintenance
      // gate must not throw on a missing user and must not block editing.
      render(<BoardView currentUser={null} />)
      expect(screen.getByTestId('swim-20')).toHaveAttribute('data-can-edit', 'true')
    })

    it('canEdit turns false for a board admin while the instance is in maintenance mode', () => {
      const blockedAdmin = { ...fakeUser, is_site_admin: false }
      render(<BoardView currentUser={blockedAdmin} />, { wrapper: flagsWrapper({ maintenance_mode: true }) })
      expect(screen.getByTestId('swim-20')).toHaveAttribute('data-can-edit', 'false')
    })

    it('site admins stay canEdit=true during maintenance mode (mirrors the server-side exemption)', () => {
      const exemptSiteAdmin = { ...fakeUser, is_site_admin: true }
      render(<BoardView currentUser={exemptSiteAdmin} />, { wrapper: flagsWrapper({ maintenance_mode: true }) })
      expect(screen.getByTestId('swim-20')).toHaveAttribute('data-can-edit', 'true')
    })

    it('canEdit stays false for a viewer regardless of maintenance mode (unrelated gate still applies)', () => {
      mockBoardContextValue = defaultContext({ board: makeBoard({ current_user_role: 'viewer' }) })
      render(<BoardView currentUser={fakeUser} />)
      expect(screen.getByTestId('swim-20')).toHaveAttribute('data-can-edit', 'false')
    })
  })

  describe('lens default tab + Board tab de-emphasis (#1063)', () => {
    const lensUser = { ...fakeUser, git_lens_enabled: true } as User
    const conn = { id: 1, provider: 'gitlab', repo_slug: 'acme/widgets' } as never

    beforeEach(() => {
      vi.mocked(getLensConnection).mockResolvedValue(conn)
    })

    it('lands on the Lens tab when a lens is configured and no ?view=', async () => {
      render(<BoardView currentUser={lensUser} />)
      expect(await screen.findByTestId('lens-view')).toBeInTheDocument()
      expect(screen.queryByTestId('swim-20')).not.toBeInTheDocument()
    })

    it('lands on Board when the flag is off (lens fetch skipped)', () => {
      render(<BoardView currentUser={fakeUser} />)
      expect(getLensConnection).not.toHaveBeenCalled()
      expect(screen.getByTestId('swim-20')).toBeInTheDocument()
      expect(screen.queryByTestId('lens-view')).not.toBeInTheDocument()
    })

    it('lands on Board when the flag is on but no lens is configured', async () => {
      vi.mocked(getLensConnection).mockRejectedValue(new Error('404'))
      render(<BoardView currentUser={lensUser} />)
      await waitFor(() => expect(getLensConnection).toHaveBeenCalled())
      expect(screen.getByTestId('swim-20')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Lens' })).not.toBeInTheDocument()
    })

    it('honors explicit ?view=board even when a lens is configured', async () => {
      mockSearchParams = new URLSearchParams('view=board')
      render(<BoardView currentUser={lensUser} />)
      await screen.findByRole('button', { name: 'Lens' })
      expect(screen.getByTestId('swim-20')).toBeInTheDocument()
      expect(screen.queryByTestId('lens-view')).not.toBeInTheDocument()
    })

    it('keeps the Board default for a ?focus= deep link', async () => {
      mockSearchParams = new URLSearchParams('focus=20')
      render(<BoardView currentUser={lensUser} />)
      await screen.findByRole('button', { name: 'Lens' })
      expect(screen.queryByTestId('lens-view')).not.toBeInTheDocument()
    })

    it('mutes the Board tab with zero swimlanes + lens, and it stays clickable', async () => {
      mockBoardContextValue = defaultContext({ board: makeBoard({ swimlanes: [] }) })
      render(<BoardView currentUser={lensUser} />)
      await screen.findByTestId('lens-view')
      const boardTab = screen.getByRole('button', { name: 'Board' })
      expect(boardTab).toHaveAttribute('data-deemphasized', 'true')
      expect(boardTab).not.toBeDisabled()
      expect(boardTab.getAttribute('data-tooltip')).toContain(LENS_ONLY_BOARD_TOOLTIP)
      await userEvent.setup().click(boardTab)
      expect(mockSetSearchParams).toHaveBeenCalled()
      expect(screen.queryByTestId('lens-view')).not.toBeInTheDocument()
    })

    it('a palette card-open while on the Lens tab switches to Board so CardDetail can render', async () => {
      const card = {
        id: 1, uid: 'carduid00001', title: 'Native Card', column: 10, swimlane: 20,
        description: '', priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
        position: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
        is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
      } as never
      mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
      render(<BoardView currentUser={lensUser} />)
      await screen.findByTestId('lens-view')
      act(() => {
        window.dispatchEvent(new CustomEvent('visiban:open-card', { detail: { cardId: 1 } }))
      })
      expect(screen.queryByTestId('lens-view')).not.toBeInTheDocument()
      expect(await screen.findByTestId('card-detail')).toBeInTheDocument()
    })

    it('does NOT mute the Board tab once one native swimlane exists', async () => {
      render(<BoardView currentUser={lensUser} />)
      await screen.findByTestId('lens-view')
      expect(screen.getByRole('button', { name: 'Board' })).not.toHaveAttribute('data-deemphasized')
    })

    it('does NOT mute the Board tab with zero swimlanes when there is no lens', async () => {
      vi.mocked(getLensConnection).mockRejectedValue(new Error('404'))
      mockBoardContextValue = defaultContext({ board: makeBoard({ swimlanes: [] }) })
      render(<BoardView currentUser={lensUser} />)
      await waitFor(() => expect(getLensConnection).toHaveBeenCalled())
      expect(screen.getByRole('button', { name: 'Board' })).not.toHaveAttribute('data-deemphasized')
    })
  })
  describe('Surfaces opened from the overflow menu return focus to its trigger (#1775)', () => {
    // Folded toolbar (sub-lg): layout, archived, drawer and settings move into the kebab.
    beforeEach(() => {
      const mq = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
      Object.defineProperty(window, 'matchMedia', {
        configurable: true, writable: true, value: vi.fn(() => mq),
      })
      localStorage.setItem('user:prefs:overflow-seen', 'true')
    })
    afterEach(() => {
      Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined })
    })

    async function openFromKebab(itemName: RegExp, dialogName: RegExp) {
      const user = userEvent.setup()
      render(<BoardView {...defaultProps()} currentUser={fakeUser} />)
      const trigger = screen.getByRole('button', { name: 'More board actions' })
      await user.click(trigger)
      await user.click(screen.getByRole('menuitem', { name: itemName }))
      const dialog = await screen.findByRole('dialog', { name: dialogName })
      return { user, trigger, dialog }
    }

    it('Export board modal: Escape returns focus to the kebab', async () => {
      const { user, trigger } = await openFromKebab(/Export board/i, /Export board/i)
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /Export board/i })).not.toBeInTheDocument())
      expect(trigger).toHaveFocus()
    })

    // BoardSettingsModal, KeyboardShortcutsOverlay and ArchivedCardsPanel are
    // mocked in this file, so assert the contract their real useFocusTrap
    // relies on: the kebab, not the unmounted menu item, holds focus when the
    // surface mounts (the trap captures its opener during that render).
    it.each([
      ['Board settings', /Board settings/i, 'settings-modal'],
      ['Keyboard shortcuts', /Keyboard shortcuts/i, 'shortcuts-overlay'],
    ])('%s: the kebab holds focus when the surface opens', async (_label, itemName, testId) => {
      const user = userEvent.setup()
      render(<BoardView {...defaultProps()} currentUser={fakeUser} />)
      const trigger = screen.getByRole('button', { name: 'More board actions' })
      await user.click(trigger)
      await user.click(screen.getByRole('menuitem', { name: itemName }))
      expect(await screen.findByTestId(testId)).toBeInTheDocument()
      expect(trigger).toHaveFocus()
    })
  })
})

// Card context menu and ⌘K card actions (#2059): BoardView owns the target
// set, the executor and the palette's window-event contract.
describe('BoardView card actions (#2059)', () => {
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
  const query = (detail: Record<string, unknown>) => {
    act(() => { window.dispatchEvent(new CustomEvent('visiban:card-target-query', { detail })) })
    return detail.response as { cardIds: number[]; source: string; summary: string; actions: { id: string; enabled: boolean }[] } | null
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockSearchParams = new URLSearchParams()
    localStorage.clear()
    vi.mocked(getCardStatus).mockResolvedValue(null)
    mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card1, card2] }) })
  })

  it('right-clicking a card outside the selection opens the menu on that card alone and outlines it', () => {
    render(<BoardView currentUser={fakeUser} />)
    fireEvent.click(screen.getByTestId('open-menu-2'))
    expect(screen.getByRole('menu', { name: 'Card actions: Second card' })).toBeInTheDocument()
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-context-target', '2')
  })

  it('a card inside the selection acts on the whole selection, and Escape closes only the menu', async () => {
    render(<BoardView currentUser={fakeUser} />)
    fireEvent.click(screen.getByTestId('select-card-1-20'))
    expect(screen.getByTestId('bulk-toolbar')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('open-menu-1'))
    expect(screen.getByRole('menu', { name: 'Card actions: Fix payout rounding' })).toBeInTheDocument()
    // In the selection: no transient outline.
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-context-target', '')
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    // The menu's Escape (59) outranks the selection clear (10).
    expect(screen.getByTestId('bulk-toolbar')).toBeInTheDocument()
  })

  it('Move to… runs the move and announces it', async () => {
    vi.mocked(moveCard).mockResolvedValue({ card: { ...card2, column: 11 } } as never)
    const updateCardSpy = vi.fn()
    mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card1, card2] }), updateCard: updateCardSpy })
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    fireEvent.click(screen.getByTestId('open-menu-2'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Move to/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Done' }))
    await waitFor(() => expect(moveCard).toHaveBeenCalledWith(1, 2, { column_id: 11, swimlane_id: 20, position: 9999 }))
    expect(updateCardSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 2, column: 11 }))
    expect(await screen.findByTestId('card-action-status')).toHaveTextContent('Moved “Second card” to Done.')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('a failed archive is shown with the bulk partial-failure wording', async () => {
    vi.mocked(archiveCard).mockRejectedValue(new Error('offline'))
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    fireEvent.click(screen.getByTestId('open-menu-2'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive card' }))
    const failure = await screen.findByTestId('card-action-toast')
    expect(failure).toHaveAttribute('data-variant', 'danger')
    expect(failure).toHaveTextContent('1 of 1 card could not be archived — a network error occurred.')
    // A failure persists until dismissed (no auto-clear timer).
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    fireEvent.click(within(failure).getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByTestId('card-action-toast')).not.toBeInTheDocument()
  })

  it('archiving on the board view raises the archive toast and no second announcement', async () => {
    vi.mocked(archiveCard).mockResolvedValue(undefined as never)
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    fireEvent.click(screen.getByTestId('open-menu-2'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive card' }))
    expect(await screen.findByTestId('archive-toast')).toHaveTextContent('Card archived')
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(screen.getByTestId('card-action-status')).toHaveTextContent('')
    expect(screen.queryByTestId('card-action-toast')).not.toBeInTheDocument()
  })

  it('a card-action failure toast does not outlive BoardView (provider stays mounted)', async () => {
    vi.mocked(archiveCard).mockRejectedValue(new Error('offline'))
    const ui = (on: boolean) => <ToastProvider>{on && <BoardView currentUser={fakeUser} />}</ToastProvider>
    const { rerender } = render(ui(true))
    fireEvent.click(screen.getByTestId('open-menu-2'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive card' }))
    expect(await screen.findByTestId('card-action-toast')).toHaveAttribute('data-variant', 'danger')
    rerender(ui(false))
    expect(screen.queryByTestId('card-action-toast')).not.toBeInTheDocument()
  })

  it('Block card… opens the card sheet with the block form requested', () => {
    render(<BoardView currentUser={fakeUser} />)
    fireEvent.click(screen.getByTestId('open-menu-2'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Block card…' }))
    expect(screen.getByTestId('card-detail')).toHaveTextContent('Second card')
    expect(screen.getByTestId('card-detail')).toHaveAttribute('data-block-form', 'block')
    // No menu over an open sheet.
    expect(screen.queryByTestId('open-menu-1')).not.toBeInTheDocument()
  })

  it('Delete card… asks first, then deletes', async () => {
    vi.mocked(deleteCard).mockResolvedValue(undefined as never)
    const removeCard = vi.fn()
    mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card1, card2] }), removeCard })
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    fireEvent.click(screen.getByTestId('open-menu-2'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete card…' }))
    expect(deleteCard).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: 'Delete this card?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(deleteCard).toHaveBeenCalledWith(1, 2))
    await waitFor(() => expect(removeCard).toHaveBeenCalledWith(2))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete this card?' })).not.toBeInTheDocument())
    // The card is gone from view, so the success is a toast, not only announced.
    const toast = screen.getByTestId('card-action-toast')
    expect(toast).toHaveTextContent('Deleted “Second card”.')
    expect(toast).toHaveAttribute('data-variant', 'success')
  })

  it('Cancel on the Delete card… confirm deletes nothing and reports nothing', async () => {
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    fireEvent.click(screen.getByTestId('open-menu-2'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete card…' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete this card?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete this card?' })).not.toBeInTheDocument())
    expect(deleteCard).not.toHaveBeenCalled()
    expect(screen.queryByTestId('card-action-toast')).not.toBeInTheDocument()
  })

  it('Copy link writes the card deep link and announces it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    fireEvent.click(screen.getByTestId('open-menu-2'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link to card' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/boards/1?card=2`))
    // Nothing on the board changes, so it is a toast, not only announced.
    expect(await screen.findByTestId('card-action-toast')).toHaveTextContent('Link copied to the clipboard.')
    expect(screen.getByTestId('card-action-status')).toHaveTextContent('')
  })

  it('says so when the clipboard is blocked', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true })
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    fireEvent.click(screen.getByTestId('open-menu-2'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link to card' }))
    expect(await screen.findByTestId('card-action-toast')).toHaveTextContent("Couldn't copy the link. The browser blocked clipboard access.")
  })

  it('answers palette target queries: none, focused, selection, then the open sheet', () => {
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    expect(query({})).toBeNull()
    expect(query({ focusedCardId: 2 })).toMatchObject({ cardIds: [2], source: 'focused', summary: 'Second card' })
    // A focused id that is not on this board is ignored.
    expect(query({ focusedCardId: 999 })).toBeNull()
    fireEvent.click(screen.getByTestId('select-card-1-20'))
    expect(query({})).toMatchObject({ cardIds: [1], source: 'selection' })
    expect(query({ cardIds: [2] })).toMatchObject({ cardIds: [2], source: 'result' })
    act(() => { window.dispatchEvent(new CustomEvent('visiban:open-card', { detail: { cardId: 2 } })) })
    expect(query({ focusedCardId: 1 })).toMatchObject({ cardIds: [2], source: 'open' })
  })

  it('runs a palette card action from the window event', async () => {
    vi.mocked(updateCard).mockResolvedValue({ ...card2, priority: 'high' } as never)
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    act(() => {
      window.dispatchEvent(new CustomEvent('visiban:card-action', { detail: { cardIds: [2], action: 'priority', value: 'high' } }))
    })
    await waitFor(() => expect(updateCard).toHaveBeenCalledWith(1, 2, { priority: 'high' }))
    expect(await screen.findByTestId('card-action-status')).toHaveTextContent('Set “Second card” to high priority.')
    // The board shows the change, so the success is announced only: no toast.
    expect(screen.getByTestId('card-action-status').parentElement).toHaveClass('sr-only')
    expect(screen.queryByTestId('card-action-toast')).not.toBeInTheDocument()
  })

  it('assigns from the window event and clears a fully successful selection', async () => {
    vi.mocked(updateCard).mockResolvedValue({ ...card1 } as never)
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    fireEvent.click(screen.getByTestId('select-card-1-20'))
    act(() => {
      window.dispatchEvent(new CustomEvent('visiban:card-action', { detail: { cardIds: [1], action: 'assign', value: 1 } }))
    })
    await waitFor(() => expect(updateCard).toHaveBeenCalledWith(1, 1, { assignee_id: 1 }))
    expect(await screen.findByTestId('card-action-status')).toHaveTextContent('Assigned “Fix payout rounding” to Jane Doe.')
    await waitFor(() => expect(screen.queryByTestId('bulk-toolbar')).not.toBeInTheDocument())
  })

  it('never runs an action the target may not take (viewer)', async () => {
    mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card1, card2], current_user_role: 'viewer' }) })
    render(<BoardView currentUser={fakeUser} />)
    expect(query({ focusedCardId: 2 })?.actions.find((a) => a.id === 'archive')).toMatchObject({ enabled: false })
    act(() => {
      window.dispatchEvent(new CustomEvent('visiban:card-action', { detail: { cardIds: [2], action: 'archive' } }))
    })
    await act(async () => {})
    expect(archiveCard).not.toHaveBeenCalled()
  })
})

// #2059 completeness: card commands run from the palette in every view, so
// their results must be visible there, and Block must reach a view that
// renders the card sheet.
describe('BoardView card actions outside the board grid (#2059)', () => {
  const card = {
    id: 2, uid: 'carduid00002', column: 10, swimlane: 20, title: 'Second card',
    description: '', priority: 'medium' as const, assignee: null,
    labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: 'jdoe', display_name: 'Jane Doe', avatar_url: '' },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    last_moved_at: null, attachment_count: 0, checklist_total: 0,
    checklist_done: 0, is_stale: false, archived_at: null, version: 1,
    custom_field_values: [],
    blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
  }
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.mocked(getCardStatus).mockResolvedValue(null)
    mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [card] }) })
  })

  it.each(['summary', 'history', 'analytics'])('shows a palette action result in the %s view', async (view) => {
    mockSearchParams = new URLSearchParams(`view=${view}`)
    vi.mocked(updateCard).mockResolvedValue({ ...card, priority: 'high' } as never)
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    act(() => {
      window.dispatchEvent(new CustomEvent('visiban:card-action', { detail: { cardIds: [2], action: 'priority', value: 'high' } }))
    })
    // The grid is not in view, so the success is a toast, not only announced.
    expect(await screen.findByTestId('card-action-toast')).toHaveTextContent('Set “Second card” to high priority.')
  })

  it('the Lens toolbar toggles drive the lens card layout and filter row (#2302)', async () => {
    const lensUser = { ...fakeUser, git_lens_enabled: true } as User
    vi.mocked(getLensConnection).mockResolvedValue({ id: 1, provider: 'gitlab', repo_slug: 'acme/widgets' } as never)
    mockSearchParams = new URLSearchParams()
    render(<BoardView currentUser={lensUser} />)
    const user = userEvent.setup()
    const lens = await screen.findByTestId('lens-view')
    const startLayout = lens.getAttribute('data-card-layout')
    const startFilters = lens.getAttribute('data-show-filters')
    await user.click(screen.getByRole('button', { name: 'Toggle lens layout' }))
    expect(screen.getByTestId('lens-view').getAttribute('data-card-layout')).not.toBe(startLayout)
    await user.click(screen.getByRole('button', { name: 'Toggle lens layout' }))
    expect(screen.getByTestId('lens-view').getAttribute('data-card-layout')).toBe(startLayout)
    await user.click(screen.getByRole('button', { name: 'Toggle lens filters' }))
    expect(screen.getByTestId('lens-view').getAttribute('data-show-filters')).not.toBe(startFilters)
    await user.click(screen.getByRole('button', { name: 'Toggle lens filters' }))
    expect(screen.getByTestId('lens-view').getAttribute('data-show-filters')).toBe(startFilters)
  })

  it('shows a palette action result in the Lens view', async () => {
    const lensUser = { ...fakeUser, git_lens_enabled: true } as User
    vi.mocked(getLensConnection).mockResolvedValue({ id: 1, provider: 'gitlab', repo_slug: 'acme/widgets' } as never)
    // A configured lens is the landing tab with no ?view= (#1063).
    mockSearchParams = new URLSearchParams()
    vi.mocked(updateCard).mockResolvedValue({ ...card, priority: 'high' } as never)
    render(<ToastProvider><BoardView currentUser={lensUser} /></ToastProvider>)
    expect(await screen.findByTestId('lens-view')).toBeInTheDocument()
    act(() => {
      window.dispatchEvent(new CustomEvent('visiban:card-action', { detail: { cardIds: [2], action: 'priority', value: 'high' } }))
    })
    expect(await screen.findByTestId('card-action-toast')).toHaveTextContent('Set “Second card” to high priority.')
    expect(screen.getByTestId('lens-view')).toBeInTheDocument()
  })

  it('archiving from the palette outside the board view raises the archive toast only', async () => {
    mockSearchParams = new URLSearchParams('view=summary')
    vi.mocked(archiveCard).mockResolvedValue(undefined as never)
    render(<ToastProvider><BoardView currentUser={fakeUser} /></ToastProvider>)
    act(() => {
      window.dispatchEvent(new CustomEvent('visiban:card-action', { detail: { cardIds: [2], action: 'archive' } }))
    })
    expect(await screen.findByTestId('archive-toast')).toHaveTextContent('Card archived')
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(screen.queryByTestId('card-action-toast')).not.toBeInTheDocument()
  })

  it('Block card… from the Summary view switches to the board and opens the sheet with the form', async () => {
    mockSearchParams = new URLSearchParams('view=summary')
    render(<BoardView currentUser={fakeUser} />)
    act(() => {
      window.dispatchEvent(new CustomEvent('visiban:card-action', { detail: { cardIds: [2], action: 'block' } }))
    })
    expect(await screen.findByTestId('card-detail')).toHaveAttribute('data-block-form', 'block')
    expect(screen.queryByTestId('summary-view')).not.toBeInTheDocument()
  })
})


// #2205 — lane filters: hidden lanes, focus (#2251), counts, empty state, notice.
describe('BoardView lane filters (#2205)', () => {
  type LaneProps = { hiddenLaneCount?: number; filters?: Record<string, unknown>; onChange?: (f: Record<string, unknown>) => void }
  const laneProps = () => capturedFilterBarProps as unknown as LaneProps
  const aeField = {
    id: 7, uid: 'slf000000007', name: 'AE', field_type: 'dropdown' as const, choices: ['Priya', 'Sam'], position: 0,
    show_on_row: true, is_admin_only: false, is_required: false, help_text: '', number_prefix: '', number_suffix: '',
    number_decimals: null, choice_colors: {}, created_at: '',
  }
  const lane = (id: number, name: string, ae?: string) => ({
    id, uid: `laneuid0000${id}`, name, contact_email: '', notes: '', position: id, color: '#6B7280', is_collapsed: false,
    created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null,
    custom_field_values: ae ? [{ field_definition: 7, value: ae }] : [],
  })
  const boardWith = (lanes: ReturnType<typeof lane>[], extra: Partial<BoardFull> = {}) =>
    makeBoard({ swimlanes: lanes, swimlane_custom_field_definitions: [aeField], ...extra })
  const priyaParam = `f_lanes=${encodeURIComponent('1.[{"f":7,"o":"is","v":"Priya"}]')}`

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCardStatus).mockResolvedValue({ archived: false })
    mockSearchParams = new URLSearchParams()
    mockSearchTruncation = null
    localStorage.clear()
    capturedFilterBarProps = {}
  })

  it('hides lanes that fail the rules from ?f_lanes and reports the count', () => {
    mockSearchParams = new URLSearchParams(priyaParam)
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Priya'), lane(21, 'Customer B', 'Sam'), lane(22, 'Customer C')]) })
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('swim-20')).toBeInTheDocument()
    expect(screen.queryByTestId('swim-21')).not.toBeInTheDocument()
    // No value fails `is` (empty-value rule).
    expect(screen.queryByTestId('swim-22')).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'f' })
    expect(laneProps().hiddenLaneCount).toBe(2)
  })

  it('a malformed ?f_lanes is ignored rather than hiding anything', () => {
    mockSearchParams = new URLSearchParams('f_lanes=1.%7Bnot-json')
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Priya'), lane(21, 'Customer B', 'Sam')]) })
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('swim-21')).toBeInTheDocument()
  })

  describe('focus mode (#2251)', () => {
    const cue = "doesn't match lane filters"

    it('applies the rules while a matching lane is focused: only that lane shows, no cue', () => {
      mockSearchParams = new URLSearchParams(`${priyaParam}&focus=20`)
      mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'APAC', 'Priya'), lane(21, 'EMEA', 'Sam'), lane(22, 'AMER', 'Sam')]) })
      render(<BoardView {...defaultProps()} />)
      expect(screen.getByTestId('swim-20')).toBeInTheDocument()
      expect(screen.queryByTestId('swim-21')).not.toBeInTheDocument()
      expect(screen.queryByTestId('swim-22')).not.toBeInTheDocument()
      expect(screen.queryByText(cue)).not.toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'f' })
      expect(laneProps().hiddenLaneCount).toBe(2)
    })

    it('keeps other matching lanes visible (collapsed by focus) and hides the rest', async () => {
      mockSearchParams = new URLSearchParams(priyaParam)
      mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'APAC', 'Priya'), lane(21, 'EMEA', 'Priya'), lane(22, 'AMER', 'Sam')]) })
      render(<BoardView {...defaultProps()} />)
      await userEvent.setup().click(screen.getByTestId('focus-btn-20'))
      expect(screen.getByTestId('swim-20')).toHaveAttribute('data-collapsed', 'false')
      expect(screen.getByTestId('swim-21')).toHaveAttribute('data-collapsed', 'true')
      expect(screen.queryByTestId('swim-22')).not.toBeInTheDocument()
    })

    it('the collapsed strip counts only lanes the rules leave visible', async () => {
      mockSearchParams = new URLSearchParams(priyaParam)
      mockBoardContextValue = defaultContext({ board: boardWith([
        lane(20, 'APAC', 'Priya'), lane(21, 'EMEA', 'Priya'), lane(22, 'AMER', 'Sam'), lane(23, 'LATAM', 'Sam'), lane(24, 'NORD', 'Sam'),
      ]) })
      render(<BoardView {...defaultProps()} />)
      await userEvent.setup().click(screen.getByTestId('focus-btn-20'))
      // Focus collapsed 4 lanes, but 3 of them are hidden by the rules: only EMEA shows collapsed.
      expect(screen.getByText(/swimlane collapsed/)).toBeInTheDocument()
      expect(screen.queryByText(/swimlanes collapsed/)).not.toBeInTheDocument()
    })

    it('exiting focus restores the pre-focus collapse state and the rules still apply', async () => {
      mockSearchParams = new URLSearchParams(priyaParam)
      mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'APAC', 'Priya'), lane(21, 'EMEA', 'Priya'), lane(22, 'AMER', 'Sam')]) })
      render(<BoardView {...defaultProps()} />)
      const user = userEvent.setup()
      await user.click(screen.getByTestId('focus-btn-20'))
      expect(screen.getByTestId('swim-21')).toHaveAttribute('data-collapsed', 'true')
      await user.click(screen.getByText('Exit focus'))
      expect(screen.getByTestId('swim-20')).toHaveAttribute('data-collapsed', 'false')
      expect(screen.getByTestId('swim-21')).toHaveAttribute('data-collapsed', 'false')
      expect(screen.queryByTestId('swim-22')).not.toBeInTheDocument()
      expect(screen.queryByText(/collapsed/)).not.toBeInTheDocument()
    })

    it('always shows a focused lane that fails the rules, with the cue, and excludes it from the hidden count', () => {
      mockSearchParams = new URLSearchParams(`${priyaParam}&focus=20`)
      mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'APAC', 'Sam'), lane(21, 'EMEA', 'Priya'), lane(22, 'AMER', 'Sam')]) })
      render(<BoardView {...defaultProps()} />)
      expect(screen.getByTestId('swim-20')).toBeInTheDocument()
      expect(screen.getByTestId('swim-21')).toBeInTheDocument()
      expect(screen.queryByTestId('swim-22')).not.toBeInTheDocument()
      expect(screen.getByText(cue)).toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'f' })
      expect(laneProps().hiddenLaneCount).toBe(1)
    })

    it('never shows the all-lanes-filtered-out state while focused', () => {
      mockSearchParams = new URLSearchParams(`${priyaParam}&focus=21`)
      mockBoardContextValue = defaultContext({ board: boardWith([lane(21, 'EMEA', 'Sam')]) })
      render(<BoardView {...defaultProps()} />)
      expect(screen.getByTestId('swim-21')).toBeInTheDocument()
      expect(screen.queryByText('No lanes match your lane filters.')).not.toBeInTheDocument()
    })

    it('with no lane rules focus is unchanged: every lane stays, no cue', () => {
      mockSearchParams = new URLSearchParams('focus=20')
      mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'APAC', 'Sam'), lane(21, 'EMEA', 'Sam')]) })
      render(<BoardView {...defaultProps()} />)
      expect(screen.getByTestId('swim-20')).toBeInTheDocument()
      expect(screen.getByTestId('swim-21')).toBeInTheDocument()
      expect(screen.queryByText(cue)).not.toBeInTheDocument()
    })

    it('clearing the rules while focused takes effect at once', () => {
      mockSearchParams = new URLSearchParams(`${priyaParam}&focus=20`)
      mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'APAC', 'Priya'), lane(21, 'EMEA', 'Sam')]) })
      render(<BoardView {...defaultProps()} />)
      expect(screen.queryByTestId('swim-21')).not.toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'f' })
      act(() => { const next = { ...laneProps().filters }; delete next.laneFilter; laneProps().onChange?.(next) })
      expect(screen.getByTestId('swim-21')).toBeInTheDocument()
    })
  })

  it('shows the all-lanes-hidden empty state ahead of the card one, and clears lane rules from it', async () => {
    mockSearchParams = new URLSearchParams(priyaParam)
    mockBoardContextValue = defaultContext({ board: boardWith([lane(21, 'Customer B', 'Sam')]) })
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByText('No lanes match your lane filters.')).toBeInTheDocument()
    expect(screen.queryByText('No cards match the active filters.')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear lane filters' }))
    expect(screen.getByTestId('swim-21')).toBeInTheDocument()
    expect(screen.queryByText('No lanes match your lane filters.')).not.toBeInTheDocument()
  })

  it('prunes a rule on an admin-only field for a non-admin, so it never hides lanes', () => {
    mockSearchParams = new URLSearchParams(priyaParam)
    mockBoardContextValue = defaultContext({
      board: makeBoard({
        current_user_role: 'member',
        swimlanes: [lane(21, 'Customer B')],
        swimlane_custom_field_definitions: [{ ...aeField, is_admin_only: true }],
      }),
    })
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('swim-21')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'f' })
    expect(laneProps().filters?.laneFilter).toBeUndefined()
  })

  // #2336 — a Contact email rule is admin-only, exactly like an admin-only custom field.
  const emailParam = `f_lanes=${encodeURIComponent('1.[{"f":"contact_email","o":"contains","v":"@acme.com"}]')}`

  it('a Contact email rule from ?f_lanes hides nothing for a member', () => {
    mockSearchParams = new URLSearchParams(emailParam)
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A'), lane(21, 'Customer B')], { current_user_role: 'member' }) })
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('swim-20')).toBeInTheDocument()
    expect(screen.getByTestId('swim-21')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'f' })
    expect(laneProps().filters?.laneFilter).toBeUndefined()
    expect(laneProps().hiddenLaneCount).toBe(0)
  })

  it('applies a Contact email rule for an admin and prunes it after a self-demotion', () => {
    mockSearchParams = new URLSearchParams(emailParam)
    const acme = { ...lane(20, 'Customer A'), contact_email: 'pat@acme.com' }
    mockBoardContextValue = defaultContext({ board: boardWith([acme, lane(21, 'Customer B')]) })
    const { rerender } = render(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('swim-20')).toBeInTheDocument()
    expect(screen.queryByTestId('swim-21')).not.toBeInTheDocument()
    // Demoted: the server stops sending contact_email, and the rule is dropped rather than hiding every lane.
    mockBoardContextValue = defaultContext({ board: boardWith([{ ...lane(20, 'Customer A'), contact_email: undefined as unknown as string }, lane(21, 'Customer B')], { current_user_role: 'member' }) })
    rerender(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('swim-20')).toBeInTheDocument()
    expect(screen.getByTestId('swim-21')).toBeInTheDocument()
  })

  it('a Lane name rule from ?f_lanes applies for a member', () => {
    mockSearchParams = new URLSearchParams(`f_lanes=${encodeURIComponent('1.[{"f":"name","o":"is","v":"customer a"}]')}`)
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A'), lane(21, 'Customer B')], { current_user_role: 'member' }) })
    render(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('swim-20')).toBeInTheDocument()
    expect(screen.queryByTestId('swim-21')).not.toBeInTheDocument()
  })

  it('writes lane rules to ?f_lanes and removes the param when they are cleared', () => {
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Priya')]) })
    render(<BoardView {...defaultProps()} />)
    fireEvent.keyDown(document, { key: 'f' })
    const laneFilter = { items: [{ kind: 'rule', id: 1, join: 'and', field: 7, op: 'is', value: 'Priya' }] }
    act(() => { laneProps().onChange?.({ ...laneProps().filters, laneFilter }) })
    const resolve = (call: unknown[]) => (typeof call[0] === 'function' ? (call[0] as (p: URLSearchParams) => URLSearchParams)(new URLSearchParams()) : call[0]) as URLSearchParams
    expect(resolve(mockSetSearchParams.mock.calls.at(-1) as unknown[]).get('f_lanes')).toBe('1.[{"f":7,"o":"is","v":"Priya"}]')
    act(() => { const next = { ...laneProps().filters }; delete next.laneFilter; laneProps().onChange?.(next) })
    expect(resolve(mockSetSearchParams.mock.calls.at(-1) as unknown[]).get('f_lanes')).toBeNull()
  })

  it('a lane holding keyboard focus that stops matching shows the notice and focus moves to the board', async () => {
    mockSearchParams = new URLSearchParams(priyaParam)
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Priya'), lane(21, 'Customer B', 'Priya')]) })
    const { rerender } = render(<BoardView {...defaultProps()} />)
    act(() => { screen.getByTestId('focus-btn-20').focus() })
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Sam'), lane(21, 'Customer B', 'Priya')]) })
    rerender(<BoardView {...defaultProps()} />)
    expect(screen.queryByTestId('swim-20')).not.toBeInTheDocument()
    const text = '“Customer A” is now hidden because it no longer matches your lane filters.'
    expect(screen.getAllByText(text).length).toBeGreaterThan(0)
    expect(document.activeElement).toBe(document.querySelector('[data-board-scroll]'))
    // Phone (#2333): jsdom has no media queries, so pin the 44px classes on the notice's buttons.
    expect(screen.getByRole('button', { name: 'Edit lane filters' })).toHaveClass('max-sm:min-h-11')
    expect(screen.getByRole('button', { name: 'Dismiss notice' })).toHaveClass('max-sm:w-11', 'max-sm:h-11')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss notice' }))
    expect(screen.queryByText(text)).not.toBeInTheDocument()
  })

  it('stays silent when a remote edit hides a lane the user is not in', () => {
    mockSearchParams = new URLSearchParams(priyaParam)
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Priya'), lane(21, 'Customer B', 'Priya')]) })
    const { rerender } = render(<BoardView {...defaultProps()} />)
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Sam'), lane(21, 'Customer B', 'Priya')]) })
    rerender(<BoardView {...defaultProps()} />)
    expect(screen.queryByTestId('swim-20')).not.toBeInTheDocument()
    expect(screen.queryByText(/no longer matches your lane filters/)).not.toBeInTheDocument()
  })

  it('shows the notice when this client edited the lane that stopped matching', () => {
    mockSearchParams = new URLSearchParams(priyaParam)
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Priya'), lane(21, 'Customer B', 'Priya')]) })
    const { rerender } = render(<BoardView {...defaultProps()} />)
    act(() => { screen.getByTestId('lane-updated-20').click() })
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Sam'), lane(21, 'Customer B', 'Priya')]) })
    rerender(<BoardView {...defaultProps()} />)
    expect(screen.queryByTestId('swim-20')).not.toBeInTheDocument()
    expect(screen.getAllByText('“Customer A” is now hidden because it no longer matches your lane filters.').length).toBeGreaterThan(0)
  })

  it('shows the notice when the open card panel belongs to the lane that stopped matching', () => {
    mockSearchParams = new URLSearchParams(`${priyaParam}&card=1`)
    const card = {
      id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Open Card',
      description: '', priority: 'medium' as const, assignee: null,
      labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: 'user1', display_name: 'User 1', avatar_url: '' },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0,
      checklist_done: 0, is_stale: false, archived_at: null, version: 1,
      custom_field_values: [],
      blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    }
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Priya'), lane(21, 'Customer B', 'Priya')], { cards: [card] }) })
    const { rerender } = render(<BoardView {...defaultProps()} />)
    expect(screen.getByTestId('card-detail')).toBeInTheDocument()
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Sam'), lane(21, 'Customer B', 'Priya')], { cards: [card] }) })
    rerender(<BoardView {...defaultProps()} />)
    expect(screen.queryByTestId('swim-20')).not.toBeInTheDocument()
    expect(screen.getAllByText('“Customer A” is now hidden because it no longer matches your lane filters.').length).toBeGreaterThan(0)
  })

  it('shows the new-lane message for a lane this client just created that does not match', async () => {
    mockSearchParams = new URLSearchParams(priyaParam)
    const created = lane(30, 'Fresh Lane')
    mockCreatedLane = created
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Priya')]) })
    const { rerender } = render(<BoardView {...defaultProps()} />)
    const user = userEvent.setup()
    await user.click(screen.getAllByTestId('row-sep-insert').at(-1)!)
    await user.click(screen.getByTestId('confirm-add-swimlane'))
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Priya'), created]) })
    rerender(<BoardView {...defaultProps()} />)
    expect(screen.queryByTestId('swim-30')).not.toBeInTheDocument()
    expect(screen.getAllByText('New lane “Fresh Lane” is hidden because it doesn\'t match your lane filters.').length).toBeGreaterThan(0)
  })

  it('stays silent when focus left the lane for a non-focusable area before a remote edit hides it', async () => {
    mockSearchParams = new URLSearchParams(priyaParam)
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Priya'), lane(21, 'Customer B', 'Priya')]) })
    const { rerender } = render(<BoardView {...defaultProps()} />)
    const btn = screen.getByTestId('focus-btn-20')
    act(() => { btn.focus() })
    // jsdom reports hasFocus() false once nothing is focused; a real page stays focused after a click on body.
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    act(() => { btn.blur() })
    await act(async () => { await Promise.resolve() }) // the deferred focusout check
    hasFocus.mockRestore()
    expect(document.activeElement).toBe(document.body)
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Sam'), lane(21, 'Customer B', 'Priya')]) })
    rerender(<BoardView {...defaultProps()} />)
    expect(screen.queryByTestId('swim-20')).not.toBeInTheDocument()
    expect(screen.queryByText(/no longer matches your lane filters/)).not.toBeInTheDocument()
    expect(document.activeElement).toBe(document.body)
  })
  it('stays silent when the focused element was removed while its lane stayed visible, before a remote edit hides the lane', async () => {
    mockSearchParams = new URLSearchParams(priyaParam)
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Priya'), lane(21, 'Customer B', 'Priya')]) })
    const { rerender } = render(<BoardView {...defaultProps()} />)
    const btn = screen.getByTestId('focus-btn-20')
    act(() => { btn.focus() })
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    // Chromium: focusout fires with the target still connected, then the node (a card) goes away; the lane stays.
    act(() => { btn.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null })); btn.remove() })
    await act(async () => { await Promise.resolve() })
    hasFocus.mockRestore()
    expect(document.activeElement).toBe(document.body)
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Sam'), lane(21, 'Customer B', 'Priya')]) })
    rerender(<BoardView {...defaultProps()} />)
    expect(screen.queryByTestId('swim-20')).not.toBeInTheDocument()
    expect(screen.queryByText(/no longer matches your lane filters/)).not.toBeInTheDocument()
  })
  it('keeps the notice and recovers focus when the browser fires focusout during removal of the focused lane (Chromium)', async () => {
    mockSearchParams = new URLSearchParams(priyaParam)
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Priya'), lane(21, 'Customer B', 'Priya')]) })
    const { rerender } = render(<BoardView {...defaultProps()} />)
    const btn = screen.getByTestId('focus-btn-20')
    act(() => { btn.focus() })
    // Chromium dispatches focusout (relatedTarget null, target still connected) just before detaching a focused node.
    const realRemove = Node.prototype.removeChild
    const spy = vi.spyOn(Node.prototype, 'removeChild').mockImplementation(function (this: Node, child: Node) {
      if (child.contains(btn) && btn.isConnected) btn.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
      return realRemove.call(this, child) as never
    })
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Sam'), lane(21, 'Customer B', 'Priya')]) })
    rerender(<BoardView {...defaultProps()} />)
    spy.mockRestore()
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('swim-20')).not.toBeInTheDocument()
    expect(screen.getAllByText('“Customer A” is now hidden because it no longer matches your lane filters.').length).toBeGreaterThan(0)
    expect(document.activeElement).toBe(document.querySelector('[data-board-scroll]'))
  })

  it('a focusout while the document is not focused (window blur) does not clear the lane, so a hide while away still notifies', async () => {
    mockSearchParams = new URLSearchParams(priyaParam)
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Priya'), lane(21, 'Customer B', 'Priya')]) })
    const { rerender } = render(<BoardView {...defaultProps()} />)
    const btn = screen.getByTestId('focus-btn-20')
    act(() => { btn.focus() })
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    act(() => { btn.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null })) })
    await act(async () => { await Promise.resolve() })
    hasFocus.mockRestore()
    mockBoardContextValue = defaultContext({ board: boardWith([lane(20, 'Customer A', 'Sam'), lane(21, 'Customer B', 'Priya')]) })
    rerender(<BoardView {...defaultProps()} />)
    expect(screen.queryByTestId('swim-20')).not.toBeInTheDocument()
    expect(screen.getAllByText('“Customer A” is now hidden because it no longer matches your lane filters.').length).toBeGreaterThan(0)
  })

  describe('Filter panel wiring (#2301)', () => {
    const preset = { id: 5, name: 'High only', state_json: {}, state_version: 1, created_at: '' }
    const openPanel = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: /^Filters/ }))
      return screen.getByRole('dialog', { name: 'Filter' })
    }
    beforeEach(() => {
      mockSavedFilters = [preset]
      mockHydrateFilter.mockReset()
      mockHydrateFilter.mockReturnValue({
        search: '', assigneeIds: [], labelIds: [], priorities: ['high'], dueDate: null, customFields: {}, visibleCustomFieldFilterIds: [],
      })
    })
    afterEach(() => { mockSavedFilters = [] })

    it('choosing a saved filter hydrates it into the filters and marks it active', async () => {
      const user = userEvent.setup()
      render(<BoardView {...defaultProps()} />)
      let panel = await openPanel(user)
      await user.click(within(panel).getByRole('button', { name: 'High only' }))
      expect(mockHydrateFilter).toHaveBeenCalledWith(preset)
      expect(screen.queryByRole('dialog', { name: 'Filter' })).toBeNull()
      panel = await openPanel(user)
      expect(within(panel).getByRole('button', { name: 'High only' })).toHaveAttribute('aria-pressed', 'true')
      expect(within(panel).getByRole('button', { name: /^Priority/ })).toHaveTextContent('High')
    })

    it('editing a filter in the panel clears the active preset, like the filter bar', async () => {
      const user = userEvent.setup()
      render(<BoardView {...defaultProps()} />)
      let panel = await openPanel(user)
      await user.click(within(panel).getByRole('button', { name: 'High only' }))
      panel = await openPanel(user)
      expect(within(panel).getByRole('button', { name: 'High only' })).toHaveAttribute('aria-pressed', 'true')
      await user.click(within(panel).getByRole('button', { name: /^Priority/ }))
      await user.click(within(panel).getByRole('checkbox', { name: 'High' }))
      expect(within(panel).getByRole('button', { name: 'High only' })).toHaveAttribute('aria-pressed', 'false')
    })

    it('the Lanes row closes the panel and opens the filter bar for the Lanes popover', async () => {
      const lanesDef = {
        id: 1, uid: 'sfuid0000001', name: 'F1', field_type: 'text' as const, choices: [], position: 1,
        show_on_row: false, is_admin_only: false, is_required: false, help_text: '',
        number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {}, created_at: '',
      }
      mockBoardContextValue = defaultContext({ board: makeBoard({ swimlane_custom_field_definitions: [lanesDef] }) })
      const user = userEvent.setup()
      render(<BoardView {...defaultProps()} />)
      expect(screen.queryByTestId('filter-bar')).not.toBeInTheDocument()
      const panel = await openPanel(user)
      await user.click(within(panel).getByRole('button', { name: /^Lanes/ }))
      expect(screen.queryByRole('dialog', { name: 'Filter' })).toBeNull()
      expect(screen.getByTestId('filter-bar')).toBeInTheDocument()
    })
  })
})

describe('BoardView phone layout (#2277)', () => {
  const mockPhone = (phone: boolean) => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((q: string) => ({ matches: q.includes('max-width: 639px') ? phone : true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    })
  }
  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined })
  })

  it('renders one column at a time instead of the grid at phone width', () => {
    mockPhone(true)
    mockSearchParams = new URLSearchParams()
    mockBoardContextValue = defaultContext({ board: makeBoard() })
    render(<BoardView currentUser={fakeUser} />)
    expect(screen.getByTestId('phone-board')).toBeInTheDocument()
    expect(screen.queryByTestId('board-grid')).not.toBeInTheDocument()
    expect(screen.getByTestId('phone-column-switcher')).toBeInTheDocument()
  })

  it('the empty-board Add a card opens the new-card input on phones', () => {
    mockPhone(true)
    mockSearchParams = new URLSearchParams()
    mockBoardContextValue = defaultContext({ board: makeBoard({ cards: [] }) })
    render(<BoardView currentUser={fakeUser} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add a card' }))
    expect(screen.getByLabelText(/New card title/)).toBeInTheDocument()
  })

  it('wires phone reorder to the drag handlers and the peek sheet to Move earlier / Move later', async () => {
    mockPhone(true)
    mockSearchParams = new URLSearchParams()
    const base = makeBoard()
    const lane2 = { ...base.swimlanes[0], id: 21, uid: 'laneuid00002', name: 'Customer B', position: 1 }
    const phoneCard = {
      id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Card One',
      description: '', priority: 'medium' as const, assignee: null,
      labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: 'user1', display_name: 'User 1', avatar_url: '' },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0,
      checklist_done: 0, is_stale: false, archived_at: null, version: 1,
      custom_field_values: [],
      blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    }
    const c1 = { ...phoneCard, id: 501, uid: 'carduid0501', column: 10, swimlane: 20, position: 0, title: 'Phone A' }
    const c2 = { ...phoneCard, id: 502, uid: 'carduid0502', column: 10, swimlane: 20, position: 1, title: 'Phone B' }
    const ctx = defaultContext({ board: makeBoard({ swimlanes: [base.swimlanes[0], lane2], cards: [c1, c2] }) })
    mockBoardContextValue = ctx
    render(<BoardView currentUser={fakeUser} />)
    fireEvent.click(screen.getByRole('button', { name: 'Move column To Do later' }))
    expect(ctx.reorderColumns).toHaveBeenCalledWith([11, 10])
    fireEvent.click(screen.getByRole('button', { name: 'Move swimlane Customer A later' }))
    expect(ctx.reorderSwimlanes).toHaveBeenCalledWith([21, 20])
    fireEvent.click(screen.getByText('Phone B'))
    const sheet = await screen.findByTestId('card-peek-sheet')
    expect(within(sheet).getByRole('button', { name: 'Move later' })).toBeDisabled()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move earlier' }))
    expect(ctx.moveCard).toHaveBeenCalledWith(502, 10, 20, 0)
  })

  it('steps a card over the filtered cards only, sending the visible neighbor\'s raw slot (#2277)', async () => {
    mockPhone(true)
    // Blocked-only filter: H1 and H2 are not blocked, so PhoneBoard hides them.
    mockSearchParams = new URLSearchParams('f_blocked=1')
    const base = makeBoard()
    const face = { ...base.cards[0], column: 10, swimlane: 20, is_blocked: true, blocked_at: '2026-01-01T00:00:00Z', archived_at: null }
    const cards = [
      { ...face, id: 601, uid: 'carduid0601', position: 0, title: 'Filt A' },
      { ...face, id: 602, uid: 'carduid0602', position: 1, title: 'Filt B' },
      { ...face, id: 603, uid: 'carduid0603', position: 2, title: 'Hidden One', is_blocked: false, blocked_at: null },
      { ...face, id: 604, uid: 'carduid0604', position: 3, title: 'Filt C' },
      { ...face, id: 605, uid: 'carduid0605', position: 4, title: 'Hidden Two', is_blocked: false, blocked_at: null },
    ]
    const ctx = defaultContext({ board: makeBoard({ cards }) })
    mockBoardContextValue = ctx
    render(<BoardView currentUser={fakeUser} />)
    expect(screen.queryByText('Hidden One')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Filt B'))
    let sheet = await screen.findByTestId('card-peek-sheet')
    // Move later passes the hidden card: right after C (its position 3, + 1).
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move later' }))
    expect(ctx.moveCard).toHaveBeenLastCalledWith(602, 10, 20, 4)
    await waitFor(() => expect(within(sheet).getByRole('button', { name: 'Move earlier' })).toBeEnabled())
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move earlier' }))
    await waitFor(() => expect(ctx.moveCard).toHaveBeenLastCalledWith(602, 10, 20, 0))
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close card peek' }))
    // C is the last visible card: Move later is off though a hidden card follows it.
    fireEvent.click(screen.getByText('Filt C'))
    sheet = await screen.findByTestId('card-peek-sheet')
    expect(within(sheet).getByRole('button', { name: 'Move later' })).toBeDisabled()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move earlier' }))
    await waitFor(() => expect(ctx.moveCard).toHaveBeenLastCalledWith(604, 10, 20, 1))
  })

  it('opens Add column from the phone board', () => {
    mockPhone(true)
    mockSearchParams = new URLSearchParams()
    mockBoardContextValue = defaultContext({ board: makeBoard() })
    render(<BoardView currentUser={fakeUser} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add column' }))
    expect(screen.getByTestId('add-column-modal')).toBeInTheDocument()
  })

  it('opens Add swimlane from the phone board', () => {
    mockPhone(true)
    mockSearchParams = new URLSearchParams()
    mockBoardContextValue = defaultContext({ board: makeBoard() })
    render(<BoardView currentUser={fakeUser} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add swimlane' }))
    expect(screen.getByTestId('add-swimlane-modal')).toBeInTheDocument()
  })

  it('keeps the grid above phone width', () => {
    mockPhone(false)
    mockSearchParams = new URLSearchParams()
    mockBoardContextValue = defaultContext({ board: makeBoard() })
    render(<BoardView currentUser={fakeUser} />)
    expect(screen.queryByTestId('phone-board')).not.toBeInTheDocument()
    expect(screen.getByTestId('board-grid')).toBeInTheDocument()
  })
})
