import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, renderHook, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChildrenModeView from '../components/Board/ChildrenModeView'
import FilterPanel from '../components/Board/FilterPanel'
import { EMPTY_FILTER, countActiveFilters } from '../components/Board/FilterBar'
import { buildFilterChips } from '../components/Board/filterChips'
import { filterCards, hasActiveClientFilters } from '../utils/filterCards'
import { usePersistedFilters } from '../hooks/usePersistedFilters'
import { useChildrenLaneCounts } from '../hooks/useChildrenLaneCounts'
import {
  DEFAULT_CHILDREN_OPTIONS, allChildrenLinkText, columnHeadCaption, columnMeterPct, inProgressChip, resolveLaneParam,
} from '../utils/childrenMode'
import {
  matchesParentLaneFilter, parentLaneFilterLabel, parentLaneFilterOptions, parseParentLaneFilterParam, sanitizeParentLaneFilter,
} from '../utils/parentFilter'
import type { BoardFull, Card, CardParent, ChildrenView } from '../types'

const getChildrenView = vi.fn()
vi.mock('../api/cards', () => ({ getChildrenView: (...a: unknown[]) => getChildrenView(...a) }))

const view = (): ChildrenView => ({
  board_total: { in_progress: 3, total: 4, blocked: 0, hidden: 0, planned: 0 },
  lanes: [
    { id: 3, name: 'Acme Corp', position: 0, parents: 1, child_boards: 1, total: 4, in_progress: 3, done: 1, doing: 1, todo: 2, blocked: 0, hidden: 0, folded: 0, planned_only: 0, planned: 0, last_moved_at: null },
    { id: 4, name: 'Globex', position: 1, parents: 0, child_boards: 0, total: 0, in_progress: 0, done: 0, doing: 0, todo: 0, blocked: 0, hidden: 0, folded: 0, planned_only: 0, planned: 0, last_moved_at: null },
  ],
  rows: [{
    id: 40, title: 'Acme: analytics module', swimlane_id: 3, column_id: 9, column_name: 'Discovery', assignee: null,
    rollup: { visible: true, total: 4, done: 1, doing: 1, todo: 2, blocked: 0, last_moved_at: null },
    in_progress: 3, folded: false, planned: 0, planned_only: false, child_board_id: 7,
    children: [
      { id: 1, title: 'Scope', column_id: 30, swimlane_id: 12, position: 0, state: 'todo', assignee: null, blocked: false, blocked_at: null, blocked_reason: null, planned: false },
      { id: 2, title: 'Build', column_id: 31, swimlane_id: 12, position: 0, state: 'doing', assignee: null, blocked: false, blocked_at: null, blocked_reason: null, planned: false },
    ],
  }],
  child_boards: [{
    id: 7, name: 'Delivery', role: 'member', enforce_wip_limits: false, enforce_wip_hard: false,
    columns: [
      { id: 30, name: 'To do', color: '', wip_limit: null, is_done: false, card_count: 9 },
      { id: 31, name: 'Doing', color: '', wip_limit: 5, is_done: false, card_count: 4 },
      { id: 32, name: 'Done', color: '', wip_limit: null, is_done: true, card_count: 3 },
    ],
  }] as ChildrenView['child_boards'],
  next_cursor: null,
})

const base = { options: DEFAULT_CHILDREN_OPTIONS, onOptionsChange: vi.fn(), onOpenParent: vi.fn(), boardId: 4 }

