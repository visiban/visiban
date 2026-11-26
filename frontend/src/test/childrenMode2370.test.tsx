import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ChildrenModeView from '../components/Board/ChildrenModeView'
import { CHILDREN_BOARD_ESCAPE_PRIORITY, WIDE_MIN_PX } from '../components/Card/cardChildren'
import { MAXIMIZE_ESCAPE_PRIORITY } from '../components/Card/FieldSetBlocks'
import { parseShowChip } from '../utils/showChips'
import {
  CHILDREN_MODE_ESCAPE_PRIORITY, DEFAULT_CHILDREN_OPTIONS, blockedDays, cellName, childCardName, compactRowLabel,
  foldLabel, isFoldedRow, laneBandName, laneBlockedLabel, laneLink, laneSubtitle, laneTotalLabel, loadChildrenOptions,
  loadShowMode, lockedRowText, moreParentsLabel, parseLaneParam, rowDoneLabel, saveChildrenOptions, saveShowMode,
  stableOrder, visibleChildren,
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
  blocked: false, blocked_at: null, planned: false, ...o,
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
    expect(laneTotalLabel(lane({ in_progress: 4, planned: 2 }))).toBe('2 in progress · 2 planned')
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
    expect(foldLabel(0, 1)).toBe('1 parent with nothing in progress · 1 with only planned work')
    expect(lockedRowText(4)).toBe("4 children on a board you can't open. Their columns and titles are not shown.")
    expect(moreParentsLabel(9, false)).toBe('+9 more parents · loads 20 rows at a time')
    expect(moreParentsLabel(9, true)).toBe('+9 more parents · load 20')
  })

  it('folds planned-only rows unless Only planned, and filters children', () => {
    expect(isFoldedRow(row({ planned_only: true }), 'any')).toBe(true)
    expect(isFoldedRow(row({ planned_only: true }), 'only')).toBe(false)
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
    expect(cellName('Acme: analytics module', 'Blocked', 2)).toBe('Acme: analytics module, Blocked, 2 cards')
    expect(cellName('A', 'To do', 1)).toBe('A, To do, 1 card')
    const now = Date.parse('2026-11-20T00:00:00Z')
    expect(blockedDays(child({ blocked: true, blocked_at: '2026-11-16T00:00:00Z' }), now)).toBe(4)
    expect(blockedDays(child(), now)).toBeNull()
  })

  it('never re-sorts rows under focus: keeps the old order and counts the changes', () => {
    expect(stableOrder([1, 2, 3], [3, 1, 2])).toEqual({ order: [1, 2, 3], changes: 3 })
    expect(stableOrder([1, 2], [2, 4])).toEqual({ order: [2, 4], changes: 0 })
  })
})

const view = (o: Partial<ChildrenView> = {}): ChildrenView => ({
  board_total: { in_progress: 6, total: 8, blocked: 1, hidden: 4, planned: 2 },
  lanes: [lane({ total: 8, in_progress: 6, planned: 2, planned_only: 1, folded: 0, parents: 4, done: 2 }), lane({ id: 4, name: 'Globex', parents: 1, hidden: 0 })],
  rows: [
    row({
      children: [
        child({ id: 1, title: 'Plan workshop', column_id: 30, planned: true }),
        child({ id: 2, title: 'Pen-test call', column_id: 31, blocked: true, state: 'blocked' }),
      ],
      planned: 1,
    }),
    row({ id: 41, title: 'Acme: pilot', rollup: { visible: true, total: 1, done: 0, doing: 0, todo: 1, blocked: 0, last_moved_at: null }, planned: 1, planned_only: true, children: [child({ id: 3, planned: true })] }),
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
    expect(screen.getByText('4 in progress · 2 planned')).toBeInTheDocument()
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

  it('opens a linked lane expanded with the others collapsed, loads more, and copies the lane link', async () => {
    getChildrenView.mockResolvedValueOnce(view()).mockResolvedValueOnce(view({ rows: [row({ id: 43, title: 'Acme: more' })], next_cursor: null }))
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<ChildrenModeView boardId={4} laneId={null} options={DEFAULT_CHILDREN_OPTIONS} onOptionsChange={vi.fn()} onOpenParent={vi.fn()} phone />)
    fireEvent.click(await screen.findByRole('button', { name: '+1 more parent · load 20' }))
    await screen.findByRole('button', { name: 'Acme: more' })
    expect(getChildrenView).toHaveBeenLastCalledWith(4, { lane: null, cursor: 'abc', done: false })
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy link' })[0])
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/boards/4?show=children&lane=3`))
    expect(screen.getByRole('button', { name: 'Collapse lane Acme Corp, 4 in progress of 8' })).toBeInTheDocument()
  })

  it('a linked lane shows only that lane, and a failed read says so', async () => {
    getChildrenView.mockResolvedValueOnce(view())
    const { unmount } = render(<ChildrenModeView boardId={4} laneId={4} options={DEFAULT_CHILDREN_OPTIONS} onOptionsChange={vi.fn()} onOpenParent={vi.fn()} />)
    await screen.findByRole('region', { name: 'Globex lane' })
    expect(screen.queryByRole('region', { name: 'Acme Corp lane' })).toBeNull()
    unmount()
    getChildrenView.mockRejectedValueOnce(new Error('boom'))
    render(<ChildrenModeView boardId={4} laneId={null} options={DEFAULT_CHILDREN_OPTIONS} onOptionsChange={vi.fn()} onOpenParent={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent("Children didn't load")
  })
})
