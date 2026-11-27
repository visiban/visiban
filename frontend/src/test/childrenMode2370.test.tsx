import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ChildrenModeView from '../components/Board/ChildrenModeView'
import { CHILDREN_BOARD_ESCAPE_PRIORITY, WIDE_MIN_PX } from '../components/Card/cardChildren'
import { MAXIMIZE_ESCAPE_PRIORITY } from '../components/Card/FieldSetBlocks'
import { parseShowChip } from '../utils/showChips'
import {
  CHILDREN_MODE_ESCAPE_PRIORITY, DEFAULT_CHILDREN_OPTIONS, blockedDays, cellName, childCardName, compactRowLabel,
  foldLabel, isFoldedRow, laneBandName, laneBlockedLabel, laneLink, laneSubtitle, laneTotalLabel, loadChildrenOptions,
  loadShowMode, lockedRowText, moreParentsLabel, parseLaneParam, rowDoneLabel, saveChildrenOptions, saveShowMode,
  visibleChildren, addPage, frontierLane, pageRowCount,
} from '../utils/childrenMode'
import type { ChildrenView, ChildrenViewChild, ChildrenViewLane, ChildrenViewRow } from '../types'

const getChildrenView = vi.fn()
vi.mock('../api/cards', () => ({ getChildrenView: (...a: unknown[]) => getChildrenView(...a) }))

const lane = (o: Partial<ChildrenViewLane> = {}): ChildrenViewLane => ({
  id: 3, name: 'Acme Corp', position: 0, parents: 2, child_boards: 1, total: 16, in_progress: 12, done: 4, doing: 3,
  todo: 6, blocked: 3, hidden: 4, folded: 1, planned_only: 0, planned: 0, last_moved_at: null, ...o,
})
const child = (o: Partial<ChildrenViewChild> = {}): ChildrenViewChild => ({
  id: 51, title: 'SSO for analytics', column_id: 30, swimlane_id: 12, position: 0, state: 'todo', assignee: null,
  blocked: false, blocked_at: null, blocked_reason: null, planned: false, ...o,
})
const row = (o: Partial<ChildrenViewRow> = {}): ChildrenViewRow => ({
  id: 40, title: 'Acme: analytics module', swimlane_id: 3, column_id: 9, column_name: 'Discovery', assignee: null,
  rollup: { visible: true, total: 6, done: 1, doing: 1, todo: 2, blocked: 2, last_moved_at: null },
  in_progress: 5, folded: false, planned: 0, planned_only: false, child_board_id: 7, children: [], ...o,
})

