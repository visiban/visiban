/**
 * Board presets in the board view (#1146): the toolbar picker, `?preset=` links,
 * the board default, Modified / Reset / Undo, and the Classic byte-for-byte
 * guarantee.
 *
 * Unlike the other BoardView suites this one renders the real grid (SwimlaneRow,
 * BoardCell, CardItem), because the Classic guarantee is about what the card face
 * renders, and a double that only echoes props could not see a change there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardView from '../components/Board/BoardView'
import type { BoardFull, Card, User } from '../types'
import type { BoardContextType } from '../contexts/BoardContext'
import type { CollisionDetection } from '@dnd-kit/core'

const DENSITY_KEY = 'board:1:card-density-override'
const OVERLAY_KEY = 'board:1:grid-overlay'

let mockSearchParams = new URLSearchParams()
// Every URL the board was given, so a test can read the latest `?preset=`.
const urlHistory: URLSearchParams[] = []

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
  useDraggable: () => ({ setNodeRef: () => {}, attributes: {}, listeners: {}, transform: null, isDragging: false }),
  useDndContext: () => ({ active: null }),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  horizontalListSortingStrategy: {},
  verticalListSortingStrategy: {},
  rectSortingStrategy: {},
  arrayMove: vi.fn(),
  useSortable: () => ({ setNodeRef: () => {}, attributes: {}, listeners: {}, transform: null, transition: undefined, isDragging: false }),
}))

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/', search: '', hash: '', state: null, key: 'default' }),
  useSearchParams: () => {
    const [params, setParams] = React.useState<URLSearchParams>(() => new URLSearchParams(mockSearchParams))
    const setter = (next: URLSearchParams | Record<string, string> | ((prev: URLSearchParams) => URLSearchParams)) => {
      setParams((current) => {
        const resolved = typeof next === 'function'
          ? next(new URLSearchParams(current))
          : next instanceof URLSearchParams
            ? next
            : new URLSearchParams(next as Record<string, string>)
        const copy = new URLSearchParams(resolved)
        urlHistory.push(copy)
        return copy
      })
    }
    return [params, setter] as const
  },
  useNavigate: () => vi.fn(),
  MemoryRouter: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('../hooks/useBoardSocket', () => ({
  useBoardSocket: () => ({ connected: true, status: 'connected', lastEventAt: null, reconnectAttempt: 0 }),
}))
vi.mock('../hooks/useBoardPan', () => ({ useBoardPan: () => {} }))

let mockBoardContextValue: BoardContextType
vi.mock('../contexts/BoardContext', () => ({
  useBoardContext: () => mockBoardContextValue,
}))

vi.mock('../api/boards', () => ({
  exportBoardCsv: vi.fn(),
  exportBoardJson: vi.fn(),
  updateSwimlane: vi.fn(),
}))
vi.mock('../api/cards', () => ({ createCard: vi.fn(), updateCard: vi.fn() }))
vi.mock('../components/Board/SummaryView', () => ({ default: () => <div /> }))
vi.mock('../components/Board/AnalyticsView', () => ({ default: () => <div /> }))
vi.mock('../components/Card/CardDetail', () => ({ default: () => <div data-testid="card-detail" /> }))
vi.mock('../components/Board/AddColumnModal', () => ({ default: () => <div /> }))
vi.mock('../components/Swimlane/AddSwimlaneModal', () => ({ default: () => <div /> }))
vi.mock('../components/Board/BoardSettingsModal', () => ({ default: () => <div data-testid="settings-modal" /> }))
vi.mock('../components/Board/FilterBar', () => ({
  default: () => <div data-testid="filter-bar" />,
  EMPTY_FILTER: { search: '', assigneeIds: [], labelIds: [], priorities: [], dueDate: null, customFields: {}, visibleCustomFieldFilterIds: [] },
  countActiveFilters: () => 0,
  isCustomFieldFilterActive: () => false,
}))
vi.mock('../components/Board/KeyboardShortcutsOverlay', () => ({ default: () => <div /> }))
vi.mock('../components/Common/Tooltip', () => ({
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for Tooltip's loosely-typed children prop, see Tooltip.tsx */
  default: ({ children }: { content: string; children: React.ReactElement<any> }) => children,
}))
vi.mock('../components/Board/BulkActionToolbar', () => ({ default: () => <div /> }))
vi.mock('../components/Board/ArchivedCardsPanel', () => ({ default: () => <div /> }))
vi.mock('../hooks/useSavedFilters', () => ({
  useSavedFilters: () => ({ savedFilters: [], loading: false, saveFilter: vi.fn(), removeFilter: vi.fn(), hydrateFilter: vi.fn() }),
}))
vi.mock('../components/Board/MovementHistoryView', () => ({ default: () => <div /> }))

