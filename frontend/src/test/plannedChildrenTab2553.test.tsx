import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CardChildrenTab from '../components/Card/CardChildrenTab'
import PlannedMoveWarning, { firstColumnId, plannedMoveWarningText } from '../components/Card/PlannedMoveWarning'
import type { ChildrenState } from '../components/Card/cardChildren'
import { moveCard } from '../api/cards'
import type { CardChildRow, CardChildrenRead } from '../types'

vi.mock('../api/cards', () => ({
  getCardChildren: vi.fn(),
  getChildBoardOptions: vi.fn(),
  getChildCandidates: vi.fn(),
  linkCardParent: vi.fn(),
  moveCard: vi.fn(),
  unlinkCardChild: vi.fn(),
  addChild: vi.fn(),
}))
vi.mock('../api/boards', () => ({ patchBoard: vi.fn() }))

const parentBoard = { id: 1, name: 'Pipeline', cards_can_have_children: true, current_user_role: 'member' as const }
const columns = [
  { id: 100, name: 'To do', color: '#6B7280', wip_limit: null, is_done: false, card_count: 3 },
  { id: 101, name: 'Doing', color: '#3B82F6', wip_limit: null, is_done: false, card_count: 1 },
  { id: 102, name: 'Done', color: '#22C55E', wip_limit: null, is_done: true, card_count: 0 },
]

function row(over: Partial<CardChildRow>): CardChildRow {
  return {
    id: 10, title: 'Proposal readout with Hooli CFO', board_id: 7, column_id: 100, column_name: 'To do',
    swimlane_id: 50, swimlane_name: 'Lane', archived: false, position: 0, assignee: null,
    blocked: false, blocked_at: null, priority: 'low', due_date: null, labels: [], ...over,
  }
}

function read(results: CardChildRow[]): CardChildrenRead {
  return {
    count: results.length, visible: true, offset: 0, limit: 50, results,
    board: { id: 7, name: 'Delivery', role: 'member', enforce_wip_limits: false, enforce_wip_hard: false, columns },
  }
}

function state(data: CardChildrenRead, reload = vi.fn()): ChildrenState {
  return { data, error: false, loading: false, reload }
}

function renderTab(s: ChildrenState) {
  return render(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="Hooli: pilot rollout" state={s} onExitToTabs={vi.fn()} userTimezone="UTC" />)
}

beforeEach(() => vi.clearAllMocks())

describe('plannedMoveWarningText (#2550)', () => {
  const today = '2026-11-24'
  const doing = { id: 101, is_done: false }
  it('warns only for a planned card with a passed date leaving the first column for an open column', () => {
    expect(plannedMoveWarningText({ planned: true, due_date: '2026-11-20' }, doing, 100, today))
      .toBe('Its date, Nov 20, has passed. It will be overdue once moved.')
  })
  it.each([
    ['not planned', { planned: false, due_date: '2026-11-20' }, doing],
    ['planned field absent', { due_date: '2026-11-20' }, doing],
    ['no date', { planned: true, due_date: null }, doing],
    ['date today', { planned: true, due_date: today }, doing],
    ['date ahead', { planned: true, due_date: '2026-12-04' }, doing],
    ['no target', { planned: true, due_date: '2026-11-20' }, null],
    ['stays in the first column', { planned: true, due_date: '2026-11-20' }, { id: 100 }],
    ['to a done column', { planned: true, due_date: '2026-11-20' }, { id: 102, is_done: true }],
  ])('stays silent: %s', (_name, card, target) => {
    expect(plannedMoveWarningText(card as { planned?: boolean; due_date: string | null }, target, 100, today)).toBeNull()
  })
  it('firstColumnId picks the lowest position, then the lowest id', () => {
    expect(firstColumnId([{ id: 9, position: 2 }, { id: 4, position: 0 }, { id: 3, position: 0 }])).toBe(3)
    expect(firstColumnId([])).toBeUndefined()
  })
  it('keeps an empty sr-only status mounted, then fills it with the warning', () => {
    const { rerender } = render(<PlannedMoveWarning text={null} />)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(screen.getByRole('status')).toHaveClass('sr-only')
    rerender(<PlannedMoveWarning text="Its date, Dec 4, has passed. It will be overdue once moved." />)
    expect(screen.getByRole('status')).toHaveTextContent('Its date, Dec 4, has passed.')
    expect(screen.getByRole('status')).toHaveClass('text-warning')
  })
})