describe('Children mode rules (#2370, #2550)', () => {
  it('pins the Escape slots and the Children tab breakpoint', () => {
    expect(CHILDREN_MODE_ESCAPE_PRIORITY).toBeLessThan(25)
    expect(CHILDREN_MODE_ESCAPE_PRIORITY).toBeGreaterThan(12)
    expect(CHILDREN_BOARD_ESCAPE_PRIORITY).toBe(30.4)
    expect(CHILDREN_BOARD_ESCAPE_PRIORITY).not.toBe(MAXIMIZE_ESCAPE_PRIORITY)
    expect(WIDE_MIN_PX).toBe(880)
  })

  it('shares ?show= with the Show chips: children is not a chip', () => {
    expect(parseShowChip('children')).toBe('all')
    expect(parseShowChip('overdue')).toBe('overdue')
  })

  it('parses only a numeric lane id', () => {
    expect(parseLaneParam('12')).toBe(12)
    expect(parseLaneParam('acme-corp')).toBeNull()
    expect(parseLaneParam(null)).toBeNull()
    expect(laneLink('https://x.test', 4, 12)).toBe('https://x.test/boards/4?show=children&lane=12')
  })

  it('remembers the mode and options per board, and decays bad storage', () => {
    saveShowMode(4, 'children')
    expect(loadShowMode(4)).toBe('children')
    expect(loadShowMode(5)).toBe('cards')
    saveShowMode(4, 'cards')
    expect(loadShowMode(4)).toBe('cards')
    saveChildrenOptions(4, { showDone: true, blockedOnly: false, planned: 'only' })
    expect(loadChildrenOptions(4)).toEqual({ showDone: true, blockedOnly: false, planned: 'only' })
    localStorage.setItem('board:6:children-options', '{bad')
    expect(loadChildrenOptions(6)).toEqual(DEFAULT_CHILDREN_OPTIONS)
    localStorage.setItem('board:6:children-options', '{"planned":"weird"}')
    expect(loadChildrenOptions(6).planned).toBe('any')
  })

  it('words the lane band, planned never counting as in progress', () => {
    expect(laneTotalLabel(lane())).toBe('12 in progress of 16')
    expect(laneTotalLabel(lane({ in_progress: 2, planned: 2 }))).toBe('2 in progress · 2 planned')
    expect(laneBlockedLabel(lane())).toBe('3 blocked')
    expect(laneBlockedLabel(lane({ blocked: 0 }))).toBe('none blocked')
    expect(laneBlockedLabel(lane({ blocked: 2, in_progress: 2 }))).toBe('All blocked')
    expect(laneSubtitle(lane({ parents: 5, child_boards: 2 }))).toBe('5 parents · 2 child boards')
    expect(laneBandName(lane())).toBe(
      "Acme Corp children: 16 you can open, 4 done, 3 doing, 3 blocked, 6 to do; 4 more on a board you can't open",
    )
  })

  it('words rows, folds, the locked row and paging', () => {
    expect(rowDoneLabel(row())).toBe('1/6 done')
    expect(rowDoneLabel(row({ rollup: { visible: true, total: 3, done: 0, doing: 0, todo: 3, blocked: 0, last_moved_at: null } }))).toBe('No work started')
    expect(rowDoneLabel(row({ rollup: { visible: false, total: 4 } }))).toBe('')
    expect(compactRowLabel(row())).toBe('2 blocked')
    expect(compactRowLabel(row({ rollup: { visible: true, total: 5, done: 3, doing: 2, todo: 0, blocked: 0, last_moved_at: null } }))).toBe('3/5 done')
    expect(foldLabel(2, 0)).toBe('2 parents with nothing in progress')
    expect(foldLabel(1, 1)).toBe('1 parent with nothing in progress · 1 with only planned work')
    expect(foldLabel(3, 1)).toBe('3 parents with nothing in progress · 1 with only planned work')
    expect(lockedRowText(4)).toBe("4 children on a board you can't open. Their columns and titles are not shown.")
    expect(moreParentsLabel(9, false)).toBe('+9 more parents · loads 20 rows at a time')
    expect(moreParentsLabel(9, true)).toBe('+9 more parents · load 20')
  })

  it('folds planned-only rows unless Only planned, and filters children', () => {
    const plannedOnly = row({ planned_only: true, folded: true, in_progress: 0 })
    expect(isFoldedRow(plannedOnly, 'any')).toBe(true)
    expect(isFoldedRow(plannedOnly, 'hide')).toBe(true)
    expect(isFoldedRow(plannedOnly, 'only')).toBe(false)
    expect(isFoldedRow(row(), 'any')).toBe(false)
    expect(isFoldedRow(row({ folded: true }), 'only')).toBe(true)
    expect(isFoldedRow(row({ rollup: { visible: false, total: 2 } }), 'any')).toBe(false)
    const kids = [child({ id: 1, planned: true }), child({ id: 2, blocked: true }), child({ id: 3 })]
    expect(visibleChildren(kids, { ...DEFAULT_CHILDREN_OPTIONS, planned: 'hide' }).map((c) => c.id)).toEqual([2, 3])
    expect(visibleChildren(kids, { ...DEFAULT_CHILDREN_OPTIONS, planned: 'only' }).map((c) => c.id)).toEqual([1])
    expect(visibleChildren(kids, { ...DEFAULT_CHILDREN_OPTIONS, blockedOnly: true }).map((c) => c.id)).toEqual([2])
  })

  it('names cards and cells, and reads block age', () => {
    const owner = { id: 1, username: 'dk', display_name: 'Dana K' } as ChildrenViewChild['assignee']
    expect(childCardName(child({ assignee: owner, blocked: true }), 'Doing')).toBe('SSO for analytics, Doing, Dana K, blocked')
    // A manual block carries its age and reason, as the card draws "⊘ 4d" (#2370 fix A13).
    const at = Date.parse('2026-11-20T00:00:00Z')
    expect(childCardName(child({ blocked: true, blocked_at: '2026-11-16T00:00:00Z', blocked_reason: 'IdP access' }), 'Blocked', at))
      .toBe('SSO for analytics, Blocked, 4d, blocked: IdP access')
    expect(childCardName(child({ blocked: true, blocked_at: '2026-11-16T00:00:00Z', blocked_reason: '  ' }), 'Blocked', at))
      .toBe('SSO for analytics, Blocked, 4d, blocked')
    expect(cellName('Acme: analytics module', 'Blocked', 2)).toBe('Acme: analytics module, Blocked, 2 cards')
    expect(cellName('A', 'To do', 1)).toBe('A, To do, 1 card')
    const now = Date.parse('2026-11-20T00:00:00Z')
    expect(blockedDays(child({ blocked: true, blocked_at: '2026-11-16T00:00:00Z' }), now)).toBe(4)
    expect(blockedDays(child(), now)).toBeNull()
  })

})