// ---------------------------------------------------------------------------
// Fixtures — fixed dates and a pinned clock, so the card face is deterministic.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-06-15T12:00:00Z')

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false, has_usable_password: true,
  has_completed_tour: true,
}

function makeCard(id: number, overrides: Partial<Card> = {}): Card {
  return {
    id, uid: `carduid0000${id}`, column: 10, swimlane: 20, title: `Card ${id}`, description: '',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: id, created_by: fakeUser, created_at: '2026-06-14T12:00:00Z', updated_at: '2026-06-14T12:00:00Z',
    last_moved_at: '2026-06-14T12:00:00Z',
    attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false,
    archived_at: null, version: 1, custom_field_values: [], blocker_count: 0, external_ref: null,
    is_blocked: false, blocked_at: null, blocked_reason: '',
    ...overrides,
  }
}

const CARDS: Card[] = [
  makeCard(1, { assignee: fakeUser, weight: 5, attachment_count: 2, checklist_total: 3, checklist_done: 1, due_date: '2026-07-30', priority: 'high' }),
  makeCard(2, { due_date: '2026-06-16', labels: [{ id: 1, uid: 'labeluid0001', name: 'Bug', color: '#ef4444' }, { id: 2, uid: 'labeluid0002', name: 'UI', color: '#3b82f6' }, { id: 3, uid: 'labeluid0003', name: 'Ops', color: '#10b981' }] }),
  makeCard(3, { column: 11, description: 'Has a description', priority: 'low' }),
]

