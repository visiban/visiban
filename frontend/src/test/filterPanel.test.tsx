import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FilterPanel from '../components/Board/FilterPanel'
import { EMPTY_FILTER, countActiveFilters } from '../components/Board/FilterBar'
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

function setup(over: { activeCount?: number; filters?: FilterState; board?: BoardFull; savedFilters?: SavedFilter[]; activeFilterId?: number | null; onSaveFilter?: (name: string) => Promise<{ error?: string }>; onOpenViewOptions?: (t: HTMLButtonElement) => void } = {}) {
  const onChange = vi.fn()
  const onLoadSaved = vi.fn()
  const onToggleFilterBar = vi.fn()
  const onOpenLaneFilters = vi.fn()
  render(
    <FilterPanel
      board={over.board ?? makeBoard()}
      filters={over.filters ?? EMPTY_FILTER}
      onChange={onChange}
      activeCount={over.activeCount ?? countActiveFilters(over.filters ?? EMPTY_FILTER)}
      icon={null}
      savedFilters={over.savedFilters ?? saved}
      activeFilterId={over.activeFilterId ?? null}
      onLoadSaved={onLoadSaved}
      filterBarShown={false}
      onToggleFilterBar={onToggleFilterBar}
      onOpenLaneFilters={onOpenLaneFilters}
      onSaveFilter={over.onSaveFilter}
      onOpenViewOptions={over.onOpenViewOptions}
    />,
  )
  return { onChange, onLoadSaved, onToggleFilterBar, onOpenLaneFilters }
}

const open = async (u: ReturnType<typeof userEvent.setup>) => u.click(screen.getByRole('button', { name: /^Filters/ }))

