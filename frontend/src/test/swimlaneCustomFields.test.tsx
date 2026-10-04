import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SwimlaneRow from '../components/Board/SwimlaneRow'
import BoardSettingsSwimlaneFieldsTab from '../components/Board/BoardSettingsSwimlaneFieldsTab'
import SwimlaneFieldEditRow from '../components/Board/SwimlaneFieldEditRow'
import { mergeSwimlaneFromBroadcast } from '../utils/swimlaneMerge'
import type { BoardFull, Card, Column, Swimlane, SwimlaneCustomFieldDefinition, User } from '../types'

const fakeUser: User = {
  id: 1, username: 'admin', display_name: 'Admin', avatar_url: '',
} as User

// Captures the settings tab's onDragEnd so a test can drive a reorder without
// simulating a pointer drag through jsdom.
const dnd = vi.hoisted(() => ({
  onDragEnd: undefined as undefined | ((e: { active: { id: number }; over: { id: number } | null }) => void),
}))

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useDndContext: () => ({ active: null }),
  MouseSensor: class { static activators = [] },
  TouchSensor: class {},
  KeyboardSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
  DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd?: typeof dnd.onDragEnd }) => {
    dnd.onDragEnd = onDragEnd
    return <div>{children}</div>
  },
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: {},
  useSortable: () => ({ setNodeRef: () => {}, attributes: {}, listeners: {}, transform: null, transition: undefined, isDragging: false }),
  arrayMove: <T,>(a: T[], from: number, to: number) => {
    const next = [...a]
    next.splice(to, 0, next.splice(from, 1)[0])
    return next
  },
}))

vi.mock('../components/Board/BoardCell', () => ({
  default: ({ column, swimlane }: { column: Column; swimlane: Swimlane }) => (
    <div data-testid={`cell-${column.id}-${swimlane.id}`}>Cell</div>
  ),
}))

vi.mock('../components/Board/EditSwimlaneModal', () => ({
  default: () => <div data-testid="edit-swimlane-modal">Edit Swimlane</div>,
}))

vi.mock('../api/cards', () => ({ createCard: vi.fn() }))

const mockApi = vi.hoisted(() => ({
  createSwimlaneCustomFieldDefinition: vi.fn(),
  updateSwimlaneCustomFieldDefinition: vi.fn(),
  deleteSwimlaneCustomFieldDefinition: vi.fn(),
  reorderSwimlaneCustomFields: vi.fn(),
  updateSwimlane: vi.fn(),
  deleteSwimlane: vi.fn(),
}))
vi.mock('../api/boards', () => mockApi)

const columns: Column[] = [
  { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
]

function makeDef(overrides: Partial<SwimlaneCustomFieldDefinition> = {}): SwimlaneCustomFieldDefinition {
  return {
    id: 1, uid: 'sfuid0000001', name: 'Owner', field_type: 'text', choices: [], position: 0,
    show_on_row: true, is_admin_only: false, is_required: false, help_text: '',
    number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
    created_at: '2026-01-01', ...overrides,
  }
}

function makeSwimlane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 20, uid: 'laneuid00001', name: 'Acme Corp', contact_email: 'ops@acme.test', notes: '',
    position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01',
    custom_field_values: [], ...overrides,
  }
}

function renderRow(swimlane: Swimlane, defs: SwimlaneCustomFieldDefinition[], collapsed = false) {
  return render(
    <SwimlaneRow
      swimlane={swimlane}
      columns={columns}
      cards={[] as Card[]}
      boardId={1}
      isAdmin
      canEdit
      closeEditorOnEnter={false}
      collapsedColumnIds={new Set()}
      filteredCardIds={null}
      selectedCardIds={new Set()}
      onToggleCardSelection={vi.fn()}
      onCardClick={vi.fn()}
      onCardAdded={vi.fn()}
      onSwimlaneUpdated={vi.fn()}
      onSwimlaneDeleted={vi.fn()}
      collapsed={collapsed}
      onToggleCollapse={vi.fn()}
      onFocus={vi.fn()}
      onExitFocus={vi.fn()}
      isFocused={false}
      swimlaneFieldDefinitions={defs}
    />
  )
}