const view = (o: Partial<ChildrenView> = {}): ChildrenView => ({
  board_total: { in_progress: 4, total: 8, blocked: 1, hidden: 4, planned: 2 },
  lanes: [lane({ total: 8, in_progress: 4, planned: 2, planned_only: 1, folded: 1, parents: 4, done: 2 }), lane({ id: 4, name: 'Globex', parents: 1, hidden: 0 })],
  rows: [
    row({
      children: [
        child({ id: 1, title: 'Plan workshop', column_id: 30, planned: true }),
        child({ id: 2, title: 'Pen-test call', column_id: 31, blocked: true, state: 'blocked' }),
      ],
      planned: 1,
    }),
    row({ id: 41, title: 'Acme: pilot', rollup: { visible: true, total: 1, done: 0, doing: 0, todo: 0, blocked: 0, last_moved_at: null }, in_progress: 0, folded: true, planned: 1, planned_only: true, children: [child({ id: 3, planned: true })] }),
    row({ id: 42, title: 'Acme: expansion', rollup: { visible: false, total: 4 }, in_progress: null, planned: null, child_board_id: null }),
  ],
  child_boards: [{
    id: 7, name: 'Delivery', role: 'member', enforce_wip_limits: false, enforce_wip_hard: false,
    columns: [
      { id: 30, name: 'To do', color: '', wip_limit: null, is_done: false, card_count: 9 },
      { id: 31, name: 'Doing', color: '', wip_limit: 5, is_done: false, card_count: 4 },
      { id: 32, name: 'Done', color: '', wip_limit: null, is_done: true, card_count: 3 },
    ],
  }] as ChildrenView['child_boards'],
  next_cursor: 'abc',
  ...o,
})

describe('per-lane row store (#2370 fix A1, A5)', () => {
  const r = (id: number, lane: number) => row({ id, swimlane_id: lane })
  it('a board-wide page completes the lanes it passed and leaves the cursor on its last lane', () => {
    const st = addPage({}, [3, 4, 5], { rows: [r(1, 3), r(2, 4)], next_cursor: 'c1' }, null, 'page')
    expect(st[3]).toEqual({ rows: [r(1, 3)], cursor: null, owner: 'page' })
    expect(st[4].cursor).toBe('c1')
    expect(st[5]).toBeUndefined()
    expect(frontierLane(st)).toBe(4)
    // Continuing from lane 4 fills it and, with no next cursor, completes every later lane.
    const more = addPage(st, [3, 4, 5], { rows: [r(2, 4), r(3, 4)], next_cursor: null }, null, 'page', 4)
    expect(more[4].rows.map((x) => x.id)).toEqual([2, 3])
    expect(more[5]).toEqual({ rows: [], cursor: null, owner: 'page' })
    expect(frontierLane(more)).toBeNull()
    expect(pageRowCount(more)).toBe(3)
  })
  it('a lane read fills only its lane, and a board-wide page leaves a lane with its own read alone', () => {
    const st = addPage({}, [3, 4], { rows: [r(9, 4)], next_cursor: 'c2' }, 4, 'lane')
    expect(st[4]).toEqual({ rows: [r(9, 4)], cursor: 'c2', owner: 'lane' })
    const both = addPage(st, [3, 4], { rows: [r(1, 3), r(8, 4)], next_cursor: null }, null, 'page')
    expect(both[4]).toBe(st[4])
    expect(pageRowCount(both)).toBe(1)
    expect(addPage({}, [3], { rows: [], next_cursor: null }, null, 'page')[3]).toEqual({ rows: [], cursor: null, owner: 'page' })
  })
})

