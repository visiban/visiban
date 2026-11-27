import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChildrenModeView from '../components/Board/ChildrenModeView'
import { DEFAULT_CHILDREN_OPTIONS, changesPillText, columnHeadCaption, columnOverLimit, holdRowOrder, pendingRowChanges } from '../utils/childrenMode'
import type { ChildrenView, ChildrenViewRow } from '../types'

// Children mode Move (item 11) and live updates (item 9), #2370.
const getChildrenView = vi.fn()
const moveCard = vi.fn()
vi.mock('../api/cards', () => ({
  getChildrenView: (...a: unknown[]) => getChildrenView(...a),
  moveCard: (...a: unknown[]) => moveCard(...a),
}))

const kid = (id: number, title: string, column_id: number) => ({
  id, title, column_id, swimlane_id: 12, position: 0, state: 'todo' as const, assignee: null, blocked: false, blocked_at: null, blocked_reason: null, planned: false,
})
const row = (id: number, title: string, children: ReturnType<typeof kid>[], extra: Partial<ChildrenViewRow> = {}): ChildrenViewRow => ({
  id, title, swimlane_id: 3, column_id: 9, column_name: 'Discovery', assignee: null,
  rollup: { visible: true, total: children.length, done: 0, doing: 0, todo: children.length, blocked: 0, last_moved_at: null },
  in_progress: children.length, folded: false, planned: 0, planned_only: false, child_board_id: 7, children, ...extra,
})
const view = (rows: ChildrenViewRow[], role = 'member', doingCount = 4): ChildrenView => ({
  board_total: { in_progress: 3, total: 3, blocked: 0, hidden: 0, planned: 0 },
  lanes: [{ id: 3, name: 'Acme Corp', position: 0, parents: rows.length, child_boards: 1, total: 3, in_progress: 3, done: 0, doing: 0, todo: 3, blocked: 0, hidden: 0, folded: 0, planned_only: 0, planned: 0, last_moved_at: null }],
  rows,
  child_boards: [{
    id: 7, name: 'Delivery', role: role as never, enforce_wip_limits: true, enforce_wip_hard: false,
    columns: [
      { id: 30, name: 'To do', color: '', wip_limit: null, is_done: false, card_count: 9 },
      { id: 31, name: 'Doing', color: '', wip_limit: 5, is_done: false, card_count: doingCount },
      { id: 32, name: 'Done', color: '', wip_limit: null, is_done: true, card_count: 3 },
    ],
  }],
  next_cursor: null,
})
const rowsA = () => [row(40, 'Alpha', [kid(1, 'Scope', 30)]), row(41, 'Beta', [kid(2, 'Build', 30)])]
const base = { options: DEFAULT_CHILDREN_OPTIONS, onOptionsChange: vi.fn(), onOpenParent: vi.fn(), boardId: 4, laneId: null }

beforeEach(() => { getChildrenView.mockReset(); moveCard.mockReset() })

describe('shownInProgress, the one in-progress derivation (#2370, #2550)', () => {
  // The server's in_progress already excludes planned (#2551 owner ruling): the client never subtracts it again.
  it('reads the server in_progress as is', async () => {
    const { shownInProgress } = await import('../utils/childrenMode')
    expect(shownInProgress({ in_progress: 4 })).toBe(4)
    expect(shownInProgress({ in_progress: 0 })).toBe(0)
  })
})

describe('Children mode live helpers (#2370 item 9)', () => {
  it('holds the order on screen, appends new rows and drops gone ones', () => {
    const a = { id: 1, v: 'a' }, b = { id: 2, v: 'b' }, c = { id: 3, v: 'c' }
    expect(holdRowOrder([a, b], [{ ...b, v: 'B' }, c, a]).map((r) => `${r.id}${r.v}`)).toEqual(['1a', '2B', '3c'])
    expect(holdRowOrder([a, b, c], [c, a]).map((r) => r.id)).toEqual([1, 3])
  })
  it('counts the row slots that differ in a lane, and words the pill', () => {
    const s = [{ id: 1, swimlane_id: 3 }, { id: 2, swimlane_id: 3 }, { id: 9, swimlane_id: 4 }]
    expect(pendingRowChanges(s, [{ id: 2, swimlane_id: 3 }, { id: 1, swimlane_id: 3 }, { id: 9, swimlane_id: 4 }], 3)).toBe(2)
    expect(pendingRowChanges(s, s, 3)).toBe(0)
    expect(pendingRowChanges(s, [...s, { id: 5, swimlane_id: 3 }], 3)).toBe(1)
    expect(changesPillText(3, 'Acme Corp', false)).toBe('3 changes in Acme Corp')
    expect(changesPillText(1, 'Acme Corp', true)).toBe('1 change')
  })
  it('says "over" past the WIP limit, never at it', () => {
    expect(columnOverLimit({ card_count: 6, wip_limit: 5 })).toBe(true)
    expect(columnOverLimit({ card_count: 5, wip_limit: 5 })).toBe(false)
    expect(columnOverLimit({ card_count: 6, wip_limit: null })).toBe(false)
    expect(columnHeadCaption({ is_done: false, card_count: 6, wip_limit: 5 }, 1, 'Delivery', false)).toBe('1 of 6 on Delivery · limit 5 over')
  })
})

