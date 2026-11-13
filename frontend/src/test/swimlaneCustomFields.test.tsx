import { typeLockedMessage } from '../constants/customFields'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react'
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
  sortableKeyboardCoordinates: () => undefined,
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
  listSwimlaneCustomFieldDefinitions: vi.fn(),
  updateSwimlane: vi.fn(),
  deleteSwimlane: vi.fn(),
}))
vi.mock('../api/boards', () => mockApi)

const columns: Column[] = [
  { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
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
    position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null,
    custom_field_values: [], ...overrides,
  }
}

function renderRow(
  swimlane: Swimlane,
  defs: SwimlaneCustomFieldDefinition[],
  collapsed = false,
  extra: { isAdmin?: boolean; onEditFieldOrder?: () => void; hideRowChipFieldNames?: boolean } = {},
) {
  return render(
    <SwimlaneRow
      swimlane={swimlane}
      columns={columns}
      cards={[] as Card[]}
      boardId={1}
      isAdmin={extra.isAdmin ?? true}
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
      onEditFieldOrder={extra.onEditFieldOrder}
      hideRowChipFieldNames={extra.hideRowChipFieldNames}
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
    // #1862: a meaningful glyph needs 3:1; fg-faint was 1.93 dark, fg-tertiary is 5.71.
    expect(screen.getByLabelText('Admin-only field')).toHaveClass('text-fg-tertiary')
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

    it('draws a top border on every entry except the first of each list', async () => {
      const dialog = await openPopover()
      const rowOf = (label: string) => screen.getByText(label, { selector: 'span' }).parentElement as HTMLElement
      expect(dialog).toBeInTheDocument()
      expect(rowOf('Region').className).not.toContain('border-t')
      expect(rowOf('Segment').className).toContain('border-t')
      expect(rowOf('Owner').className).not.toContain('border-t')
      expect(rowOf('Tier').className).toContain('border-t')
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

    it('closes when the window resizes', async () => {
      await openPopover()
      fireEvent(window, new Event('resize'))
      expect(screen.queryByRole('dialog', { name: 'Field values for Acme Corp' })).not.toBeInTheDocument()
    })

    it('focuses the panel when everything fits, and the scrollable list when it overflows', async () => {
      const dialog = await openPopover()
      expect(dialog).toHaveFocus()
      fireEvent.mouseDown(document.body) // dismiss
      const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(300)
      const clientSpy = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
      try {
        await userEvent.setup().click(screen.getByRole('button', { name: /Show all 4 field values/ }))
        expect(screen.getByRole('region', { name: 'Field values' })).toHaveFocus()
      } finally {
        scrollSpy.mockRestore()
        clientSpy.mockRestore()
      }
    })

    it('moves focus only once the panel is placed and visible', async () => {
      // jsdom focuses a visibility:hidden element; browsers ignore the call.
      // So assert on the panel's visibility at the moment focus() runs.
      const original = HTMLElement.prototype.focus
      const visibilityAtFocus: string[] = []
      const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, opts?: FocusOptions) {
        const panel = this.closest('[role="dialog"]') as HTMLElement | null
        if (panel) visibilityAtFocus.push(panel.style.visibility)
        return original.call(this, opts)
      })
      try {
        await openPopover()
        expect(visibilityAtFocus).toEqual([''])
      } finally {
        focusSpy.mockRestore()
      }
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

    it('pins to the bottom edge when it fits neither below nor above the trigger', async () => {
      // Taller than the space on either side of a trigger near the top.
      const height = window.innerHeight - 60
      const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(height)
      try {
        const user = userEvent.setup()
        renderRow(lane(), defs)
        const trigger = screen.getByRole('button', { name: /Show all 4 field values/ })
        vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 120, left: 10, right: 40, width: 30, height: 20, x: 10, y: 100, toJSON: () => ({}) } as DOMRect)
        await user.click(trigger)
        expect(screen.getByRole('dialog').style.top).toBe(`${window.innerHeight - 8 - height}px`)
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

describe('SwimlaneRow — hidden field names on row chips (#1418)', () => {
  const owner = makeDef({ id: 1, name: 'Owner' })
  const laneWith = (value: string, field_definition = 1) =>
    makeSwimlane({ custom_field_values: [{ field_definition, value }] })

  it('shows the visible "{name}:" label by default', () => {
    renderRow(laneWith('J. Rivera'), [owner])
    const label = screen.getByText('Owner:')
    expect(label).not.toHaveClass('sr-only')
    expect(label).toHaveClass('text-fg-tertiary') // #1862: fg-muted is sub-AA on bg-surface in dark
  })

  it('drops the visible name but keeps it for screen readers and in the title when hidden', () => {
    renderRow(laneWith('J. Rivera'), [owner], false, { hideRowChipFieldNames: true })
    const label = screen.getByText('Owner:')
    expect(label).toHaveClass('sr-only')
    expect(label).not.toHaveClass('text-fg-tertiary')
    expect(screen.getByText('J. Rivera')).toBeInTheDocument()
    expect(screen.getByTitle('Owner: J. Rivera')).toBeInTheDocument()
  })

  it('keeps the admin-only padlock and title suffix when the name is hidden', () => {
    const arr = makeDef({ id: 1, name: 'ARR', is_admin_only: true })
    renderRow(laneWith('480000'), [arr], false, { hideRowChipFieldNames: true })
    expect(screen.getByLabelText('Admin-only field')).toBeInTheDocument()
    expect(screen.getByTitle('ARR: 480000 · Only board admins can see this')).toBeInTheDocument()
    expect(screen.getByText('ARR:')).toHaveClass('sr-only')
  })

  it('always shows the name on a checkbox field — a bare Yes/No says nothing', () => {
    const signed = makeDef({ id: 1, name: 'Signed', field_type: 'checkbox' })
    renderRow(laneWith('true'), [signed], false, { hideRowChipFieldNames: true })
    expect(screen.getByText('Signed:')).not.toHaveClass('sr-only')
  })

  it('still omits a chip for an empty value when names are hidden', () => {
    renderRow(laneWith(''), [owner], false, { hideRowChipFieldNames: true })
    expect(screen.queryByText('Owner:')).not.toBeInTheDocument()
  })

  it('keeps an "All fields" trigger on an all-pinned row when names are hidden (#1509)', async () => {
    const user = userEvent.setup()
    const defs = [
      makeDef({ id: 1, name: 'Owner', show_on_row: true }),
      makeDef({ id: 2, uid: 'sfuid0000002', name: 'Region', show_on_row: true, position: 1 }),
    ]
    const lane = makeSwimlane({ custom_field_values: [
      { field_definition: 1, value: 'J. Rivera' },
      { field_definition: 2, value: 'EMEA' },
    ] })
    renderRow(lane, defs, false, { hideRowChipFieldNames: true })
    const trigger = screen.getByRole('button', { name: /Show all 2 field values/ })
    expect(trigger).toHaveTextContent('All fields')
    expect(trigger).toHaveAccessibleName(/^All fields: Show all 2 field values for Acme Corp$/)
    expect(trigger).toHaveClass('min-h-6')
    // #1862: same untinted floor as the row chips beside it; fg-muted is 3.07:1 on bg-surface in dark.
    expect(trigger).toHaveClass('text-fg-tertiary', 'hover:text-fg-secondary')
    expect(trigger).not.toHaveClass('text-fg-muted')
    await user.click(trigger)
    const text = screen.getByRole('dialog', { name: 'Field values for Acme Corp' }).textContent ?? ''
    for (const s of ['Owner', 'J. Rivera', 'Region', 'EMEA']) expect(text).toContain(s)
  })

  it('still renders the "All fields" trigger when every pinned value is a checkbox and names are hidden (#1509)', () => {
    // Checkbox chips always show their name, but the trigger condition counts
    // all pinned fields, so the trigger stays; this pins that behavior.
    const defs = [
      makeDef({ id: 1, name: 'Signed', field_type: 'checkbox', show_on_row: true }),
      makeDef({ id: 2, uid: 'sfuid0000002', name: 'Approved', field_type: 'checkbox', show_on_row: true, position: 1 }),
    ]
    renderRow(makeSwimlane({ custom_field_values: [
      { field_definition: 1, value: 'true' },
      { field_definition: 2, value: 'true' },
    ] }), defs, false, { hideRowChipFieldNames: true })
    expect(screen.getByText('Signed:')).not.toHaveClass('sr-only')
    expect(screen.getByRole('button', { name: /^All fields: Show all 2 field values/ })).toBeInTheDocument()
  })

  it('shows no trigger on an all-pinned row when names are visible', () => {
    const defs = [makeDef({ id: 1, name: 'Owner', show_on_row: true })]
    renderRow(makeSwimlane({ custom_field_values: [{ field_definition: 1, value: 'J. Rivera' }] }), defs, false, { hideRowChipFieldNames: false })
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument()
  })

  it('keeps the +N label when unpinned fields exist and names are hidden', () => {
    const defs = [
      makeDef({ id: 1, name: 'Owner', show_on_row: true }),
      makeDef({ id: 2, uid: 'sfuid0000002', name: 'Region', show_on_row: false, position: 1 }),
    ]
    renderRow(makeSwimlane({ custom_field_values: [
      { field_definition: 1, value: 'J. Rivera' },
      { field_definition: 2, value: 'EMEA' },
    ] }), defs, false, { hideRowChipFieldNames: true })
    expect(screen.getByRole('button', { name: /Show all 2 field values/ })).toHaveTextContent('+1')
    expect(screen.getByRole('button', { name: /^\+1: Show all 2 field values/ })).toBeInTheDocument()
  })

  it('leaves the +N field list popover listing names and values', async () => {
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
      defs, false, { hideRowChipFieldNames: true },
    )
    await user.click(screen.getByRole('button', { name: /Show all 2 field values/ }))
    const dialog = screen.getByRole('dialog', { name: 'Field values for Acme Corp' })
    const text = dialog.textContent ?? ''
    for (const s of ['Owner', 'J. Rivera', 'Region', 'EMEA']) expect(text).toContain(s)
    const names = Array.from(dialog.querySelectorAll('.sr-only')).map((n) => n.textContent)
    expect(names).not.toContain('Owner: ')
  })
})

describe('"Edit field order…" popover shortcut (#1458)', () => {
  const defs = [
    makeDef({ id: 1, name: 'Owner', show_on_row: false, position: 0 }),
    makeDef({ id: 2, uid: 'sfuid0000002', name: 'Region', show_on_row: false, position: 1 }),
  ]
  const lane = () => makeSwimlane({ custom_field_values: [{ field_definition: 1, value: 'J. Rivera' }] })
  const open = async (extra: Parameters<typeof renderRow>[3]) => {
    const user = userEvent.setup()
    renderRow(lane(), defs, false, extra)
    await user.click(screen.getByRole('button', { name: /Show all 1 field values/ }))
    return user
  }

  it('shows the item to an admin when the board hands over the callback', async () => {
    await open({ isAdmin: true, onEditFieldOrder: vi.fn() })
    expect(screen.getByRole('button', { name: 'Edit field order…' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit fields…' })).toBeInTheDocument()
  })

  it('hides the item when the board withholds the callback (admin, fewer than 2 fields)', async () => {
    await open({ isAdmin: true })
    expect(screen.queryByRole('button', { name: 'Edit field order…' })).not.toBeInTheDocument()
  })

  it('hides the item from a non-admin even if the callback is passed', async () => {
    await open({ isAdmin: false, onEditFieldOrder: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Edit field order…' })).not.toBeInTheDocument()
  })

  it('closes the popover, then calls the callback, on click', async () => {
    const onEditFieldOrder = vi.fn()
    const user = await open({ isAdmin: true, onEditFieldOrder })
    await user.click(screen.getByRole('button', { name: 'Edit field order…' }))
    expect(onEditFieldOrder).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: 'Field values for Acme Corp' })).not.toBeInTheDocument()
  })

  it('activates from the keyboard with Enter', async () => {
    const onEditFieldOrder = vi.fn()
    const user = await open({ isAdmin: true, onEditFieldOrder })
    screen.getByRole('button', { name: 'Edit field order…' }).focus()
    await user.keyboard('{Enter}')
    expect(onEditFieldOrder).toHaveBeenCalledTimes(1)
  })
})

describe('"Edit fields…" popover item', () => {
  it('closes the popover and opens the Edit Swimlane modal', async () => {
    const user = userEvent.setup()
    renderRow(
      makeSwimlane({ custom_field_values: [{ field_definition: 1, value: 'x' }] }),
      [makeDef({ show_on_row: false })],
    )
    await user.click(screen.getByRole('button', { name: /Show all 1 field values/ }))
    await user.click(screen.getByRole('button', { name: 'Edit fields…' }))
    expect(screen.queryByRole('dialog', { name: 'Field values for Acme Corp' })).not.toBeInTheDocument()
    expect(screen.getByTestId('edit-swimlane-modal')).toBeInTheDocument()
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
    health_status: null, effective_health_status: null, health_status_source: null, default_preset: null,
    id: 1, uid: 'boarduid0001', name: 'Board', description: '', group: null, group_name: null,
    archived_card_count: 0,
    columns: [], swimlanes, cards: [], labels: [],
    members: [], custom_field_definitions: [], swimlane_custom_field_definitions: defs,
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false,
    export_min_role: 'viewer', card_density: 'standard', show_wip_at_limit: false, show_row_chip_field_names: true,
    created_at: '', updated_at: '', current_user_role: 'admin', is_starred: false,
    share_token: null, share_token_expires_at: null, share_link_active: false,
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

  it('the drag handle is a named, ringed, focusable button (#1739)', async () => {
    // dnd-kit is mocked in this file, so this proves only the handle markup and
    // tab stop. The pick-up is covered with real sensors in
    // boardSettingsFieldsTab.test.tsx, and the actual arrow-key reorder (jsdom
    // has no layout) in e2e/field-keyboard-reorder.spec.ts.
    const user = userEvent.setup()
    render(<BoardSettingsSwimlaneFieldsTab board={makeBoard([makeDef()])} isAdmin onFieldsUpdated={vi.fn()} />)
    const handle = screen.getAllByRole('button', { name: /^Drag to reorder / })[0]
    expect(handle.tagName).toBe('BUTTON')
    expect(handle).toHaveAttribute('type', 'button')
    expect(handle).toHaveClass('focus:opacity-100', 'focus:ring-2', 'focus:ring-primary-emphasis')
    await user.tab()
    expect(handle).toHaveFocus()
  })

  it("names each choice's remove button (#1737)", async () => {
    const user = userEvent.setup()
    render(<BoardSettingsSwimlaneFieldsTab board={makeBoard([])} isAdmin onFieldsUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: '+ Add field' }))
    await user.click(screen.getByRole('button', { name: /Dropdown/ }))
    await user.click(screen.getByRole('button', { name: '+ Add choice' }))
    const remove = screen.getByRole('button', { name: 'Remove choice 1' })
    expect(remove).toHaveAttribute('type', 'button')
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
    expect(screen.getByText(/The type can't be changed because swimlanes already have values/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /# Number/ })).toBeDisabled()
  })

  it('leaves the type editable while no swimlane holds a value', async () => {
    const user = userEvent.setup()
    const def = makeDef({ id: 1, name: 'Owner' })
    render(
      <BoardSettingsSwimlaneFieldsTab board={makeBoard([def], [makeSwimlane()])} isAdmin onFieldsUpdated={vi.fn()} />
    )
    await user.click(screen.getByTitle('Edit Owner'))
    expect(screen.queryByText(/The type can't be changed because swimlanes already have values/)).not.toBeInTheDocument()
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
    expect(screen.queryByText(/The type can't be changed because swimlanes already have values/)).not.toBeInTheDocument()
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

describe('BoardSettingsSwimlaneFieldsTab — row-chip field names setting (#1418)', () => {
  const NAME = 'Show field names on row chips'

  it('renders the switch on by default with its helper text, above the field list', () => {
    render(
      <BoardSettingsSwimlaneFieldsTab board={makeBoard([makeDef()])} isAdmin onFieldsUpdated={vi.fn()} onUpdateBoardSettings={vi.fn()} />
    )
    const toggle = screen.getByRole('switch', { name: NAME })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toHaveAccessibleDescription(/Turn off to show values only\. Names stay available on hover and in the row's field list\. Checkbox fields always show their name\./)
    const header = screen.getByText('Swimlane fields')
    expect(toggle.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('reflects a board that has names hidden', () => {
    render(
      <BoardSettingsSwimlaneFieldsTab
        board={{ ...makeBoard([]), show_row_chip_field_names: false }}
        isAdmin onFieldsUpdated={vi.fn()} onUpdateBoardSettings={vi.fn()}
      />
    )
    expect(screen.getByRole('switch', { name: NAME })).toHaveAttribute('aria-checked', 'false')
  })

  it('turning it off calls onUpdateBoardSettings with the board PATCH payload', async () => {
    const user = userEvent.setup()
    const onUpdate = vi.fn()
    render(
      <BoardSettingsSwimlaneFieldsTab board={makeBoard([])} isAdmin onFieldsUpdated={vi.fn()} onUpdateBoardSettings={onUpdate} />
    )
    await user.click(screen.getByRole('switch', { name: NAME }))
    expect(onUpdate).toHaveBeenCalledWith({ show_row_chip_field_names: false })
  })

  it('clicking the label text also toggles it, turning names back on', async () => {
    const user = userEvent.setup()
    const onUpdate = vi.fn()
    render(
      <BoardSettingsSwimlaneFieldsTab
        board={{ ...makeBoard([]), show_row_chip_field_names: false }}
        isAdmin onFieldsUpdated={vi.fn()} onUpdateBoardSettings={onUpdate}
      />
    )
    await user.click(screen.getByText(NAME))
    expect(onUpdate).toHaveBeenCalledWith({ show_row_chip_field_names: true })
  })

  it('a non-admin sees a read-only line and no control', () => {
    render(
      <BoardSettingsSwimlaneFieldsTab
        board={{ ...makeBoard([makeDef()]), show_row_chip_field_names: false }}
        isAdmin={false} onFieldsUpdated={vi.fn()} onUpdateBoardSettings={vi.fn()}
      />
    )
    expect(screen.getByText('Field names on row chips: hidden')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: NAME })).not.toBeInTheDocument()
  })

  it('an admin without a write callback gets the read-only line', () => {
    render(<BoardSettingsSwimlaneFieldsTab board={makeBoard([])} isAdmin onFieldsUpdated={vi.fn()} />)
    expect(screen.getByText('Field names on row chips: shown')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: NAME })).not.toBeInTheDocument()
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
      expect(screen.getByText('one per line or cell')).toBeInTheDocument()
      await user.type(screen.getByPlaceholderText('One choice per line'), 'EMEA{Enter}APAC{Enter}{Enter}AMER')
      // EMEA was already present, so pasting it again adds nothing — and the
      // count says so (#2192: it used to read "Add 3" and add two).
      await user.click(screen.getByRole('button', { name: 'Add 2 choices' }))
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

    describe('pasting a list after removing every original choice (#2192)', () => {
      const stage = makeDef({ id: 3, name: 'Stage', field_type: 'dropdown', choices: ['Old A', 'Old B'], show_on_row: false })
      const choiceLabels = () =>
        screen.queryAllByRole('button', { name: /^Remove choice / }).map((b) => b.getAttribute('aria-label'))

      async function removeOriginalsAndPaste(user: ReturnType<typeof userEvent.setup>, text: string) {
        mockApi.updateSwimlaneCustomFieldDefinition.mockImplementation(async (_b: number, id: number, p: object) => ({ ...stage, id, ...p }))
        renderTab([stage])
        await user.click(screen.getByRole('button', { name: 'Edit Stage' }))
        await user.click(screen.getByRole('button', { name: 'Remove choice Old A' }))
        await user.click(screen.getByRole('button', { name: 'Remove choice Old B' }))
        expect(choiceLabels()).toEqual([])
        await user.click(screen.getByRole('button', { name: 'Paste a list' }))
        await user.click(screen.getByPlaceholderText('One choice per line'))
        await user.paste(text)
      }

      it('Add moves the pasted choices into the list, and Save sends them', async () => {
        const user = userEvent.setup()
        await removeOriginalsAndPaste(user, 'New 1\nNew 2')
        await user.click(screen.getByRole('button', { name: 'Add 2 choices' }))
        expect(choiceLabels()).toEqual(['Remove choice New 1', 'Remove choice New 2'])
        await user.click(screen.getByRole('button', { name: 'Save field' }))
        await waitFor(() => expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(
          1, 3, expect.objectContaining({ choices: ['New 1', 'New 2'] }),
        ))
        expect(screen.queryByText('A dropdown field needs at least one choice.')).not.toBeInTheDocument()
      })

      it('Add drops duplicates within one paste, and Save sends each choice once', async () => {
        const user = userEvent.setup()
        await removeOriginalsAndPaste(user, 'New 1\nNew 1\nNew 2')
        await user.click(screen.getByRole('button', { name: 'Add 2 choices' }))
        await user.click(screen.getByRole('button', { name: 'Save field' }))
        await waitFor(() => expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(
          1, 3, expect.objectContaining({ choices: ['New 1', 'New 2'] }),
        ))
      })

      it('Save refuses more than 100 choices with a specific error and sends nothing', async () => {
        const user = userEvent.setup()
        const lines = Array.from({ length: 101 }, (_, i) => `Opt ${i}`).join('\n')
        await removeOriginalsAndPaste(user, lines)
        await user.click(screen.getByRole('button', { name: 'Save field' }))
        expect(await screen.findByText('A dropdown field may have at most 100 choices.')).toBeInTheDocument()
        expect(mockApi.updateSwimlaneCustomFieldDefinition).not.toHaveBeenCalled()
      })

      it('Save with the text still in the paste box saves the pasted choices', async () => {
        const user = userEvent.setup()
        await removeOriginalsAndPaste(user, 'New 1\r\nNew 2\rNew 3')
        await user.click(screen.getByRole('button', { name: 'Save field' }))
        await waitFor(() => expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(
          1, 3, expect.objectContaining({ choices: ['New 1', 'New 2', 'New 3'] }),
        ))
        expect(screen.queryByText('A dropdown field needs at least one choice.')).not.toBeInTheDocument()
      })

      it('closing the paste box with text in it applies the text, and opening it changes nothing', async () => {
        const user = userEvent.setup()
        await removeOriginalsAndPaste(user, 'New 1\nNew 2')
        await user.click(screen.getByRole('button', { name: 'Paste a list' }))
        expect(screen.queryByPlaceholderText('One choice per line')).not.toBeInTheDocument()
        expect(choiceLabels()).toEqual(['Remove choice New 1', 'Remove choice New 2'])
        await user.click(screen.getByRole('button', { name: 'Save field' }))
        await waitFor(() => expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(
          1, 3, expect.objectContaining({ choices: ['New 1', 'New 2'] }),
        ))
      })

      it('editing another field does not carry the paste box or its text over', async () => {
        const user = userEvent.setup()
        const other = makeDef({ id: 4, name: 'Other', field_type: 'dropdown', choices: ['X'], show_on_row: false })
        mockApi.updateSwimlaneCustomFieldDefinition.mockImplementation(async (_b: number, id: number, p: object) => ({ ...other, id, ...p }))
        renderTab([stage, other])
        await user.click(screen.getByRole('button', { name: 'Edit Stage' }))
        await user.click(screen.getByRole('button', { name: 'Paste a list' }))
        await user.click(screen.getByPlaceholderText('One choice per line'))
        await user.paste('Leaked')
        await user.click(screen.getByRole('button', { name: 'Edit Other' }))
        expect(screen.queryByPlaceholderText('One choice per line')).not.toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Save field' }))
        await waitFor(() => expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(
          1, 4, expect.objectContaining({ choices: ['X'] }),
        ))
      })

      it('splits a row of spreadsheet cells on tabs, and the count matches what is added', async () => {
        const user = userEvent.setup()
        await removeOriginalsAndPaste(user, 'North\tSouth\tNorth\n')
        await user.click(screen.getByRole('button', { name: 'Add 2 choices' }))
        expect(choiceLabels()).toEqual(['Remove choice North', 'Remove choice South'])
      })
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
        await screen.findByText(typeLockedMessage('swimlanes'))
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

    // #2193: saving an existing field from the editor sends a changed pin toggle.
    it('pins an existing field from the editor', async () => {
      const user = userEvent.setup()
      mockApi.updateSwimlaneCustomFieldDefinition.mockImplementation(
        (_b: number, id: number, patch: Partial<SwimlaneCustomFieldDefinition>) =>
          Promise.resolve({ ...[defA, defB].find((d) => d.id === id)!, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) })
      )
      renderTab([defA, defB])
      await user.click(screen.getByTitle('Edit A'))
      await user.click(screen.getByRole('switch', { name: 'Pin to swimlane row' }))
      await user.click(screen.getByRole('button', { name: 'Save field' }))
      await waitFor(() => expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(
        1, 1, expect.objectContaining({ show_on_row: true })))
      expect(await screen.findByRole('button', { name: 'Unpin A from swimlane row' })).toBeInTheDocument()
    })

    it('unpins an existing pinned field from the editor', async () => {
      const user = userEvent.setup()
      const pinnedA = { ...defA, show_on_row: true }
      mockApi.updateSwimlaneCustomFieldDefinition.mockImplementation(
        (_b: number, _id: number, patch: Partial<SwimlaneCustomFieldDefinition>) =>
          Promise.resolve({ ...pinnedA, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) })
      )
      renderTab([pinnedA])
      await user.click(screen.getByTitle('Edit A'))
      await user.click(screen.getByRole('switch', { name: 'Pin to swimlane row' }))
      await user.click(screen.getByRole('button', { name: 'Save field' }))
      await waitFor(() => expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(
        1, 1, expect.objectContaining({ show_on_row: false })))
      expect(await screen.findByRole('button', { name: 'Pin A to swimlane row' })).toBeInTheDocument()
    })

    it('leaves the row pin alone when the editor toggle was not touched', async () => {
      const user = userEvent.setup()
      mockApi.updateSwimlaneCustomFieldDefinition.mockResolvedValue(defA)
      renderTab([defA])
      await user.click(screen.getByTitle('Edit A'))
      await user.click(screen.getByRole('button', { name: 'Save field' }))
      await waitFor(() => expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalled())
      expect(mockApi.updateSwimlaneCustomFieldDefinition.mock.calls[0][2]).not.toHaveProperty('show_on_row')
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

      // #2193: the editor's pin toggle was dropped when saving an existing field.
      it('the editor pin toggle, at the cap, saves without the pin and opens the swap prompt', async () => {
        const user = userEvent.setup()
        mockApi.updateSwimlaneCustomFieldDefinition.mockImplementation(
          (_b: number, id: number, patch: Partial<SwimlaneCustomFieldDefinition>) =>
            Promise.resolve({ ...[...pinnedDefs, extra].find((d) => d.id === id)!, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) })
        )
        renderTab([...pinnedDefs, extra])
        await user.click(screen.getByTitle('Edit Extra'))
        await user.click(screen.getByRole('switch', { name: 'Pin to swimlane row' }))
        await user.click(screen.getByRole('button', { name: 'Save field' }))
        expect(await screen.findByText('The row header shows 8 fields.')).toBeInTheDocument()
        expect(mockApi.updateSwimlaneCustomFieldDefinition.mock.calls[0][2]).not.toHaveProperty('show_on_row')
        await user.click(screen.getByRole('button', { name: /P2\s*Replace/ }))
        await waitFor(() => {
          expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(1, 2, { show_on_row: false })
          expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(1, 9, { show_on_row: true })
        })
      })

      it('a new field asking to be pinned opens the swap prompt instead of a refused pin', async () => {
        const user = userEvent.setup()
        const created = makeDef({ id: 10, uid: 'sfuid0000010', name: 'Fresh', position: 9, show_on_row: false })
        mockApi.createSwimlaneCustomFieldDefinition.mockResolvedValue(created)
        const onFieldsUpdated = renderTab([...pinnedDefs, extra])
        await user.click(screen.getByRole('button', { name: '+ Add field' }))
        await user.type(screen.getByPlaceholderText(NAME), 'Fresh')
        await user.click(screen.getByRole('switch', { name: 'Pin to swimlane row' }))
        await user.click(screen.getByRole('button', { name: 'Save field' }))
        await waitFor(() => expect(onFieldsUpdated).toHaveBeenCalledWith([...pinnedDefs, extra, created]))
        expect(mockApi.updateSwimlaneCustomFieldDefinition).not.toHaveBeenCalled()
        expect(await screen.findByText('The row header shows 8 fields.')).toBeInTheDocument()
      })

      it('sends the unpin first and the pin only after the unpin resolves', async () => {
        const user = userEvent.setup()
        let resolveUnpin!: (v: SwimlaneCustomFieldDefinition) => void
        mockApi.updateSwimlaneCustomFieldDefinition
          .mockImplementationOnce(() => new Promise((r) => { resolveUnpin = r }))
          .mockImplementationOnce(() => Promise.resolve({ ...extra, show_on_row: true }))
        renderTab([...pinnedDefs, extra])
        await user.click(screen.getByRole('button', { name: 'Pin Extra to swimlane row' }))
        await user.click(screen.getByRole('button', { name: /P2\s*Replace/ }))
        await waitFor(() => expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledTimes(1))
        expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenLastCalledWith(1, 2, { show_on_row: false })
        resolveUnpin({ ...p2, show_on_row: false })
        await waitFor(() => expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledTimes(2))
        expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenLastCalledWith(1, 9, { show_on_row: true })
      })

      it('re-syncs from the server and shows an error when the pin fails after the unpin succeeded', async () => {
        const user = userEvent.setup()
        const serverState = [...pinnedDefs.map((d) => (d.id === 2 ? { ...d, show_on_row: false } : d)), extra]
        mockApi.updateSwimlaneCustomFieldDefinition
          .mockResolvedValueOnce({ ...p2, show_on_row: false })
          .mockRejectedValueOnce(new Error('boom'))
        mockApi.listSwimlaneCustomFieldDefinitions.mockResolvedValue(serverState)
        const onFieldsUpdated = renderTab([...pinnedDefs, extra])
        await user.click(screen.getByRole('button', { name: 'Pin Extra to swimlane row' }))
        await user.click(screen.getByRole('button', { name: /P2\s*Replace/ }))
        expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't finish replacing the pinned field/)
        expect(mockApi.listSwimlaneCustomFieldDefinitions).toHaveBeenCalledWith(1)
        expect(onFieldsUpdated).toHaveBeenCalledWith(serverState)
        expect(screen.getAllByRole('button', { name: /^Unpin / })).toHaveLength(7)
        expect(screen.getByRole('button', { name: 'Pin P2 to swimlane row' })).toBeInTheDocument()
      })

      it('keeps only the confirmed unpin when the re-sync itself fails', async () => {
        const user = userEvent.setup()
        const unpinned = { ...p2, show_on_row: false }
        mockApi.updateSwimlaneCustomFieldDefinition
          .mockResolvedValueOnce(unpinned)
          .mockRejectedValueOnce(new Error('boom'))
        mockApi.listSwimlaneCustomFieldDefinitions.mockRejectedValue(new Error('offline'))
        const onFieldsUpdated = renderTab([...pinnedDefs, extra])
        await user.click(screen.getByRole('button', { name: 'Pin Extra to swimlane row' }))
        await user.click(screen.getByRole('button', { name: /P2\s*Replace/ }))
        expect(await screen.findByRole('alert')).toBeInTheDocument()
        await waitFor(() => expect(onFieldsUpdated).toHaveBeenCalledTimes(1))
        expect(onFieldsUpdated).toHaveBeenCalledWith([...pinnedDefs.map((d) => (d.id === 2 ? unpinned : d)), extra])
      })

      it('never sends the pin and shows an alert when the unpin itself fails', async () => {
        const user = userEvent.setup()
        mockApi.updateSwimlaneCustomFieldDefinition.mockRejectedValueOnce(new Error('500'))
        mockApi.listSwimlaneCustomFieldDefinitions.mockResolvedValue([...pinnedDefs, extra])
        renderTab([...pinnedDefs, extra])
        await user.click(screen.getByRole('button', { name: 'Pin Extra to swimlane row' }))
        await user.click(screen.getByRole('button', { name: /P2\s*Replace/ }))
        expect(await screen.findByRole('alert')).toBeInTheDocument()
        expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledTimes(1)
        expect(mockApi.updateSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(1, 2, { show_on_row: false })
      })
    })

    describe('refused pins on the other paths (#2193)', () => {
      it('the row Pin button shows an alert and re-syncs when the server refuses', async () => {
        const user = userEvent.setup()
        mockApi.updateSwimlaneCustomFieldDefinition.mockRejectedValue(new Error('400'))
        mockApi.listSwimlaneCustomFieldDefinitions.mockResolvedValue([defA, defB])
        renderTab([defA, defB])
        await user.click(screen.getByRole('button', { name: 'Pin A to swimlane row' }))
        expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't change that pin/)
        expect(mockApi.listSwimlaneCustomFieldDefinitions).toHaveBeenCalledWith(1)
        expect(screen.getByRole('button', { name: 'Pin A to swimlane row' })).toBeInTheDocument()
      })

      it('a created field stays in the list, is not re-created, and an alert shows when its follow-up pin is refused', async () => {
        const user = userEvent.setup()
        const created = makeDef({ id: 10, uid: 'sfuid0000010', name: 'Fresh', position: 2, show_on_row: false })
        mockApi.createSwimlaneCustomFieldDefinition.mockResolvedValue(created)
        mockApi.updateSwimlaneCustomFieldDefinition.mockRejectedValue(new Error('400'))
        mockApi.listSwimlaneCustomFieldDefinitions.mockResolvedValue([defA, defB, created])
        const onFieldsUpdated = renderTab([defA, defB])
        await user.click(screen.getByRole('button', { name: '+ Add field' }))
        await user.type(screen.getByPlaceholderText(NAME), 'Fresh')
        await user.click(screen.getByRole('switch', { name: 'Pin to swimlane row' }))
        await user.click(screen.getByRole('button', { name: 'Save field' }))
        expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't change that pin/)
        expect(mockApi.listSwimlaneCustomFieldDefinitions).toHaveBeenCalledWith(1)
        expect(onFieldsUpdated).toHaveBeenLastCalledWith([defA, defB, created])
        expect(screen.getByRole('button', { name: 'Pin Fresh to swimlane row' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Save field' })).not.toBeInTheDocument()
        expect(mockApi.createSwimlaneCustomFieldDefinition).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('type lock reason and Delete in the editor (#2194)', () => {
    const LOCK_RE = /The type can't be changed because swimlanes already have values/
    // The paragraph is the shared text, referenced by the type group.

    function renderWithValues(defs: SwimlaneCustomFieldDefinition[], onFieldsUpdated = vi.fn()) {
      const board = {
        ...makeBoard(defs),
        swimlanes: [makeSwimlane({ custom_field_values: [{ field_definition: 1, value: 'x' }] })],
      }
      render(<BoardSettingsSwimlaneFieldsTab board={board} isAdmin onFieldsUpdated={onFieldsUpdated} />)
      return onFieldsUpdated
    }

    it('explains the lock, the workaround and the data loss when the field has values', async () => {
      const user = userEvent.setup()
      renderWithValues([defA])
      await user.click(screen.getByTitle('Edit A'))
      const reason = screen.getByText(LOCK_RE)
      expect(reason).toHaveTextContent('add a new field of that type, then delete this one')
      expect(reason).toHaveTextContent('permanently deletes all of its values')
      expect(reason).toHaveTextContent("can't be recovered")
      expect(reason).toHaveTextContent(typeLockedMessage('swimlanes'))
      expect(screen.getByRole('group', { name: 'Field type' })).toHaveAccessibleDescription(typeLockedMessage('swimlanes'))
      expect(screen.getByRole('button', { name: /# Number/ })).not.toHaveAttribute('title')
      expect(screen.getByRole('button', { name: /# Number/ })).toBeDisabled()
    })

    it('shows no reason for a field without values or for a new field', async () => {
      const user = userEvent.setup()
      renderTab([defA])
      await user.click(screen.getByTitle('Edit A'))
      expect(screen.queryByText(LOCK_RE)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /# Number/ })).toBeEnabled()
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      await user.click(screen.getByRole('button', { name: '+ Add field' }))
      expect(screen.queryByText(LOCK_RE)).not.toBeInTheDocument()
    })

    it('offers Delete field only when editing an existing field', async () => {
      const user = userEvent.setup()
      renderTab([defA])
      expect(screen.queryByRole('button', { name: 'Delete field' })).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: '+ Add field' }))
      expect(screen.queryByRole('button', { name: 'Delete field' })).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      await user.click(screen.getByTitle('Edit A'))
      expect(screen.getByRole('button', { name: 'Delete field' })).toBeInTheDocument()
    })

    it('opens the existing confirmation, deletes, and closes the editor', async () => {
      const user = userEvent.setup()
      mockApi.deleteSwimlaneCustomFieldDefinition.mockResolvedValue(undefined)
      const onFieldsUpdated = renderTab([defA, defB])
      await user.click(screen.getByTitle('Edit A'))
      await user.click(screen.getByRole('button', { name: 'Delete field' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete field?' })
      await user.type(within(dialog).getByPlaceholderText('A'), 'A')
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(onFieldsUpdated).toHaveBeenCalledWith([defB]))
      expect(mockApi.deleteSwimlaneCustomFieldDefinition).toHaveBeenCalledWith(1, 1)
      expect(screen.queryByPlaceholderText(NAME)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '+ Add field' })).toBeInTheDocument()
    })

    it('keeps the editor and its edits open when the DELETE fails', async () => {
      const user = userEvent.setup()
      mockApi.deleteSwimlaneCustomFieldDefinition.mockRejectedValue(new Error('boom'))
      const onFieldsUpdated = renderTab([defA, defB])
      await user.click(screen.getByTitle('Edit A'))
      await user.type(screen.getByPlaceholderText(NAME), ' 2')
      await user.click(screen.getByRole('button', { name: 'Delete field' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete field?' })
      await user.type(within(dialog).getByPlaceholderText('A'), 'A')
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(mockApi.deleteSwimlaneCustomFieldDefinition).toHaveBeenCalled())
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete field?' })).not.toBeInTheDocument())
      expect(screen.getByPlaceholderText(NAME)).toHaveValue('A 2')
      expect(onFieldsUpdated).not.toHaveBeenCalled()
    })

    it('disables Delete field while a save is in flight', async () => {
      const user = userEvent.setup()
      mockApi.updateSwimlaneCustomFieldDefinition.mockReturnValue(new Promise(() => {}))
      renderTab([defA])
      await user.click(screen.getByTitle('Edit A'))
      await user.click(screen.getByRole('button', { name: 'Save field' }))
      expect(screen.getByRole('button', { name: 'Delete field' })).toBeDisabled()
    })

    it('announces a save error in a polite status region', async () => {
      const user = userEvent.setup()
      mockApi.updateSwimlaneCustomFieldDefinition.mockRejectedValue(new Error('boom'))
      renderTab([defA])
      await user.click(screen.getByTitle('Edit A'))
      await user.click(screen.getByRole('button', { name: 'Save field' }))
      const err = await screen.findByText(/Couldn't save this field/)
      const status = screen.getAllByRole('status').find((el) => el.contains(err))
      expect(status).toBeDefined()
      expect(status).toHaveAttribute('aria-live', 'polite')
    })

    it('keeps Delete off the default focus and Save out of its neighbor slot', async () => {
      const user = userEvent.setup()
      renderTab([defA])
      await user.click(screen.getByTitle('Edit A'))
      const del = screen.getByRole('button', { name: 'Delete field' })
      const cancel = screen.getByRole('button', { name: 'Cancel' })
      const save = screen.getByRole('button', { name: 'Save field' })
      expect(del).not.toHaveFocus()
      expect(screen.getByPlaceholderText(NAME)).toHaveFocus()
      // DOM (= Tab) order: Delete, Cancel, Save.
      expect(del.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(cancel.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(del.className).toContain('bg-danger-bg')
      expect(del.className).toContain('mr-auto')
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