describe('ChildrenModeView', () => {
  beforeEach(() => { getChildrenView.mockReset(); localStorage.clear() })

  it('draws bands, rows, planned fold, locked row, lane fold and paging, with ARIA names', async () => {
    getChildrenView.mockResolvedValue(view())
    const onOptions = vi.fn()
    const onOpen = vi.fn()
    render(<ChildrenModeView boardId={4} laneId={null} options={DEFAULT_CHILDREN_OPTIONS} onOptionsChange={onOptions} onOpenParent={onOpen} />)
    expect(screen.getByRole('status', { name: 'Loading children' })).toBeInTheDocument()
    await screen.findByRole('region', { name: 'Acme Corp lane' })
    expect(getChildrenView).toHaveBeenCalledWith(4, { lane: null, done: false }, expect.anything())
    expect(screen.getByTestId('children-board-total')).toHaveTextContent('4 in progress')
    expect(screen.getByRole('region', { name: 'Acme Corp lane' })).toHaveTextContent('4 in progress · 2 planned')
    expect(screen.getByRole('grid', { name: 'Acme Corp children on Delivery, by parent' })).toBeInTheDocument()
    expect(screen.getByText("4 children on a board you can't open. Their columns and titles are not shown.")).toBeInTheDocument()
    // Planned child folds into the To do cell; the blocked card shows its accent line.
    const plannedBtn = screen.getByRole('button', { name: '1 planned · Show' })
    expect(plannedBtn).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: /Plan workshop/ })).toBeNull()
    fireEvent.click(plannedBtn)
    expect(screen.getByRole('link', { name: 'Plan workshop, To do, planned' })).toHaveAttribute('href', '/boards/7?card=1&from_parent=40')
    expect(screen.getByRole('link', { name: 'Pen-test call, Doing, blocked' })).toBeInTheDocument()
    // Planned-only parent folds at the end of the lane.
    const fold = screen.getByRole('button', { name: '1 parent with nothing in progress · 1 with only planned work' })
    expect(screen.queryByRole('button', { name: 'Acme: pilot' })).toBeNull()
    fireEvent.click(fold)
    expect(screen.getByRole('button', { name: 'Acme: pilot' })).toBeInTheDocument()
    // Done column count opens Show done cards; parent opens its sheet.
    fireEvent.click(screen.getAllByRole('button', { name: '1 done. Show done cards' })[0])
    expect(onOptions).toHaveBeenCalledWith({ ...DEFAULT_CHILDREN_OPTIONS, showDone: true })
    fireEvent.click(screen.getByRole('button', { name: 'Acme: analytics module' }))
    expect(onOpen).toHaveBeenCalledWith(40)
    // Collapse a lane.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Acme Corp' }))
    expect(screen.getByRole('button', { name: 'Expand Acme Corp' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('grid')).toBeNull()
  })

  it('is one Tab stop with roving arrows, and Escape leaves the grid', async () => {
    getChildrenView.mockResolvedValue(view())
    render(<ChildrenModeView boardId={4} laneId={null} options={{ ...DEFAULT_CHILDREN_OPTIONS, planned: 'only' }} onOptionsChange={vi.fn()} onOpenParent={vi.fn()} />)
    const grid = await screen.findByRole('grid', { name: 'Acme Corp children on Delivery, by parent' })
    const stops = grid.querySelectorAll('[tabindex="0"]')
    expect(stops).toHaveLength(1)
    const parent = screen.getByRole('button', { name: 'Acme: analytics module' })
    parent.focus()
    fireEvent.keyDown(parent, { key: 'ArrowRight' })
    expect(document.activeElement).toHaveAccessibleName('Plan workshop, To do, planned')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toHaveAttribute('data-stop')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(parent)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toHaveAccessibleName('Collapse Acme Corp')
  })

  it('opens a linked lane expanded with every other lane drawn and collapsed; a collapsed lane reads its rows when opened (#2370 fix A1)', async () => {
    const linked = view({ rows: [row({ id: 50, title: 'Globex: rollout', swimlane_id: 4 })], next_cursor: null })
    getChildrenView.mockResolvedValueOnce(linked).mockResolvedValueOnce(view({ next_cursor: null }))
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<ChildrenModeView boardId={4} laneId={4} options={DEFAULT_CHILDREN_OPTIONS} onOptionsChange={vi.fn()} onOpenParent={vi.fn()} />)
    await screen.findByRole('button', { name: 'Globex: rollout' })
    // The main read is the linked lane's; the other lane is drawn, collapsed, with its band.
    expect(getChildrenView).toHaveBeenCalledWith(4, { lane: 4, done: false }, expect.anything())
    expect(screen.getByRole('button', { name: 'Collapse Globex' })).toHaveAttribute('aria-expanded', 'true')
    const acme = screen.getByRole('button', { name: 'Expand Acme Corp' })
    expect(acme).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('region', { name: 'Acme Corp lane' })).toBeInTheDocument()
    // Opening it reads that lane's own rows.
    fireEvent.click(acme)
    await screen.findByRole('button', { name: 'Acme: analytics module' })
    expect(getChildrenView).toHaveBeenLastCalledWith(4, { lane: 3, cursor: null, done: false })
    fireEvent.click(screen.getAllByRole('button', { name: /^Copy link/ })[0])
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/boards/4?show=children&lane=3`))
  })

  it("every lane pages on its own: a lane past the loaded page has its load button, the board-wide read's last lane continues it (#2370 fix A5)", async () => {
    // The continuation still has a cursor (Globex's row is on a later page), so Globex stays unread.
    getChildrenView.mockResolvedValueOnce(view()).mockResolvedValueOnce(view({ rows: [row({ id: 43, title: 'Acme: more' })], next_cursor: 'def' }))
    render(<ChildrenModeView boardId={4} laneId={null} options={DEFAULT_CHILDREN_OPTIONS} onOptionsChange={vi.fn()} onOpenParent={vi.fn()} phone />)
    const acme = await screen.findByRole('region', { name: 'Acme Corp lane' })
    const globex = screen.getByRole('region', { name: 'Globex lane' })
    // Globex (no rows in the first page) is not empty: it offers its own load, even with the last lane collapsed.
    fireEvent.click(within(acme).getByRole('button', { name: /^Collapse lane Acme Corp/ }))
    expect(within(globex).getByRole('button', { name: '+1 more parent · load 20' })).toBeInTheDocument()
    fireEvent.click(within(acme).getByRole('button', { name: /^Expand lane Acme Corp/ }))
    fireEvent.click(within(acme).getByRole('button', { name: '+1 more parent · load 20' }))
    await screen.findByRole('button', { name: 'Acme: more' })
    expect(getChildrenView).toHaveBeenLastCalledWith(4, { lane: null, cursor: 'abc', done: false })
    // Then Globex reads its own lane.
    getChildrenView.mockResolvedValueOnce(view({ rows: [row({ id: 60, title: 'Globex: pilot', swimlane_id: 4 })], next_cursor: null }))
    fireEvent.click(within(globex).getByRole('button', { name: '+1 more parent · load 20' }))
    await within(globex).findByRole('button', { name: 'Globex: pilot' })
    expect(getChildrenView).toHaveBeenLastCalledWith(4, { lane: 4, cursor: null, done: false })
  })

  it('a live re-read keeps the pages Load more added, following next_cursor, and re-reads lanes opened on their own (#2370 perf-check, ux-review)', async () => {
    getChildrenView
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view({ rows: [row({ id: 43, title: 'Acme: more' })], next_cursor: null }))
    const props = { boardId: 4, laneId: null, options: DEFAULT_CHILDREN_OPTIONS, onOptionsChange: vi.fn(), onOpenParent: vi.fn(), phone: true }
    const { rerender } = render(<ChildrenModeView {...props} refreshKey={0} />)
    const acme = await screen.findByRole('region', { name: 'Acme Corp lane' })
    fireEvent.click(within(acme).getByRole('button', { name: '+1 more parent · load 20' }))
    await screen.findByRole('button', { name: 'Acme: more' })
    // The board event: page 1 comes back with its cursor, and the view reads page 2 again before replacing rows.
    getChildrenView
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view({ rows: [row({ id: 43, title: 'Acme: more' })], next_cursor: null }))
    getChildrenView.mockClear()
    rerender(<ChildrenModeView {...props} refreshKey={1} />)
    await waitFor(() => expect(getChildrenView).toHaveBeenCalledTimes(2))
    expect(getChildrenView).toHaveBeenLastCalledWith(4, { lane: null, cursor: 'abc', done: false }, expect.anything())
    expect(await screen.findByRole('button', { name: 'Acme: more' })).toBeInTheDocument()
  })

  it('one read in flight: a board event during a slow read waits for it, then re-reads once (#2370 fix A12)', async () => {
    let release: (v: ChildrenView) => void = () => {}
    getChildrenView.mockResolvedValueOnce(view({ next_cursor: null }))
    const props = { boardId: 4, laneId: null, options: DEFAULT_CHILDREN_OPTIONS, onOptionsChange: vi.fn(), onOpenParent: vi.fn() }
    const { rerender } = render(<ChildrenModeView {...props} refreshKey={0} />)
    await screen.findByRole('region', { name: 'Acme Corp lane' })
    getChildrenView.mockClear()
    getChildrenView.mockImplementationOnce(() => new Promise<ChildrenView>((r) => { release = r }))
    rerender(<ChildrenModeView {...props} refreshKey={1} />)
    rerender(<ChildrenModeView {...props} refreshKey={2} />)
    rerender(<ChildrenModeView {...props} refreshKey={3} />)
    expect(getChildrenView).toHaveBeenCalledTimes(1)
    const signal = getChildrenView.mock.calls[0][2] as AbortSignal
    getChildrenView.mockResolvedValue(view({ next_cursor: null }))
    release(view({ next_cursor: null }))
    await waitFor(() => expect(getChildrenView).toHaveBeenCalledTimes(2))
    expect(signal.aborted).toBe(false)
  })

  it('Focus draws only that lane; a failed read says so', async () => {
    getChildrenView.mockResolvedValueOnce(view())
    const { unmount } = render(<ChildrenModeView boardId={4} laneId={null} focusLaneId={4} options={DEFAULT_CHILDREN_OPTIONS} onOptionsChange={vi.fn()} onOpenParent={vi.fn()} />)
    await screen.findByRole('region', { name: 'Globex lane' })
    expect(screen.queryByRole('region', { name: 'Acme Corp lane' })).toBeNull()
    unmount()
    getChildrenView.mockRejectedValueOnce(new Error('boom'))
    render(<ChildrenModeView boardId={4} laneId={null} options={DEFAULT_CHILDREN_OPTIONS} onOptionsChange={vi.fn()} onOpenParent={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent("Children didn't load")
  })

  it('says once when no card on the board has children (#2370 fix A6)', async () => {
    getChildrenView.mockResolvedValueOnce(view({
      board_total: { in_progress: 0, total: 0, blocked: 0, hidden: 0, planned: 0 },
      lanes: [lane({ parents: 0, total: 0, in_progress: 0, done: 0, hidden: 0 }), lane({ id: 4, name: 'Globex', parents: 0, hidden: 0 })],
      rows: [], child_boards: [], next_cursor: null,
    }))
    render(<ChildrenModeView boardId={4} laneId={null} options={DEFAULT_CHILDREN_OPTIONS} onOptionsChange={vi.fn()} onOpenParent={vi.fn()} />)
    expect(await screen.findByTestId('children-empty')).toHaveTextContent('No cards on this board have children yet.')
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('the lane action scrolls to its lane and puts focus on its collapse button (#2370 fix A2)', async () => {
    getChildrenView.mockResolvedValueOnce(view({ next_cursor: null }))
    const scrolled = vi.fn()
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: unknown }
    const prev = proto.scrollIntoView
    proto.scrollIntoView = scrolled
    const done = vi.fn()
    try {
      render(<ChildrenModeView boardId={4} laneId={4} laneFocusRequest={4} onLaneFocusDone={done} options={DEFAULT_CHILDREN_OPTIONS} onOptionsChange={vi.fn()} onOpenParent={vi.fn()} />)
      await waitFor(() => expect(document.activeElement).toHaveAccessibleName('Collapse Globex'))
      expect(scrolled).toHaveBeenCalledWith({ block: 'start' })
      expect(done).toHaveBeenCalled()
    } finally {
      proto.scrollIntoView = prev
    }
  })

  it('"N done · Show" keeps focus in its cell; the planned fold opens and folds back with aria-expanded (#2370 fix A3)', async () => {
    getChildrenView.mockResolvedValue(view({ next_cursor: null }))
    const { rerender } = render(<ChildrenModeView boardId={4} laneId={null} options={DEFAULT_CHILDREN_OPTIONS} onOptionsChange={vi.fn()} onOpenParent={vi.fn()} />)
    const planned = await screen.findByRole('button', { name: '1 planned · Show' })
    planned.focus()
    fireEvent.click(planned)
    expect(planned).toHaveAttribute('aria-expanded', 'true')
    expect(planned).toHaveTextContent('1 planned · Hide')
    expect(planned).toHaveAttribute('tabindex', '0')
    expect(document.activeElement).toBe(planned)
    expect(screen.getByRole('link', { name: 'Plan workshop, To do, planned' })).toBeInTheDocument()
    fireEvent.click(planned)
    expect(planned).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: /Plan workshop/ })).toBeNull()
    // Done: the button unmounts under the press, focus stays in the cell, then lands on the first done card.
    const show = screen.getAllByRole('button', { name: '1 done. Show done cards' })[0]
    fireEvent.click(show)
    const withDone = view({ next_cursor: null })
    withDone.rows[0].children.push(child({ id: 9, title: 'Kickoff', column_id: 32, state: 'done' }))
    getChildrenView.mockResolvedValue(withDone)
    rerender(<ChildrenModeView boardId={4} laneId={null} options={{ ...DEFAULT_CHILDREN_OPTIONS, showDone: true }} onOptionsChange={vi.fn()} onOpenParent={vi.fn()} />)
    await waitFor(() => expect(document.activeElement).toHaveAccessibleName('Kickoff, Done'))
  })

  it("a large lane's Open is reached with Down from the row title (#2370 fix A4)", async () => {
    const many = Array.from({ length: 9 }, (_, i) => row({ id: 70 + i, title: `P${i}`, children: [child({ id: 100 + i, title: `K${i}` })] }))
    getChildrenView.mockResolvedValue(view({ lanes: [lane({ parents: 9 })], rows: many, next_cursor: null }))
    render(<ChildrenModeView boardId={4} laneId={null} options={DEFAULT_CHILDREN_OPTIONS} onOptionsChange={vi.fn()} onOpenParent={vi.fn()} />)
    const p0 = await screen.findByRole('button', { name: 'P0' })
    p0.focus()
    fireEvent.keyDown(p0, { key: 'ArrowDown' })
    expect(document.activeElement).toHaveAccessibleName('Open P0')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toHaveAccessibleName('P1')
  })

  it('Move is an icon action inside the card, named for it and never visible text; Copy link failure shows on screen (#2370 fix A7, A11)', async () => {
    getChildrenView.mockResolvedValue(view({ next_cursor: null }))
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    render(<MemoryRouter><ChildrenModeView boardId={4} laneId={null} options={DEFAULT_CHILDREN_OPTIONS} onOptionsChange={vi.fn()} onOpenParent={vi.fn()} /></MemoryRouter>)
    const move = await screen.findByRole('button', { name: 'Move Pen-test call' })
    expect(move).toHaveTextContent('')
    expect(screen.queryByText('Move', { selector: 'button' })).toBeNull()
    // The card is a router link, and its Move sits inside the card's own box.
    const card = screen.getByRole('link', { name: 'Pen-test call, Doing, blocked' })
    expect(card).toHaveAttribute('href', '/boards/7?card=2&from_parent=40')
    expect(card.parentElement).toContainElement(move)
    fireEvent.click(screen.getAllByRole('button', { name: /^Copy link/ })[0])
    expect(await screen.findByText("Couldn't copy the link", { selector: 'span.text-danger' })).toBeInTheDocument()
  })
})