describe('Children mode column meter past the limit (#2370 ruling)', () => {
  it('uses the warning tone and the word over, and keeps the meter fill primary', async () => {
    getChildrenView.mockResolvedValue(view(rowsA(), 'member', 7))
    render(<ChildrenModeView {...base} />)
    const caption = await screen.findByText('0 of 7 on Delivery · limit 5 over')
    expect(caption).toHaveClass('text-warning-on-tint')
    expect(caption).not.toHaveClass('text-danger')
    const meter = screen.getByRole('meter', { name: 'Doing on Delivery: 7 of limit 5' })
    expect(meter.querySelector('span')).toHaveClass('bg-primary-emphasis')
  })
})

describe('Children mode Move (#2370 item 11)', () => {
  it('renders Move only for MEMBER+ on the child board, never on a locked row', async () => {
    const locked = row(42, 'Gamma', [], { rollup: { visible: false, total: 4 } as ChildrenViewRow['rollup'], child_board_id: null, in_progress: null })
    getChildrenView.mockResolvedValue(view([...rowsA(), locked], 'viewer'))
    const { unmount } = render(<ChildrenModeView {...base} />)
    await screen.findByRole('link', { name: /^Scope/ })
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull()
    unmount()
    getChildrenView.mockResolvedValue(view([...rowsA(), locked], 'member'))
    render(<ChildrenModeView {...base} />)
    await screen.findByRole('button', { name: 'Move Scope' })
    expect(screen.getAllByRole('button', { name: /^Move / })).toHaveLength(2)
    const lockedRow = screen.getByRole('button', { name: 'Gamma' }).closest<HTMLElement>('[role="row"]')!
    expect(within(lockedRow).queryByRole('button', { name: /^Move / })).toBeNull()
  })

  it('Move lives inside the card stop: Right reaches it, Left goes back, it is never a Tab stop', async () => {
    getChildrenView.mockResolvedValue(view(rowsA()))
    render(<ChildrenModeView {...base} />)
    const card = await screen.findByRole('link', { name: /^Scope/ })
    const move = screen.getByRole('button', { name: 'Move Scope' })
    expect(move).toHaveAttribute('tabindex', '-1')
    act(() => card.focus())
    await userEvent.keyboard('{ArrowRight}')
    expect(move).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(card).toHaveFocus()
    act(() => move.focus())
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('link', { name: /^Build/ })).toHaveFocus()
  })

  it("moves the column only through the child board's endpoint, re-reads, and returns focus to the moved card", async () => {
    getChildrenView.mockResolvedValue(view(rowsA()))
    moveCard.mockResolvedValue({})
    render(<ChildrenModeView {...base} currentUserId={5} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Move Scope' }))
    const dialog = screen.getByRole('dialog', { name: 'Move Scope' })
    await userEvent.click(within(dialog).getByRole('radio', { name: /Doing 4 of 5/ }))
    const moved = view([row(40, 'Alpha', [kid(1, 'Scope', 31)]), row(41, 'Beta', [kid(2, 'Build', 30)])])
    getChildrenView.mockResolvedValue(moved)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
    expect(moveCard).toHaveBeenCalledWith(7, 1, { column_id: 31, position: 4 }, false)
    await waitFor(() => expect(getChildrenView).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('link', { name: /^Scope, Doing/ })).toHaveFocus())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it("shows the server's refusal in the picker, and Cancel returns focus to the card", async () => {
    getChildrenView.mockResolvedValue(view(rowsA()))
    moveCard.mockRejectedValue(new Error('nope'))
    render(<ChildrenModeView {...base} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Move Scope' }))
    const dialog = screen.getByRole('dialog', { name: 'Move Scope' })
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Done' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't move Scope. Try again.")
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByRole('link', { name: /^Scope/ })).toHaveFocus())
  })
})

