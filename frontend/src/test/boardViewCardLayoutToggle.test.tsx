/**
 * Tests for the card layout toggle button in BoardView (#626).
 * Covers rendering, toggle behaviour, aria-pressed state, and tooltip text.
 *
 * These tests reuse the same mock infrastructure as boardView.test.tsx but live
 * in their own file to keep the card-layout concern isolated and easy to locate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
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
}))

vi.mock('../hooks/useBoardSocket', () => ({
  useBoardSocket: () => ({ connected: true, status: 'connected' }),
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
  EMPTY_FILTER: { search: '', assigneeIds: [], labelIds: [], priorities: [], dueDate: null },
  countActiveFilters: () => 0,
}))
vi.mock('../components/Board/KeyboardShortcutsOverlay', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="shortcuts-overlay"><button onClick={onClose}>Close Shortcuts</button></div>
  ),
}))
vi.mock('../components/Common/Tooltip', () => ({
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
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
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false,
    is_starred: false,
    created_at: '', updated_at: '',
    current_user_role: 'admin',
    owner: fakeUser,
    capabilities: { movement_export: false },
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
// Helper: find the layout toggle button by its aria-label attribute
// ---------------------------------------------------------------------------
function getToggleButton(): HTMLElement {
  // In expanded state the label is "Switch to compact card layout";
  // in compact state it is "Switch to expanded card layout".
  return (
    screen.queryByLabelText('Switch to compact card layout') ??
    screen.getByLabelText('Switch to expanded card layout')
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BoardView — card layout toggle button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSearchParams = new URLSearchParams()
    localStorage.clear()
    mockBoardContextValue = defaultContext()
  })

  it('renders the layout toggle button in the toolbar', () => {
    render(<BoardView />)
    expect(getToggleButton()).toBeInTheDocument()
  })

  it('starts in expanded mode (aria-pressed=false) by default', () => {
    render(<BoardView />)
    expect(getToggleButton()).toHaveAttribute('aria-pressed', 'false')
  })

  it('starts in compact mode (aria-pressed=true) when localStorage has compact', () => {
    localStorage.setItem(LAYOUT_KEY, 'compact')
    render(<BoardView />)
    expect(getToggleButton()).toHaveAttribute('aria-pressed', 'true')
  })

  it('aria-label is "Switch to compact card layout" in expanded mode', () => {
    render(<BoardView />)
    expect(screen.getByLabelText('Switch to compact card layout')).toBeInTheDocument()
  })

  it('aria-label is "Switch to expanded card layout" when in compact mode', () => {
    localStorage.setItem(LAYOUT_KEY, 'compact')
    render(<BoardView />)
    expect(screen.getByLabelText('Switch to expanded card layout')).toBeInTheDocument()
  })

  it('clicking the toggle switches from expanded to compact', async () => {
    render(<BoardView />)
    const btn = getToggleButton()
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    await userEvent.setup().click(btn)
    expect(getToggleButton()).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking the toggle twice returns to expanded', async () => {
    render(<BoardView />)
    const user = userEvent.setup()
    await user.click(getToggleButton())
    await user.click(getToggleButton())
    expect(getToggleButton()).toHaveAttribute('aria-pressed', 'false')
  })

  it('toggling to compact persists compact to localStorage', async () => {
    render(<BoardView />)
    await userEvent.setup().click(getToggleButton())
    expect(localStorage.getItem(LAYOUT_KEY)).toBe('compact')
  })

  it('toggling back to expanded persists expanded to localStorage', async () => {
    localStorage.setItem(LAYOUT_KEY, 'compact')
    render(<BoardView />)
    await userEvent.setup().click(getToggleButton())
    expect(localStorage.getItem(LAYOUT_KEY)).toBe('expanded')
  })

  it('tooltip text updates to "Switch to expanded card layout" after switching to compact', async () => {
    render(<BoardView />)
    await userEvent.setup().click(getToggleButton())
    expect(getToggleButton().getAttribute('data-tooltip')).toBe('Switch to expanded card layout')
  })

  it('tooltip text updates to "Switch to compact card layout" after switching back to expanded', async () => {
    localStorage.setItem(LAYOUT_KEY, 'compact')
    render(<BoardView />)
    await userEvent.setup().click(getToggleButton())
    expect(getToggleButton().getAttribute('data-tooltip')).toBe('Switch to compact card layout')
  })

  it('toggle button is accessible by its aria-label', () => {
    render(<BoardView />)
    const btn = screen.getByLabelText('Switch to compact card layout')
    expect(btn.tagName).toBe('BUTTON')
  })

  it('compact mode propagates to swimlane rows via data-compact attribute', async () => {
    render(<BoardView />)
    // Expanded by default
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-compact', 'false')
    await userEvent.setup().click(getToggleButton())
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-compact', 'true')
  })

  it('returning to expanded mode propagates to swimlane rows', async () => {
    localStorage.setItem(LAYOUT_KEY, 'compact')
    render(<BoardView />)
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-compact', 'true')
    await userEvent.setup().click(getToggleButton())
    expect(screen.getByTestId('swim-20')).toHaveAttribute('data-compact', 'false')
  })
})
