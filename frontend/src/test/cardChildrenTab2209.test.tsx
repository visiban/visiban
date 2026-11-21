import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CardChildrenTab from '../components/Card/CardChildrenTab'
import { childrenCount, useCardChildren, type ChildrenState } from '../components/Card/cardChildren'
import ChildCardPicker from '../components/Card/ChildCardPicker'
import { childCandidateReason } from '../components/Card/cardParent'
import {
  getCardChildren, getChildBoardOptions, getChildCandidates, linkCardParent, moveCard, unlinkCardChild,
} from '../api/cards'
import type { CardChildRow, CardChildrenRead, ChildCandidate } from '../types'

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

function row(over: Partial<CardChildRow>): CardChildRow {
  return {
    id: 10, title: 'Pen-test scoping call', board_id: 7, column_id: 100, column_name: 'To do',
    swimlane_id: 50, swimlane_name: 'Lane', archived: false, position: 0, assignee: null,
    blocked: false, blocked_at: null, ...over,
  }
}

const columns = [
  { id: 100, name: 'To do', color: '#6B7280', wip_limit: null, is_done: false, card_count: 9 },
  { id: 101, name: 'Doing', color: '#3B82F6', wip_limit: 5, is_done: false, card_count: 5 },
  { id: 102, name: 'Done', color: '#22C55E', wip_limit: null, is_done: true, card_count: 4 },
]

function read(results: CardChildRow[], role = 'member'): CardChildrenRead {
  return {
    count: results.length, visible: true, offset: 0, limit: 50, results,
    board: { id: 7, name: 'Delivery', role: role as never, columns },
  }
}

function state(over: Partial<ChildrenState>): ChildrenState {
  return { data: null, error: false, loading: false, reload: vi.fn(), ...over }
}

const kids = [
  row({ id: 10, title: 'Pen-test scoping call', column_id: 100, position: 0 }),
  row({ id: 11, title: 'Kickoff', column_id: 100, position: 1, blocked: true, blocked_at: new Date(Date.now() - 6 * 86400_000).toISOString() }),
  row({ id: 12, title: 'Contract', column_id: 102, column_name: 'Done', assignee: { id: 3, username: 'sam', display_name: 'Sam', avatar_url: '' } }),
]

function renderTab(s: ChildrenState, onExitToTabs = vi.fn(), board = parentBoard) {
  return render(<CardChildrenTab board={board} cardId={5} cardTitle="Initech: security review" state={s} onExitToTabs={onExitToTabs} />)
}

beforeEach(() => vi.clearAllMocks())

