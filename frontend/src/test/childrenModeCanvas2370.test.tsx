import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import ChildrenModeView from '../components/Board/ChildrenModeView'
import ChildStateBar from '../components/Card/ChildStateBar'
import { DEFAULT_CHILDREN_OPTIONS, columnHeadCaption, laneIdleLabel, laneTotalParts, phoneHiddenLabel } from '../utils/childrenMode'
import type { ChildrenView, ChildrenViewChild, ChildrenViewLane, ChildrenViewRow } from '../types'

// Children mode's canvas fidelity rules (#2370 fix round B; canvas 6a, 6b, 2f g, 8 § 5).
const getChildrenView = vi.fn()
vi.mock('../api/cards', () => ({ getChildrenView: (...a: unknown[]) => getChildrenView(...a), moveCard: vi.fn() }))

const NOW = Date.parse('2026-11-26T12:00:00Z')
const lane = (o: Partial<ChildrenViewLane> = {}): ChildrenViewLane => ({
  id: 3, name: 'Acme Corp', position: 0, parents: 3, child_boards: 2, total: 16, in_progress: 12, done: 4, doing: 3,
  todo: 6, blocked: 3, hidden: 4, folded: 0, planned_only: 0, planned: 0, last_moved_at: null, ...o,
})
const child = (o: Partial<ChildrenViewChild>): ChildrenViewChild => ({
  id: 50, title: 'Child', column_id: 30, swimlane_id: 12, position: 0, state: 'todo', assignee: null,
  blocked: false, blocked_at: null, blocked_reason: null, planned: false, ...o,
})
const row = (o: Partial<ChildrenViewRow>): ChildrenViewRow => ({
  id: 40, title: 'Acme: analytics module', swimlane_id: 3, column_id: 9, column_name: 'Discovery', assignee: null,
  rollup: { visible: true, total: 6, done: 1, doing: 1, todo: 1, blocked: 3, last_moved_at: null },
  in_progress: 5, folded: false, planned: 0, planned_only: false, child_board_id: 7, children: [child({ id: 51 })], ...o,
})
const col = (id: number, name: string, is_done = false) => ({ id, name, color: '#3B82F6', wip_limit: null, is_done, card_count: 2 })
const view = (o: Partial<ChildrenViewLane> = {}): ChildrenView => ({
  board_total: { in_progress: 25, total: 30, blocked: 3, hidden: 4, planned: 0 },
  lanes: [lane(o)],
  rows: [
    row({}),
    row({ id: 42, title: 'Acme: training pack', child_board_id: 8, children: [child({ id: 60, column_id: 80 })], rollup: { visible: true, total: 2, done: 0, doing: 1, todo: 1, blocked: 0, last_moved_at: null } }),
    row({ id: 43, title: 'Acme: expansion pilot', child_board_id: null, children: [], rollup: { visible: false, total: 4 } }),
  ],
  child_boards: [
    { id: 7, name: 'Delivery', role: 'viewer', enforce_wip_limits: false, enforce_wip_hard: false, columns: [col(30, 'To do'), col(31, 'Doing'), col(32, 'Blocked'), col(33, 'Done', true)] },
    { id: 8, name: 'Onboarding', role: 'viewer', enforce_wip_limits: false, enforce_wip_hard: false, columns: [col(80, 'Requested'), col(81, 'Scheduled'), col(82, 'Live', true)] },
  ],
  next_cursor: null,
})
const base = { boardId: 4, laneId: null, options: DEFAULT_CHILDREN_OPTIONS, onOptionsChange: vi.fn(), onOpenParent: vi.fn() }