function makeBoard(overrides: Partial<BoardFull> = {}): BoardFull {
  return {
    health_status: null, effective_health_status: null, health_status_source: null, default_preset: null,
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0,
    columns: [
      { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
      { id: 11, uid: 'coluid000002', name: 'Doing', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
    ],
    swimlanes: [
      { id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null },
    ],
    cards: CARDS,
    labels: [],
    members: [{ id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7,
    stale_warning_pct: 50,
    allowed_priorities: ['low', 'medium', 'high', 'critical'] as BoardFull['allowed_priorities'],
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

function context(board: BoardFull): BoardContextType {
  const fn = () => vi.fn()
  return {
    board, loading: false, error: null, reload: fn(), silentReload: fn(),
    moveCard: fn(), forceMoveCard: fn(), forceMoveCardTo: fn(), moveError: null, clearMoveError: fn(),
    addCard: fn(), removeCard: fn(), archiveCard: fn(), archiveCardByUid: fn(), unarchiveCard: fn(),
    addColumn: fn(), removeColumn: fn(), addSwimlane: fn(), updateCard: fn(), updateColumn: fn(),
    addLabel: fn(), updateLabel: fn(), removeLabel: fn(), applyCustomFieldDefinitions: fn(),
    applySwimlaneFieldDefinitions: fn(), addMember: fn(), updateMember: fn(), removeMember: fn(),
    applyColumnOrder: fn(), applySwimlaneOrder: fn(), reorderColumns: fn(), reorderSwimlanes: fn(),
    updateSwimlane: fn(), removeSwimlane: fn(), updateBoardSettings: fn(), evictColumn: fn(),
    evictSwimlane: fn(), evictCardByUid: fn(), mergeBoardState: fn(),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The board grid's markup: everything the cards and cells render, no toolbar.
 * React `useId` values depend on how many components mounted before in the test
 * process, so they are normalized; nothing else is.
 */
function gridHtml(): string {
  return screen.getByRole('region', { name: 'Board' }).innerHTML.replace(/_r_[0-9a-z]+_/g, '_r_ID_')
}

function renderBoard(board: BoardFull = makeBoard(), search = '') {
  mockSearchParams = new URLSearchParams(search)
  mockBoardContextValue = context(board)
  return render(<BoardView />)
}

function presetTrigger(): HTMLElement {
  return screen.getByRole('button', { name: /^Preset(:|$)/ })
}

function latestPresetParam(): string | null {
  const last = urlHistory[urlHistory.length - 1]
  return last ? last.get('preset') : mockSearchParams.get('preset')
}

async function choosePreset(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(presetTrigger())
  await user.click(screen.getByRole('menuitemradio', { name: (accessibleName) => accessibleName.startsWith(name) }))
}

async function chooseOverlay(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: /^Overlay$|^Card count$/ }))
  await user.click(screen.getByRole('menuitem', { name }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BoardView — board presets (#1146)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
    localStorage.clear()
    urlHistory.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('Classic reproduces current behavior byte for byte', () => {
    it('renders the same grid as a board with no preset, and matches the pinned snapshot', () => {
      const { unmount } = renderBoard()
      const baseline = gridHtml()
      unmount()

      // A member who had personal settings opens a Classic link.
      localStorage.setItem(DENSITY_KEY, 'dense')
      localStorage.setItem(OVERLAY_KEY, 'card-count')
      renderBoard(makeBoard(), 'preset=classic')
      const classic = gridHtml()

      expect(classic).toBe(baseline)
      // Pinned: a change to the card face that reaches Classic (e.g. #871's
      // redesign applied to every board) fails here and must be gated out of
      // Classic instead.
      expect(classic).toMatchSnapshot()
    })

    it('renders the same grid for each board density', () => {
      for (const card_density of ['comfortable', 'standard', 'dense'] as const) {
        const { unmount } = renderBoard(makeBoard({ card_density }))
        const baseline = gridHtml()
        unmount()
        localStorage.setItem(DENSITY_KEY, card_density === 'dense' ? 'comfortable' : 'dense')
        const again = renderBoard(makeBoard({ card_density }), 'preset=classic')
        expect(gridHtml()).toBe(baseline)
        again.unmount()
        localStorage.clear()
      }
    })

    it('is sensitive: Default renders a different grid on a comfortable board', () => {
      const { unmount } = renderBoard()
      const baseline = gridHtml()
      unmount()
      renderBoard(makeBoard(), 'preset=default')
      expect(gridHtml()).not.toBe(baseline)
    })

    it('a board with no default and no link writes nothing and shows the trigger at rest', () => {
      renderBoard()
      expect(presetTrigger()).toHaveAccessibleName('Preset')
      expect(presetTrigger()).toHaveTextContent(/^Preset$/)
      expect(localStorage.getItem(DENSITY_KEY)).toBeNull()
      expect(localStorage.getItem(OVERLAY_KEY)).toBeNull()
    })
  })

  describe('picker', () => {
    it('lists Classic and Default with their summaries, and tags the board default', async () => {
      const user = userEvent.setup()
      renderBoard(makeBoard({ default_preset: 'default' }))
      await user.click(presetTrigger())
      const items = screen.getAllByRole('menuitemradio').map((i) => i.textContent)
      expect(items).toEqual([
        'ClassicBoard density · No overlay',
        'DefaultBoard default · Standard density · No overlay',
      ])
      // The active preset is exposed to assistive tech, not color-only.
      expect(screen.getByRole('menuitemradio', { name: /^Default/ })).toHaveAttribute('aria-checked', 'true')
      expect(screen.getByRole('menuitemradio', { name: /^Classic/ })).toHaveAttribute('aria-checked', 'false')
    })

    it('offers the notice Undo as a menu action, for keyboard users', async () => {
      const user = userEvent.setup()
      renderBoard()
      await choosePreset(user, 'Default')
      await user.click(presetTrigger())
      await user.click(screen.getByRole('menuitem', { name: 'Undo: Applied \u201cDefault\u201d' }))
      expect(localStorage.getItem(DENSITY_KEY)).toBeNull()
      expect(presetTrigger()).toHaveAccessibleName('Preset')
      expect(screen.queryByTestId('preset-notice')).not.toBeInTheDocument()
      // Gone from the menu once the notice is.
      await user.click(presetTrigger())
      expect(screen.queryByRole('menuitem', { name: /^Undo/ })).not.toBeInTheDocument()
    })

    it('returns focus to the picker after Undo or dismiss in the notice', async () => {
      const user = userEvent.setup()
      renderBoard()
      await choosePreset(user, 'Default')
      await user.click(within(screen.getByTestId('preset-notice')).getByRole('button', { name: 'Undo' }))
      expect(presetTrigger()).toHaveFocus()
      await choosePreset(user, 'Classic')
      await user.click(screen.getByRole('button', { name: 'Dismiss notification' }))
      expect(presetTrigger()).toHaveFocus()
    })

    it('describes the menu with what changed', async () => {
      const user = userEvent.setup()
      renderBoard()
      await choosePreset(user, 'Default')
      await chooseOverlay(user, 'Card count')
      await user.click(presetTrigger())
      expect(screen.getByRole('menu')).toHaveAccessibleDescription(/Modified from \u201cDefault\u201d.*Overlay: Card count/)
    })

    it('applying a preset writes the per-user keys, sets ?preset=, and offers Undo', async () => {
      const user = userEvent.setup()
      renderBoard()
      await choosePreset(user, 'Default')
      expect(localStorage.getItem(DENSITY_KEY)).toBe('standard')
      expect(localStorage.getItem(OVERLAY_KEY)).toBe('none')
      expect(latestPresetParam()).toBe('default')
      expect(presetTrigger()).toHaveAccessibleName('Preset: Default')
      const notice = screen.getByTestId('preset-notice')
      expect(notice).toHaveTextContent('Applied “Default”')

      await user.click(within(notice).getByRole('button', { name: 'Undo' }))
      expect(localStorage.getItem(DENSITY_KEY)).toBeNull()
      expect(localStorage.getItem(OVERLAY_KEY)).toBeNull()
      expect(latestPresetParam()).toBeNull()
      expect(presetTrigger()).toHaveAccessibleName('Preset')
      expect(screen.queryByTestId('preset-notice')).not.toBeInTheDocument()
    })

    it('choosing the active, unmodified preset again does nothing', async () => {
      const user = userEvent.setup()
      renderBoard(makeBoard({ default_preset: 'default' }))
      await choosePreset(user, 'Default')
      expect(screen.queryByTestId('preset-notice')).not.toBeInTheDocument()
      expect(localStorage.getItem(DENSITY_KEY)).toBeNull()
    })

    it('the notice can be dismissed', async () => {
      const user = userEvent.setup()
      renderBoard()
      await choosePreset(user, 'Classic')
      await user.click(screen.getByRole('button', { name: 'Dismiss notification' }))
      expect(screen.queryByTestId('preset-notice')).not.toBeInTheDocument()
    })
  })

  describe('Modified and Reset', () => {
    it('marks the preset Modified, lists what changed, and Reset restores it', async () => {
      const user = userEvent.setup()
      renderBoard()
      await choosePreset(user, 'Default')
      await chooseOverlay(user, 'Card count')

      expect(presetTrigger()).toHaveAccessibleName('Preset: Default, modified')
      expect(screen.getByTestId('preset-modified-tag')).toHaveTextContent('Modified')
      // The link no longer describes the board, so it is dropped.
      expect(latestPresetParam()).toBeNull()

      await user.click(presetTrigger())
      expect(screen.getByText('Modified from “Default”')).toBeInTheDocument()
      expect(screen.getByText('Overlay: Card count (preset: No overlay)')).toBeInTheDocument()
      await user.click(screen.getByRole('menuitem', { name: 'Reset to “Default”' }))

      expect(localStorage.getItem(OVERLAY_KEY)).toBe('none')
      expect(presetTrigger()).toHaveAccessibleName('Preset: Default')
      expect(screen.queryByTestId('preset-modified-tag')).not.toBeInTheDocument()
      expect(screen.getByTestId('preset-notice')).toHaveTextContent('Reset to “Default”')
      expect(latestPresetParam()).toBe('default')

      // Undo brings the modification back.
      await user.click(screen.getByRole('button', { name: 'Undo' }))
      expect(localStorage.getItem(OVERLAY_KEY)).toBe('card-count')
      expect(presetTrigger()).toHaveAccessibleName('Preset: Default, modified')
    })

    it('choosing the modified preset again resets it', async () => {
      const user = userEvent.setup()
      renderBoard()
      await choosePreset(user, 'Classic')
      await chooseOverlay(user, 'Card count')
      await choosePreset(user, 'Classic')
      expect(localStorage.getItem(OVERLAY_KEY)).toBe('none')
      expect(screen.getByTestId('preset-notice')).toHaveTextContent('Reset to “Classic”')
    })

    it('the Reset menu item is keyboard reachable with the arrow keys', async () => {
      const user = userEvent.setup()
      renderBoard()
      await choosePreset(user, 'Default')
      await chooseOverlay(user, 'Card count')
      presetTrigger().focus()
      await user.keyboard('{Enter}')
      await user.keyboard('{ArrowDown}')
      expect(screen.getByRole('menuitem', { name: 'Reset to “Default”' })).toHaveFocus()
      await user.keyboard('{End}')
      expect(screen.getByRole('menuitemradio', { name: /^Default/ })).toHaveFocus()
      await user.keyboard('{Home}')
      expect(screen.getByRole('menuitem', { name: 'Reset to “Default”' })).toHaveFocus()
    })
  })

  describe('precedence: ?preset= > member > board default', () => {
    it('a board default applies to a member with no keys, without writing any', () => {
      renderBoard(makeBoard({ default_preset: 'default' }))
      expect(presetTrigger()).toHaveAccessibleName('Preset: Default')
      expect(localStorage.getItem(DENSITY_KEY)).toBeNull()
    })

    it('a board default renders exactly what applying that preset renders', () => {
      const { unmount } = renderBoard(makeBoard(), 'preset=default')
      const applied = gridHtml()
      unmount()
      localStorage.clear()
      renderBoard(makeBoard({ default_preset: 'default' }))
      expect(gridHtml()).toBe(applied)
    })

    it("a member's own density beats the board default, which then reads as modified", () => {
      localStorage.setItem(DENSITY_KEY, 'dense')
      const { unmount } = renderBoard(makeBoard({ card_density: 'dense' }))
      const dense = gridHtml()
      unmount()
      renderBoard(makeBoard({ card_density: 'comfortable', default_preset: 'default' }))
      expect(gridHtml()).toBe(dense)
      expect(presetTrigger()).toHaveAccessibleName('Preset: Default, modified')
    })

    it('a ?preset= link beats both the member keys and the board default', () => {
      localStorage.setItem(DENSITY_KEY, 'dense')
      localStorage.setItem(OVERLAY_KEY, 'card-count')
      renderBoard(makeBoard({ default_preset: 'default' }), 'preset=classic')
      expect(presetTrigger()).toHaveAccessibleName('Preset: Classic')
      // Classic over a Standard board default pins the board's own density.
      expect(localStorage.getItem(DENSITY_KEY)).toBe('comfortable')
      expect(localStorage.getItem(OVERLAY_KEY)).toBe('none')
    })

    it('names the preset a member applied in an earlier visit', () => {
      localStorage.setItem(DENSITY_KEY, 'standard')
      localStorage.setItem(OVERLAY_KEY, 'none')
      renderBoard()
      expect(presetTrigger()).toHaveAccessibleName('Preset: Default')
    })

    it('ignores an unknown ?preset= value', () => {
      renderBoard(makeBoard(), 'preset=standup')
      expect(presetTrigger()).toHaveAccessibleName('Preset')
      expect(localStorage.getItem(DENSITY_KEY)).toBeNull()
      expect(localStorage.getItem(OVERLAY_KEY)).toBeNull()
    })

    it('follows a board default changed by another admin while open', () => {
      const view = renderBoard()
      expect(presetTrigger()).toHaveAccessibleName('Preset')
      act(() => {
        mockBoardContextValue = context(makeBoard({ default_preset: 'default' }))
      })
      view.rerender(<BoardView />)
      expect(presetTrigger()).toHaveAccessibleName('Preset: Default')
    })
  })
})