describe('Children mode ways in and band (#2370 items 1, 2, 3, 8, 10)', () => {
  beforeEach(() => { getChildrenView.mockReset(); localStorage.clear() })

  it('words the ways in and the column heads', () => {
    expect(inProgressChip(12)).toBe('12 in progress')
    expect(allChildrenLinkText('Acme Corp', 12)).toBe('All children in Acme Corp (12 in progress)')
    expect(allChildrenLinkText('Acme Corp', null)).toBe('All children in Acme Corp')
    expect(columnHeadCaption({ is_done: false, card_count: 4, wip_limit: 5 }, 3, 'Delivery', false)).toBe('3 of 4 on Delivery · limit 5')
    expect(columnHeadCaption({ is_done: false, card_count: 9, wip_limit: null }, 5, 'Delivery', false)).toBe('5 of 9 on Delivery')
    expect(columnHeadCaption({ is_done: true, card_count: 3, wip_limit: null }, 0, 'Delivery', false)).toBe('Count per row · Show opens them')
    expect(columnHeadCaption({ is_done: true, card_count: 3, wip_limit: null }, 2, 'Delivery', true)).toBe('2 of 3 on Delivery')
    expect(columnMeterPct({ card_count: 4, wip_limit: 5 })).toBe(80)
    expect(columnMeterPct({ card_count: 9, wip_limit: 5 })).toBe(100)
    expect(columnMeterPct({ card_count: 4, wip_limit: null })).toBeNull()
    expect(columnMeterPct({ card_count: 4, wip_limit: 0 })).toBeNull()
  })

  it('a lane the viewer was not served is simply absent: no lane, never an error', () => {
    expect(resolveLaneParam('3', [3, 4])).toBe(3)
    expect(resolveLaneParam('99', [3, 4])).toBeNull()
    expect(resolveLaneParam('acme', [3, 4])).toBeNull()
    expect(resolveLaneParam(null, [3, 4])).toBeNull()
  })

  it('a lane the server no longer finds (404) renders every lane, with no error state', async () => {
    getChildrenView.mockRejectedValueOnce({ response: { status: 404 } }).mockResolvedValueOnce(view())
    render(<ChildrenModeView {...base} laneId={3} />)
    await screen.findByRole('region', { name: 'Globex lane' })
    expect(screen.getByRole('region', { name: 'Acme Corp lane' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(getChildrenView).toHaveBeenLastCalledWith(4, { lane: null, done: false }, expect.anything())
  })

  it('a 404 with no lane is still an error', async () => {
    getChildrenView.mockRejectedValueOnce({ response: { status: 404 } })
    render(<ChildrenModeView {...base} laneId={null} />)
    expect(await screen.findByRole('alert')).toHaveTextContent("Children didn't load")
  })

  it('heads each child board with the parent board, links the child board, and draws whole-column meters', async () => {
    getChildrenView.mockResolvedValue(view())
    render(<ChildrenModeView {...base} laneId={null} boardName="Pipeline" />)
    await screen.findByText('Parent · column on Pipeline')
    expect(screen.getByRole('link', { name: 'Delivery' })).toHaveAttribute('href', '/boards/7')
    const heads = screen.getAllByTestId('children-column-head')
    expect(heads.map((h) => h.textContent)).toEqual([
      'To do1 of 9 on Delivery', 'Doing1 of 4 on Delivery · limit 5', 'DoneCount per row · Show opens them',
    ])
    const meter = screen.getByRole('meter', { name: 'Doing on Delivery: 4 of limit 5' })
    expect(meter).toHaveAttribute('aria-valuenow', '4')
    expect(meter).toHaveAttribute('aria-valuemax', '5')
    expect(screen.getAllByRole('meter')).toHaveLength(1)
  })

  it('the band has Focus for everyone, Copy link, and the admin ⋮ only for admins', async () => {
    getChildrenView.mockResolvedValue(view())
    const onFocusLane = vi.fn()
    const onEditLane = vi.fn()
    const onEditFieldOrder = vi.fn()
    const { unmount } = render(<ChildrenModeView {...base} laneId={null} onFocusLane={onFocusLane} />)
    const focus = await screen.findByRole('button', { name: 'Focus on Acme Corp' })
    expect(focus).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(focus)
    expect(onFocusLane).toHaveBeenCalledWith(3)
    expect(screen.queryByRole('button', { name: 'Actions for swimlane "Acme Corp"' })).toBeNull()
    unmount()
    // Focus is its own prop, never the shared ?lane= link (#2370 fix A1).
    render(<ChildrenModeView {...base} laneId={null} focusLaneId={3} onFocusLane={onFocusLane} onEditLane={onEditLane} onEditFieldOrder={onEditFieldOrder} />)
    const pressed = await screen.findByRole('button', { name: 'Focus on Acme Corp' })
    expect(screen.queryByRole('region', { name: 'Globex lane' })).toBeNull()
    expect(getChildrenView).toHaveBeenLastCalledWith(4, { lane: 3, done: false }, expect.anything())
    expect(pressed).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(pressed)
    expect(onFocusLane).toHaveBeenLastCalledWith(null)
    // Order beside the name: Focus, Copy link, ⋮.
    const copy = screen.getByRole('button', { name: 'Copy link to Acme Corp' })
    const menu = screen.getByRole('button', { name: 'Actions for swimlane "Acme Corp"' })
    expect(pressed.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(copy.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await userEvent.click(menu)
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit swimlane…' }))
    expect(onEditLane).toHaveBeenCalledWith(3)
    await userEvent.click(menu)
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Change field order…' }))
    expect(onEditFieldOrder).toHaveBeenCalled()
  })

  it('Home and End move to the row ends; with Ctrl, to the grid ends', async () => {
    getChildrenView.mockResolvedValue(view())
    render(<ChildrenModeView {...base} laneId={null} />)
    await screen.findByRole('grid')
    const parent = screen.getByRole('button', { name: 'Acme: analytics module' })
    parent.focus()
    fireEvent.keyDown(parent, { key: 'End' })
    const last = document.activeElement as HTMLElement
    expect(last).not.toBe(parent)
    expect(last.dataset.stop).toMatch(/:0:3:0$/)
    fireEvent.keyDown(last, { key: 'Home' })
    expect(document.activeElement).toBe(parent)
    fireEvent.keyDown(parent, { key: 'End', ctrlKey: true })
    expect((document.activeElement as HTMLElement).dataset.stop).toMatch(/:0:3:0$/)
    fireEvent.keyDown(document.activeElement!, { key: 'Home', ctrlKey: true })
    expect(document.activeElement).toBe(parent)
  })

  it('useChildrenLaneCounts reads the server lane in_progress (planned already excluded), and is empty when off or failed', async () => {
    getChildrenView.mockResolvedValueOnce({ lanes: [{ id: 3, in_progress: 12, planned: 2 }] })
    const { result } = renderHook(() => useChildrenLaneCounts(4, true))
    await waitFor(() => expect(result.current.get(3)).toBe(12))
    // Counts only (#2370 perf): the server skips the page of rows the lane action never draws.
    expect(getChildrenView).toHaveBeenCalledWith(4, { lane: null, countsOnly: true }, expect.anything())
    getChildrenView.mockClear()
    const off = renderHook(() => useChildrenLaneCounts(4, false))
    expect(off.result.current.size).toBe(0)
    expect(getChildrenView).not.toHaveBeenCalled()
    getChildrenView.mockRejectedValueOnce(new Error('x'))
    const failed = renderHook(() => useChildrenLaneCounts(4, true))
    await waitFor(() => expect(getChildrenView).toHaveBeenCalled())
    expect(failed.result.current.size).toBe(0)
  })
})

const parent = (id: number, lane: number, laneName: string, board = 'Pipeline'): CardParent => ({
  hidden: false, id, title: `P${id}`, board_id: 1, board_name: board, column_id: 1, column_name: 'Qualify',
  swimlane_id: lane, swimlane_name: laneName, archived: false, board_parent_name_singular: '',
})
const card = (id: number, p: CardParent | null | undefined): Card => ({
  id, title: `C${id}`, description: '', assignee: null, labels: [], priority: 'medium', due_date: null,
  custom_field_values: [], column: 1, swimlane: 1, blocked_at: null, parent: p,
}) as unknown as Card
const cards = [card(1, parent(50, 3, 'Acme Corp')), card(2, parent(51, 4, 'Globex')), card(3, { hidden: true }), card(4, null), card(5, parent(52, 3, 'Acme Corp'))]
const board = (over: Partial<BoardFull> = {}) => ({
  id: 7, uid: 'b7', name: 'Delivery', cards, columns: [], swimlanes: [], labels: [], members: [],
  current_user_role: 'member', custom_field_definitions: [], swimlane_custom_field_definitions: [],
  cards_can_have_children: false, ...over,
}) as unknown as BoardFull

describe('Parent lane filter (#2370 way in 3)', () => {
  it('matches children of a visible parent in that lane only; a hidden parent never matches', () => {
    expect(cards.filter((c) => matchesParentLaneFilter(c, 3)).map((c) => c.id)).toEqual([1, 5])
    expect(cards.filter((c) => matchesParentLaneFilter(c, undefined))).toHaveLength(5)
    expect(filterCards(cards, { ...EMPTY_FILTER, parentLaneFilter: 4 })).toEqual([2])
    // AND with the Parent filter.
    expect(filterCards(cards, { ...EMPTY_FILTER, parentLaneFilter: 3, parentFilter: 52 })).toEqual([5])
  })

  it('offers only lanes of parents the viewer can open, once each; a shared name carries its board', () => {
    expect(parentLaneFilterOptions(cards)).toEqual([{ id: 3, label: 'Acme Corp' }, { id: 4, label: 'Globex' }])
    const dup = [card(1, parent(1, 3, 'Acme Corp')), card(2, parent(2, 9, 'Acme Corp', 'Renewals'))]
    expect(parentLaneFilterOptions(dup).map((o) => o.label)).toEqual(['Acme Corp (Pipeline)', 'Acme Corp (Renewals)'])
    expect(parentLaneFilterLabel(undefined, cards)).toBeNull()
    expect(parentLaneFilterLabel(77, cards)).toBe('A lane not shown here')
  })

  it('accepts only a positive lane id from storage, saved filters and the URL', () => {
    expect(sanitizeParentLaneFilter(5)).toBe(5)
    for (const v of [undefined, null, 0, -1, 1.5, '5', true, 2 ** 31, {}]) expect(sanitizeParentLaneFilter(v)).toBeUndefined()
    expect(parseParentLaneFilterParam('12')).toBe(12)
    expect(parseParentLaneFilterParam('x')).toBeUndefined()
    expect(parseParentLaneFilterParam(null)).toBeUndefined()
    expect(countActiveFilters({ ...EMPTY_FILTER, parentLaneFilter: 3 })).toBe(1)
    expect(hasActiveClientFilters({ ...EMPTY_FILTER, parentLaneFilter: 3 })).toBe(true)
    localStorage.setItem('board:7:filters', JSON.stringify({ ...EMPTY_FILTER, parentLaneFilter: 3 }))
    expect(renderHook(() => usePersistedFilters(7, [])).result.current.filters.parentLaneFilter).toBe(3)
    localStorage.clear()
  })

  it('a removable chip names the lane', () => {
    const onChange = vi.fn()
    const chip = buildFilterChips(board(), { ...EMPTY_FILTER, parentLaneFilter: 3 }, onChange, 'MM/DD/YYYY').find((c) => c.key === 'parent-lane')!
    expect(chip.label).toBe('Parent lane: Acme Corp')
    chip.onDismiss()
    expect(onChange.mock.calls[0][0]).not.toHaveProperty('parentLaneFilter')
  })

  it('Filter panel: a Parent lane row sets and clears the lane', async () => {
    const u = userEvent.setup()
    const onChange = vi.fn()
    const filters = { ...EMPTY_FILTER, parentLaneFilter: 3 }
    render(
      <FilterPanel
        board={board()} filters={filters} onChange={onChange} activeCount={countActiveFilters(filters)} icon={null}
        savedFilters={[]} activeFilterId={null} onLoadSaved={vi.fn()} filterBarShown={false} onToggleFilterBar={vi.fn()}
        onOpenLaneFilters={vi.fn()}
      />,
    )
    await u.click(screen.getByRole('button', { name: /^Filters/ }))
    const row = screen.getByRole('button', { name: /^Parent lane/ })
    expect(row).toHaveTextContent('Acme Corp')
    await u.click(row)
    const group = screen.getByRole('radiogroup', { name: 'Parent lane' })
    expect(within(group).getAllByRole('radio').map((r) => r.closest('label')!.textContent)).toEqual(['Any', 'Acme Corp', 'Globex'])
    await u.click(within(group).getByRole('radio', { name: 'Globex' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ parentLaneFilter: 4 }))
    await u.click(within(group).getByRole('radio', { name: 'Any' }))
    expect(onChange.mock.calls.at(-1)![0]).not.toHaveProperty('parentLaneFilter')
  })

  it('Filter panel on phones: Assignee, Parent, Parent lane, Planned, Due date come first (#2370 fix A10)', async () => {
    const u = userEvent.setup()
    const order = async (phoneOrder: boolean) => {
      const { unmount } = render(
        <FilterPanel
          board={board()} filters={EMPTY_FILTER} onChange={vi.fn()} activeCount={0} icon={null} phoneOrder={phoneOrder}
          savedFilters={[]} activeFilterId={null} onLoadSaved={vi.fn()} filterBarShown={false} onToggleFilterBar={vi.fn()}
          onOpenLaneFilters={vi.fn()}
        />,
      )
      await u.click(screen.getByRole('button', { name: /^Filters/ }))
      const labels = within(screen.getByTestId('filter-panel')).getAllByRole('button').map((b) => b.textContent ?? '')
      const at = (re: RegExp) => labels.findIndex((t) => re.test(t))
      const out = [/^Assignee/, /^Parent(?! lane)/, /^Parent lane/, /^Due date/, /^Label/].map((re) => at(re))
      unmount()
      return out
    }
    const [assignee, parent, parentLane, due, label] = await order(true)
    expect(assignee).toBeGreaterThanOrEqual(0)
    expect(assignee < parent && parent < parentLane && parentLane < due && due < label).toBe(true)
    const desktop = await order(false)
    expect(desktop[4]).toBeLessThan(desktop[3])
  })
})