describe('Children tab summary uses the footer planned bucket (#2551)', () => {
  it('counts a planned child as planned, not to do; blocked and done beat planned', () => {
    renderTab(state(read([
      row({ id: 1, planned: true }),
      row({ id: 2, column_id: 100, position: 1 }),
      row({ id: 3, column_id: 100, position: 2, planned: true, blocked: true }),
      row({ id: 4, column_id: 102, position: 3, planned: true }),
    ])))
    expect(screen.getByTestId('children-planned-count')).toHaveTextContent(/^1 planned$/)
    expect(screen.getByRole('img', { name: '1 done, 0 doing, 1 blocked, 1 to do, 1 planned for later columns' })).toBeInTheDocument()
  })

  it('omits the planned segment and count when no child is planned', () => {
    renderTab(state(read([row({ id: 1 })])))
    expect(screen.queryByTestId('children-planned-count')).toBeNull()
    expect(screen.getByRole('img', { name: '0 done, 0 doing, 0 blocked, 1 to do' })).toBeInTheDocument()
  })
})

describe("Children tab: a planned child's date is inactive (#2553)", () => {
  it('a planned child with a past date reads "passed while planned", never Overdue', () => {
    renderTab(state(read([row({ planned: true, due_date: '2020-01-02' })])))
    const face = screen.getByTestId('child-card-face')
    expect(face).toHaveTextContent('Jan 2 passed while planned')
    expect(within(face).queryByText(/Overdue/)).toBeNull()
    expect(within(face).getByText('Jan 2 passed while planned')).toHaveClass('text-warning')
  })
  it('a planned child with a future date says when it counts; without a date it says planned', () => {
    renderTab(state(read([
      row({ id: 10, planned: true, due_date: '2099-12-04' }),
      row({ id: 11, title: 'Workshop', planned: true }),
    ])))
    const faces = screen.getAllByTestId('child-card-face')
    expect(faces[0]).toHaveTextContent('Planned for a later stage · Dec 4, counts once needed')
    expect(faces[1]).toHaveTextContent('Planned for a later stage')
  })
  it('an ordinary child with a past date is still Overdue', () => {
    renderTab(state(read([row({ due_date: '2020-01-02' })])))
    expect(screen.getByTestId('child-card-face')).toHaveTextContent(/Overdue/)
  })
})

describe('Children tab Move popover (#2550)', () => {
  it('warns before pulling a planned child whose date has passed, then moves and focuses the card', async () => {
    const reload = vi.fn()
    vi.mocked(moveCard).mockResolvedValue({} as never)
    renderTab(state(read([row({ planned: true, due_date: '2020-12-04' })]), reload))
    await userEvent.click(screen.getByRole('button', { name: 'Move Proposal readout with Hooli CFO' }))
    const dialog = screen.getByRole('dialog', { name: 'Move Proposal readout with Hooli CFO' })
    expect(within(dialog).getByRole('status')).toBeEmptyDOMElement()
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Doing' }))
    expect(within(dialog).getByRole('status')).toHaveTextContent('Its date, Dec 4, has passed. It will be overdue once moved.')
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Done' }))
    expect(within(dialog).getByRole('status')).toBeEmptyDOMElement()
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Doing' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
    expect(moveCard).toHaveBeenCalledWith(7, 10, { column_id: 101, swimlane_id: 50, position: 1 }, false)
    await waitFor(() => expect(screen.getByRole('link', { name: /^Proposal readout with Hooli CFO/ })).toHaveFocus())
  })
  it('does not warn for an ordinary child', async () => {
    renderTab(state(read([row({ due_date: '2020-12-04' })])))
    await userEvent.click(screen.getByRole('button', { name: 'Move Proposal readout with Hooli CFO' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Doing' }))
    expect(screen.getByTestId('planned-move-warning')).toBeEmptyDOMElement()
  })
})
