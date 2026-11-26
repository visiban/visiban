import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import ChildrenModeView from '../components/Board/ChildrenModeView'
import { DEFAULT_CHILDREN_OPTIONS, childBoardSwitchLabel, childBoardSwitchName, phoneColumnCount, phoneEmptyCellText } from '../utils/childrenMode'
import type { ChildrenView, ChildrenViewChild, ChildrenViewRow } from '../types'

// Children mode at phone width (#2370 item 12, canvas 6b and 2f g): two-line tinted bands, one child board per lane
// and one of its columns at a time, parent names as headings inside the column, "Nothing blocked", and the
// "Onboarding · 2 children · Columns ›" switch.
const getChildrenView = vi.fn()
vi.mock('../api/cards', () => ({ getChildrenView: (...a: unknown[]) => getChildrenView(...a), moveCard: vi.fn() }))

const child = (o: Partial<ChildrenViewChild>): ChildrenViewChild => ({
  id: 50, title: 'Child', column_id: 30, swimlane_id: 12, position: 0, state: 'todo', assignee: null,
  blocked: false, blocked_at: null, planned: false, ...o,
})
const row = (o: Partial<ChildrenViewRow>): ChildrenViewRow => ({
  id: 40, title: 'Parent', swimlane_id: 3, column_id: 9, column_name: 'Discovery', assignee: null,
  rollup: { visible: true, total: 3, done: 1, doing: 1, todo: 1, blocked: 0, last_moved_at: null },
  in_progress: 2, folded: false, planned: 0, planned_only: false, child_board_id: 7, children: [], ...o,
})
const view = (): ChildrenView => ({
  board_total: { in_progress: 12, total: 16, blocked: 3, hidden: 4, planned: 0 },
  lanes: [{
    id: 3, name: 'Acme Corp', position: 0, parents: 3, child_boards: 2, total: 16, in_progress: 12, done: 4, doing: 3,
    todo: 6, blocked: 3, hidden: 4, folded: 0, planned_only: 0, planned: 0, last_moved_at: null,
  }],
  rows: [
    row({
      id: 40, title: 'Acme: analytics module',
      rollup: { visible: true, total: 4, done: 2, doing: 0, todo: 1, blocked: 1, last_moved_at: null },
      children: [
        child({ id: 51, title: 'SSO for analytics', column_id: 32, state: 'blocked', blocked: true }),
        child({ id: 52, title: 'Data model review', column_id: 30 }),
      ],
    }),
    row({ id: 41, title: 'Acme: platform renewal', children: [child({ id: 53, title: 'Migrate tenant', column_id: 31, state: 'doing' })] }),
    row({
      id: 42, title: 'Acme: training pack', child_board_id: 8,
      rollup: { visible: true, total: 2, done: 0, doing: 1, todo: 1, blocked: 0, last_moved_at: null },
      children: [child({ id: 60, title: 'Kickoff deck', column_id: 80 }), child({ id: 61, title: 'Trainer booked', column_id: 81, state: 'doing' })],
    }),
  ],
  child_boards: [
    {
      id: 7, name: 'Delivery', role: 'member', enforce_wip_limits: false, enforce_wip_hard: false,
      columns: [
        { id: 30, name: 'To do', color: '#6B7280', wip_limit: null, is_done: false, card_count: 5 },
        { id: 31, name: 'Doing', color: '#3B82F6', wip_limit: 5, is_done: false, card_count: 3 },
        { id: 32, name: 'Blocked', color: '#EF4444', wip_limit: null, is_done: false, card_count: 2 },
        { id: 33, name: 'Done', color: '#22C55E', wip_limit: null, is_done: true, card_count: 4 },
      ],
    },
    {
      id: 8, name: 'Onboarding', role: 'viewer', enforce_wip_limits: false, enforce_wip_hard: false,
      columns: [
        { id: 80, name: 'Booked', color: '#6B7280', wip_limit: null, is_done: false, card_count: 1 },
        { id: 81, name: 'Running', color: '#3B82F6', wip_limit: null, is_done: false, card_count: 1 },
      ],
    },
  ],
  next_cursor: null,
})