describe('SwimlaneRow — pinned row field chips (#1140)', () => {
  it('renders a pinned value as a chip', () => {
    const def = makeDef({ id: 1, name: 'Owner' })
    renderRow(
      makeSwimlane({ custom_field_values: [{ field_definition: 1, value: 'J. Rivera' }] }),
      [def]
    )
    expect(screen.getByText('Owner:')).toBeInTheDocument()
    expect(screen.getByText('J. Rivera')).toBeInTheDocument()
  })

  it('marks an admin-only field with a padlock so an admin knows what their team cannot see', () => {
    const def = makeDef({ id: 1, name: 'ARR', is_admin_only: true })
    renderRow(
      makeSwimlane({ custom_field_values: [{ field_definition: 1, value: '480000' }] }),
      [def]
    )
    expect(screen.getByLabelText('Admin-only field')).toBeInTheDocument()
  })

  it('renders no padlock for a public field', () => {
    const def = makeDef({ id: 1, name: 'Region', is_admin_only: false })
    renderRow(
      makeSwimlane({ custom_field_values: [{ field_definition: 1, value: 'EMEA' }] }),
      [def]
    )
    expect(screen.queryByLabelText('Admin-only field')).not.toBeInTheDocument()
  })

  it('renders nothing for an empty-string value — never a ghost chip', () => {
    const def = makeDef({ id: 1, name: 'Owner' })
    renderRow(
      makeSwimlane({ custom_field_values: [{ field_definition: 1, value: '' }] }),
      [def]
    )
    expect(screen.queryByText('Owner:')).not.toBeInTheDocument()
  })

  it('drops a value whose definition is missing rather than crashing', () => {
    // A WS race: the definition was deleted between the board load and this render.
    renderRow(
      makeSwimlane({ custom_field_values: [{ field_definition: 999, value: 'orphan' }] }),
      [makeDef({ id: 1 })]
    )
    expect(screen.queryByText('orphan')).not.toBeInTheDocument()
  })

  it('hides chips when the row is collapsed, matching contact_email', () => {
    const def = makeDef({ id: 1, name: 'Owner' })
    renderRow(
      makeSwimlane({ custom_field_values: [{ field_definition: 1, value: 'J. Rivera' }] }),
      [def],
      true
    )
    expect(screen.queryByText('Owner:')).not.toBeInTheDocument()
  })

  it('offers a +N overflow trigger for non-pinned values', () => {
    const defs = [
      makeDef({ id: 1, name: 'Owner', show_on_row: true }),
      makeDef({ id: 2, uid: 'sfuid0000002', name: 'Region', show_on_row: false, position: 1 }),
      makeDef({ id: 3, uid: 'sfuid0000003', name: 'Tier', show_on_row: false, position: 2 }),
    ]
    renderRow(
      makeSwimlane({ custom_field_values: [
        { field_definition: 1, value: 'J. Rivera' },
        { field_definition: 2, value: 'EMEA' },
        { field_definition: 3, value: 'Gold' },
      ] }),
      defs
    )
    expect(screen.getByRole('button', { name: /Show all 3 field values for Acme Corp/ })).toBeInTheDocument()
  })

  it('opens the field list popover from the overflow trigger', async () => {
    const user = userEvent.setup()
    const defs = [
      makeDef({ id: 1, name: 'Owner', show_on_row: true }),
      makeDef({ id: 2, uid: 'sfuid0000002', name: 'Region', show_on_row: false, position: 1 }),
    ]
    renderRow(
      makeSwimlane({ custom_field_values: [
        { field_definition: 1, value: 'J. Rivera' },
        { field_definition: 2, value: 'EMEA' },
      ] }),
      defs
    )
    await user.click(screen.getByRole('button', { name: /Show all 2 field values/ }))
    expect(screen.getByRole('dialog', { name: 'Field values for Acme Corp' })).toBeInTheDocument()
    expect(screen.getByText('EMEA')).toBeInTheDocument()
  })

  describe('field list popover layout (#1455)', () => {
    // Owner and Tier pinned, Region and Segment not — interleaved by position
    // so the regrouping is observable.
    const defs = [
      makeDef({ id: 1, name: 'Owner', show_on_row: true, position: 0 }),
      makeDef({ id: 2, uid: 'sfuid0000002', name: 'Region', show_on_row: false, position: 1 }),
      makeDef({ id: 3, uid: 'sfuid0000003', name: 'Tier', show_on_row: true, position: 2 }),
      makeDef({ id: 4, uid: 'sfuid0000004', name: 'Segment', show_on_row: false, position: 3 }),
    ]
    const lane = () => makeSwimlane({ custom_field_values: [
      { field_definition: 1, value: 'J. Rivera' },
      { field_definition: 2, value: 'EMEA' },
      { field_definition: 3, value: 'Gold' },
      { field_definition: 4, value: 'Retail' },
    ] })
    const openPopover = async () => {
      const user = userEvent.setup()
      renderRow(lane(), defs)
      await user.click(screen.getByRole('button', { name: /Show all 4 field values/ }))
      return screen.getByRole('dialog', { name: 'Field values for Acme Corp' })
    }

    it('lists the off-row fields first, then the pinned ones under "On row", each in position order', async () => {
      const dialog = await openPopover()
      const text = dialog.textContent ?? ''
      const order = ['Region', 'Segment', 'On row', 'Owner', 'Tier'].map((s) => text.indexOf(s))
      expect(order.every((i) => i >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
    })

    it('omits the "On row" divider when no field is pinned', async () => {
      const user = userEvent.setup()
      renderRow(
        makeSwimlane({ custom_field_values: [{ field_definition: 2, value: 'EMEA' }] }),
        [makeDef({ id: 2, uid: 'sfuid0000002', name: 'Region', show_on_row: false })]
      )
      await user.click(screen.getByRole('button', { name: /Show all 1 field values/ }))
      expect(screen.queryByText('On row')).not.toBeInTheDocument()
    })

    it('stays open when its own list scrolls, but closes when the board scrolls', async () => {
      const dialog = await openPopover()
      fireEvent.scroll(screen.getByTestId('swimlane-fields-list'))
      expect(dialog).toBeInTheDocument()
      fireEvent.scroll(window)
      expect(screen.queryByRole('dialog', { name: 'Field values for Acme Corp' })).not.toBeInTheDocument()
    })

    it('shows a bottom fade only while more of the list is below the fold', async () => {
      await openPopover()
      const list = screen.getByTestId('swimlane-fields-list')
      // jsdom has no layout; give the list a 100px viewport over 300px of rows.
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 })
      Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 300 })
      list.scrollTop = 0
      fireEvent.scroll(list)
      expect(screen.getByTestId('swimlane-fields-more-below')).toBeInTheDocument()
      list.scrollTop = 200
      fireEvent.scroll(list)
      expect(screen.queryByTestId('swimlane-fields-more-below')).not.toBeInTheDocument()
    })

    it('opens below the trigger when it fits and above it when it does not', async () => {
      const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
      try {
        const user = userEvent.setup()
        renderRow(lane(), defs)
        const trigger = screen.getByRole('button', { name: /Show all 4 field values/ })
        const rect = (top: number) => ({ top, bottom: top + 20, left: 10, right: 40, width: 30, height: 20, x: 10, y: top, toJSON: () => ({}) }) as DOMRect
        vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(100))
        await user.click(trigger)
        expect(screen.getByRole('dialog').style.top).toBe('124px')
        // A second click re-reads the trigger rect and re-places the open panel.
        vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(window.innerHeight - 40))
        await user.click(trigger)
        expect(screen.getByRole('dialog').style.top).toBe(`${window.innerHeight - 40 - 4 - 200}px`)
      } finally {
        heightSpy.mockRestore()
      }
    })
  })

  it('renders nothing at all when the swimlane carries no values', () => {
    renderRow(makeSwimlane(), [makeDef()])
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument()
  })
})

describe('mergeSwimlaneFromBroadcast (#1140)', () => {
  const adminOnly = makeDef({ id: 1, name: 'ARR', is_admin_only: true })
  const publicDef = makeDef({ id: 2, uid: 'sfuid0000002', name: 'Region', is_admin_only: false })

  it('keeps an admin-only value the public broadcast could not carry', () => {
    const prior = makeSwimlane({
      custom_field_values: [
        { field_definition: 1, value: '480000' },
        { field_definition: 2, value: 'EMEA' },
      ],
    })
    // What the wire actually delivers: public serializer, admin-only stripped.
    const broadcast = makeSwimlane({
      name: 'Acme Corporation',
      contact_email: undefined,
      custom_field_values: [{ field_definition: 2, value: 'EMEA' }],
    })
    const merged = mergeSwimlaneFromBroadcast([prior], broadcast, [adminOnly, publicDef])
    expect(merged.name).toBe('Acme Corporation')
    expect(merged.custom_field_values).toEqual(
      expect.arrayContaining([{ field_definition: 1, value: '480000' }])
    )
  })

  it('preserves contact_email, which the broadcast also never carries', () => {
    const prior = makeSwimlane({ contact_email: 'ops@acme.test' })
    const broadcast = makeSwimlane({ name: 'Renamed', contact_email: undefined })
    expect(mergeSwimlaneFromBroadcast([prior], broadcast, []).contact_email).toBe('ops@acme.test')
  })

  it('lets the payload win for a public field', () => {
    const prior = makeSwimlane({ custom_field_values: [{ field_definition: 2, value: 'EMEA' }] })
    const broadcast = makeSwimlane({ custom_field_values: [{ field_definition: 2, value: 'APAC' }] })
    const merged = mergeSwimlaneFromBroadcast([prior], broadcast, [publicDef])
    expect(merged.custom_field_values).toEqual([{ field_definition: 2, value: 'APAC' }])
  })

  it('does not resurrect an admin-only value the payload explicitly carries', () => {
    const prior = makeSwimlane({ custom_field_values: [{ field_definition: 1, value: 'old' }] })
    const broadcast = makeSwimlane({ custom_field_values: [{ field_definition: 1, value: 'new' }] })
    const merged = mergeSwimlaneFromBroadcast([prior], broadcast, [adminOnly])
    expect(merged.custom_field_values).toEqual([{ field_definition: 1, value: 'new' }])
  })

  it('drops a stale admin-only value once its definition has been deleted', () => {
    // Concurrent deletion: another admin removed the definition, so the
    // swimlane_custom_field.deleted handler has already pruned it from
    // board.swimlane_custom_field_definitions. The next merge must not
    // resurrect the orphaned value from local state.
    const prior = makeSwimlane({ custom_field_values: [{ field_definition: 1, value: '480000' }] })
    const broadcast = makeSwimlane({ custom_field_values: [] })
    const merged = mergeSwimlaneFromBroadcast([prior], broadcast, [/* definition gone */])
    expect(merged.custom_field_values).toEqual([])
  })

  it('returns the payload untouched for a swimlane it has never seen', () => {
    const broadcast = makeSwimlane({ id: 99 })
    expect(mergeSwimlaneFromBroadcast([], broadcast, [])).toBe(broadcast)
  })
})

