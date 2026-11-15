import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FilterPanel from '../components/Board/FilterPanel'
import { EMPTY_FILTER } from '../components/Board/FilterBar'
import type { FilterState } from '../components/Board/FilterBar'
import type { BoardFull, SavedFilter, User } from '../types'

const user1: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane', last_name: 'Doe', avatar_url: '',
  display_name: 'Jane Doe', is_site_admin: false, must_change_password: false, must_change_username: false,
}

function cf(over: Record<string, unknown>) {
  return { position: 0, choices: [], show_on_card: false, ...over }
}

function makeBoard(over: Partial<BoardFull> = {}): BoardFull {
  return {
    id: 1, uid: 'b1', name: 'B', cards: [], columns: [], swimlanes: [],
    labels: [{ id: 100, uid: 'l1', name: 'Bug', color: '#EF4444' }],
    members: [{ id: 1, user: user1, role: 'admin', is_moderator: false, joined_at: '' }],
    current_user_role: 'admin',
    custom_field_definitions: [
      cf({ id: 7, name: 'Region', field_type: 'dropdown', choices: ['EMEA', 'APAC'], position: 0 }),
      cf({ id: 8, name: 'Notes', field_type: 'text', position: 1 }),
      cf({ id: 9, name: 'Budget', field_type: 'number', position: 2 }),
      cf({ id: 10, name: 'Go live', field_type: 'date', position: 3 }),
      cf({ id: 11, name: 'Approved', field_type: 'checkbox', position: 4 }),
    ],
    swimlane_custom_field_definitions: [],
    ...over,
  } as unknown as BoardFull
}

const saved: SavedFilter[] = [
  { id: 5, name: 'My open work', state_json: {}, state_version: 1, created_at: '' },
]

function setup(over: { filters?: FilterState; board?: BoardFull; savedFilters?: SavedFilter[]; activeFilterId?: number | null } = {}) {
  const onChange = vi.fn()
  const onLoadSaved = vi.fn()
  const onToggleFilterBar = vi.fn()
  const onOpenLaneFilters = vi.fn()
  render(
    <FilterPanel
      board={over.board ?? makeBoard()}
      filters={over.filters ?? EMPTY_FILTER}
      onChange={onChange}
      activeCount={0}
      icon={null}
      savedFilters={over.savedFilters ?? saved}
      activeFilterId={over.activeFilterId ?? null}
      onLoadSaved={onLoadSaved}
      filterBarShown={false}
      onToggleFilterBar={onToggleFilterBar}
      onOpenLaneFilters={onOpenLaneFilters}
    />,
  )
  return { onChange, onLoadSaved, onToggleFilterBar, onOpenLaneFilters }
}

const open = async (u: ReturnType<typeof userEvent.setup>) => u.click(screen.getByRole('button', { name: /^Filters/ }))