describe('Children mode canvas rules (#2370 fix round B)', () => {
  beforeEach(() => getChildrenView.mockReset())

  it('splits the band total, words idle by the card rollup rule and shortens the phone hidden count', () => {
    expect(laneTotalParts(lane())).toEqual({ active: '12 in progress', rest: ' of 16' })
    expect(laneTotalParts(lane({ in_progress: 2, planned: 2 }))).toEqual({ active: '2 in progress', rest: ' · 2 planned' })
    const moved = '2026-11-17T12:00:00Z'
    expect(laneIdleLabel(lane({ last_moved_at: moved }), 7, NOW)).toBe('Work idle 9d')
    expect(laneIdleLabel(lane({ last_moved_at: moved }), 14, NOW)).toBeNull()
    expect(laneIdleLabel(lane({ last_moved_at: null }), 7, NOW)).toBeNull()
    // Planned children never make a lane idle, and an all-planned lane has nothing to be idle.
    expect(laneIdleLabel(lane({ total: 2, planned: 2, done: 0, doing: 0, todo: 0, blocked: 0, last_moved_at: moved }), 7, NOW)).toBeNull()
    expect(phoneHiddenLabel(4)).toBe("+4 you can't open")
    expect(columnHeadCaption(col(82, 'Live', true), 0, 'Onboarding', false, true)).toBe('Done column')
    expect(columnHeadCaption(col(33, 'Done', true), 0, 'Delivery', false)).toBe('Count per row · Show opens them')
  })

  it('draws one segment per child up to the limit, else one per state', () => {
    const { rerender } = render(<ChildStateBar perChild counts={{ done: 1, doing: 1, blocked: 3, todo: 1 }} />)
    expect([...screen.getByTestId('children-state-bar').children].map((e) => e.getAttribute('data-segment'))).toEqual(['done', 'doing', 'blocked', 'blocked', 'blocked', 'todo'])
    rerender(<ChildStateBar perChild counts={{ done: 8, planned: 4 }} />)
    expect(screen.getByTestId('children-state-bar').children).toHaveLength(2)
    rerender(<ChildStateBar counts={{}} />)
    expect(screen.queryByTestId('children-state-bar')).toBeNull()
  })

  it('puts the locked row inside the first section, pads a narrower board before Done and reports the board total', async () => {
    getChildrenView.mockResolvedValue(view())
    const onBoardTotal = vi.fn()
    const { unmount } = render(<ChildrenModeView {...base} onBoardTotal={onBoardTotal} />)
    const delivery = await screen.findByRole('grid', { name: 'Acme Corp children on Delivery, by parent' })
    const cell = within(delivery).getByTestId('children-locked-cell')
    expect(cell).toHaveTextContent("4 children on a board you can't open")
    expect(cell.closest('[role="row"]')).toHaveTextContent('Acme: expansion pilot')
    expect(cell.closest('[role="row"]')).toHaveTextContent('Discovery')
    expect(screen.queryByTestId('children-locked-row')).toBeNull()
    const onboarding = screen.getByRole('grid', { name: 'Acme Corp children on Onboarding, by parent' })
    const parts = [...onboarding.querySelector('[role="row"]')!.children]
    // Parent, Requested, Scheduled, the empty space, Live.
    expect(parts).toHaveLength(5)
    expect(parts[3]).toHaveAttribute('data-pad')
    expect(screen.getByText('Done column')).toBeInTheDocument()
    expect(screen.queryByTestId('children-board-total')).toBeNull()
    expect(onBoardTotal).toHaveBeenCalledWith(25)
    unmount()
    expect(onBoardTotal).toHaveBeenLastCalledWith(null)
  })

  it('drops the band actions and shows idle work on a collapsed lane', async () => {
    getChildrenView.mockResolvedValue(view({ blocked: 0, last_moved_at: '2020-01-01T00:00:00Z' }))
    render(<ChildrenModeView {...base} onFocusLane={vi.fn()} stalenessDays={7} />)
    const toggle = await screen.findByRole('button', { name: 'Collapse Acme Corp' })
    expect(screen.getByRole('button', { name: 'Copy link to Acme Corp' })).toBeInTheDocument()
    expect(screen.queryByText(/Work idle/)).toBeNull()
    fireEvent.click(toggle)
    expect(screen.queryByRole('button', { name: 'Copy link to Acme Corp' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Focus on Acme Corp' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Acme Corp lane' })).toHaveTextContent('12 in progress of 16 · none blocked')
    expect(screen.getByText(/^Work idle \d+d$/)).toHaveClass('text-warning')
  })

  it('draws a large lane as one line per parent, with Open revealed rather than shown', async () => {
    getChildrenView.mockResolvedValue({ ...view({ parents: 12 }), rows: [row({ id: 44, title: 'Acme: renewal', rollup: { visible: true, total: 5, done: 3, doing: 1, todo: 1, blocked: 0, last_moved_at: null } })] })
    render(<ChildrenModeView {...base} />)
    const title = await screen.findByRole('button', { name: 'Acme: renewal' })
    const line = title.closest<HTMLElement>('[role="row"]')!
    expect(line).toHaveTextContent('3/5 done')
    expect(line).not.toHaveTextContent('Discovery')
    expect(within(line).getByTestId('children-state-bar')).toBeInTheDocument()
    expect(within(line).getByRole('button', { name: 'Open Acme: renewal' })).toHaveClass('opacity-0', 'focus:opacity-100')
  })

  it('phone: lane swatch, uppercase parent headings and the short hidden count', async () => {
    getChildrenView.mockResolvedValue(view())
    render(<ChildrenModeView {...base} phone laneColors={{ 3: '#F59E0B' }} />)
    await waitFor(() => expect(screen.getByTestId('children-lane-swatch')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Acme: analytics module' })).toHaveClass('uppercase')
    expect(screen.getByText("+4 you can't open")).toBeInTheDocument()
    expect(screen.getByTestId('children-locked-row')).toBeInTheDocument()
  })
})