describe('Children mode live updates (#2370 item 9)', () => {
  it('re-reads in place on refreshKey; re-sorts at once when focus is outside the grid', async () => {
    getChildrenView.mockResolvedValue(view(rowsA()))
    const { rerender } = render(<ChildrenModeView {...base} refreshKey={0} />)
    await screen.findByRole('link', { name: /^Scope/ })
    getChildrenView.mockResolvedValue(view([...rowsA()].reverse()))
    rerender(<ChildrenModeView {...base} refreshKey={1} />)
    await waitFor(() => expect(screen.getAllByRole('rowheader').map((h) => h.querySelector('button')?.textContent)).toEqual(['Beta', 'Alpha']))
    expect(screen.queryByRole('button', { name: /changes? in/ })).toBeNull()
  })

  it('holds the row order while focus is in the grid, keeps a moved card focused, and the pill applies the order', async () => {
    getChildrenView.mockResolvedValue(view(rowsA()))
    const { rerender } = render(<ChildrenModeView {...base} refreshKey={0} />)
    const scope = await screen.findByRole('link', { name: /^Scope/ })
    act(() => scope.focus())
    // Scope moved to Doing and Beta now sorts first.
    getChildrenView.mockResolvedValue(view([row(41, 'Beta', [kid(2, 'Build', 30)]), row(40, 'Alpha', [kid(1, 'Scope', 31)])]))
    rerender(<ChildrenModeView {...base} refreshKey={1} />)
    await waitFor(() => expect(screen.getByRole('link', { name: /^Scope, Doing/ })).toHaveFocus())
    expect(screen.getAllByRole('rowheader').map((h) => h.querySelector('button')?.textContent)).toEqual(['Alpha', 'Beta'])
    const pill = await screen.findByRole('button', { name: '2 changes in Acme Corp · Show' })
    expect(pill.closest('[role="status"]')).toHaveAttribute('aria-live', 'polite')
    await userEvent.click(pill)
    await waitFor(() => expect(screen.getAllByRole('rowheader').map((h) => h.querySelector('button')?.textContent)).toEqual(['Beta', 'Alpha']))
    expect(screen.queryByRole('button', { name: /changes in/ })).toBeNull()
    // Focus goes back into the lane's grid, never to <body>.
    expect(document.activeElement?.closest('[data-children-grid="3"]')).not.toBeNull()
  })

  it('a focused card that leaves the view hands focus to its parent cell, announced', async () => {
    getChildrenView.mockResolvedValue(view(rowsA()))
    const { rerender } = render(<ChildrenModeView {...base} refreshKey={0} />)
    const scope = await screen.findByRole('link', { name: /^Scope/ })
    act(() => scope.focus())
    getChildrenView.mockResolvedValue(view([row(40, 'Alpha', []), row(41, 'Beta', [kid(2, 'Build', 30)])]))
    rerender(<ChildrenModeView {...base} refreshKey={1} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Alpha' })).toHaveFocus())
    expect(screen.getByText('Scope left this view.')).toBeInTheDocument()
  })

  it('focus leaving the grid for another control applies the held order', async () => {
    getChildrenView.mockResolvedValue(view(rowsA()))
    const { rerender } = render(<ChildrenModeView {...base} refreshKey={0} />)
    const scope = await screen.findByRole('link', { name: /^Scope/ })
    act(() => scope.focus())
    getChildrenView.mockResolvedValue(view([...rowsA()].reverse()))
    rerender(<ChildrenModeView {...base} refreshKey={1} />)
    await screen.findByRole('button', { name: /changes in Acme Corp/ })
    act(() => screen.getByRole('button', { name: 'Collapse Acme Corp' }).focus())
    await waitFor(() => expect(screen.getAllByRole('rowheader').map((h) => h.querySelector('button')?.textContent)).toEqual(['Beta', 'Alpha']))
  })

  it('changes the pill text at most once per 10 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const three = () => [row(40, 'Alpha', [kid(1, 'Scope', 30)]), row(41, 'Beta', [kid(2, 'Build', 30)]), row(43, 'Delta', [kid(3, 'Plan', 30)])]
      getChildrenView.mockResolvedValue(view(three()))
      const { rerender } = render(<ChildrenModeView {...base} refreshKey={0} />)
      const scope = await screen.findByRole('link', { name: /^Scope/ })
      act(() => scope.focus())
      const [a, b, d] = three()
      getChildrenView.mockResolvedValue(view([b, a, d]))
      rerender(<ChildrenModeView {...base} refreshKey={1} />)
      await screen.findByRole('button', { name: '2 changes in Acme Corp · Show' })
      getChildrenView.mockResolvedValue(view([b, d, a]))
      rerender(<ChildrenModeView {...base} refreshKey={2} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(screen.getByRole('button', { name: '2 changes in Acme Corp · Show' })).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
      expect(screen.getByRole('button', { name: '3 changes in Acme Corp · Show' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