const renderPhone = (phone = true) =>
  render(
    <ChildrenModeView boardId={4} laneId={null} options={DEFAULT_CHILDREN_OPTIONS} onOptionsChange={vi.fn()} onOpenParent={vi.fn()} phone={phone} laneColors={{ 3: '#f59e0b' }} boardName="Pipeline" />,
  )

describe('Children mode phone layout (#2370 item 12)', () => {
  beforeEach(() => { getChildrenView.mockReset(); getChildrenView.mockResolvedValue(view()) })

  it('words the phone empty cell, column counts and the board switch', () => {
    expect(phoneEmptyCellText('Blocked')).toBe('Nothing blocked')
    expect(phoneEmptyCellText('Doing')).toBe('Nothing in Doing')
    const rows = view().rows.slice(0, 2)
    expect(phoneColumnCount(rows, { id: 32, is_done: false }, DEFAULT_CHILDREN_OPTIONS)).toBe(1)
    // The folded Done column counts the rows' done rollups, as its "N done · Show" cells say.
    expect(phoneColumnCount(rows, { id: 33, is_done: true }, DEFAULT_CHILDREN_OPTIONS)).toBe(3)
    expect(phoneColumnCount(rows, { id: 32, is_done: false }, { ...DEFAULT_CHILDREN_OPTIONS, planned: 'only' })).toBe(0)
    expect(phoneColumnCount([row({ rollup: { visible: false, total: 4 } })], { id: 33, is_done: true }, DEFAULT_CHILDREN_OPTIONS)).toBe(0)
    expect(childBoardSwitchLabel('Onboarding', [view().rows[2]])).toBe('Onboarding · 2 children')
    expect(childBoardSwitchName('Onboarding', [view().rows[2]])).toBe('Show Onboarding columns, 2 children')
    expect(childBoardSwitchLabel('Onboarding', [row({ rollup: { visible: true, total: 1, done: 0, doing: 1, todo: 0, blocked: 0, last_moved_at: null } }), row({ rollup: { visible: false, total: 3 } })])).toBe('Onboarding · 1 child')
  })

  it('draws a two-line tinted band, one column at a time, and parent headings inside it', async () => {
    renderPhone()
    const band = await screen.findByTestId('children-phone-band')
    expect(within(band).getByRole('button', { name: 'Collapse lane Acme Corp, 12 in progress of 16' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(band).getByText('12 in progress of 16')).toBeInTheDocument()
    expect(within(band).getByText('3 blocked')).toHaveClass('text-danger-on-tint')
    expect(within(band).getByText(/\+4 on a board you can't open/)).toBeInTheDocument()
    expect(within(band).getByRole('button', { name: 'Copy link to Acme Corp' })).toBeInTheDocument()
    // The lane actions row is PhoneBoard's footer: the band's last line, a subtle divider, px-3 pb-2.5 pt-2.
    const actionsRow = within(band).getByTestId('children-lane-actions')
    expect(actionsRow).toHaveClass('border-t', 'border-line-subtle', 'px-3', 'pb-2.5', 'pt-2')
    expect(actionsRow.contains(within(band).getByRole('button', { name: 'Copy link to Acme Corp' }))).toBe(true)
    // No desktop header grid on phone: one column head, under the column buttons.
    expect(screen.queryByText('Parent · column on Pipeline')).toBeNull()
    expect(screen.getAllByTestId('children-column-head')).toHaveLength(1)
    const columns = screen.getByRole('group', { name: 'Columns on Delivery' })
    const buttons = within(columns).getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['To do1', 'Doing1', 'Blocked1', 'Done3'])
    expect(within(columns).getByRole('button', { name: /^To do/ })).toHaveAttribute('aria-pressed', 'true')
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1)
    // Parent names are headings inside the shown column; a parent with nothing there says so.
    expect(screen.getByRole('heading', { level: 4, name: 'Acme: analytics module' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 4, name: 'Acme: platform renewal' })).toBeInTheDocument()
    expect(screen.getByText('Nothing in To do')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Data model review, To do' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /SSO for analytics/ })).toBeNull()
    fireEvent.click(within(columns).getByRole('button', { name: /^Blocked/ }))
    expect(within(columns).getByRole('button', { name: /^Blocked/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('link', { name: 'SSO for analytics, Blocked, blocked' })).toBeInTheDocument()
    expect(screen.getByText('Nothing blocked')).toBeInTheDocument()
    expect(screen.getByText("Delivery's columns. Blocked here is the column; the band counts the flag.")).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: /Acme Corp/ })).toBeInTheDocument()
    // Move stays inside the card's roving stop for a member of the child board.
    expect(screen.getByRole('button', { name: 'Move SSO for analytics' })).toHaveAttribute('tabindex', '-1')
    // Collapsed, the band is two lines: no actions line, until the lane opens again.
    fireEvent.click(within(band).getByRole('button', { name: /^Collapse lane/ }))
    expect(within(screen.getByTestId('children-phone-band')).queryByRole('button', { name: 'Copy link to Acme Corp' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Expand lane Acme Corp/ }))
    // The Done column keeps its "N done · Show" cells.
    fireEvent.click(within(screen.getByRole('group', { name: 'Columns on Delivery' })).getByRole('button', { name: /^Done/ }))
    expect(screen.getByRole('button', { name: '2 done. Show done cards' })).toBeInTheDocument()
  })

  it('moves the shown column with Left and Right on the column buttons, wrapping', async () => {
    renderPhone()
    const columns = await screen.findByRole('group', { name: 'Columns on Delivery' })
    const todo = within(columns).getByRole('button', { name: /^To do/ })
    todo.focus()
    fireEvent.keyDown(todo, { key: 'ArrowRight' })
    await waitFor(() => expect(document.activeElement).toBe(within(columns).getByRole('button', { name: /^Doing/ })))
    expect(document.activeElement).toHaveAttribute('aria-pressed', 'true')
    expect(document.activeElement).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('link', { name: 'Migrate tenant, Doing' })).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    fireEvent.keyDown(within(columns).getByRole('button', { name: /^To do/ }), { key: 'ArrowLeft' })
    await waitFor(() => expect(document.activeElement).toBe(within(columns).getByRole('button', { name: /^Done/ })))
    // Other keys are left alone.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(within(columns).getByRole('button', { name: /^Done/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('walks the stacked column in reading order with Up and Down', async () => {
    renderPhone()
    await screen.findByRole('grid', { name: 'Acme Corp children on Delivery, by parent' })
    const first = screen.getByRole('button', { name: 'Acme: analytics module' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toHaveAccessibleName('Data model review, To do')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toHaveAccessibleName('Acme: platform renewal')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toHaveTextContent('Nothing in To do')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toHaveTextContent('Nothing in To do')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toHaveAccessibleName('Acme: platform renewal')
  })

  it('shows one child board per lane and switches with "Onboarding · 2 children · Columns ›"', async () => {
    renderPhone()
    await screen.findByRole('group', { name: 'Columns on Delivery' })
    expect(screen.queryByRole('group', { name: 'Columns on Onboarding' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Acme: training pack' })).toBeNull()
    const sw = screen.getByRole('button', { name: 'Show Onboarding columns, 2 children' })
    expect(sw).toHaveTextContent('Onboarding · 2 childrenColumns ›')
    fireEvent.click(sw)
    expect(screen.queryByRole('group', { name: 'Columns on Delivery' })).toBeNull()
    const onboarding = screen.getByRole('group', { name: 'Columns on Onboarding' })
    await waitFor(() => expect(document.activeElement).toBe(within(onboarding).getByRole('button', { name: /^Booked/ })))
    expect(screen.getByRole('heading', { level: 4, name: 'Acme: training pack' })).toBeInTheDocument()
    // A viewer on Onboarding has no Move.
    expect(screen.queryByRole('button', { name: 'Move Kickoff deck' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Show Delivery columns, 7 children' })).toBeInTheDocument()
  })

  it('keeps the desktop grid with every child board above the phone breakpoint', async () => {
    renderPhone(false)
    expect(await screen.findAllByText('Parent · column on Pipeline')).toHaveLength(2)
    expect(screen.queryByRole('group', { name: /^Columns on/ })).toBeNull()
    expect(screen.queryByTestId('children-phone-band')).toBeNull()
    expect(screen.getByRole('grid', { name: 'Acme Corp children on Onboarding, by parent' })).toBeInTheDocument()
    expect(screen.getAllByTestId('children-column-head')).toHaveLength(6)
  })
})