describe('FilterPanel (#2301)', () => {
  it('opens with Find a field focused, one row per field showing Any, and saved filters', async () => {
    const u = userEvent.setup()
    setup()
    expect(screen.queryByRole('dialog')).toBeNull()
    await open(u)
    expect(screen.getByRole('dialog', { name: 'Filter' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Find a field' })).toHaveFocus()
    const rows = within(screen.getByRole('list', { name: 'Filterable fields' })).getAllByRole('button')
    expect(rows.map((r) => r.textContent)).toEqual([
      'AssigneeAny', 'LabelAny', 'PriorityAny', 'Due dateAny', 'BlockedAny',
      'RegionAny', 'NotesAny', 'BudgetAny', 'Go liveAny', 'ApprovedAny',
    ])
    expect(screen.getByText('Saved filters')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'My open work' })).toBeInTheDocument()
  })

  it('Find a field narrows the rows and reports no match', async () => {
    const u = userEvent.setup()
    setup()
    await open(u)
    await u.type(screen.getByRole('textbox', { name: 'Find a field' }), 'reg')
    expect(screen.getAllByRole('button', { name: /Any$/ }).map((b) => b.textContent)).toEqual(['RegionAny'])
    await u.clear(screen.getByRole('textbox', { name: 'Find a field' }))
    await u.type(screen.getByRole('textbox', { name: 'Find a field' }), 'zzz')
    expect(screen.getByRole('status')).toHaveTextContent('No field matches "zzz"')
  })

  it('tints an active row and shows its value', async () => {
    const u = userEvent.setup()
    setup({ filters: { ...EMPTY_FILTER, labelIds: [100], priorities: ['high'], dueDate: 'overdue', assigneeIds: [-1, 1], blockedOnly: true } })
    await open(u)
    expect(screen.getByRole('button', { name: /^Label/ })).toHaveTextContent('Bug')
    expect(screen.getByRole('button', { name: /^Label/ }).className).toContain('font-semibold')
    expect(screen.getByRole('button', { name: /^Priority/ })).toHaveTextContent('High')
    expect(screen.getByRole('button', { name: /^Due date/ })).toHaveTextContent('Overdue')
    expect(screen.getByRole('button', { name: /^Assignee/ })).toHaveTextContent('Unassigned, Jane Doe')
    expect(screen.getByRole('button', { name: /^Blocked/ })).toHaveTextContent('Blocked only')
  })

  it('edits assignee, label, priority, due date and blocked through the same FilterState', async () => {
    const u = userEvent.setup()
    const { onChange } = setup()
    await open(u)
    await u.click(screen.getByRole('button', { name: /^Assignee/ }))
    await u.click(screen.getByRole('checkbox', { name: 'Unassigned' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, assigneeIds: [-1] })
    await u.click(screen.getByRole('checkbox', { name: 'Jane Doe' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, assigneeIds: [1] })

    await u.click(screen.getByRole('button', { name: /^Label/ }))
    await u.click(screen.getByRole('checkbox', { name: 'Bug' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, labelIds: [100] })

    await u.click(screen.getByRole('button', { name: /^Priority/ }))
    await u.click(screen.getByRole('checkbox', { name: 'Urgent' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, priorities: ['urgent'] })

    await u.click(screen.getByRole('button', { name: /^Due date/ }))
    await u.click(screen.getByRole('radio', { name: 'Overdue' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, dueDate: 'overdue' })

    await u.click(screen.getByRole('button', { name: /^Blocked/ }))
    await u.click(screen.getByRole('checkbox', { name: /Blocked only/ }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, blockedOnly: true })
  })

  it('unchecks a selected value and clears a due date back to Any', async () => {
    const u = userEvent.setup()
    const { onChange } = setup({ filters: { ...EMPTY_FILTER, labelIds: [100], dueDate: 'today' } })
    await open(u)
    await u.click(screen.getByRole('button', { name: /^Label/ }))
    await u.click(screen.getByRole('checkbox', { name: 'Bug' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, dueDate: 'today', labelIds: [] })
    await u.click(screen.getByRole('button', { name: /^Due date/ }))
    await u.click(screen.getByRole('radio', { name: 'Any' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, labelIds: [100], dueDate: null })
  })

  it('edits every custom field type', async () => {
    const u = userEvent.setup()
    const { onChange } = setup()
    await open(u)
    await u.click(screen.getByRole('button', { name: /^Region/ }))
    await u.click(screen.getByRole('checkbox', { name: 'APAC' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, customFields: { 7: { kind: 'choice', values: ['APAC'] } } })

    await u.click(screen.getByRole('button', { name: /^Notes/ }))
    await u.type(screen.getByRole('textbox', { name: 'Notes' }), 'x')
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, customFields: { 8: { kind: 'text', query: 'x' } } })

    await u.click(screen.getByRole('button', { name: /^Budget/ }))
    await u.type(screen.getByRole('spinbutton', { name: 'Budget' }), '5')
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, customFields: { 9: { kind: 'number', equals: '5' } } })

    await u.click(screen.getByRole('button', { name: /^Go live/ }))
    const date = screen.getByLabelText('Go live') as HTMLInputElement
    expect(date.type).toBe('date')

    await u.click(screen.getByRole('button', { name: /^Approved/ }))
    await u.click(screen.getByRole('checkbox', { name: 'Yes' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, customFields: { 11: { kind: 'choice', values: ['true'] } } })
  })

  it('summarizes active custom field values on the row', async () => {
    const u = userEvent.setup()
    setup({ filters: { ...EMPTY_FILTER, customFields: { 7: { kind: 'choice', values: ['EMEA'] }, 8: { kind: 'text', query: 'abc' }, 9: { kind: 'number', equals: '4' } } } })
    await open(u)
    expect(screen.getByRole('button', { name: /^Region/ })).toHaveTextContent('EMEA')
    expect(screen.getByRole('button', { name: /^Notes/ })).toHaveTextContent('abc')
    expect(screen.getByRole('button', { name: /^Budget/ })).toHaveTextContent('4')
  })

  it('only one row is expanded at a time', async () => {
    const u = userEvent.setup()
    setup()
    await open(u)
    await u.click(screen.getByRole('button', { name: /^Label/ }))
    expect(screen.getByRole('button', { name: /^Label/ })).toHaveAttribute('aria-expanded', 'true')
    await u.click(screen.getByRole('button', { name: /^Priority/ }))
    expect(screen.getByRole('button', { name: /^Label/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows the Lanes row only with swimlane fields and hands off to the Lanes popover', async () => {
    const u = userEvent.setup()
    const board = makeBoard({
      swimlane_custom_field_definitions: [cf({ id: 50, name: 'Region', field_type: 'dropdown', choices: ['A'], is_admin_only: false })] as never,
    })
    const { onOpenLaneFilters } = setup({ board })
    await open(u)
    await u.click(screen.getByRole('button', { name: /^Lanes/ }))
    expect(onOpenLaneFilters).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('has no Lanes row when the board has no swimlane fields', async () => {
    const u = userEvent.setup()
    setup()
    await open(u)
    expect(screen.queryByRole('button', { name: /^Lanes/ })).toBeNull()
  })

  it('loads a saved filter and closes, marking the active one', async () => {
    const u = userEvent.setup()
    const { onLoadSaved } = setup()
    await open(u)
    await u.click(screen.getByRole('button', { name: 'My open work' }))
    expect(onLoadSaved).toHaveBeenCalledWith(saved[0])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('marks the active saved filter and lists an empty state', async () => {
    const u = userEvent.setup()
    setup({ activeFilterId: 5 })
    await open(u)
    expect(screen.getByRole('button', { name: 'My open work' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('says so when there are no saved filters', async () => {
    const u = userEvent.setup()
    setup({ savedFilters: [] })
    await open(u)
    expect(screen.getByText('No saved filters yet.')).toBeInTheDocument()
  })

  it('footer toggles the full filter bar and closes the panel', async () => {
    const u = userEvent.setup()
    const { onToggleFilterBar } = setup()
    await open(u)
    await u.click(screen.getByRole('button', { name: /Show filter bar/ }))
    expect(onToggleFilterBar).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Escape closes and returns focus to the trigger; outside click closes', async () => {
    const u = userEvent.setup()
    setup()
    await open(u)
    await u.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveFocus()
    await open(u)
    await u.click(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Tab from the trigger enters the panel; Tab off the last control closes the panel', async () => {
    const u = userEvent.setup()
    setup()
    const trigger = screen.getByRole('button', { name: /^Filters/ })
    trigger.focus()
    await u.keyboard('{Enter}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    trigger.focus()
    await u.tab()
    expect(screen.getByRole('textbox', { name: 'Find a field' })).toHaveFocus()
    screen.getByRole('button', { name: /Show filter bar/ }).focus()
    await u.tab()
    // Focus goes to the trigger and the native Tab then moves on to the next toolbar control.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Shift+Tab off Find a field closes the panel', async () => {
    const u = userEvent.setup()
    setup()
    await open(u)
    await u.tab({ shift: true })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('the trigger reports its count and expanded state', async () => {
    const u = userEvent.setup()
    render(
      <FilterPanel board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} activeCount={2} icon={null}
        savedFilters={[]} activeFilterId={null} onLoadSaved={vi.fn()} filterBarShown onToggleFilterBar={vi.fn()} onOpenLaneFilters={vi.fn()} />,
    )
    const trigger = screen.getByRole('button', { name: 'Filters, 2 active' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await u.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Hide filter bar' })).toBeInTheDocument()
  })
})