function makeBoard(defs: SwimlaneCustomFieldDefinition[], swimlanes: Swimlane[] = []): BoardFull {
  return {
    id: 1, uid: 'boarduid0001', name: 'Board', description: '', group: null, group_name: null,
    archived_card_count: 0,
    columns: [], swimlanes, cards: [], labels: [],
    members: [], custom_field_definitions: [], swimlane_custom_field_definitions: defs,
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false,
    export_min_role: 'viewer', card_density: 'standard', show_wip_at_limit: false,
    created_at: '', updated_at: '', current_user_role: 'admin', is_starred: false,
    share_token: null, share_token_expires_at: null,
    // Fully typed, no `as unknown as` escape hatch: the double cast would
    // suppress exactly the serializer<->TS drift signal that made every other
    // BoardFull fixture in this directory flag the new field.
    owner: fakeUser, capabilities: { movement_export: false },
  }
}

describe('BoardSettingsSwimlaneFieldsTab (#1140)', () => {
  it('shows the swimlane caps, not the card caps', () => {
    render(<BoardSettingsSwimlaneFieldsTab board={makeBoard([makeDef()])} isAdmin onFieldsUpdated={vi.fn()} />)
    expect(screen.getByText('1 of 15 · 1 of 8 pinned')).toBeInTheDocument()
  })

  it('warns when every field is admin-only, since members then see nothing', () => {
    render(
      <BoardSettingsSwimlaneFieldsTab
        board={makeBoard([makeDef({ is_admin_only: true })])}
        isAdmin
        onFieldsUpdated={vi.fn()}
      />
    )
    expect(screen.getByText(/members and viewers see none of these/i)).toBeInTheDocument()
  })

  it('does not warn when at least one field is public', () => {
    render(
      <BoardSettingsSwimlaneFieldsTab
        board={makeBoard([makeDef({ is_admin_only: false })])}
        isAdmin
        onFieldsUpdated={vi.fn()}
      />
    )
    expect(screen.queryByText(/members and viewers see none of these/i)).not.toBeInTheDocument()
  })

  it('defaults a new field to admin-only', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsSwimlaneFieldsTab board={makeBoard([])} isAdmin onFieldsUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: '+ Add field' }))
    // The loosening caution must NOT be showing while the default (on) holds.
    expect(screen.queryByText(/Everyone on this board will see/)).not.toBeInTheDocument()
    expect(screen.getByText('Admin only')).toBeInTheDocument()
  })

  it('warns on the loosening transition only', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsSwimlaneFieldsTab board={makeBoard([])} isAdmin onFieldsUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: '+ Add field' }))
    await user.click(screen.getByText('Admin only'))
    expect(screen.getByText(/Everyone on this board will see this field's values/)).toBeInTheDocument()
  })

  it('locks the type once a swimlane holds a value for the field', async () => {
    const user = userEvent.setup()
    const def = makeDef({ id: 1, name: 'Owner' })
    const lane = makeSwimlane({ custom_field_values: [{ field_definition: 1, value: 'J. Rivera' }] })
    render(
      <BoardSettingsSwimlaneFieldsTab board={makeBoard([def], [lane])} isAdmin onFieldsUpdated={vi.fn()} />
    )
    await user.click(screen.getByTitle('Edit Owner'))
    expect(screen.getByText(/Type is locked/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /# Number/ })).toBeDisabled()
  })

  it('leaves the type editable while no swimlane holds a value', async () => {
    const user = userEvent.setup()
    const def = makeDef({ id: 1, name: 'Owner' })
    render(
      <BoardSettingsSwimlaneFieldsTab board={makeBoard([def], [makeSwimlane()])} isAdmin onFieldsUpdated={vi.fn()} />
    )
    await user.click(screen.getByTitle('Edit Owner'))
    expect(screen.queryByText(/Type is locked/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /# Number/ })).not.toBeDisabled()
  })

  it('treats an empty-string value as no value for the type lock', async () => {
    const user = userEvent.setup()
    const def = makeDef({ id: 1, name: 'Owner' })
    const lane = makeSwimlane({ custom_field_values: [{ field_definition: 1, value: '' }] })
    render(
      <BoardSettingsSwimlaneFieldsTab board={makeBoard([def], [lane])} isAdmin onFieldsUpdated={vi.fn()} />
    )
    await user.click(screen.getByTitle('Edit Owner'))
    expect(screen.queryByText(/Type is locked/)).not.toBeInTheDocument()
  })

  it('disables Add field at the cap', () => {
    const defs = Array.from({ length: 15 }, (_, i) =>
      makeDef({ id: i + 1, uid: `sfuid000000${i}`, name: `F${i}`, position: i, show_on_row: false })
    )
    render(<BoardSettingsSwimlaneFieldsTab board={makeBoard(defs)} isAdmin onFieldsUpdated={vi.fn()} />)
    expect(screen.getByRole('button', { name: '+ Add field' })).toBeDisabled()
    expect(screen.getByText(/reached its 15-field limit/)).toBeInTheDocument()
  })

  it('warns two fields before the cap', () => {
    const defs = Array.from({ length: 13 }, (_, i) =>
      makeDef({ id: i + 1, uid: `sfuid000000${i}`, name: `F${i}`, position: i, show_on_row: false })
    )
    render(<BoardSettingsSwimlaneFieldsTab board={makeBoard(defs)} isAdmin onFieldsUpdated={vi.fn()} />)
    expect(screen.getByText('2 fields left on this board.')).toBeInTheDocument()
  })

  it('names the swimlane row, not the card face, in the pin swap prompt', async () => {
    const user = userEvent.setup()
    const defs = [
      ...Array.from({ length: 8 }, (_, i) =>
        makeDef({ id: i + 1, uid: `sfuid00000${i + 1}`.padEnd(12, '0'), name: `F${i + 1}`, position: i, show_on_row: true })),
      makeDef({ id: 9, uid: 'sfuid0000009', name: 'D', position: 8, show_on_row: false }),
    ]
    render(<BoardSettingsSwimlaneFieldsTab board={makeBoard(defs)} isAdmin onFieldsUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /Pin D to swimlane row/ }))
    expect(screen.getByText('The row header shows 8 fields.')).toBeInTheDocument()
    expect(screen.getByText(/still visible in the row's field list/)).toBeInTheDocument()
  })

  it('says values are stored on swimlanes in the delete confirmation', async () => {
    const user = userEvent.setup()
    render(
      <BoardSettingsSwimlaneFieldsTab board={makeBoard([makeDef({ name: 'Owner' })])} isAdmin onFieldsUpdated={vi.fn()} />
    )
    await user.click(screen.getByTitle('Delete Owner'))
    expect(screen.getByText(/any values stored on swimlanes for it/)).toBeInTheDocument()
  })
})

describe('BoardSettingsSwimlaneFieldsTab — editing, pinning, deleting, reordering (#1140)', () => {
  const defA = makeDef({ id: 1, uid: 'sfuid0000001', name: 'A', position: 0, show_on_row: false })
  const defB = makeDef({ id: 2, uid: 'sfuid0000002', name: 'B', position: 1, show_on_row: false })

  beforeEach(() => {
    Object.values(mockApi).forEach((m) => m.mockReset())
    dnd.onDragEnd = undefined
  })

  function renderTab(defs: SwimlaneCustomFieldDefinition[], onFieldsUpdated = vi.fn(), isAdmin = true) {
    render(<BoardSettingsSwimlaneFieldsTab board={makeBoard(defs)} isAdmin={isAdmin} onFieldsUpdated={onFieldsUpdated} />)
    return onFieldsUpdated
  }

  const NAME = 'e.g. Account owner'

  describe('read-only view for a non-admin', () => {
    it('lists the fields with type, lock and pin markers but no edit controls', () => {
      renderTab([makeDef({ name: 'Owner', is_admin_only: true, show_on_row: true })], vi.fn(), false)
      expect(screen.getByText('Only board admins can add or edit swimlane fields.')).toBeInTheDocument()
      expect(screen.getByText('Owner')).toBeInTheDocument()
      expect(screen.getByText('Pinned')).toBeInTheDocument()
      expect(screen.getByText('Locked fields store values only board admins can see.')).toBeInTheDocument()
      expect(screen.queryByTitle('Edit Owner')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '+ Add field' })).not.toBeInTheDocument()
    })

    it('says so plainly when the board has no fields', () => {
      renderTab([], vi.fn(), false)
      expect(screen.getByText('This board has no swimlane fields.')).toBeInTheDocument()
    })
  })

  describe('adding a field', () => {
    it('opens from the empty state and cancels back to it', async () => {
      const user = userEvent.setup()
      renderTab([])
      expect(screen.getByText('No swimlane fields yet')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: '+ Add field' }))
      expect(screen.getByPlaceholderText(NAME)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByPlaceholderText(NAME)).not.toBeInTheDocument()
    })

    it('requires a name', async () => {
      const user = userEvent.setup()
      renderTab([])
      await user.click(screen.getByRole('button', { name: '+ Add field' }))
      await user.click(screen.getByRole('button', { name: 'Save field' }))
      expect(screen.getByText('Name is required.')).toBeInTheDocument()
      expect(mockApi.createSwimlaneCustomFieldDefinition).not.toHaveBeenCalled()
    })

    it('rejects a duplicate name regardless of case', async () => {
      const user = userEvent.setup()
      renderTab([defA])
      await user.click(screen.getByRole('button', { name: '+ Add field' }))
      await user.type(screen.getByPlaceholderText(NAME), 'a')
      await user.click(screen.getByRole('button', { name: 'Save field' }))
      expect(screen.getByText('A swimlane field with this name already exists.')).toBeInTheDocument()
      expect(mockApi.createSwimlaneCustomFieldDefinition).not.toHaveBeenCalled()
    })

    it('requires at least one choice for a dropdown', async () => {
      const user = userEvent.setup()
      renderTab([])
      await user.click(screen.getByRole('button', { name: '+ Add field' }))
      await user.type(screen.getByPlaceholderText(NAME), 'Region')
      await user.click(screen.getByRole('button', { name: /▾ Dropdown/ }))
      await user.click(screen.getByRole('button', { name: 'Save field' }))
      expect(screen.getByText('A dropdown field needs at least one choice.')).toBeInTheDocument()
      expect(mockApi.createSwimlaneCustomFieldDefinition).not.toHaveBeenCalled()
    })

    it('creates an admin-only text field by default and reports the new list', async () => {
      const user = userEvent.setup()
      const created = makeDef({ id: 7, name: 'Region', is_admin_only: true, show_on_row: false })
      mockApi.createSwimlaneCustomFieldDefinition.mockResolvedValue(created)
      const onFieldsUpdated = renderTab([])
      await user.click(screen.getByRole('button', { name: '+ Add field' }))
      await user.type(screen.getByPlaceholderText(NAME), '  Region  ')
      await user.click(screen.getByRole('button', { name: 'Save field' }))
      await waitFor(() => expect(onFieldsUpdated).toHaveBeenCalledWith([created]))
      expect(mockApi.createSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(1, {
        name: 'Region', field_type: 'text', choices: undefined, help_text: undefined, is_admin_only: true,
      })
      expect(mockApi.updateSwimlaneCustomFieldDefinition).not.toHaveBeenCalled()
      // Editor closes and the saved field is listed.
      expect(screen.queryByPlaceholderText(NAME)).not.toBeInTheDocument()
      expect(screen.getByText('Region')).toBeInTheDocument()
    })

    it('builds a dropdown from typed, pasted and removed choices, with help text, public and pinned', async () => {
      const user = userEvent.setup()
      const created = makeDef({ id: 7, name: 'Region', field_type: 'dropdown', show_on_row: false })
      const pinned = { ...created, show_on_row: true }
      mockApi.createSwimlaneCustomFieldDefinition.mockResolvedValue(created)
      mockApi.updateSwimlaneCustomFieldDefinition.mockResolvedValue(pinned)
      const onFieldsUpdated = renderTab([])
      await user.click(screen.getByRole('button', { name: '+ Add field' }))
      await user.type(screen.getByPlaceholderText(NAME), 'Region')
      await user.type(screen.getByPlaceholderText('Shown as hint text'), ' Sales region ')
      await user.click(screen.getByRole('button', { name: /▾ Dropdown/ }))

      await user.click(screen.getByRole('button', { name: '+ Add choice' }))
      // name, help text, then the one choice input
      await user.type(screen.getAllByRole('textbox')[2], 'EMEA')

      await user.click(screen.getByRole('button', { name: 'Paste a list' }))
      expect(screen.getByText('newline-separated')).toBeInTheDocument()
      await user.type(screen.getByPlaceholderText('One choice per line'), 'EMEA{Enter}APAC{Enter}{Enter}AMER')
      await user.click(screen.getByRole('button', { name: 'Add 3 choices' }))
      // EMEA was already present, so pasting it again adds nothing.
      expect(screen.getAllByRole('textbox').slice(2).map((i) => (i as HTMLInputElement).value)).toEqual(['EMEA', 'APAC', 'AMER'])
      expect(screen.queryByPlaceholderText('One choice per line')).not.toBeInTheDocument()

      await user.click(screen.getAllByText('✕')[0])
      expect(screen.getAllByRole('textbox').slice(2).map((i) => (i as HTMLInputElement).value)).toEqual(['APAC', 'AMER'])

      await user.click(screen.getByText('Admin only'))
      expect(screen.getByText(/Everyone on this board will see/)).toBeInTheDocument()
      await user.click(screen.getByRole('switch', { name: 'Pin to swimlane row' }))

      await user.click(screen.getByRole('button', { name: 'Save field' }))
      await waitFor(() => expect(onFieldsUpdated).toHaveBeenCalledWith([pinned]))
      expect(mockApi.createSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(1, {
        name: 'Region', field_type: 'dropdown', choices: ['APAC', 'AMER'], choice_colors: {},
        help_text: 'Sales region', is_admin_only: false,
      })
      // Pinning is a second call: the create endpoint does not take show_on_row.
      expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(1, 7, { show_on_row: true })
    })

    it('reports a generic error when the save fails', async () => {
      const user = userEvent.setup()
      mockApi.createSwimlaneCustomFieldDefinition.mockRejectedValue(new Error('boom'))
      const onFieldsUpdated = renderTab([])
      await user.click(screen.getByRole('button', { name: '+ Add field' }))
      await user.type(screen.getByPlaceholderText(NAME), 'Region')
      await user.click(screen.getByRole('button', { name: 'Save field' }))
      expect(await screen.findByText("Couldn't save this field. Check the values and try again.")).toBeInTheDocument()
      expect(onFieldsUpdated).not.toHaveBeenCalled()
      // Editor stays open with the input intact so the admin can retry.
      expect(screen.getByPlaceholderText(NAME)).toHaveValue('Region')
      expect(screen.getByRole('button', { name: 'Save field' })).toBeEnabled()
    })

    it('flags the type lock when the server rejects a type change', async () => {
      const user = userEvent.setup()
      // The client-side lock derives from board data that can be stale; the
      // server's field_type error is the real gate and must read as such.
      mockApi.updateSwimlaneCustomFieldDefinition.mockRejectedValue({ response: { data: { field_type: ['locked'] } } })
      renderTab([defA])
      await user.click(screen.getByTitle('Edit A'))
      await user.click(screen.getByRole('button', { name: /# Number/ }))
      await user.click(screen.getByRole('button', { name: 'Save field' }))
      expect(
        await screen.findByText("Couldn't change this field's type — swimlanes already have values for it.")
      ).toBeInTheDocument()
    })
  })

  describe('editing a field', () => {
    it('saves changes through PATCH and replaces the row', async () => {
      const user = userEvent.setup()
      const updated = { ...defA, name: 'Alpha' }
      mockApi.updateSwimlaneCustomFieldDefinition.mockResolvedValue(updated)
      const onFieldsUpdated = renderTab([defA, defB])
      await user.click(screen.getByTitle('Edit A'))
      const input = screen.getByPlaceholderText(NAME)
      expect(input).toHaveValue('A')
      await user.clear(input)
      await user.type(input, 'Alpha')
      await user.click(screen.getByRole('button', { name: 'Save field' }))
      await waitFor(() => expect(onFieldsUpdated).toHaveBeenCalledWith([updated, defB]))
      expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(1, 1, {
        name: 'Alpha', field_type: 'text', choices: undefined, help_text: undefined, is_admin_only: false,
      })
    })

    it('does not treat its own name as a duplicate', async () => {
      const user = userEvent.setup()
      mockApi.updateSwimlaneCustomFieldDefinition.mockResolvedValue(defA)
      renderTab([defA])
      await user.click(screen.getByTitle('Edit A'))
      await user.click(screen.getByRole('button', { name: 'Save field' }))
      await waitFor(() => expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalled())
      expect(screen.queryByText(/already exists/)).not.toBeInTheDocument()
    })

    it('cancels without calling the API', async () => {
      const user = userEvent.setup()
      renderTab([defA])
      await user.click(screen.getByTitle('Edit A'))
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByPlaceholderText(NAME)).not.toBeInTheDocument()
      expect(mockApi.updateSwimlaneCustomFieldDefinition).not.toHaveBeenCalled()
    })

    it('keeps in-progress edits when the board definitions change underneath', async () => {
      const user = userEvent.setup()
      const { rerender } = render(
        <BoardSettingsSwimlaneFieldsTab board={makeBoard([defA])} isAdmin onFieldsUpdated={vi.fn()} />
      )
      await user.click(screen.getByTitle('Edit A'))
      await user.type(screen.getByPlaceholderText(NAME), 'lpha')
      rerender(<BoardSettingsSwimlaneFieldsTab board={makeBoard([defA, defB])} isAdmin onFieldsUpdated={vi.fn()} />)
      expect(screen.getByPlaceholderText(NAME)).toHaveValue('Alpha')
    })

    it('re-syncs from the board when no row is being edited', () => {
      const { rerender } = render(
        <BoardSettingsSwimlaneFieldsTab board={makeBoard([defA])} isAdmin onFieldsUpdated={vi.fn()} />
      )
      expect(screen.queryByText('B')).not.toBeInTheDocument()
      rerender(<BoardSettingsSwimlaneFieldsTab board={makeBoard([defA, defB])} isAdmin onFieldsUpdated={vi.fn()} />)
      expect(screen.getByText('B')).toBeInTheDocument()
    })
  })

  describe('pinning', () => {
    it('pins a field under the cap', async () => {
      const user = userEvent.setup()
      const pinned = { ...defA, show_on_row: true }
      mockApi.updateSwimlaneCustomFieldDefinition.mockResolvedValue(pinned)
      const onFieldsUpdated = renderTab([defA, defB])
      await user.click(screen.getByRole('button', { name: 'Pin A to swimlane row' }))
      await waitFor(() => expect(onFieldsUpdated).toHaveBeenCalledWith([pinned, defB]))
      expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(1, 1, { show_on_row: true })
    })

    it('unpins a pinned field', async () => {
      const user = userEvent.setup()
      const pinnedA = { ...defA, show_on_row: true }
      mockApi.updateSwimlaneCustomFieldDefinition.mockResolvedValue(defA)
      const onFieldsUpdated = renderTab([pinnedA])
      await user.click(screen.getByRole('button', { name: 'Unpin A from swimlane row' }))
      await waitFor(() => expect(onFieldsUpdated).toHaveBeenCalledWith([defA]))
      expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(1, 1, { show_on_row: false })
    })

    it('rolls the optimistic pin back when the save fails', async () => {
      const user = userEvent.setup()
      mockApi.updateSwimlaneCustomFieldDefinition.mockRejectedValue(new Error('boom'))
      const onFieldsUpdated = renderTab([defA])
      await user.click(screen.getByRole('button', { name: 'Pin A to swimlane row' }))
      await waitFor(() => expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalled())
      expect(await screen.findByRole('button', { name: 'Pin A to swimlane row' })).toBeInTheDocument()
      expect(onFieldsUpdated).not.toHaveBeenCalled()
    })

    describe('at the pin cap', () => {
      // Eight pinned fields is the cap (SwimlaneCustomFieldDefinition.MAX_PINNED_PER_BOARD).
      const pinnedDefs = Array.from({ length: 8 }, (_, i) =>
        makeDef({ id: i + 1, uid: `sfuid00000${i + 1}`.padEnd(12, '0'), name: `P${i + 1}`, position: i, show_on_row: true }))
      const p2 = pinnedDefs[1]
      const extra = makeDef({ id: 9, uid: 'sfuid0000009', name: 'Extra', position: 8, show_on_row: false })

      it('swaps: unpins the chosen field and pins the new one together', async () => {
        const user = userEvent.setup()
        mockApi.updateSwimlaneCustomFieldDefinition.mockImplementation(
          (_b: number, id: number, patch: { show_on_row: boolean }) =>
            Promise.resolve({ ...[...pinnedDefs, extra].find((d) => d.id === id)!, ...patch })
        )
        const onFieldsUpdated = renderTab([...pinnedDefs, extra])
        await user.click(screen.getByRole('button', { name: 'Pin Extra to swimlane row' }))
        await user.click(screen.getByRole('button', { name: /P2\s*Replace/ }))
        await waitFor(() => expect(onFieldsUpdated).toHaveBeenCalled())
        expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(1, 2, { show_on_row: false })
        expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(1, 9, { show_on_row: true })
        const next = onFieldsUpdated.mock.calls[0][0] as SwimlaneCustomFieldDefinition[]
        expect(next.map((d) => [d.name, d.show_on_row])).toEqual([
          ...pinnedDefs.map((d) => [d.name, d.name !== 'P2']),
          ['Extra', true],
        ])
        expect(screen.queryByText('The row header shows 8 fields.')).not.toBeInTheDocument()
      })

      it('dismisses the prompt on Cancel without changing anything', async () => {
        const user = userEvent.setup()
        renderTab([...pinnedDefs, extra])
        await user.click(screen.getByRole('button', { name: 'Pin Extra to swimlane row' }))
        await user.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(screen.queryByText('The row header shows 8 fields.')).not.toBeInTheDocument()
        expect(mockApi.updateSwimlaneCustomFieldDefinition).not.toHaveBeenCalled()
      })

      it('rolls both halves back when either request fails', async () => {
        const user = userEvent.setup()
        mockApi.updateSwimlaneCustomFieldDefinition
          .mockResolvedValueOnce({ ...p2, show_on_row: false })
          .mockRejectedValueOnce(new Error('boom'))
        const onFieldsUpdated = renderTab([...pinnedDefs, extra])
        await user.click(screen.getByRole('button', { name: 'Pin Extra to swimlane row' }))
        await user.click(screen.getByRole('button', { name: /P2\s*Replace/ }))
        await waitFor(() => expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledTimes(2))
        expect(onFieldsUpdated).not.toHaveBeenCalled()
        expect(screen.getAllByRole('button', { name: /^Unpin / })).toHaveLength(8)
      })
    })
  })

  describe('deleting a field', () => {
    it('stays disabled until the exact name is typed, then deletes', async () => {
      const user = userEvent.setup()
      mockApi.deleteSwimlaneCustomFieldDefinition.mockResolvedValue(undefined)
      const onFieldsUpdated = renderTab([defA, defB])
      await user.click(screen.getByTitle('Delete A'))
      const del = screen.getByRole('button', { name: 'Delete' })
      expect(del).toBeDisabled()
      await user.type(screen.getByPlaceholderText('A'), 'a')
      expect(del).toBeDisabled()
      await user.clear(screen.getByPlaceholderText('A'))
      await user.type(screen.getByPlaceholderText('A'), 'A')
      expect(del).toBeEnabled()
      await user.click(del)
      await waitFor(() => expect(onFieldsUpdated).toHaveBeenCalledWith([defB]))
      expect(mockApi.deleteSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(1, 1)
      expect(screen.queryByText('Delete field?')).not.toBeInTheDocument()
    })

    it('deletes on Enter once the name matches', async () => {
      const user = userEvent.setup()
      mockApi.deleteSwimlaneCustomFieldDefinition.mockResolvedValue(undefined)
      const onFieldsUpdated = renderTab([defA])
      await user.click(screen.getByTitle('Delete A'))
      await user.type(screen.getByPlaceholderText('A'), 'A{Enter}')
      await waitFor(() => expect(onFieldsUpdated).toHaveBeenCalledWith([]))
    })

    it('ignores Enter while the name does not match', async () => {
      const user = userEvent.setup()
      renderTab([defA])
      await user.click(screen.getByTitle('Delete A'))
      await user.type(screen.getByPlaceholderText('A'), 'x{Enter}')
      expect(mockApi.deleteSwimlaneCustomFieldDefinition).not.toHaveBeenCalled()
    })

    it('cancels without calling the API', async () => {
      const user = userEvent.setup()
      renderTab([defA])
      await user.click(screen.getByTitle('Delete A'))
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByText('Delete field?')).not.toBeInTheDocument()
      expect(mockApi.deleteSwimlaneCustomFieldDefinition).not.toHaveBeenCalled()
    })

    it('restores the field when the delete fails', async () => {
      const user = userEvent.setup()
      mockApi.deleteSwimlaneCustomFieldDefinition.mockRejectedValue(new Error('boom'))
      const onFieldsUpdated = renderTab([defA, defB])
      await user.click(screen.getByTitle('Delete A'))
      await user.type(screen.getByPlaceholderText('A'), 'A')
      await user.click(screen.getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(screen.queryByText('Delete field?')).not.toBeInTheDocument())
      expect(onFieldsUpdated).not.toHaveBeenCalled()
      expect(screen.getByTitle('Delete A')).toBeInTheDocument()
    })
  })

  describe('reordering', () => {
    const drag = (activeId: number, overId: number | null) =>
      act(async () => { dnd.onDragEnd!({ active: { id: activeId }, over: overId === null ? null : { id: overId } }) })

    it('sends the new id order and reports the server list', async () => {
      const serverList = [{ ...defB, position: 0 }, { ...defA, position: 1 }]
      mockApi.reorderSwimlaneCustomFields.mockResolvedValue(serverList)
      const onFieldsUpdated = renderTab([defA, defB])
      await drag(1, 2)
      expect(mockApi.reorderSwimlaneCustomFields).toHaveBeenCalledWith(1, [2, 1])
      await waitFor(() => expect(onFieldsUpdated).toHaveBeenCalledWith(serverList))
    })

    it.each([
      ['dropped outside the list', 1, null],
      ['dropped on itself', 1, 1],
      ['an id the list does not hold', 99, 2],
    ])('does nothing for a drag %s', async (_label, activeId, overId) => {
      renderTab([defA, defB])
      await drag(activeId, overId)
      expect(mockApi.reorderSwimlaneCustomFields).not.toHaveBeenCalled()
    })

    it('restores the previous order when the request fails', async () => {
      mockApi.reorderSwimlaneCustomFields.mockRejectedValue(new Error('boom'))
      const onFieldsUpdated = renderTab([defA, defB])
      await drag(1, 2)
      await waitFor(() => expect(mockApi.reorderSwimlaneCustomFields).toHaveBeenCalled())
      expect(onFieldsUpdated).not.toHaveBeenCalled()
      const names = screen.getAllByTitle(/^(?!Edit|Delete)[AB]$/).map((n) => n.textContent)
      expect(names).toEqual(['A', 'B'])
    })
  })
})

describe('SwimlaneFieldEditRow (#1140, #1236)', () => {
  // #1236 — this row is a real consumer of CustomFieldValueInput distinct
  // from CustomFieldEditRow: EditSwimlaneModal commits once behind an
  // explicit Save button, not per keystroke, so SwimlaneFieldEditRow passes
  // `debounceMs={0}` deliberately (see its own JSDoc). Prove the wiring:
  // a value change reaches `onChange` immediately, with no timer pending.
  it('a text field change reaches onChange immediately (debounceMs=0 contract)', () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    render(<SwimlaneFieldEditRow definition={makeDef({ field_type: 'text' })} value="" onChange={onChange} />)
    act(() => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new owner' } })
    })
    expect(onChange).toHaveBeenCalledWith('new owner')
    // Nothing pending — a debounce timer would still be queued here.
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('a checkbox field toggle reaches onChange immediately', () => {
    const onChange = vi.fn()
    render(
      <SwimlaneFieldEditRow
        definition={makeDef({ field_type: 'checkbox', name: 'Active' })}
        value="false"
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenLastCalledWith('true')
  })

  it('a dropdown field selection reaches onChange immediately', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <SwimlaneFieldEditRow
        definition={makeDef({ field_type: 'dropdown', name: 'Region', choices: ['East', 'West'] })}
        value=""
        onChange={onChange}
      />,
    )
    await user.click(screen.getByRole('button', { name: /— No value —/ }))
    await user.click(screen.getByRole('menuitem', { name: 'West' }))
    expect(onChange).toHaveBeenCalledWith('West')
  })
})


describe('Swimlane URL fields (#1390)', () => {
  it('renders a pinned url value as a hostname link with the full URL in the chip title', () => {
    const def = makeDef({ id: 1, name: 'CRM', field_type: 'url' })
    renderRow(
      makeSwimlane({ custom_field_values: [{ field_definition: 1, value: 'https://www.crm.example.com/acct/42' }] }),
      [def]
    )
    const link = screen.getByRole('link', { name: 'Open crm.example.com in new tab' })
    expect(link).toHaveTextContent('crm.example.com')
    expect(link).toHaveAttribute('href', 'https://www.crm.example.com/acct/42')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByTitle('CRM: https://www.crm.example.com/acct/42')).toBeInTheDocument()
  })

  it('truncates a long hostname on the row chip at 20 characters', () => {
    const def = makeDef({ id: 1, name: 'CRM', field_type: 'url' })
    renderRow(
      makeSwimlane({ custom_field_values: [{ field_definition: 1, value: 'https://a-very-long-subdomain.example.com/' }] }),
      [def]
    )
    expect(screen.getByRole('link')).toHaveTextContent('a-very-long-subdomai…')
  })

  it('double-clicking the link does not open the swimlane editor', () => {
    const def = makeDef({ id: 1, name: 'CRM', field_type: 'url' })
    renderRow(
      makeSwimlane({ custom_field_values: [{ field_definition: 1, value: 'https://crm.example.com' }] }),
      [def]
    )
    fireEvent.doubleClick(screen.getByRole('link'))
    expect(screen.queryByTestId('edit-swimlane-modal')).not.toBeInTheDocument()
  })

  it('renders a legacy non-http value as plain text', () => {
    const def = makeDef({ id: 1, name: 'CRM', field_type: 'url' })
    renderRow(
      makeSwimlane({ custom_field_values: [{ field_definition: 1, value: 'data:text/html,hi' }] }),
      [def]
    )
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByText('data:text/html,hi')).toBeInTheDocument()
  })

  it('renders the full URL as a link in the fields popover', async () => {
    const user = userEvent.setup()
    const defs = [
      makeDef({ id: 1, name: 'Owner', show_on_row: true }),
      makeDef({ id: 2, uid: 'sfuid0000002', name: 'CRM', field_type: 'url', show_on_row: false, position: 1 }),
    ]
    renderRow(
      makeSwimlane({ custom_field_values: [
        { field_definition: 1, value: 'J. Rivera' },
        { field_definition: 2, value: 'https://crm.example.com/acct/42' },
      ] }),
      defs
    )
    await user.click(screen.getByRole('button', { name: /Show all 2 field values/ }))
    expect(screen.getByRole('link', { name: 'Open https://crm.example.com/acct/42 in new tab' })).toBeInTheDocument()
  })

  it('offers URL in the swimlane field type picker', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsSwimlaneFieldsTab board={makeBoard([])} isAdmin onFieldsUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: '+ Add field' }))
    expect(screen.getByRole('button', { name: /↗ URL/ })).toBeInTheDocument()
  })

  it('the Edit Swimlane field row commits a normalized URL on blur, not per keystroke', () => {
    const onChange = vi.fn()
    render(<SwimlaneFieldEditRow definition={makeDef({ name: 'CRM', field_type: 'url' })} value="" onChange={onChange} />)
    const input = screen.getByRole('textbox', { name: 'CRM' })
    fireEvent.change(input, { target: { value: 'crm.example.com' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith('https://crm.example.com')
  })
})

describe('Swimlane multi-select fields (#1391)', () => {
  it('renders up to three entries on the row chip, then +N', () => {
    const def = makeDef({ id: 1, name: 'Markets', field_type: 'multi_select', choices: ['EMEA', 'AMER', 'APAC', 'LATAM'] })
    renderRow(
      makeSwimlane({ custom_field_values: [{ field_definition: 1, value: '["EMEA","AMER","APAC","LATAM"]' }] }),
      [def]
    )
    expect(screen.getByText('EMEA')).toBeInTheDocument()
    expect(screen.getByText('APAC')).toBeInTheDocument()
    expect(screen.queryByText('LATAM')).not.toBeInTheDocument()
    expect(screen.getByText('+1')).toHaveAttribute('title', 'EMEA, AMER, APAC, LATAM')
  })

  it('offers Multi-select in the swimlane field type picker', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsSwimlaneFieldsTab board={makeBoard([])} isAdmin onFieldsUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: '+ Add field' }))
    await user.click(screen.getByRole('button', { name: /☰ Multi-select/ }))
    expect(screen.getByText('People can pick more than one choice.')).toBeInTheDocument()
    expect(screen.getByText('Choices')).toBeInTheDocument()
  })

  it('the Edit Swimlane field row hands the canonical value to the form on Done', async () => {
    const onChange = vi.fn()
    render(
      <SwimlaneFieldEditRow
        definition={makeDef({ name: 'Markets', field_type: 'multi_select', choices: ['EMEA', 'APAC'] })}
        value=""
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Markets: No value' }))
    fireEvent.mouseDown(screen.getByRole('option', { name: 'APAC' }))
    fireEvent.mouseDown(screen.getByRole('option', { name: 'EMEA' }))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onChange).toHaveBeenCalledWith('["EMEA","APAC"]')
  })
})

