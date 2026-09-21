import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SwimlaneRow from '../components/Board/SwimlaneRow'
import BoardSettingsSwimlaneFieldsTab from '../components/Board/BoardSettingsSwimlaneFieldsTab'
import { mergeSwimlaneFromBroadcast } from '../utils/swimlaneMerge'
import type { BoardFull, Card, Column, Swimlane, SwimlaneCustomFieldDefinition, User } from '../types'

const fakeUser: User = {
  id: 1, username: 'admin', display_name: 'Admin', avatar_url: '',
} as User

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useDndContext: () => ({ active: null }),
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: {},
  useSortable: () => ({ setNodeRef: () => {}, attributes: {}, listeners: {}, transform: null, transition: undefined, isDragging: false }),
  arrayMove: <T,>(a: T[]) => a,
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
    expect(screen.getByText('1 of 15 · 1 of 3 pinned')).toBeInTheDocument()
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
      makeDef({ id: 1, uid: 'sfuid0000001', name: 'A', position: 0, show_on_row: true }),
      makeDef({ id: 2, uid: 'sfuid0000002', name: 'B', position: 1, show_on_row: true }),
      makeDef({ id: 3, uid: 'sfuid0000003', name: 'C', position: 2, show_on_row: true }),
      makeDef({ id: 4, uid: 'sfuid0000004', name: 'D', position: 3, show_on_row: false }),
    ]
    render(<BoardSettingsSwimlaneFieldsTab board={makeBoard(defs)} isAdmin onFieldsUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /Pin D to swimlane row/ }))
    expect(screen.getByText('The row header shows 3 fields.')).toBeInTheDocument()
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