describe('CardChildrenTab states (#2209)', () => {
  it('shows a loading status, an error with Try again, and the hidden count only', async () => {
    const { rerender } = renderTab(state({ loading: true }))
    expect(screen.getByRole('status', { name: 'Loading children' })).toBeInTheDocument()

    const reload = vi.fn()
    rerender(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ error: true, reload })} onExitToTabs={vi.fn()} />)
    expect(screen.getByText("The children didn't load").closest('[role="alert"]')).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reload).toHaveBeenCalled()

    rerender(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ data: { count: 5, visible: false, offset: 0, limit: 50, results: [] } })} onExitToTabs={vi.fn()} />)
    expect(screen.getByTestId('children-hidden')).toHaveTextContent("5 children on a board you can't open")
    expect(screen.queryByRole('button', { name: 'Add child' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Link existing' })).not.toBeInTheDocument()
  })

  it('empty: offers Add child and Link existing to a member, nothing to a viewer', () => {
    const empty = { count: 0, visible: true, offset: 0, limit: 50, results: [] }
    const { rerender } = renderTab(state({ data: empty }))
    expect(screen.getByText('No children yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add child' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Link existing' })).toBeInTheDocument()
    rerender(<CardChildrenTab board={{ ...parentBoard, current_user_role: 'viewer' as never }} cardId={5} cardTitle="P" state={state({ data: empty })} onExitToTabs={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Add child' })).not.toBeInTheDocument()
  })
})

describe('CardChildrenTab scoped board (#2209)', () => {
  it("draws the summary and the child board's columns, counts, limits and links", () => {
    renderTab(state({ data: read(kids) }))
    expect(screen.getByText('1 of 3 done')).toBeInTheDocument()
    expect(screen.getByText(/1 blocked/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '1 done, 0 doing, 1 blocked, 1 to do' })).toBeInTheDocument()
    expect(screen.getByText('2 of 9 on Delivery')).toBeInTheDocument()
    expect(screen.getByText('0 of 5 on Delivery · limit 5')).toBeInTheDocument()
    expect(screen.getByText('15 other cards on Delivery are hidden by this view.')).toBeInTheDocument()
    expect(screen.getByText('New children go to Delivery · To do')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open on Delivery' })).toHaveAttribute('href', '/boards/7')
    const card = screen.getByRole('link', { name: /^Kickoff, To do, blocked, 2 of 2/ })
    expect(card).toHaveAttribute('href', '/boards/7?card=11')
    expect(screen.getByRole('link', { name: /^Contract, Done, Sam/ })).toBeInTheDocument()
    // One roving stop: only the first card is in the Tab order.
    expect(screen.getByRole('link', { name: /^Pen-test scoping call/ })).toHaveAttribute('tabindex', '0')
    expect(card).toHaveAttribute('tabindex', '-1')
  })

  it('arrows move between cards, skip empty columns, and Escape leaves to the tab list', async () => {
    const onExit = vi.fn()
    renderTab(state({ data: read(kids) }), onExit)
    const first = screen.getByRole('link', { name: /^Pen-test/ })
    act(() => first.focus())
    await userEvent.keyboard('{ArrowDown}')
    await waitFor(() => expect(screen.getByRole('link', { name: /^Kickoff/ })).toHaveFocus())
    await userEvent.keyboard('{ArrowRight}')
    await waitFor(() => expect(screen.getByRole('link', { name: /^Contract/ })).toHaveFocus())
    await userEvent.keyboard('{ArrowLeft}')
    await waitFor(() => expect(screen.getByRole('link', { name: /^Pen-test/ })).toHaveFocus())
    await userEvent.keyboard('{End}')
    await waitFor(() => expect(screen.getByRole('link', { name: /^Kickoff/ })).toHaveFocus())
    await userEvent.keyboard('{Home}')
    await waitFor(() => expect(screen.getByRole('link', { name: /^Pen-test/ })).toHaveFocus())
    await userEvent.keyboard('{Escape}')
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it("moves through the child board's move endpoint; an at-limit column is disabled with its reason", async () => {
    const full = read(kids)
    full.board!.columns = columns.map((c) => (c.id === 101 ? { ...c, card_count: 5 } : c))
    const reload = vi.fn()
    vi.mocked(moveCard).mockResolvedValue({} as never)
    renderTab(state({ data: full, reload }))
    await userEvent.click(screen.getByRole('button', { name: 'Move Pen-test scoping call' }))
    const group = screen.getByRole('radiogroup', { name: 'Column on Delivery' })
    expect(within(group).getByRole('radio', { name: /To do · current/ })).toBeChecked()
    expect(within(group).getByRole('radio', { name: /Doing 5 of 5/ })).toBeDisabled()
    expect(within(group).getByText('At its limit of 5')).toBeInTheDocument()
    await userEvent.click(within(group).getByRole('radio', { name: 'Done' }))
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(moveCard).toHaveBeenCalledWith(7, 10, { column_id: 102, swimlane_id: 50, position: 4 })
    await waitFor(() => expect(reload).toHaveBeenCalled())
    expect(screen.getByText('Pen-test scoping call moved to Done. 2 of 3 done.')).toBeInTheDocument()
  })

  it('shows the server refusal when a move is rejected, and Close move returns focus', async () => {
    const err = Object.assign(new Error('x'), { isAxiosError: true, response: { status: 409, data: { detail: 'Doing is at its WIP limit.' } } })
    vi.mocked(moveCard).mockRejectedValue(err)
    renderTab(state({ data: read(kids) }))
    await userEvent.click(screen.getByRole('button', { name: 'Move Contract' }))
    await userEvent.click(screen.getByRole('radio', { name: 'To do' }))
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: 'Move Contract' })).getByText('Doing is at its WIP limit.')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Close move' }))
    await waitFor(() => expect(screen.getByRole('link', { name: /^Contract/ })).toHaveFocus())
  })

  it('a child-board member who only views the parent board can Move but not Unlink or add', () => {
    renderTab(state({ data: read(kids, 'site_admin') }), vi.fn(), { ...parentBoard, current_user_role: 'viewer' as never })
    expect(screen.getByRole('button', { name: 'Move Kickoff' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Unlink child/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add child' })).not.toBeInTheDocument()
  })

  it('keeps Add child live while loading, and flags a failed refresh over stale data', async () => {
    const { rerender } = renderTab(state({ loading: true }))
    expect(screen.getByRole('button', { name: 'Add child' })).toBeInTheDocument()
    const reload = vi.fn()
    rerender(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ data: read(kids), error: true, reload })} onExitToTabs={vi.fn()} />)
    expect(screen.getByText("Couldn't refresh the children.")).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reload).toHaveBeenCalled()
  })

  it('unlinks a child from the parent end', async () => {
    const reload = vi.fn()
    vi.mocked(unlinkCardChild).mockResolvedValue({} as never)
    renderTab(state({ data: read(kids), reload }))
    await userEvent.click(screen.getByRole('button', { name: 'Unlink child Kickoff' }))
    expect(unlinkCardChild).toHaveBeenCalledWith(1, 5, 11)
    await waitFor(() => expect(reload).toHaveBeenCalled())
  })

  it('a viewer on the child board gets no Move, but a parent member keeps Unlink; the cards stay navigable', () => {
    renderTab(state({ data: read(kids, 'viewer') }))
    expect(screen.queryByRole('button', { name: /^Move / })).not.toBeInTheDocument()
    // Parent-side unlink needs member on the parent board and any role on the child board (#1104).
    expect(screen.getByRole('button', { name: 'Unlink child Kickoff' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Link existing' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add child' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^Kickoff/ })).toHaveAttribute('href', '/boards/7?card=11')
  })

  describe('narrow sheet', () => {
    const RO = globalThis.ResizeObserver
    beforeEach(() => {
      globalThis.ResizeObserver = class {
        cb: ResizeObserverCallback
        constructor(cb: ResizeObserverCallback) { this.cb = cb }
        observe() { this.cb([{ contentRect: { width: 540 } } as ResizeObserverEntry], this as never) }
        disconnect() {}
        unobserve() {}
      } as never
    })
    afterEach(() => { globalThis.ResizeObserver = RO })

    it('shows one column at a time, chosen with the column buttons', async () => {
      renderTab(state({ data: read(kids) }))
      expect(screen.getByRole('button', { name: 'Add child to Delivery' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Link existing card' })).toBeInTheDocument()
      const todo = screen.getByRole('button', { name: /To do/, pressed: true })
      expect(screen.queryByRole('link', { name: /^Contract/ })).not.toBeInTheDocument()
      act(() => todo.focus())
      await userEvent.keyboard('{ArrowRight}')
      await userEvent.keyboard('{ArrowRight}')
      await waitFor(() => expect(screen.getByRole('link', { name: /^Contract/ })).toBeInTheDocument())
      expect(screen.getByRole('button', { name: /Done/, pressed: true })).toHaveFocus()
    })
  })
})

describe('Link existing (#2209)', () => {
  const candidate = (over: Partial<ChildCandidate>): ChildCandidate => ({
    id: 20, title: 'Loose task', column_id: 100, column_name: 'To do', swimlane_id: 50, swimlane_name: 'Lane',
    assignee: null, disabled_reason: null, parent_title: null, ...over,
  })

  it('copy for each disabled reason names a parent only when the server did', () => {
    expect(childCandidateReason(candidate({}))).toBeNull()
    expect(childCandidateReason(candidate({ disabled_reason: 'link_exists' }))).toBe('already a child of this card')
    expect(childCandidateReason(candidate({ disabled_reason: 'children_limit' }))).toMatch(/100 children/)
    expect(childCandidateReason(candidate({ disabled_reason: 'already_has_parent', parent_title: 'Acme' }))).toBe('already a child of Acme')
    expect(childCandidateReason(candidate({ disabled_reason: 'already_has_parent' }))).toBe("already a child of a card you can't open")
  })

  it("opens on the fixed child board and links on the child's own board", async () => {
    vi.mocked(getChildBoardOptions).mockResolvedValue({
      fixed_board: { hidden: false, id: 7, name: 'Delivery', can_add: true }, default: null, can_set_default: false, boards: [],
    })
    vi.mocked(getChildCandidates).mockResolvedValue([
      candidate({}), candidate({ id: 21, title: 'Taken', disabled_reason: 'already_has_parent' }),
    ])
    vi.mocked(linkCardParent).mockResolvedValue({ parent_id: 5, child_id: 20 })
    const reload = vi.fn()
    renderTab(state({ data: read(kids), reload }))
    await userEvent.click(screen.getByRole('button', { name: 'Link existing' }))
    const dialog = await screen.findByRole('dialog', { name: 'Link existing card' })
    expect(within(dialog).getByText('Delivery')).toBeInTheDocument()
    await userEvent.type(within(dialog).getByRole('combobox'), 'task')
    await waitFor(() => expect(getChildCandidates).toHaveBeenCalledWith(1, 5, 7, 'task', expect.anything()))
    expect(await within(dialog).findByText(/already a child of a card you can't open/)).toBeInTheDocument()
    await userEvent.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(linkCardParent).toHaveBeenCalledWith(7, 20, 5))
    await waitFor(() => expect(reload).toHaveBeenCalled())
    expect(screen.queryByRole('dialog', { name: 'Link existing card' })).not.toBeInTheDocument()
  })

  it('with no fixed board or default, offers the chooser boards; none at all says so', async () => {
    vi.mocked(getChildBoardOptions).mockResolvedValueOnce({ fixed_board: null, default: null, can_set_default: false, boards: [] })
    const empty = { count: 0, visible: true, offset: 0, limit: 50, results: [] }
    renderTab(state({ data: empty }))
    await userEvent.click(screen.getByRole('button', { name: 'Link existing' }))
    expect(await screen.findByText('There is no board you can link children from.')).toBeInTheDocument()
  })

  it('picker: no matching cards, a failed search, and a refused link', async () => {
    vi.mocked(getChildCandidates).mockResolvedValueOnce([])
    const onClose = vi.fn()
    render(<ChildCardPicker boardId={1} cardId={5} cardTitle="P" boards={[{ id: 7, name: 'Delivery' }, { id: 8, name: 'Ops' }]} onLinked={vi.fn()} onClose={onClose} />)
    const box = screen.getByRole('combobox', { name: 'Card' })
    await userEvent.type(box, 'zz')
    expect(await screen.findByText('No matching cards')).toBeInTheDocument()
    vi.mocked(getChildCandidates).mockRejectedValueOnce(new Error('net'))
    await userEvent.type(box, 'z')
    expect(await screen.findByText('Search failed. Try again.')).toBeInTheDocument()
    vi.mocked(getChildCandidates).mockResolvedValueOnce([candidate({})])
    vi.mocked(linkCardParent).mockRejectedValueOnce({ response: { status: 400, data: { code: 'already_has_parent' } } })
    await userEvent.type(box, 'z')
    await screen.findByText('Loose task')
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(await screen.findByText('This card already has a parent. Unlink it first.')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })
})

describe('useCardChildren (#2209)', () => {
  it('reads every page and drops archived children; disabled reads nothing', async () => {
    vi.mocked(getCardChildren)
      .mockResolvedValueOnce({ ...read([row({ id: 1 }), row({ id: 2, archived: true })]), count: 3 })
      .mockResolvedValueOnce({ ...read([row({ id: 3 })]), count: 3, offset: 2 })
    const { result } = renderHook(() => useCardChildren(1, 5, true))
    await waitFor(() => expect(result.current.data).not.toBeNull())
    expect(getCardChildren).toHaveBeenLastCalledWith(1, 5, 2, expect.anything())
    expect(result.current.data!.results.map((r) => r.id)).toEqual([1, 3])
    expect(childrenCount(result.current.data)).toBe(2)
    expect(childrenCount({ count: 4, visible: false, offset: 0, limit: 50, results: [] })).toBe(4)
    expect(childrenCount(null)).toBeUndefined()

    vi.mocked(getCardChildren).mockRejectedValueOnce(new Error('x'))
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.error).toBe(true))

    vi.mocked(getCardChildren).mockClear()
    renderHook(() => useCardChildren(1, 5, false))
    expect(getCardChildren).not.toHaveBeenCalled()
  })
})