describe('BoardSettingsSwimlaneFieldsTab — number format (#1391)', () => {
  beforeEach(() => {
    Object.values(mockApi).forEach((m) => m.mockReset())
  })

  function renderTab(defs: SwimlaneCustomFieldDefinition[]) {
    render(<BoardSettingsSwimlaneFieldsTab board={makeBoard(defs)} isAdmin onFieldsUpdated={vi.fn()} />)
  }

  it('shows the Format block only for number and sends the options on create', async () => {
    const user = userEvent.setup()
    mockApi.createSwimlaneCustomFieldDefinition.mockResolvedValue(makeDef({ id: 9, name: 'ARR', field_type: 'number' }))
    renderTab([])
    await user.click(screen.getByRole('button', { name: '+ Add field' }))
    await user.type(screen.getByPlaceholderText('e.g. Account owner'), 'ARR')
    expect(screen.queryByText('Format')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /# Number/ }))
    await user.type(screen.getByLabelText('Prefix'), '€')
    await user.type(screen.getByLabelText('Suffix'), 'k')
    await user.type(screen.getByLabelText('Decimals'), '1')
    expect(screen.getByText('Preview: €1,234.5k')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save field' }))
    await waitFor(() => expect(mockApi.createSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(1, {
      name: 'ARR', field_type: 'number', choices: undefined, help_text: undefined, is_admin_only: true,
      number_prefix: '€', number_suffix: 'k', number_decimals: 1,
    }))
  })

  it('refuses to save an out-of-range decimals value', async () => {
    const user = userEvent.setup()
    renderTab([])
    await user.click(screen.getByRole('button', { name: '+ Add field' }))
    await user.type(screen.getByPlaceholderText('e.g. Account owner'), 'ARR')
    await user.click(screen.getByRole('button', { name: /# Number/ }))
    await user.type(screen.getByLabelText('Decimals'), '-1')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter 0 to 10.')
    await user.click(screen.getByRole('button', { name: 'Save field' }))
    expect(mockApi.createSwimlaneCustomFieldDefinition).not.toHaveBeenCalled()
  })

  it('loads and patches an existing format', async () => {
    const user = userEvent.setup()
    const def = makeDef({ id: 3, name: 'ARR', field_type: 'number', number_prefix: '$', number_decimals: 2 })
    mockApi.updateSwimlaneCustomFieldDefinition.mockResolvedValue({ ...def, number_decimals: null })
    renderTab([def])
    await user.click(screen.getByTitle('Edit ARR'))
    expect(screen.getByLabelText('Prefix')).toHaveValue('$')
    expect(screen.getByText('Preview: $1,234.50')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Decimals'))
    expect(screen.getByText('Preview: $1234.5')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save field' }))
    await waitFor(() => expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(1, 3, expect.objectContaining({
      number_prefix: '$', number_suffix: '', number_decimals: null,
    })))
  })
})

describe('BoardSettingsSwimlaneFieldsTab — choice colors (#1391)', () => {
  beforeEach(() => vi.clearAllMocks())

  function renderTab(defs: SwimlaneCustomFieldDefinition[]) {
    render(<BoardSettingsSwimlaneFieldsTab board={makeBoard(defs)} isAdmin onFieldsUpdated={vi.fn()} />)
  }

  it('picks, renames and saves row field colors through Save field', async () => {
    const user = userEvent.setup()
    const def = makeDef({ id: 4, name: 'Tier', field_type: 'dropdown', choices: ['Gold', 'Silver'], choice_colors: { Gold: 'amber', Silver: 'slate' } })
    mockApi.updateSwimlaneCustomFieldDefinition.mockResolvedValue(def)
    renderTab([def])
    await user.click(screen.getByTitle('Edit Tier'))
    expect(screen.getByRole('button', { name: 'Color for Gold: Amber' })).toBeInTheDocument()
    expect(screen.getByText('Renaming a choice resets its color.')).toBeInTheDocument()
    // Rename Silver: its color goes.
    const silver = screen.getByDisplayValue('Silver')
    await user.clear(silver)
    await user.type(silver, 'Platinum')
    expect(screen.getByRole('button', { name: 'Color for Platinum: Automatic' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Color for Platinum: Automatic' }))
    await user.click(screen.getByRole('radio', { name: 'Violet' }))
    expect(mockApi.updateSwimlaneCustomFieldDefinition).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Save field' }))
    await waitFor(() => expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(1, 4, expect.objectContaining({
      choices: ['Gold', 'Platinum'], choice_colors: { Gold: 'amber', Platinum: 'violet' },
    })))
  })

  it('shows no swatches for a non-choice type and sends no colors', async () => {
    const user = userEvent.setup()
    mockApi.createSwimlaneCustomFieldDefinition.mockResolvedValue(makeDef({ id: 9, name: 'ARR', field_type: 'number' }))
    renderTab([])
    await user.click(screen.getByRole('button', { name: '+ Add field' }))
    await user.type(screen.getByPlaceholderText('e.g. Account owner'), 'ARR')
    await user.click(screen.getByRole('button', { name: /# Number/ }))
    expect(screen.queryByRole('button', { name: /Color for/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save field' }))
    await waitFor(() => expect(mockApi.createSwimlaneCustomFieldDefinition).toHaveBeenCalled())
    expect(mockApi.createSwimlaneCustomFieldDefinition.mock.calls[0][1].choice_colors).toBeUndefined()
  })

  it('renders a colored row-header chip through the row', () => {
    const def = makeDef({ id: 4, name: 'Tier', field_type: 'dropdown', choices: ['Gold'], choice_colors: { Gold: 'amber' } })
    const { container } = renderRow(makeSwimlane({ custom_field_values: [{ field_definition: 4, value: 'Gold' }] }), [def])
    const badge = container.querySelector('.cf-choice-badge')
    expect(badge).not.toBeNull()
    expect(badge).toHaveTextContent('Gold')
  })
})