describe('FilterPanel (#2301)', () => {
  it('opens with the search input focused, one row per field showing Any, and saved filters', async () => {
    const u = userEvent.setup()
    setup()
    expect(screen.queryByRole('dialog')).toBeNull()
    await open(u)
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Search fields and values to filter' })).toHaveFocus()
    const rows = within(screen.getByRole('list', { name: 'Filterable fields' })).getAllByRole('button')
    expect(rows.map((r) => r.textContent)).toEqual([
      'SearchAny', 'AssigneeAny', 'LabelAny', 'PriorityAny', 'Due dateAny', 'BlockedAny',
      'RegionAny', 'NotesAny', 'BudgetAny', 'Go liveAny', 'ApprovedAny',
    ])
    expect(within(screen.getByTestId('filter-panel-header')).getByRole('list', { name: 'Saved filters' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'My open work' })).toBeInTheDocument()
  })

  it('the search input narrows the rows and reports no match', async () => {
    const u = userEvent.setup()
    setup()
    await open(u)
    await u.type(screen.getByRole('textbox', { name: 'Search fields and values to filter' }), 'reg')
    const rows = screen.getAllByRole('button', { name: /Any$/ })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveAccessibleName('Card Region Dropdown Any')
    await u.clear(screen.getByRole('textbox', { name: 'Search fields and values to filter' }))
    await u.type(screen.getByRole('textbox', { name: 'Search fields and values to filter' }), 'zzz')
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

  it('keeps a row active when its ids no longer resolve, and shows Yes/No for checkbox fields', async () => {
    const u = userEvent.setup()
    setup({ filters: { ...EMPTY_FILTER, assigneeIds: [999], labelIds: [404], customFields: { 11: { kind: 'choice', values: ['true'] } } } })
    await open(u)
    expect(screen.getByRole('button', { name: /^Assignee/ })).toHaveTextContent('1 selected')
    expect(screen.getByRole('button', { name: /^Label/ })).toHaveTextContent('1 selected')
    expect(screen.getByRole('button', { name: /^Approved/ })).toHaveTextContent('Yes')
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

  // #2336 — the same laneFilterAvailable gate as the filter bar's Lanes trigger.
  it('shows the Lanes row without swimlane fields once there are two lanes or a lane filter', async () => {
    const u = userEvent.setup()
    const lane = (id: number) => ({ id, name: `L${id}`, custom_field_values: [] })
    setup({ board: makeBoard({ swimlanes: [lane(1)] as never }) })
    await open(u)
    expect(screen.queryByRole('button', { name: /^Lanes/ })).toBeNull()
    cleanup()
    setup({ board: makeBoard({ swimlanes: [lane(1), lane(2)] as never }) })
    await open(u)
    expect(screen.getByRole('button', { name: /^Lanes/ })).toBeInTheDocument()
    cleanup()
    const lf = { items: [{ kind: 'rule' as const, id: 1, join: 'and' as const, field: 'name' as const, op: 'is' as const, value: 'L1' }] }
    setup({ board: makeBoard({ swimlanes: [lane(1)] as never }), filters: { ...EMPTY_FILTER, laneFilter: lf } })
    await open(u)
    expect(screen.getByRole('button', { name: /^Lanes(?!:)/ })).toHaveTextContent('1 rule')
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

  it('with nothing saved, teaches Save filter only while something is active, else hides the row (#2695)', async () => {
    const u = userEvent.setup()
    setup({ savedFilters: [] })
    await open(u)
    expect(screen.queryByTestId('filter-panel-saved')).toBeNull()
    expect(screen.queryByText(/None yet/)).toBeNull()
    cleanup()
    setup({ savedFilters: [], filters: { ...EMPTY_FILTER, blockedOnly: true } })
    await open(u)
    expect(within(screen.getByTestId('filter-panel-saved')).getByText('None yet. Save this view to reuse it in one click.')).toBeInTheDocument()
  })

  it('the header Filter bar switch toggles the bar and keeps the panel open with focus on the switch (#2691)', async () => {
    const u = userEvent.setup()
    const { onToggleFilterBar } = setup()
    await open(u)
    const sw = within(screen.getByTestId('filter-panel-header')).getByRole('button', { name: 'Filter bar' })
    expect(sw).toHaveAttribute('aria-pressed', 'false')
    expect(sw).toHaveAttribute('aria-keyshortcuts', 'f')
    await u.click(sw)
    expect(onToggleFilterBar).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument()
    expect(sw).toHaveFocus()
    // The old footer action is gone: the switch replaces it.
    expect(screen.queryByRole('button', { name: /Show filter bar|Hide filter bar/ })).toBeNull()
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

  it('Tab from the trigger enters the panel at the Filter bar switch (#2691)', async () => {
    const u = userEvent.setup()
    setup()
    const trigger = screen.getByRole('button', { name: /^Filters/ })
    trigger.focus()
    await u.keyboard('{Enter}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    trigger.focus()
    await u.tab()
    expect(screen.getByRole('button', { name: 'Filter bar' })).toHaveFocus()
  })

  it('contains focus: Tab order is switch, search, scope chips, one stop for the list, Clear all, Save filter, then wraps (#2691)', async () => {
    const u = userEvent.setup()
    setup({ filters: { ...EMPTY_FILTER, priorities: ['high'] }, onSaveFilter: vi.fn(), savedFilters: [] })
    await open(u)
    const dialog = screen.getByRole('dialog', { name: 'Filters' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    screen.getByRole('button', { name: 'Filter bar' }).focus()
    const seen: string[] = []
    for (let i = 0; i < 9; i++) {
      await u.tab()
      const el = document.activeElement as HTMLElement
      seen.push(el.getAttribute('aria-label') ?? el.textContent ?? '')
    }
    expect(seen).toEqual([
      'Search fields and values to filter', 'All fields', 'Card fields', 'Swimlane fields',
      'Remove High filter', 'SearchAny', 'Clear all', 'Save filter', 'Filter barF',
    ])
    expect(dialog).toBeInTheDocument()
  })

  it('a scroll outside the panel closes it; a scroll inside it does not', async () => {
    const u = userEvent.setup()
    setup()
    await open(u)
    fireEvent.scroll(screen.getByRole('list', { name: 'Filterable fields' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.scroll(screen.getByRole('dialog'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.scroll(document)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows and edits the search query through filters.search', async () => {
    const u = userEvent.setup()
    const { onChange } = setup({ filters: { ...EMPTY_FILTER, search: 'x' } })
    await open(u)
    const row = screen.getByRole('button', { name: /^Search/ })
    expect(row).toHaveTextContent('x')
    await u.click(row)
    await u.type(screen.getByRole('textbox', { name: 'Search cards' }), 'y')
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, search: 'xy' })
  })

  it('suppresses the Filters tooltip while the panel is open', async () => {
    const u = userEvent.setup()
    setup()
    const trigger = screen.getByRole('button', { name: /^Filters/ })
    await u.click(trigger)
    fireEvent.mouseEnter(trigger.parentElement as HTMLElement)
    trigger.focus()
    await new Promise((r) => setTimeout(r, 400))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('shows a loading state, not the empty message, while saved filters load', async () => {
    const u = userEvent.setup()
    render(
      <FilterPanel board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} activeCount={0} icon={null}
        savedFilters={[]} savedFiltersLoading activeFilterId={null} onLoadSaved={vi.fn()} filterBarShown={false} onToggleFilterBar={vi.fn()} onOpenLaneFilters={vi.fn()} />,
    )
    await u.click(screen.getByRole('button', { name: /^Filters/ }))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText(/None yet/)).toBeNull()
  })

  it('Shift+Tab off the search input reaches the switch, and Shift+Tab off the switch wraps inside the panel (#2691)', async () => {
    const u = userEvent.setup()
    setup()
    await open(u)
    await u.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Filter bar' })).toHaveFocus()
    await u.tab({ shift: true })
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('the trigger reports its count and expanded state', async () => {
    const u = userEvent.setup()
    render(
      <FilterPanel board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} activeCount={2} icon={null}
        savedFilters={[]} activeFilterId={null} onLoadSaved={vi.fn()} filterBarShown onToggleFilterBar={vi.fn()} onOpenLaneFilters={vi.fn()} />,
    )
    const trigger = screen.getByRole('button', { name: 'Filters, 2 active' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    // A real space before the badge keeps the visible text a whole-word match for the name (#2467).
    expect(trigger.textContent).toBe('Filters 2')
    await u.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Filter bar' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('an active row and the active saved filter use the persistent-active fill, never bg-info (#2301)', async () => {
    const u = userEvent.setup()
    setup({ filters: { ...EMPTY_FILTER, priorities: ['high'] }, activeFilterId: 5 })
    await open(u)
    for (const el of [screen.getByRole('button', { name: /^Priority/ }), screen.getByRole('button', { name: 'My open work' })]) {
      expect(el.className).toContain('bg-primary-emphasis/10')
      expect(el.className).toContain('text-info-on-tint')
      expect(el.className).not.toContain('bg-info/')
    }
    expect(screen.getByRole('button', { name: /^Assignee/ }).className).not.toContain('bg-primary-emphasis')
  })

  it('stays open on a height-only resize while focus is inside (soft keyboard), closes otherwise', async () => {
    const u = userEvent.setup()
    setup()
    await open(u)
    expect(screen.getByRole('textbox', { name: 'Search fields and values to filter' })).toHaveFocus()
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument()
    // Width change closes even with focus inside.
    const w = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: w + 100 })
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(screen.queryByRole('dialog')).toBeNull()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: w })
    // Focus outside the panel: a resize closes as before.
    await open(u)
    act(() => { (document.activeElement as HTMLElement).blur() })
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a color dot on dropdown choices but none on multi-select choices', async () => {
    const u = userEvent.setup()
    const board = makeBoard({
      custom_field_definitions: [
        cf({ id: 7, name: 'Region', field_type: 'dropdown', choices: ['EMEA', 'APAC'], position: 0 }),
        cf({ id: 8, name: 'Tags', field_type: 'multi_select', choices: ['a', 'b'], position: 1 }),
      ] as never,
    })
    setup({ board })
    await open(u)
    await u.click(screen.getByRole('button', { name: /^Region/ }))
    const region = screen.getByRole('group', { name: 'Region' })
    const dots = region.querySelectorAll('span[aria-hidden="true"]')
    expect(dots).toHaveLength(2)
    dots.forEach((d) => expect((d as HTMLElement).style.backgroundColor).not.toBe(''))
    await u.click(screen.getByRole('button', { name: /^Tags/ }))
    expect(screen.getByRole('group', { name: 'Tags' }).querySelectorAll('span[aria-hidden="true"]')).toHaveLength(0)
  })
})

describe('FilterPanel Filtered by row (#2315)', () => {
  const active: FilterState = { ...EMPTY_FILTER, labelIds: [100], priorities: ['high'], blockedOnly: true }

  it('shows no row when nothing is filtered', async () => {
    const u = userEvent.setup()
    setup({ onSaveFilter: vi.fn() })
    await open(u)
    expect(screen.queryByTestId('filter-panel-chips')).toBeNull()
  })

  it('lists one removable chip per active filter, and dismisses like the filter bar', async () => {
    const u = userEvent.setup()
    const { onChange } = setup({ filters: active, onSaveFilter: vi.fn() })
    await open(u)
    const group = screen.getByRole('group', { name: 'Filtered by' })
    // Each chip is a role=button span holding a (tab-skipped) × button with the same name.
    const names = new Set(within(group).getAllByRole('button').map((b) => b.getAttribute('aria-label')))
    expect([...names]).toEqual(['Remove Bug filter', 'Remove High filter', 'Remove Blocked only filter'])
    await u.click(within(group).getAllByRole('button', { name: 'Remove Bug filter' })[1])
    expect(onChange).toHaveBeenLastCalledWith({ ...active, labelIds: [] })
    // Keyboard: Delete on the focused chip dismisses it
    within(group).getAllByRole('button', { name: 'Remove High filter' })[0].focus()
    await u.keyboard('{Delete}')
    expect(onChange).toHaveBeenLastCalledWith({ ...active, priorities: [] })
  })

  it('Clear all resets to the empty filter', async () => {
    const u = userEvent.setup()
    const { onChange } = setup({ filters: active, onSaveFilter: vi.fn() })
    await open(u)
    await u.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(onChange).toHaveBeenCalledWith(EMPTY_FILTER)
  })

  it('returns focus to Save filter when Escape closes the name input', async () => {
    const u = userEvent.setup()
    setup({ filters: active, onSaveFilter: vi.fn() })
    await open(u)
    await u.click(screen.getByRole('button', { name: 'Save filter' }))
    await u.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Save filter' })).toHaveFocus()
  })

  it('falls back to the search input when the row goes away (Clear all with the filters prop updated)', async () => {
    const u = userEvent.setup()
    function Wrapper() {
      const [f, setF] = useState<FilterState>(active)
      return (
        <FilterPanel
          board={makeBoard()} filters={f} onChange={setF} activeCount={countActiveFilters(f)} icon={null}
          savedFilters={saved} activeFilterId={null} onLoadSaved={vi.fn()} filterBarShown={false}
          onToggleFilterBar={vi.fn()} onOpenLaneFilters={vi.fn()} onSaveFilter={vi.fn()}
        />
      )
    }
    render(<Wrapper />)
    await open(u)
    await u.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(screen.queryByTestId('filter-panel-chips')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Search fields and values to filter' })).toHaveFocus()
  })

  it('keeps focus in the panel when a chip is removed: the neighbor chip, then Clear all', async () => {
    const u = userEvent.setup()
    function Wrapper() {
      const [f, setF] = useState<FilterState>(active)
      return (
        <FilterPanel
          board={makeBoard()} filters={f} onChange={setF} activeCount={countActiveFilters(f)} icon={null}
          savedFilters={saved} activeFilterId={null} onLoadSaved={vi.fn()} filterBarShown={false}
          onToggleFilterBar={vi.fn()} onOpenLaneFilters={vi.fn()} onSaveFilter={vi.fn()}
        />
      )
    }
    render(<Wrapper />)
    await open(u)
    const group = () => screen.getByRole('group', { name: 'Filtered by' })
    // Bug, High, Blocked: remove the first; the chip that takes its place (High) gets focus.
    await u.click(within(group()).getAllByRole('button', { name: 'Remove Bug filter' })[1])
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(within(group()).getAllByRole('button', { name: 'Remove High filter' })[0]).toHaveFocus()
    // Remove the last (Blocked): the previous chip (High) gets focus.
    await u.click(within(group()).getAllByRole('button', { name: 'Remove Blocked only filter' })[1])
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(within(group()).getAllByRole('button', { name: 'Remove High filter' })[0]).toHaveFocus()
  })

  it('keeps focus in the panel when a lane chip is removed, falling back to Clear all', async () => {
    const u = userEvent.setup()
    const laneBoard = makeBoard({
      swimlane_custom_field_definitions: [{
        id: 21, uid: 'slf21', name: 'Team', field_type: 'dropdown', choices: ['Red', 'Blue'], position: 1, show_on_row: false, is_admin_only: false,
      }] as never,
    })
    const laneFilter = { items: [{ kind: 'rule', id: 1, join: 'and', field: 21, op: 'is', value: 'Red' }] }
    function Wrapper() {
      const [f, setF] = useState<FilterState>({ ...EMPTY_FILTER, blockedOnly: true, laneFilter } as unknown as FilterState)
      return (
        <FilterPanel
          board={laneBoard} filters={f} onChange={setF} activeCount={countActiveFilters(f)} icon={null}
          savedFilters={saved} activeFilterId={null} onLoadSaved={vi.fn()} filterBarShown={false}
          onToggleFilterBar={vi.fn()} onOpenLaneFilters={vi.fn()} onSaveFilter={vi.fn()}
        />
      )
    }
    render(<Wrapper />)
    await open(u)
    const group = screen.getByRole('group', { name: 'Filtered by' })
    const btns = within(group).getAllByRole('button', { name: 'Lanes: Team is Red, remove' })
    await u.click(btns[btns.length - 1])
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // The lane chip was last; the Blocked chip before it takes focus.
    expect(within(screen.getByRole('group', { name: 'Filtered by' })).getAllByRole('button', { name: 'Remove Blocked only filter' })[0]).toHaveFocus()
  })

  it('offers Clear all and Save filter when an unresolved assignee counts but has no chip', async () => {
    const u = userEvent.setup()
    const { onChange } = setup({ filters: { ...EMPTY_FILTER, assigneeIds: [9999] }, onSaveFilter: vi.fn() })
    await open(u)
    expect(screen.getByRole('button', { name: 'Save filter' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Filtered by' })).toBeNull()
    await u.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(onChange).toHaveBeenCalledWith(EMPTY_FILTER)
  })

  it('Save filter asks for a name, saves through the shared handler and closes the form', async () => {
    const u = userEvent.setup()
    const onSaveFilter = vi.fn().mockResolvedValue({})
    setup({ filters: active, onSaveFilter })
    await open(u)
    await u.click(screen.getByRole('button', { name: 'Save filter' }))
    const input = screen.getByRole('textbox', { name: 'Save current filters as:' })
    expect(input).toHaveFocus()
    await u.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Filter name is required.')
    expect(onSaveFilter).not.toHaveBeenCalled()
    await u.type(input, '  Hot bugs {Enter}')
    expect(onSaveFilter).toHaveBeenCalledWith('Hot bugs')
    expect(screen.queryByRole('textbox', { name: 'Save current filters as:' })).toBeNull()
  })

  it('keeps the form open and shows the error when saving fails; Escape cancels the form first', async () => {
    const u = userEvent.setup()
    const onSaveFilter = vi.fn().mockResolvedValue({ error: 'Name already taken.' })
    setup({ filters: active, onSaveFilter })
    await open(u)
    await u.click(screen.getByRole('button', { name: 'Save filter' }))
    await u.type(screen.getByRole('textbox', { name: 'Save current filters as:' }), 'Dup{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('Name already taken.')
    await u.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Save current filters as:' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument()
  })

  it('caps the save name at 100 characters, like the Saved dropdown', async () => {
    const u = userEvent.setup()
    setup({ filters: active, onSaveFilter: vi.fn() })
    await open(u)
    await u.click(screen.getByRole('button', { name: 'Save filter' }))
    expect(screen.getByRole('textbox', { name: 'Save current filters as:' })).toHaveAttribute('maxlength', '100')
  })

  it('dismisses a lane chip through onChange', async () => {
    const u = userEvent.setup()
    const laneBoard = makeBoard({
      swimlane_custom_field_definitions: [{
        id: 21, uid: 'slf21', name: 'Team', field_type: 'dropdown', choices: ['Red', 'Blue'], position: 1, show_on_row: false, is_admin_only: false,
      }] as never,
    })
    const laneFilter = { items: [{ kind: 'rule', id: 1, join: 'and', field: 21, op: 'is', value: 'Red' }] }
    const { onChange } = setup({ board: laneBoard, filters: { ...EMPTY_FILTER, laneFilter } as unknown as FilterState, onSaveFilter: vi.fn() })
    await open(u)
    const group = screen.getByRole('group', { name: 'Filtered by' })
    const btns = within(group).getAllByRole('button', { name: 'Lanes: Team is Red, remove' })
    await u.click(btns[btns.length - 1])
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as FilterState
    expect(next.laneFilter).toBeUndefined()
  })

  it('shows Clear all and Save filter, with no chips, for a search-only filter', async () => {
    const u = userEvent.setup()
    const { onChange } = setup({ filters: { ...EMPTY_FILTER, search: 'crash' }, onSaveFilter: vi.fn() })
    await open(u)
    expect(screen.queryByRole('group', { name: 'Filtered by' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save filter' })).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(onChange).toHaveBeenCalledWith(EMPTY_FILTER)
  })

  it('omits Save filter when no save handler is wired', async () => {
    const u = userEvent.setup()
    setup({ filters: active })
    await open(u)
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save filter' })).toBeNull()
  })
})

describe('FilterPanel on phones: one Filter button for filters and View (#2340)', () => {
  it('has no View options button without the phone handoff', async () => {
    const u = userEvent.setup()
    setup()
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
    await open(u)
    expect(screen.queryByRole('button', { name: 'View options' })).toBeNull()
  })

  it('names the trigger for both panels and hands it to the View panel from the heading row', async () => {
    const u = userEvent.setup()
    const onOpenViewOptions = vi.fn()
    setup({ onOpenViewOptions, activeCount: 2 })
    const trigger = screen.getByRole('button', { name: 'Filters and view options, 2 active' })
    await open(u)
    const viewBtn = within(screen.getByTestId('filter-panel')).getByRole('button', { name: 'View options' })
    expect(viewBtn).toHaveAttribute('aria-haspopup', 'dialog')
    await u.click(viewBtn)
    expect(screen.queryByTestId('filter-panel')).toBeNull()
    expect(onOpenViewOptions).toHaveBeenCalledWith(trigger)
  })

  it('lifts every panel button and text input to 44px at phone width', async () => {
    const u = userEvent.setup()
    setup()
    await open(u)
    expect(screen.getByTestId('filter-panel')).toHaveClass('max-sm:[&_button]:min-h-11', 'max-sm:[&_input[type=text]]:min-h-11', 'max-sm:[&_input[type=date]]:min-h-11')
    // A checkbox or radio row's target is its label, not the 16px input.
    await u.click(screen.getByRole('button', { name: /^Due date/ }))
    expect(screen.getByRole('radio', { name: 'Any' }).closest('label')).toHaveClass('max-sm:min-h-11')
    await u.click(screen.getByRole('button', { name: /^Priority/ }))
    expect(screen.getAllByRole('checkbox')[0].closest('label')).toHaveClass('max-sm:min-h-11')
  })
})

// #2437 — field and value search.
describe('FilterPanel search (#2437)', () => {
  const box = () => screen.getByRole('textbox', { name: 'Search fields and values to filter' })
  const cv = (field_definition: number, value: string) => ({ field_definition, value })
  const searchBoard = (role: string | null = 'admin') => makeBoard({
    current_user_role: (role ?? undefined) as never,
    cards: [
      { id: 1, title: '', description: '', assignee: null, labels: [], custom_field_values: [cv(7, 'EMEA')] },
      { id: 2, title: '', description: '', assignee: null, labels: [], custom_field_values: [cv(7, 'EMEA')] },
      { id: 3, title: '', description: '', assignee: null, labels: [], custom_field_values: [cv(7, 'APAC')] },
    ] as never,
    swimlanes: [
      { id: 1, name: 'Acme', custom_field_values: [cv(50, 'gold'), cv(51, 'hunter2')] },
      { id: 2, name: 'Bolt', custom_field_values: [cv(50, 'silver')] },
    ] as never,
    lane_details_cap: 6,
    swimlane_custom_field_definitions: [
      { id: 50, uid: 'a', name: 'Tier', field_type: 'dropdown', choices: ['gold', 'silver'], position: 0, show_on_row: false, is_admin_only: false, is_required: false, help_text: '', band_visibility: 'hidden' },
      { id: 51, uid: 'b', name: 'Secret code', field_type: 'text', choices: [], position: 1, show_on_row: false, is_admin_only: true, is_required: false, help_text: '', band_visibility: 'band' },
    ] as never,
  })

  it('is 520px wide with scope chips, the Esc keycap and the footer hint', async () => {
    const u = userEvent.setup()
    setup()
    await open(u)
    expect(screen.getByTestId('filter-panel').style.width).toBe('520px')
    expect(screen.getByRole('button', { name: 'All fields' })).toHaveAttribute('aria-pressed', 'true')
    await u.click(screen.getByRole('button', { name: 'Card fields' }))
    expect(screen.getByRole('button', { name: 'Card fields' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'All fields' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Esc')).toBeInTheDocument()
    expect(screen.getByText(/field:value$/)).toBeInTheDocument()
  })

  it('lists matching values with counts and adds the filter on click', async () => {
    const u = userEvent.setup()
    const { onChange } = setup({ board: searchBoard() })
    await open(u)
    await u.type(box(), 'emea')
    const row = screen.getByRole('button', { name: /Region is EMEA/ })
    expect(row).toHaveTextContent('2 cards')
    expect(screen.getByRole('button', { name: /Title contains .emea./ })).toBeInTheDocument()
    await u.click(row)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ customFields: { 7: { kind: 'choice', values: ['EMEA'] } } }))
  })

  it('a Hidden lane field is found by name and value and labeled (hidden on band)', async () => {
    const u = userEvent.setup()
    const { onChange, onOpenLaneFilters } = setup({ board: searchBoard() })
    await open(u)
    await u.type(box(), 'gold')
    const row = screen.getByRole('button', { name: /Tier is gold/ })
    expect(row).toHaveTextContent('(hidden on band)')
    expect(row).toHaveTextContent('1 lane')
    await u.click(row)
    expect(onChange.mock.calls[0][0].laneFilter.items[0]).toMatchObject({ field: 50, op: 'is', value: 'gold' })
    await u.clear(box())
    await u.type(box(), 'tier')
    await u.click(screen.getByRole('button', { name: /Swimlane.*Tier/ }))
    expect(onOpenLaneFilters).toHaveBeenCalled()
  })

  it('a lane field with several values lists them and counts as active (#2659)', async () => {
    const u = userEvent.setup()
    const laneFilter = { items: [{ kind: 'rule', id: 1, join: 'and', field: 52, op: 'is', values: ['gold', 'silver'] }] }
    // Several values are a multi-select shape (a dropdown rule with `values` is unusable), so use a multi-select field.
    const base = searchBoard()
    const board = { ...base, swimlane_custom_field_definitions: [
      { ...(base.swimlane_custom_field_definitions as never[])[0] as object, id: 52, name: 'Tier', field_type: 'multi_select' },
    ] } as never
    setup({ board, filters: { ...EMPTY_FILTER, laneFilter } as unknown as FilterState })
    await open(u)
    await u.type(box(), 'tier')
    const row = screen.getByRole('button', { name: /Swimlane.*Tier/ })
    expect(row).toHaveTextContent('gold, silver')
    expect(row).not.toHaveTextContent('Any')
    expect(within(row).getByTestId('filter-row-mark')).toBeInTheDocument()
  })

  it.each<[string, Record<string, unknown>, string]>([
    ['is, one value', { op: 'is', value: 'gold' }, 'gold'],
    ['is not, one value', { op: 'is_not', value: 'gold' }, 'not gold'],
    ['is not, several values', { op: 'is_not', values: ['gold', 'silver'] }, 'none of gold, silver'],
  ])('the lane row keeps the operator: %s (#2708)', async (_name, rule, text) => {
    const u = userEvent.setup()
    const base = searchBoard()
    const board = { ...base, swimlane_custom_field_definitions: [
      { ...(base.swimlane_custom_field_definitions as never[])[0] as object, id: 52, name: 'Tier', field_type: 'multi_select' },
    ] } as never
    const laneFilter = { items: [{ kind: 'rule', id: 1, join: 'and', field: 52, ...rule }] }
    setup({ board, filters: { ...EMPTY_FILTER, laneFilter } as unknown as FilterState })
    await open(u)
    await u.type(box(), 'tier')
    const row = screen.getByRole('button', { name: /Swimlane.*Tier/ })
    expect(row.textContent).toContain(text)
    if (rule.op === 'is') expect(row.textContent).not.toContain('not ')
  })

  it('field:value applies with Enter', async () => {
    const u = userEvent.setup()
    const { onChange } = setup({ board: searchBoard() })
    await open(u)
    await u.type(box(), 'tier:silver{Enter}')
    expect(onChange.mock.calls[0][0].laneFilter.items[0]).toMatchObject({ field: 50, value: 'silver' })
  })

  it('Enter with no value hit falls back to Title contains', async () => {
    const u = userEvent.setup()
    const { onChange } = setup({ board: searchBoard() })
    await open(u)
    await u.type(box(), 'zzz{Enter}')
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ search: 'zzz' }))
  })

  it('Enter on a lane-field name with no value hit opens swimlane filters, not a title search (#2437)', async () => {
    const u = userEvent.setup()
    const { onChange, onOpenLaneFilters } = setup({ board: searchBoard() })
    await open(u)
    await u.type(box(), 'tier{Enter}')
    expect(onOpenLaneFilters).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  })

  describe('#2660 design fidelity', () => {
    const boardWith = () => {
      const b = searchBoard() as unknown as { swimlane_custom_field_definitions: unknown[]; cards: Record<string, unknown>[] }
      return {
        ...b,
        cards: [{ ...b.cards[0], title: 'Pricing page' }, { ...b.cards[1], title: 'Priority fix' }, { ...b.cards[2], title: 'Other' }],
        swimlane_custom_field_definitions: [
          ...b.swimlane_custom_field_definitions,
          { id: 52, uid: 'c', name: 'Approved lane', field_type: 'checkbox', choices: [], position: 2, show_on_row: false, is_admin_only: false, is_required: false, help_text: '', band_visibility: 'band' },
          { id: 53, uid: 'd', name: 'Regions', field_type: 'multi_select', choices: ['X'], position: 3, show_on_row: false, is_admin_only: false, is_required: false, help_text: '', band_visibility: 'band' },
          { id: 54, uid: 'e', name: 'Renewal', field_type: 'date', choices: [], position: 4, show_on_row: false, is_admin_only: false, is_required: false, help_text: '', band_visibility: 'band' },
        ],
      } as never
    }

    it('footer reads Enter to add and the scope group is labeled Search in', async () => {
      const u = userEvent.setup()
      setup({ board: boardWith() })
      await open(u)
      expect(screen.getByText(/move ·/)).toHaveTextContent('↑↓ move · ↵ add · field:value')
      expect(screen.getByRole('group', { name: 'Search in' })).toBeInTheDocument()
    })

    it('a checkbox lane field row shows Yes or No and capitalized type names', async () => {
      const u = userEvent.setup()
      const filters = { ...EMPTY_FILTER, laneFilter: { items: [{ kind: 'rule', id: 1, join: 'and', field: 52, op: 'is', value: 'false' }] } } as unknown as FilterState
      setup({ board: boardWith(), filters })
      await open(u)
      await u.type(box(), 'approved')
      const row = screen.getByRole('button', { name: /Swimlane.*Approved lane/ })
      expect(row).toHaveTextContent('Checkbox')
      expect(row).toHaveTextContent('No')
      expect(row).not.toHaveTextContent('false')
      await u.clear(box())
      await u.type(box(), 'regions')
      expect(screen.getByRole('button', { name: /Swimlane.*Regions/ })).toHaveTextContent('Multi-select')
      await u.clear(box())
      await u.type(box(), 'region')
      expect(screen.getByText('Dropdown')).toBeInTheDocument()
    })

    it('a checked checkbox lane rule reads Yes', async () => {
      const u = userEvent.setup()
      const filters = { ...EMPTY_FILTER, laneFilter: { items: [{ kind: 'rule', id: 1, join: 'and', field: 52, op: 'is', value: 'true' }] } } as unknown as FilterState
      setup({ board: boardWith(), filters })
      await open(u)
      await u.type(box(), 'approved')
      const row = screen.getByRole('button', { name: /Swimlane.*Approved lane/ })
      expect(row).toHaveTextContent('Yes')
      expect(row).not.toHaveTextContent('true')
    })

    it('the Title contains count includes description matches', async () => {
      const u = userEvent.setup()
      const b = boardWith() as unknown as { cards: Record<string, unknown>[] }
      const board = { ...b, cards: [b.cards[0], b.cards[1], { ...b.cards[2], title: 'Other', description: 'about pricing' }] } as never
      setup({ board })
      await open(u)
      await u.type(box(), 'pri')
      expect(screen.getByRole('button', { name: /Title contains/ })).toHaveTextContent('3 cards')
    })

    it('the Title contains count does not count a card matched only by a label name', async () => {
      const u = userEvent.setup()
      const b = boardWith() as unknown as { cards: Record<string, unknown>[] }
      const board = { ...b, cards: [b.cards[0], { ...b.cards[1], title: 'Other', labels: [{ id: 9, name: 'pricing', color: '#000' }] }, b.cards[2]] } as never
      setup({ board })
      await open(u)
      await u.type(box(), 'pric')
      expect(screen.getByRole('button', { name: /Title contains/ })).toHaveTextContent('1 card')
      expect(screen.getByRole('button', { name: /Title contains/ })).not.toHaveTextContent('2 cards')
    })

    it('a date between lane rule row shows the formatted dates, as its chip does', async () => {
      const u = userEvent.setup()
      const filters = { ...EMPTY_FILTER, laneFilter: { items: [{ kind: 'rule', id: 1, join: 'and', field: 54, op: 'between', min: '2026-01-02', max: '2026-02-03' }] } } as unknown as FilterState
      setup({ board: boardWith(), filters })
      await open(u)
      await u.type(box(), 'renewal')
      const row = screen.getByRole('button', { name: /Swimlane.*Renewal/ })
      expect(row).toHaveTextContent('01/02/2026 to 02/03/2026')
      expect(row).not.toHaveTextContent('2026-01-02')
    })

    it('an incomplete lane rule leaves its field row reading Any', async () => {
      const u = userEvent.setup()
      const filters = { ...EMPTY_FILTER, laneFilter: { items: [{ kind: 'rule', id: 1, join: 'and', field: 54, op: 'between' }, { kind: 'rule', id: 2, join: 'and', field: 50, op: 'is', value: '' }] } } as unknown as FilterState
      setup({ board: boardWith(), filters })
      await open(u)
      await u.type(box(), 'renewal')
      expect(screen.getByRole('button', { name: /Swimlane.*Renewal/ })).toHaveTextContent('Any')
      await u.clear(box())
      await u.type(box(), 'tier')
      expect(screen.getByRole('button', { name: /Swimlane.*Tier/ })).toHaveTextContent('Any')
    })

    it('selecting a lane field row opens that field and Enter on a name hit passes it too', async () => {
      const u = userEvent.setup()
      const { onOpenLaneFilters } = setup({ board: boardWith() })
      await open(u)
      await u.type(box(), 'tier')
      await u.click(screen.getByRole('button', { name: /Swimlane.*Tier/ }))
      expect(onOpenLaneFilters).toHaveBeenLastCalledWith(50)
    })

    it('Enter on a lane name hit passes the field id', async () => {
      const u = userEvent.setup()
      const { onOpenLaneFilters } = setup({ board: boardWith() })
      await open(u)
      await u.type(box(), 'tier{Enter}')
      expect(onOpenLaneFilters).toHaveBeenLastCalledWith(50)
    })

    it('the Title contains row uses curly quotes and counts matching cards', async () => {
      const u = userEvent.setup()
      setup({ board: boardWith() })
      await open(u)
      await u.type(box(), 'pri')
      const row = screen.getByRole('button', { name: /Title contains/ })
      expect(row).toHaveTextContent('Title contains \u201cpri\u201d')
      expect(row).toHaveTextContent('2 cards')
    })
  })

  it('Enter on a card-field name with no value hit opens that field\'s editor, not a title search (#2437)', async () => {
    const u = userEvent.setup()
    const { onChange } = setup({ board: searchBoard() })
    await open(u)
    await u.type(box(), 'region{Enter}')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Region/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('arrow keys move across groups and back to the input', async () => {
    const u = userEvent.setup()
    setup({ board: searchBoard() })
    await open(u)
    await u.type(box(), 'a')
    await u.keyboard('{ArrowDown}')
    const results = Array.from(document.querySelectorAll('[data-fp-result]')) as HTMLElement[]
    expect(results.length).toBeGreaterThan(2)
    expect(results[0]).toHaveFocus()
    await u.keyboard('{ArrowDown}')
    expect(results[1]).toHaveFocus()
    await u.keyboard('{ArrowUp}{ArrowUp}')
    expect(box()).toHaveFocus()
  })

  it('scope chips narrow the results', async () => {
    const u = userEvent.setup()
    setup({ board: searchBoard() })
    await open(u)
    await u.type(box(), 'gold')
    await u.click(screen.getByRole('button', { name: 'Card fields' }))
    expect(screen.queryByRole('button', { name: /Tier is gold/ })).toBeNull()
    await u.click(screen.getByRole('button', { name: 'Swimlane fields' }))
    expect(screen.getByRole('button', { name: /Tier is gold/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Title contains/ })).toBeNull()
  })

  it('Escape clears the query first, then closes', async () => {
    const u = userEvent.setup()
    setup({ board: searchBoard() })
    await open(u)
    await u.type(box(), 'emea')
    await u.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(box()).toHaveValue('')
    expect(box()).toHaveFocus()
    await u.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Escape in the save-name input still cancels it before clearing the query', async () => {
    const u = userEvent.setup()
    setup({ board: searchBoard(), filters: { ...EMPTY_FILTER, blockedOnly: true }, onSaveFilter: vi.fn() })
    await open(u)
    await u.type(box(), 'emea')
    await u.click(screen.getByRole('button', { name: 'Save filter' }))
    await u.keyboard('{Escape}')
    expect(screen.queryByPlaceholderText('Filter name')).toBeNull()
    expect(box()).toHaveValue('emea')
  })

  it('a non-admin never sees an admin-only lane field name or value', async () => {
    for (const role of ['member', 'viewer', null]) {
      cleanup()
      const u = userEvent.setup()
      setup({ board: searchBoard(role) })
      await open(u)
      await u.type(box(), 'secret')
      expect(screen.queryByText(/Secret code/), `name, role ${role}`).toBeNull()
      await u.clear(box())
      await u.type(box(), 'hunter2')
      expect(screen.queryByRole('button', { name: /is hunter2/ }), `value, role ${role}`).toBeNull()
      await u.clear(box())
      await u.type(box(), 'secret code:hunter')
      expect(screen.queryByText(/hunter2/)).toBeNull()
    }
  })

  it('an admin sees the admin-only lane field', async () => {
    const u = userEvent.setup()
    setup({ board: searchBoard('admin') })
    await open(u)
    await u.type(box(), 'hunter2')
    expect(screen.getByRole('button', { name: /Secret code is hunter2/ })).toBeInTheDocument()
  })

  it('field:value shows no false empty state and a Hidden lane name hit is labeled', async () => {
    const u = userEvent.setup()
    setup({ board: searchBoard() })
    await open(u)
    await u.type(box(), 'tier:gold')
    expect(screen.queryByText(/No field matches/)).toBeNull()
    expect(screen.queryByText(/Fields matching/)).toBeNull()
    await u.clear(box())
    await u.type(box(), 'tier')
    expect(screen.getByRole('button', { name: /Swimlane.*Tier.*hidden on band/ })).toBeInTheDocument()
  })

  it('an empty query shows the per-field rows and no result groups', async () => {
    const u = userEvent.setup()
    setup({ board: searchBoard() })
    await open(u)
    expect(screen.getByRole('button', { name: /^Region/ })).toBeInTheDocument()
    expect(screen.queryByText(/Values matching/)).toBeNull()
  })
})

describe('FilterPanel trigger and the hidden filter bar (#2459)', () => {
  const renderPanel = (over: { activeCount: number; filterBarShown: boolean }) =>
    render(
      <FilterPanel board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} activeCount={over.activeCount} icon={null}
        savedFilters={[]} activeFilterId={null} onLoadSaved={vi.fn()} filterBarShown={over.filterBarShown}
        onToggleFilterBar={vi.fn()} onOpenLaneFilters={vi.fn()} />,
    )

  it('exposes the bar state via aria-pressed without tinting on it', () => {
    renderPanel({ activeCount: 0, filterBarShown: true })
    const t = screen.getByRole('button', { name: 'Filters' })
    expect(t).toHaveAttribute('aria-pressed', 'true')
    expect(t.className).not.toContain('bg-info/10')
  })

  it('still tints for active filters', () => {
    renderPanel({ activeCount: 2, filterBarShown: false })
    const t = screen.getByRole('button', { name: 'Filters, 2 active' })
    expect(t).toHaveAttribute('aria-pressed', 'false')
    expect(t.className).toContain('bg-info/10')
  })

  it('tooltip names the active count when the bar is hidden (singular and plural)', async () => {
    const u = userEvent.setup()
    const { unmount } = renderPanel({ activeCount: 1, filterBarShown: false })
    await u.hover(screen.getByRole('button', { name: 'Filters, 1 active' }))
    expect(await screen.findByText('1 filter active (bar hidden)')).toBeInTheDocument()
    unmount()
    renderPanel({ activeCount: 3, filterBarShown: false })
    await u.hover(screen.getByRole('button', { name: 'Filters, 3 active' }))
    expect(await screen.findByText('3 filters active (bar hidden)')).toBeInTheDocument()
  })
})

describe('FilterPanel pinned shell and Filter bar switch (#2691)', () => {
  const manyFields = () => makeBoard({
    custom_field_definitions: Array.from({ length: 42 }, (_, i) => cf({ id: 100 + i, name: `Field ${i}`, field_type: 'text', position: i })) as never,
  })

  it('pins the header (title, count, switch, search) and the footer; only the body scrolls, capped at min(600px, 80vh)', async () => {
    const u = userEvent.setup()
    setup({ board: manyFields(), filters: { ...EMPTY_FILTER, blockedOnly: true }, onSaveFilter: vi.fn() })
    await open(u)
    const panel = screen.getByTestId('filter-panel')
    expect(panel.style.maxHeight).toMatch(/^min\(600px, 80vh, /)
    expect(panel.className).toContain('overflow-hidden')
    const header = screen.getByTestId('filter-panel-header')
    const body = screen.getByTestId('filter-panel-body')
    const footer = screen.getByTestId('filter-panel-footer')
    expect(body.className).toContain('overflow-y-auto')
    expect(header.className).toContain('shrink-0')
    expect(footer.className).toContain('shrink-0')
    // With 40+ fields the switch, search, Clear all and Save filter stay outside the scrolling body.
    expect(within(header).getByRole('heading', { name: 'Filters' })).toBeInTheDocument()
    expect(within(header).getByTestId('filter-panel-active-count')).toHaveTextContent('1 active')
    expect(within(header).getByRole('button', { name: 'Filter bar' })).toBeInTheDocument()
    expect(within(header).getByRole('textbox', { name: 'Search fields and values to filter' })).toBeInTheDocument()
    expect(within(footer).getByRole('button', { name: 'Clear all' })).toBeInTheDocument()
    expect(within(footer).getByRole('button', { name: 'Save filter' })).toBeInTheDocument()
    expect(within(body).getByRole('button', { name: /^Field 41/ })).toBeInTheDocument()
    expect(within(body).queryByRole('button', { name: 'Filter bar' })).toBeNull()
  })

  it('hides the active count at 0 and keeps the Esc keycap on search', async () => {
    const u = userEvent.setup()
    setup()
    await open(u)
    expect(screen.queryByTestId('filter-panel-active-count')).toBeNull()
    expect(within(screen.getByTestId('filter-panel-header')).getByText('Esc')).toBeInTheDocument()
  })

  it('the switch tooltip names the filter bar both ways', async () => {
    const u = userEvent.setup()
    setup()
    await open(u)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Filter bar' }).parentElement as HTMLElement)
    expect(await screen.findByText('Show the filter bar (F)')).toBeInTheDocument()
    cleanup()
    render(
      <FilterPanel board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} activeCount={0} icon={null}
        savedFilters={[]} activeFilterId={null} onLoadSaved={vi.fn()} filterBarShown onToggleFilterBar={vi.fn()} onOpenLaneFilters={vi.fn()} />,
    )
    await u.click(screen.getByRole('button', { name: /^Filters/ }))
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Filter bar' }).parentElement as HTMLElement)
    expect(await screen.findByText('Hide the filter bar (F)')).toBeInTheDocument()
  })

  it('F types in search and never toggles the bar there; on the switch or a row F toggles it', async () => {
    const u = userEvent.setup()
    const { onToggleFilterBar } = setup()
    await open(u)
    const search = screen.getByRole('textbox', { name: 'Search fields and values to filter' })
    await u.keyboard('f')
    expect(search).toHaveValue('f')
    expect(onToggleFilterBar).not.toHaveBeenCalled()
    await u.clear(search)
    screen.getByRole('button', { name: 'Filter bar' }).focus()
    await u.keyboard('f')
    expect(onToggleFilterBar).toHaveBeenCalledTimes(1)
    screen.getByRole('button', { name: /^Assignee/ }).focus()
    await u.keyboard('f')
    expect(onToggleFilterBar).toHaveBeenCalledTimes(2)
    // A modifier chord is not the shortcut.
    await u.keyboard('{Control>}f{/Control}')
    expect(onToggleFilterBar).toHaveBeenCalledTimes(2)
    // Text inside an open editor types too.
    await u.click(screen.getByRole('button', { name: /^Notes/ }))
    await u.type(screen.getByRole('textbox', { name: 'Notes' }), 'f')
    expect(onToggleFilterBar).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument()
  })

  it('the field list is one Tab stop with arrows inside; the last row focused keeps the stop', async () => {
    const u = userEvent.setup()
    setup()
    await open(u)
    const list = screen.getByRole('list', { name: 'Filterable fields' })
    const rows = within(list).getAllByRole('button')
    expect(rows.filter((r) => r.tabIndex === 0)).toEqual([rows[0]])
    await u.keyboard('{ArrowDown}')
    expect(rows[0]).toHaveFocus()
    await u.keyboard('{ArrowDown}{ArrowDown}')
    expect(rows[2]).toHaveFocus()
    expect(rows[2].tabIndex).toBe(0)
    expect(rows[0].tabIndex).toBe(-1)
    await u.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}')
    expect(screen.getByRole('textbox', { name: 'Search fields and values to filter' })).toHaveFocus()
  })

  it('arrows inside an open editor stay native and do not jump rows', async () => {
    const u = userEvent.setup()
    setup()
    await open(u)
    await u.click(screen.getByRole('button', { name: /^Due date/ }))
    const radio = screen.getByRole('radio', { name: 'Any' })
    radio.focus()
    fireEvent.keyDown(radio, { key: 'ArrowDown' })
    expect(screen.getByRole('button', { name: /^Blocked/ })).not.toHaveFocus()
  })
})

describe('FilterPanel saved presets (#2695)', () => {
  const two: SavedFilter[] = [
    { id: 5, name: 'My open work', state_json: {}, state_version: 1, created_at: '' },
    { id: 6, name: 'Shared triage', state_json: {}, state_version: 1, created_at: '' },
  ]

  it('pins the presets under search and scope, before the field list in Tab order, and applies one in one click', async () => {
    const u = userEvent.setup()
    const { onLoadSaved } = setup({ savedFilters: two, activeFilterId: 6 })
    await open(u)
    const row = screen.getByTestId('filter-panel-saved')
    expect(screen.getByTestId('filter-panel-header')).toContainElement(row)
    const pills = within(row).getAllByRole('button')
    expect(pills.map((p) => p.textContent)).toEqual(['My open work', 'Shared triage'])
    // The applied preset is a checked info-tint pill; tint is not the only cue (ActiveMark).
    expect(pills[1]).toHaveAttribute('aria-pressed', 'true')
    expect(pills[1].className).toContain('text-info-on-tint')
    expect(within(pills[1]).getByTestId('saved-filter-mark')).toBeInTheDocument()
    expect(pills[0]).toHaveAttribute('aria-pressed', 'false')
    expect(within(row).getByRole('list', { name: 'Saved filters' }).className).toContain('overflow-x-auto')
    // Tab from the Swimlane fields scope chip reaches the first pill, then the list.
    screen.getByRole('button', { name: 'Swimlane fields' }).focus()
    await u.tab()
    expect(pills[0]).toHaveFocus()
    await u.click(pills[0])
    expect(onLoadSaved).toHaveBeenCalledWith(two[0])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveFocus()
  })

  it('hides the row while a query is typed', async () => {
    const u = userEvent.setup()
    setup({ savedFilters: two })
    await open(u)
    await u.keyboard('re')
    expect(screen.queryByTestId('filter-panel-saved')).toBeNull()
    await u.clear(screen.getByRole('textbox', { name: 'Search fields and values to filter' }))
    expect(screen.getByTestId('filter-panel-saved')).toBeInTheDocument()
  })
})
