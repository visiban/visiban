/**
 * Board presets in the board view (#1146): the toolbar picker, `?preset=` links,
 * the board default, Modified / Reset / Undo, and the `classic` id resolving to
 * the redesigned board (#2279).
 *
 * Unlike the other BoardView suites this one renders the real grid (SwimlaneRow,
 * BoardCell, CardItem), because "classic shows the redesigned board" is about what
 * the card face renders, and a double that only echoes props could not see it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ToastProvider } from '../contexts/ToastContext'
import React from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardView from '../components/Board/BoardView'
import type { BoardFull, Card, User, CustomFieldDefinition } from '../types'
import type { BoardContextType } from '../contexts/BoardContext'
import type { CollisionDetection } from '@dnd-kit/core'

const DENSITY_KEY = 'board:1:card-density-override'
const OVERLAY_KEY = 'board:1:grid-overlay'
const MARKER_KEY = 'board:1:preset'

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
vi.mock('../components/Board/BoardSettingsModal', () => ({
  default: ({ densityPresetSource }: { densityPresetSource?: unknown }) => (
    <div data-testid="settings-modal" data-density-source={JSON.stringify(densityPresetSource ?? null)} />
  ),
}))
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
vi.mock('../api/gitLens', () => ({ getLensConnection: vi.fn(() => Promise.resolve({ id: 1, provider: 'gitlab', repo_slug: 'acme/widgets' })) }))
vi.mock('../components/Board/Lens/LensView', () => ({ default: () => <div data-testid="lens-view" /> }))
vi.mock('../components/Board/Lens/LensToolbar', () => ({ default: () => <div /> }))

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
    health_status: null, effective_health_status: null, health_status_source: null, health_status_changed_at: null, health_status_changed_by: null, health_status_note: null, health_review_days: null, health_review_due_at: null, health_auto_enabled: false, health_off_track_cards: 3, computed_health_status: null, health_computed_at: null, health_computed_counts: null, health_status_origin: null, default_preset: null,
    swimlane_rollup_field: null,
    commitment_column_uid: null,
    cards_can_have_children: false,
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0,
    columns: [
      { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
      { id: 11, uid: 'coluid000002', name: 'Doing', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
    ],
    swimlanes: [
      { id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null },
    ],
    cards: CARDS,
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
  // Attribute order follows when an attribute was first set (a title that appears after the
  // density settles lands last), so normalize it: only the attribute values matter here.
  const root = screen.getByRole('region', { name: 'Board' }).cloneNode(true) as HTMLElement
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const attrs = Array.from(el.attributes).map((a) => [a.name, a.value] as const).sort(([a], [b]) => a.localeCompare(b))
    for (const [n] of attrs) el.removeAttribute(n)
    for (const [n, v] of attrs) el.setAttribute(n, v)
  }
  return root.innerHTML.replace(/_r_[0-9a-z]+_/g, '_r_ID_')
}

function renderBoard(board: BoardFull = makeBoard(), search = '', currentUser: User | null = null) {
  mockSearchParams = new URLSearchParams(search)
  mockBoardContextValue = context(board)
  return render(<ToastProvider><BoardView currentUser={currentUser} /></ToastProvider>)
}

// The Preset picker lives in the View menu (#2269): open it on first use.
function openViewMenu() {
  if (!screen.queryByTestId('view-menu-panel')) {
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
  }
}

function presetTrigger(): HTMLElement {
  openViewMenu()
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
  openViewMenu()
  await user.click(screen.getByRole('button', { name: /^Overlay: / }))
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

  describe('the classic id resolves to the redesigned board (#2279)', () => {
    // There is no Classic rendering: the id stays accepted in links and Board.default_preset,
    // and the board it names is the same grid a board with no preset renders. The per-density
    // visual baseline is the Playwright screenshot spec (e2e/board-redesign.spec.ts).
    for (const card_density of ['comfortable', 'standard', 'dense'] as const) {
      it(`a ?preset=classic link on a ${card_density} board renders the same grid as no preset`, () => {
        const { unmount } = renderBoard(makeBoard({ card_density }))
        const baseline = gridHtml()
        unmount()

        // A member who had personal settings opens a link naming classic.
        localStorage.setItem(DENSITY_KEY, card_density === 'dense' ? 'comfortable' : 'dense')
        localStorage.setItem(OVERLAY_KEY, 'card-count')
        renderBoard(makeBoard({ card_density }), 'preset=classic')
        expect(gridHtml()).toBe(baseline)
      })
    }

    it('a link naming classic loads without error and shows the redesigned card face', () => {
      renderBoard(makeBoard({ card_density: 'standard' }), 'preset=classic')
      expect(presetTrigger()).toHaveAccessibleName('Preset: Classic')
      const badge = screen.getAllByTitle('Due 2026-06-16')[0]
      expect(badge.textContent).toBe('Due tomorrow')
      expect(badge.textContent).not.toContain('⏱')
      expect(badge.querySelector('svg[data-testid="urgency-glyph-due-soon-flag"]')).not.toBeNull()
    })

    it('a board whose default preset is classic loads and shows the redesigned card face', () => {
      renderBoard(makeBoard({ card_density: 'standard', default_preset: 'classic' }))
      expect(presetTrigger()).toHaveAccessibleName('Preset: Classic')
      expect(screen.getAllByTitle('Due 2026-06-16')[0].querySelector('svg[data-testid="urgency-glyph-due-soon-flag"]')).not.toBeNull()
    })

    // #2271: the swimlane band shows the first two lane fields at every density and
    // folds the rest behind the N fields toggle, for every preset (the redesign replaces the grid for every
    // preset, so the old #1417 density-following chip cap no longer exists).
    describe('swimlane band fields (#2271)', () => {
      const defs = Array.from({ length: 6 }, (_, i) => ({
        id: i + 1, uid: `sfuid00000${i + 1}`, name: `Pin${i + 1}`, field_type: 'text' as const, choices: [], position: i,
        show_on_row: true, is_admin_only: false, is_required: false, help_text: '',
        number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {}, created_at: '2026-01-01',
      }))
      const pinnedBoard = (card_density: 'comfortable' | 'standard' | 'dense') => {
        const base = makeBoard({ card_density })
        return makeBoard({
          card_density,
          swimlane_custom_field_definitions: defs,
          swimlanes: [{ ...base.swimlanes[0], custom_field_values: defs.map((d) => ({ field_definition: d.id, value: `val${d.id}` })) }],
        })
      }
      it.each(['comfortable', 'standard', 'dense'] as const)('Classic %s shows 2 of 6 fields and a 6 fields toggle', (card_density) => {
        renderBoard(pinnedBoard(card_density), 'preset=classic')
        expect(screen.queryAllByText(/^val\d$/)).toHaveLength(2)
        expect(screen.getByRole('button', { name: '6 fields: show all field values for Customer A' })).toBeInTheDocument()
      })
    })

    // #1122: threshold marks render under every preset, classic included, so a mark's
    // meaning never depends on the viewer's preset.
    it('renders custom-field threshold marks under classic (#1122)', () => {
      const spend: CustomFieldDefinition = {
        id: 77, uid: 'cfuid077', name: 'Spend', field_type: 'number', choices: [], position: 0,
        show_on_card: true, is_required: false, help_text: '', number_prefix: '', number_suffix: '',
        number_decimals: null, choice_colors: {}, threshold_direction: 'above', threshold_warn: 5,
        threshold_alert: 8, threshold_warn_days: null, threshold_alert_days: null, created_at: '',
      }
      const marked = makeCard(901, { custom_field_values: [{ field_definition: 77, value: '9' }] })
      renderBoard(makeBoard({ custom_field_definitions: [spend], cards: [marked] }), 'preset=classic')
      const chip = document.querySelector('[data-threshold-level="alert"]')
      expect(chip).not.toBeNull()
      expect(chip!.querySelector('svg[data-threshold-mark="alert"]')).not.toBeNull()
    })

    it('is sensitive: Default renders a different grid on a comfortable board', () => {
      const { unmount } = renderBoard()
      const baseline = gridHtml()
      unmount()
      renderBoard(makeBoard(), 'preset=default')
      expect(gridHtml()).not.toBe(baseline)
    })

    it('the urgency face is the redesigned one under Default and under no preset', () => {
      const badge = () => screen.getAllByTitle('Due 2026-06-16')[0]
      for (const search of ['', 'preset=default']) {
        const { unmount } = renderBoard(makeBoard({ card_density: 'standard' }), search)
        expect(badge().textContent, search || 'no preset').toBe('Due tomorrow')
        expect(badge().className).toContain('text-fg-secondary')
        expect(badge().querySelector('svg[data-testid="urgency-glyph-due-soon-flag"]')).not.toBeNull()
        unmount()
        localStorage.clear()
      }
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
      // The picker lives in the View menu (#2269), so focus returns to its button.
      expect(screen.getByRole('button', { name: 'View' })).toHaveFocus()
      await choosePreset(user, 'Classic')
      await user.click(screen.getByRole('button', { name: 'Dismiss notification' }))
      expect(screen.getByRole('button', { name: 'View' })).toHaveFocus()
    })

    it('returns focus to the Filter button on phones, where View is hidden (#2344)', async () => {
      const user = userEvent.setup()
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: vi.fn((q: string) => ({ matches: q.includes('max-width: 639px'), addEventListener: vi.fn(), removeEventListener: vi.fn() })),
      })
      try {
        renderBoard()
        await choosePreset(user, 'Default')
        await user.click(within(screen.getByTestId('preset-notice')).getByRole('button', { name: 'Undo' }))
        expect(screen.getByRole('button', { name: /^Filters and view options/ })).toHaveFocus()
        await choosePreset(user, 'Classic')
        await user.click(screen.getByRole('button', { name: 'Dismiss notification' }))
        expect(screen.getByRole('button', { name: /^Filters and view options/ })).toHaveFocus()
      } finally {
        Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined })
      }
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
      // #2124: no state change, but the choice is acknowledged and announced.
      expect(screen.getByTestId('preset-already-active')).toHaveTextContent('\u201cDefault\u201d is already applied')
      expect(screen.getByTestId('toast-announcer-polite')).toHaveTextContent('is already applied')
    })

    it('the trigger carries the full preset name as its title, and none at rest (#2124)', async () => {
      const user = userEvent.setup()
      renderBoard()
      expect(presetTrigger()).not.toHaveAttribute('title')
      await choosePreset(user, 'Classic')
      expect(presetTrigger()).toHaveAttribute('title', 'Classic')
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
      // A modified preset is reset, not "already applied".
      expect(screen.queryByTestId('preset-already-active')).not.toBeInTheDocument()
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

  describe('upgrade from 1.2: a member\'s own settings are not a preset', () => {
    function densitySource(): unknown {
      act(() => { window.dispatchEvent(new Event('visiban:open-settings')) })
      return JSON.parse(screen.getByTestId('settings-modal').getAttribute('data-density-source') ?? 'null')
    }

    it('own density and overlay that match Default are not reported as Default', () => {
      localStorage.setItem(DENSITY_KEY, 'standard')
      localStorage.setItem(OVERLAY_KEY, 'none')
      renderBoard()
      expect(presetTrigger()).toHaveAccessibleName('Preset')
      expect(densitySource()).toBeNull()
      expect(localStorage.getItem(MARKER_KEY)).toBeNull()
    })

    it('a stored none overlay is not reported as Classic', () => {
      localStorage.setItem(OVERLAY_KEY, 'none')
      renderBoard()
      expect(presetTrigger()).toHaveAccessibleName('Preset')
    })

    it('own settings that match no preset leave the trigger at rest, and nothing is written', () => {
      localStorage.setItem(DENSITY_KEY, 'dense')
      localStorage.setItem(OVERLAY_KEY, 'card-count')
      renderBoard()
      expect(presetTrigger()).toHaveAccessibleName('Preset')
      expect(localStorage.getItem(DENSITY_KEY)).toBe('dense')
      expect(localStorage.getItem(OVERLAY_KEY)).toBe('card-count')
    })

    it('own density equal to the board default preset is the member\'s, not set by the preset', () => {
      localStorage.setItem(DENSITY_KEY, 'standard')
      renderBoard(makeBoard({ default_preset: 'default' }))
      expect(presetTrigger()).toHaveAccessibleName('Preset: Default')
      expect(densitySource()).toBeNull()
    })

    it('a board default preset with no member key is named as the density source', () => {
      renderBoard(makeBoard({ default_preset: 'default' }))
      expect(densitySource()).toEqual({ presetName: 'Default', via: 'board-default' })
    })

    it('a preset the member applied is named as the writer of their key', async () => {
      const user = userEvent.setup()
      renderBoard()
      await choosePreset(user, 'Default')
      expect(densitySource()).toEqual({ presetName: 'Default', via: 'own-key', offChangesDensity: true, offFallsBackTo: 'board' })
    })

    it('ignores a stale marker', () => {
      localStorage.setItem(MARKER_KEY, 'standup')
      renderBoard()
      expect(presetTrigger()).toHaveAccessibleName('Preset')
    })
  })

  describe('command palette commands', () => {
    function command(detail: unknown) {
      act(() => { window.dispatchEvent(new CustomEvent('visiban:preset-command', { detail })) })
    }

    it('applies a preset through the picker path, with the Undo notice', () => {
      renderBoard()
      command({ kind: 'apply', presetId: 'default' })
      expect(presetTrigger()).toHaveAccessibleName('Preset: Default')
      expect(screen.getByTestId('preset-notice')).toHaveTextContent('Applied \u201cDefault\u201d')
      expect(localStorage.getItem(DENSITY_KEY)).toBe('standard')
    })

    it('resets a modified preset, and ignores a reset with nothing to reset', async () => {
      const user = userEvent.setup()
      renderBoard()
      command({ kind: 'reset' })
      expect(screen.queryByTestId('preset-notice')).not.toBeInTheDocument()
      command({ kind: 'apply', presetId: 'classic' })
      await chooseOverlay(user, 'Card count')
      command({ kind: 'reset' })
      expect(localStorage.getItem(OVERLAY_KEY)).toBe('none')
      expect(screen.getByTestId('preset-notice')).toHaveTextContent('Reset to \u201cClassic\u201d')
    })

    it('ignores re-applying the active unmodified preset and unknown ids', () => {
      renderBoard(makeBoard({ default_preset: 'default' }))
      // An unknown id first: it must raise nothing at all.
      command({ kind: 'apply', presetId: 'standup' })
      expect(screen.queryByTestId('preset-already-active')).not.toBeInTheDocument()
      command({ kind: 'apply', presetId: 'default' })
      expect(screen.queryByTestId('preset-notice')).not.toBeInTheDocument()
      expect(screen.getByTestId('preset-already-active')).toHaveTextContent('\u201cDefault\u201d is already applied')
    })
  })

  describe('state never crosses boards', () => {
    it('switching boards under a mounted BoardView drops the preset, the notice and its Undo', async () => {
      const user = userEvent.setup()
      const view = renderBoard()
      await choosePreset(user, 'Default')
      // Modifying drops ?preset= (a real navigation to another board drops it
      // too; the router double here keeps params across the switch).
      await chooseOverlay(user, 'Card count')
      expect(latestPresetParam()).toBeNull()
      expect(screen.getByTestId('preset-notice')).toBeInTheDocument()
      expect(localStorage.getItem(MARKER_KEY)).toBe('default')
      // App keys BoardView by board id (app.test.tsx); this proves the hook is safe
      // even if a board switch ever reuses the mounted instance.
      act(() => { mockBoardContextValue = context(makeBoard({ id: 2, uid: 'boarduid0002' })) })
      view.rerender(<ToastProvider><BoardView /></ToastProvider>)
      expect(presetTrigger()).toHaveAccessibleName('Preset')
      expect(screen.queryByTestId('preset-notice')).not.toBeInTheDocument()
      await user.click(presetTrigger())
      expect(screen.queryByRole('menuitem', { name: /^Undo/ })).not.toBeInTheDocument()
      expect(localStorage.getItem('board:2:preset')).toBeNull()
      expect(localStorage.getItem('board:2:card-density-override')).toBeNull()
      expect(localStorage.getItem('board:2:grid-overlay')).toBeNull()
      // Board 1's state is left as the member set it.
      expect(localStorage.getItem(MARKER_KEY)).toBe('default')
    })

    it("reads board 2's own marker after the switch", () => {
      localStorage.setItem('board:2:preset', 'classic')
      const view = renderBoard()
      act(() => { mockBoardContextValue = context(makeBoard({ id: 2, uid: 'boarduid0002' })) })
      view.rerender(<ToastProvider><BoardView /></ToastProvider>)
      expect(presetTrigger()).toHaveAccessibleName(/^Preset: Classic/)
    })
  })

  describe('the active preset is resolved from current inputs', () => {
    it('a member who chose the board default follows a later change of board default, like a reload', async () => {
      const user = userEvent.setup()
      const view = renderBoard(makeBoard({ default_preset: 'default' }))
      await choosePreset(user, 'Classic')
      await choosePreset(user, 'Default')
      expect(localStorage.getItem(MARKER_KEY)).toBeNull()
      act(() => { mockBoardContextValue = context(makeBoard({ default_preset: 'classic' })) })
      view.rerender(<ToastProvider><BoardView /></ToastProvider>)
      expect(presetTrigger()).toHaveAccessibleName('Preset: Classic')
      view.unmount()
      renderBoard(makeBoard({ default_preset: 'classic' }))
      expect(presetTrigger()).toHaveAccessibleName('Preset: Classic')
    })

    it('an explicit choice survives a change of board default', async () => {
      const user = userEvent.setup()
      const view = renderBoard(makeBoard({ default_preset: 'default' }))
      await choosePreset(user, 'Classic')
      act(() => { mockBoardContextValue = context(makeBoard({ default_preset: 'classic' })) })
      view.rerender(<ToastProvider><BoardView /></ToastProvider>)
      expect(presetTrigger()).toHaveAccessibleName('Preset: Classic')
      act(() => { mockBoardContextValue = context(makeBoard({ default_preset: null })) })
      view.rerender(<ToastProvider><BoardView /></ToastProvider>)
      expect(presetTrigger()).toHaveAccessibleName('Preset: Classic')
    })
  })

  describe('reloading with ?preset=', () => {
    it('raises no notice when the link changes nothing (picked, then reloaded)', async () => {
      const user = userEvent.setup()
      const first = renderBoard()
      await choosePreset(user, 'Default')
      expect(latestPresetParam()).toBe('default')
      first.unmount()
      renderBoard(makeBoard(), 'preset=default')
      expect(presetTrigger()).toHaveAccessibleName('Preset: Default')
      expect(screen.queryByTestId('preset-notice')).not.toBeInTheDocument()
    })

    it('raises no notice for a board-default link on a member following the board default', () => {
      renderBoard(makeBoard({ default_preset: 'default' }), 'preset=default')
      expect(screen.queryByTestId('preset-notice')).not.toBeInTheDocument()
    })

    it('still drops the param once the preset is then modified', async () => {
      const user = userEvent.setup()
      localStorage.setItem(DENSITY_KEY, 'standard')
      localStorage.setItem(OVERLAY_KEY, 'none')
      localStorage.setItem(MARKER_KEY, 'default')
      renderBoard(makeBoard(), 'preset=default')
      await chooseOverlay(user, 'Card count')
      expect(latestPresetParam()).toBeNull()
    })
  })

  describe('the notice shows in every view', () => {
    function command(detail: unknown) {
      act(() => { window.dispatchEvent(new CustomEvent('visiban:preset-command', { detail })) })
    }

    for (const view of ['summary', 'history', 'analytics'] as const) {
      it(`a ⌘K apply in the ${view} view shows the notice with Undo`, async () => {
        const user = userEvent.setup()
        renderBoard(makeBoard(), `view=${view}`)
        command({ kind: 'apply', presetId: 'default' })
        const notice = screen.getByTestId('preset-notice')
        expect(notice).toHaveTextContent('Applied \u201cDefault\u201d')
        await user.click(within(notice).getByRole('button', { name: 'Undo' }))
        expect(localStorage.getItem(DENSITY_KEY)).toBeNull()
      })
    }

    it('a ⌘K apply in the lens view shows the notice', async () => {
      // No ?view=: with a lens configured the board lands on it (#1063).
      renderBoard(makeBoard(), '', { ...fakeUser, git_lens_enabled: true } as User)
      expect(await screen.findByTestId('lens-view')).toBeInTheDocument()
      command({ kind: 'apply', presetId: 'classic' })
      expect(screen.getByTestId('preset-notice')).toHaveTextContent('Applied \u201cClassic\u201d')
    })

    it('a ?preset= link opened on the summary view shows the notice', () => {
      localStorage.setItem(DENSITY_KEY, 'dense')
      renderBoard(makeBoard(), 'view=summary&preset=default')
      expect(screen.getByTestId('preset-notice')).toHaveTextContent('from the link')
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
      // The baseline carries the same board default preset: only the density is
      // compared here.
      const { unmount } = renderBoard(makeBoard({ card_density: 'dense', default_preset: 'default' }))
      const dense = gridHtml()
      unmount()
      renderBoard(makeBoard({ card_density: 'comfortable', default_preset: 'default' }))
      expect(gridHtml()).toBe(dense)
      expect(presetTrigger()).toHaveAccessibleName('Preset: Default, modified')
    })

    it('a ?preset= link raises the Undo notice, and Undo restores the member settings and drops the link', async () => {
      const user = userEvent.setup()
      localStorage.setItem(DENSITY_KEY, 'dense')
      localStorage.setItem(OVERLAY_KEY, 'card-count')
      renderBoard(makeBoard(), 'preset=default')
      const notice = screen.getByTestId('preset-notice')
      expect(notice).toHaveTextContent('Applied \u201cDefault\u201d from the link')
      expect(localStorage.getItem(DENSITY_KEY)).toBe('standard')
      await user.click(within(notice).getByRole('button', { name: 'Undo' }))
      expect(localStorage.getItem(DENSITY_KEY)).toBe('dense')
      expect(localStorage.getItem(OVERLAY_KEY)).toBe('card-count')
      expect(localStorage.getItem(MARKER_KEY)).toBeNull()
      expect(latestPresetParam()).toBeNull()
      expect(presetTrigger()).toHaveAccessibleName('Preset')
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

    it('names the preset a member applied in an earlier visit', async () => {
      const user = userEvent.setup()
      const { unmount } = renderBoard()
      await choosePreset(user, 'Default')
      expect(localStorage.getItem(MARKER_KEY)).toBe('default')
      unmount()
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
      view.rerender(<ToastProvider><BoardView /></ToastProvider>)
      expect(presetTrigger()).toHaveAccessibleName('Preset: Default')
    })
  })
})

describe('BoardView — Show chips (#2272)', () => {
  // Card 1 overdue, 2 due soon, 3 stale, 4 on track, 5 stale but in the done column.
  const chipBoard = () => makeBoard({
    columns: [
      ...makeBoard().columns,
      { ...makeBoard().columns[1], id: 12, uid: 'coluid000003', name: 'Done', position: 2, is_done: true },
    ],
    cards: [
      makeCard(1, { title: 'Overdue one', due_date: '2026-06-10' }),
      makeCard(2, { title: 'Soon one', due_date: '2026-06-16' }),
      makeCard(3, { title: 'Stale one', is_stale: true }),
      makeCard(4, { title: 'Calm one' }),
      makeCard(5, { title: 'Finished one', is_stale: true, column: 12 }),
    ],
  })
  const chip = (name: RegExp) => screen.getByRole('button', { name })

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
    localStorage.clear()
    urlHistory.length = 0
  })
  afterEach(() => { vi.useRealTimers() })

  it('shows All cards, Overdue, Stale and Due soon with whole-board counts and the totals', () => {
    renderBoard(chipBoard())
    expect(chip(/^All cards 5 cards$/)).toHaveAttribute('aria-pressed', 'true')
    expect(chip(/^Overdue 1 card$/)).toHaveAttribute('aria-pressed', 'false')
    // Stale ignores a done column, like the card face.
    expect(chip(/^Stale 1 card$/)).toBeInTheDocument()
    expect(chip(/^Due soon 1 card$/)).toBeInTheDocument()
    expect(screen.getByTestId('board-totals')).toHaveTextContent('1 swimlane · 3 columns · 5 cards')
  })

  it('ANDs with an active Filter-panel filter: only cards matching both stay', () => {
    // Two overdue cards, only one high priority; a high-priority card that is not overdue.
    renderBoard(
      makeBoard({
        cards: [
          makeCard(1, { title: 'Overdue high', due_date: '2026-06-10', priority: 'high' }),
          makeCard(2, { title: 'Overdue medium', due_date: '2026-06-10', priority: 'medium' }),
          makeCard(3, { title: 'Calm high', priority: 'high' }),
        ],
      }),
      'show=overdue&f_priorities=high',
    )
    expect(screen.getByText('Overdue high')).toBeInTheDocument()
    expect(screen.queryByText('Overdue medium')).not.toBeInTheDocument()
    expect(screen.queryByText('Calm high')).not.toBeInTheDocument()
  })

  it('the Overdue filter drops a card once its column is switched to done (memo reads board.columns)', () => {
    const board = makeBoard({ cards: [makeCard(1, { title: 'Overdue one', due_date: '2026-06-10' })] })
    const view = renderBoard(board, 'f_due=overdue')
    expect(screen.getByText('Overdue one')).toBeInTheDocument()
    const doneBoard = { ...board, columns: board.columns.map((c) => (c.id === board.cards[0].column ? { ...c, is_done: true } : c)) }
    act(() => { mockBoardContextValue = context(doneBoard) })
    view.rerender(<ToastProvider><BoardView /></ToastProvider>)
    expect(screen.queryByText('Overdue one')).not.toBeInTheDocument()
  })

  it('swatches reuse the collapsed-lane square tokens', () => {
    renderBoard(chipBoard())
    expect(chip(/^Overdue/).querySelector('span[aria-hidden="true"]')).toHaveClass('bg-danger-emphasis')
    expect(chip(/^Stale/).querySelector('span[aria-hidden="true"]')).toHaveClass('bg-warning-emphasis')
  })

  it('choosing a chip hides non-matching cards and writes ?show= to the URL; All cards clears it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderBoard(chipBoard())
    await user.click(chip(/^Overdue/))
    expect(urlHistory[urlHistory.length - 1].get('show')).toBe('overdue')
    expect(chip(/^Overdue/)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Overdue one')).toBeInTheDocument()
    expect(screen.queryByText('Soon one')).not.toBeInTheDocument()
    expect(screen.queryByText('Stale one')).not.toBeInTheDocument()
    // Counts keep showing the whole board.
    expect(chip(/^All cards 5 cards$/)).toBeInTheDocument()

    await user.click(chip(/^All cards/))
    expect(urlHistory[urlHistory.length - 1].has('show')).toBe(false)
    expect(screen.getByText('Soon one')).toBeInTheDocument()
  })

  it('reads ?show= on load and the active chip is marked by weight and border, not color alone', () => {
    renderBoard(chipBoard(), 'show=stale')
    expect(chip(/^Stale/)).toHaveAttribute('aria-pressed', 'true')
    expect(chip(/^Stale/).className).toContain('font-semibold')
    expect(chip(/^Stale/).className).toContain('border-info')
    expect(screen.getByText('Stale one')).toBeInTheDocument()
    expect(screen.queryByText('Overdue one')).not.toBeInTheDocument()
  })

  it('ignores an unknown ?show= value', () => {
    renderBoard(chipBoard(), 'show=bogus')
    expect(chip(/^All cards/)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Calm one')).toBeInTheDocument()
  })

  it('a chip is a quick view: it is not written to storage', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderBoard(chipBoard())
    await user.click(chip(/^Due soon/))
    expect(Object.keys(localStorage).some((k) => /filters/.test(k) && /due_soon/.test(localStorage.getItem(k) ?? ''))).toBe(false)
  })

  it('says so when only the chip empties the board, and does not count chip-hidden cards as filtered out', () => {
    renderBoard(makeBoard({ cards: [makeCard(1, { title: 'Calm one' })] }), 'show=overdue')
    expect(screen.getByText('No cards are overdue')).toBeInTheDocument()
  })
})
