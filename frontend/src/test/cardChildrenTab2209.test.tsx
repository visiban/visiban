import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import CardChildrenTab from '../components/Card/CardChildrenTab'
import { childrenCount, describeChildrenChange, moveTargetState, useCardChildren, type ChildrenState } from '../components/Card/cardChildren'
import { ToastContext } from '../contexts/useToast'
import { ToastProvider } from '../contexts/ToastContext'
import ChildCardPicker from '../components/Card/ChildCardPicker'
import { childCandidateReason } from '../components/Card/cardParent'
import {
  addChild, getCardChildren, getChildBoardOptions, getChildCandidates, linkCardParent, moveCard, unlinkCardChild,
} from '../api/cards'
import { patchBoard } from '../api/boards'
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
    blocked: false, blocked_at: null, priority: 'low', due_date: null, labels: [], ...over,
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
    board: { id: 7, name: 'Delivery', role: role as never, enforce_wip_limits: true, enforce_wip_hard: false, columns },
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

  it('a hidden board with count 0 renders the ordinary no-children state, not a count', () => {
    renderTab(state({ data: { count: 0, visible: false, offset: 0, limit: 50, results: [] } }))
    expect(screen.queryByTestId('children-hidden')).not.toBeInTheDocument()
    expect(screen.queryByText(/on a board you can't open/)).not.toBeInTheDocument()
    expect(screen.getByTestId('children-empty')).toBeInTheDocument()
  })

  it('the empty state carries one child-cards help link (#2592)', () => {
    renderTab(state({ data: { count: 0, visible: true, offset: 0, limit: 50, results: [] } }))
    const links = screen.getAllByRole('link', { name: 'Learn more about child cards, opens docs' })
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', expect.stringContaining('/features/board/#child-cards'))
  })

  it('the populated heading carries one child-cards help link, also with children turned off (#2592)', () => {
    const { rerender } = renderTab(state({ data: read(kids) }))
    const heading = screen.getByRole('heading', { level: 4 })
    const link = screen.getByRole('link', { name: 'Learn more about child cards, opens docs' })
    expect(link).toHaveAttribute('href', expect.stringContaining('/features/board/#child-cards'))
    expect(heading.parentElement).toContainElement(link)
    rerender(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" canHaveChildren={false} state={state({ data: read(kids) })} onExitToTabs={vi.fn()} />)
    expect(screen.getAllByRole('link', { name: 'Learn more about child cards, opens docs' })).toHaveLength(1)
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
  it('"Open on <board>" is router navigation inside a router, not a full page load', async () => {
    function Where() { const l = useLocation(); return <p>at {l.pathname}</p> }
    render(
      <MemoryRouter initialEntries={['/boards/1']}>
        <Routes>
          <Route path="/boards/1" element={<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ data: read(kids) })} onExitToTabs={vi.fn()} />} />
          <Route path="/boards/7" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    )
    const link = screen.getByRole('link', { name: 'Open on Delivery' })
    expect(link).toHaveAttribute('href', '/boards/7?f_parent=5')
    await userEvent.setup().click(link)
    expect(await screen.findByText('at /boards/7')).toBeInTheDocument()
  })

  it("draws the summary and the child board's columns, counts, limits and links", () => {
    renderTab(state({ data: read(kids) }))
    expect(screen.getByText('1 of 3 done')).toBeInTheDocument()
    expect(screen.getByText(/1 blocked/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '1 done, 0 doing, 1 blocked, 1 to do' })).toBeInTheDocument()
    expect(screen.getByText('2 of 9 on Delivery')).toBeInTheDocument()
    expect(screen.getByText('0 of 5 on Delivery · limit 5, at limit')).toBeInTheDocument()
    expect(screen.getByText('15 other cards on Delivery are hidden by this view.')).toBeInTheDocument()
    expect(screen.getByText('New children go to Delivery · To do')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open on Delivery' })).toHaveAttribute('href', '/boards/7?f_parent=5')
    const card = screen.getByRole('link', { name: /^Kickoff, To do, blocked, 2 of 2/ })
    expect(card).toHaveAttribute('href', '/boards/7?card=11&from_parent=5')
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
    expect(moveCard).toHaveBeenCalledWith(7, 10, { column_id: 102, swimlane_id: 50, position: 4 }, false)
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
    expect(screen.getByRole('link', { name: /^Kickoff/ })).toHaveAttribute('href', '/boards/7?card=11&from_parent=5')
  })

  it('offers Undo on the unlink toast to a member of the child board, but not to a viewer there', async () => {
    vi.mocked(unlinkCardChild).mockResolvedValue(undefined as never)
    const notify = vi.fn(() => 1)
    const toastOf = (n: number) => (notify.mock.calls[n] as unknown as [{ title: string; action?: { label: string } }])[0]
    const mount = (role: string) => render(
      <ToastContext.Provider value={{ notify, dismiss: vi.fn() }}>
        <CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ data: read(kids, role), reload: vi.fn() })} onExitToTabs={vi.fn()} />
      </ToastContext.Provider>,
    )
    const first = mount('member')
    await userEvent.click(screen.getByRole('button', { name: 'Unlink child Kickoff' }))
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
    expect(toastOf(0).action?.label).toBe('Undo')
    first.unmount()
    // A viewer on the child board can unlink, but linking again needs member there: no Undo to fail on.
    mount('viewer')
    await userEvent.click(screen.getByRole('button', { name: 'Unlink child Kickoff' }))
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(2))
    expect(toastOf(1).title).toBe('Unlinked Kickoff')
    expect(toastOf(1).action).toBeUndefined()
  })

  it("puts a child's blocked duration before its labels, priority and due date", () => {
    const first = row({ id: 11, title: 'Kickoff', column_id: 100, position: 1, blocked: true, blocked_at: new Date(Date.now() - 6 * 86400_000).toISOString(), priority: 'high' })
    renderTab(state({ data: read([first]) }))
    const face = screen.getByTestId('child-card-face')
    expect(face.firstElementChild).toHaveTextContent(/⊘ 6d/)
    expect(face).toHaveTextContent(/High/)
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

    it("puts the child board's limit line and WIP meter under the column buttons (#2209 row 12)", async () => {
      const over = read([row({ id: 20, column_id: 101, column_name: 'Doing' })])
      over.board!.columns = columns.map((c) => (c.id === 101 ? { ...c, card_count: 6 } : c))
      renderTab(state({ data: over }))
      expect(screen.getByTestId('children-limit-line')).toHaveTextContent("1 of 6 on Delivery are this card's · limit 5, over limit")
      const meter = screen.getByTestId('children-wip-meter')
      expect(meter).toHaveAttribute('aria-hidden', 'true')
      // Over the limit: the meter is full and warning-colored, as on the child board.
      expect(meter.firstElementChild).toHaveClass('bg-warning')
      // Not color alone: over limit is striped too.
      expect((meter.firstElementChild as HTMLElement).style.backgroundImage).toContain('repeating-linear-gradient')
      expect((meter.firstElementChild as HTMLElement).style.width).toBe('100%')
      // A column with no limit has no meter.
      await userEvent.click(screen.getByRole('button', { name: /To do/ }))
      expect(screen.getByTestId('children-limit-line')).toHaveTextContent("0 of 9 on Delivery are this card's")
      expect(screen.queryByTestId('children-wip-meter')).toBeNull()
    })
  })
})

describe('Add child from the Children tab (#2208, #2209)', () => {
  it('tells the user, in visible text, when the default could not be set', async () => {
    vi.mocked(getChildBoardOptions).mockResolvedValue({
      fixed_board: null, default: null, can_set_default: true,
      boards: [{ id: 7, name: 'Delivery', can_set_default: true }],
    })
    vi.mocked(addChild).mockResolvedValue({} as never)
    vi.mocked(patchBoard).mockRejectedValue(new Error('nope'))
    const user = userEvent.setup()
    renderTab(state({ data: { count: 0, visible: true, offset: 0, limit: 50, results: [] } }))
    await user.click(screen.getByRole('button', { name: 'Add child' }))
    await user.click(await screen.findByRole('combobox', { name: /Child board/ }))
    await user.click(await screen.findByRole('option', { name: 'Delivery' }))
    await user.click(screen.getByRole('checkbox'))
    await user.type(screen.getByLabelText('Title'), 'Task')
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const note = screen.getByRole('status')
    expect(note).toHaveTextContent('Added "Task" to Delivery; the default was not changed.')
    expect(note).not.toHaveClass('sr-only')
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
    expect(childCandidateReason(candidate({ disabled_reason: 'parent_archived' }))).toBe('this card is archived')
    expect(childCandidateReason(candidate({ disabled_reason: 'child_is_parent' }))).toBe('has children of its own')
    expect(childCandidateReason(candidate({ disabled_reason: 'already_has_parent', parent_title: 'Acme' }))).toBe('already a child of Acme')
    expect(childCandidateReason(candidate({ disabled_reason: 'already_has_parent' }))).toBe("already a child of a card you can't open")
  })

  it('an archived parent keeps Add child and Link existing focusable but inert, with the reason (#2447)', async () => {
    render(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="Initech" state={state({ data: read(kids) })} onExitToTabs={vi.fn()} cardArchived />)
    const add = screen.getByRole('button', { name: /^Add child/ })
    const link = screen.getByRole('button', { name: /^Link existing/ })
    for (const b of [add, link]) {
      expect(b).toHaveAttribute('aria-disabled', 'true')
      expect(b.className).toMatch(/aria-disabled:hover:bg-/)
      expect(b).toHaveAccessibleDescription('This card is archived. Restore it before adding or linking children.')
      await userEvent.click(b)
    }
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(getChildBoardOptions).not.toHaveBeenCalled()
  })

  it('Link existing says the card is archived when the server reports it first (#2447)', async () => {
    vi.mocked(getChildBoardOptions).mockResolvedValue({
      fixed_board: { hidden: false, id: 7, name: 'Delivery', can_add: true }, default: null, can_set_default: false, boards: [],
      disabled_reason: 'parent_archived',
    })
    renderTab(state({ data: read(kids) }))
    await userEvent.click(screen.getByRole('button', { name: 'Link existing' }))
    expect(await screen.findByText('This card is archived. Restore it before adding or linking children.')).toHaveAttribute('role', 'alert')
    expect(screen.queryByRole('dialog', { name: 'Link existing card' })).toBeNull()
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
    // Zero never becomes a "Children, 0" chip, hidden board or not.
    expect(childrenCount({ count: 0, visible: false, offset: 0, limit: 50, results: [] })).toBeUndefined()
    expect(childrenCount({ count: 0, visible: true, offset: 0, limit: 50, results: [] })).toBeUndefined()

    vi.mocked(getCardChildren).mockRejectedValueOnce(new Error('x'))
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.error).toBe(true))

    vi.mocked(getCardChildren).mockClear()
    renderHook(() => useCardChildren(1, 5, false))
    expect(getCardChildren).not.toHaveBeenCalled()
  })
})

describe('remote changes (#2209 row 13)', () => {
  const hidden = { count: 3, visible: false, offset: 0, limit: 50, results: [] }
  const movedKids = kids.map((k) => (k.id === 10 ? { ...k, column_id: 101, column_name: 'Doing' } : k))

  it('describes one move, any other change, and nothing for a first, unchanged or hidden read', () => {
    expect(describeChildrenChange(null, read(kids))).toBe('')
    expect(describeChildrenChange(read(kids), read(kids))).toBe('')
    expect(describeChildrenChange(read(kids), read(movedKids))).toBe('Pen-test scoping call moved to Doing. 1 of 3 done.')
    expect(describeChildrenChange(read(kids), read([...kids, row({ id: 13, title: 'New' })]))).toBe('Children updated. 1 of 4 done.')
    expect(describeChildrenChange(read(kids), read(kids.slice(1)))).toBe('Children updated. 1 of 2 done.')
    expect(describeChildrenChange(read(kids), read(kids.map((k) => (k.id === 10 ? { ...k, blocked: true } : k))))).toBe('Children updated. 1 of 3 done.')
    // A board the viewer cannot open never yields a title, column or tally, before or after.
    expect(describeChildrenChange(read(kids), hidden)).toBe('')
    expect(describeChildrenChange(hidden, read(movedKids))).toBe('')
    expect(describeChildrenChange(hidden, hidden)).toBe('')
  })

  it('announces a re-read from elsewhere once, politely; a hidden re-read announces nothing', () => {
    const { rerender } = renderTab(state({ data: read(kids) }))
    const status = () => document.querySelector('[role="status"][aria-live="polite"]')!
    expect(status()).toHaveTextContent('')
    rerender(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ data: read(movedKids) })} onExitToTabs={vi.fn()} />)
    expect(status()).toHaveTextContent('Pen-test scoping call moved to Doing. 1 of 3 done.')
    rerender(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ data: hidden })} onExitToTabs={vi.fn()} />)
    expect(screen.queryByText(/Pen-test scoping call/)).toBeNull()
  })

  it("a re-read after this tab's own write keeps that write's announcement", async () => {
    vi.mocked(unlinkCardChild).mockResolvedValue(undefined as never)
    const reload = vi.fn()
    const { rerender } = renderTab(state({ data: read(kids), reload }))
    await userEvent.click(screen.getByRole('button', { name: 'Unlink child Pen-test scoping call' }))
    await waitFor(() => expect(reload).toHaveBeenCalled())
    rerender(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ data: read(kids.slice(1)), reload })} onExitToTabs={vi.fn()} />)
    expect(screen.getByText('Unlinked Pen-test scoping call.')).toBeInTheDocument()
    expect(screen.queryByText(/Children updated/)).toBeNull()
    // The next re-read is someone else's again.
    rerender(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ data: read(kids.slice(2)), reload })} onExitToTabs={vi.fn()} />)
    expect(screen.getByText('Children updated. 1 of 1 done.')).toBeInTheDocument()
  })

  it('a failed re-read after a write does not swallow the next remote change', async () => {
    vi.mocked(unlinkCardChild).mockResolvedValue(undefined as never)
    const reload = vi.fn()
    const { rerender } = renderTab(state({ data: read(kids), reload }))
    await userEvent.click(screen.getByRole('button', { name: 'Unlink child Pen-test scoping call' }))
    await waitFor(() => expect(reload).toHaveBeenCalled())
    rerender(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ data: read(kids), error: true, reload })} onExitToTabs={vi.fn()} />)
    rerender(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ data: read(movedKids), reload })} onExitToTabs={vi.fn()} />)
    expect(screen.getByText('Pen-test scoping call moved to Doing. 1 of 3 done.')).toBeInTheDocument()
  })
})

describe('Children tab review fixes (#2209)', () => {
  const status = () => document.querySelector('[role="status"][aria-live="polite"]')!
  const tab = (st: ChildrenState, remoteSignal = 0) => (
    <CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={st} onExitToTabs={vi.fn()} remoteSignal={remoteSignal} />
  )

  it('says an under-limit column in no extra words and marks the at-limit meter with an end cap', () => {
    const under = read(kids)
    under.board!.columns = columns.map((c) => (c.id === 101 ? { ...c, card_count: 3 } : c))
    const { unmount } = renderTab(state({ data: under }))
    expect(screen.getByText('0 of 3 on Delivery · limit 5')).toBeInTheDocument()
    unmount()
    renderTab(state({ data: read(kids) }))
    expect((screen.getByTestId('children-wip-meter').firstElementChild as HTMLElement).style.borderRight).toContain('3px')
  })

  it('re-announces identical consecutive text and clears stale text', async () => {
    vi.mocked(unlinkCardChild).mockResolvedValue(undefined as never)
    const reload = vi.fn()
    const { rerender } = renderTab(state({ data: read(kids), reload }))
    const unlinkBtn = () => screen.getByRole('button', { name: 'Unlink child Contract' })
    await userEvent.click(unlinkBtn())
    await waitFor(() => expect(status()).toHaveTextContent('Unlinked Contract.'))
    const first = status().textContent
    await userEvent.click(unlinkBtn())
    await waitFor(() => expect(status().textContent).not.toBe(first))
    expect(status()).toHaveTextContent('Unlinked Contract.')
    rerender(tab(state({ data: read(kids), reload })))
    vi.useFakeTimers()
    try {
      await act(async () => { fireEvent.click(unlinkBtn()) })
      expect(status()).toHaveTextContent('Unlinked Contract.')
      act(() => { vi.advanceTimersByTime(8001) })
      expect(status()).toHaveTextContent('')
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps this tab's own write announcement when its own echo ping lands before the re-read", async () => {
    vi.mocked(unlinkCardChild).mockResolvedValue(undefined as never)
    const reload = vi.fn()
    const { rerender } = render(tab(state({ data: read(kids), reload }), 0))
    await userEvent.click(screen.getByRole('button', { name: 'Unlink child Pen-test scoping call' }))
    await waitFor(() => expect(reload).toHaveBeenCalled())
    // The actor's own socket echo bumps the remote counter before the single re-read lands.
    rerender(tab(state({ data: read(kids.slice(1)), reload }), 1))
    expect(status()).toHaveTextContent('Unlinked Pen-test scoping call.')
    expect(screen.queryByText(/Children updated/)).toBeNull()
  })

  it('swallows a ping that lands before the write resolves, then announces the write', async () => {
    let resolveUnlink: () => void = () => {}
    vi.mocked(unlinkCardChild).mockReturnValue(new Promise<never>((r) => { resolveUnlink = () => r(undefined as never) }))
    const reload = vi.fn()
    const { rerender } = render(tab(state({ data: read(kids), reload }), 0))
    await userEvent.click(screen.getByRole('button', { name: 'Unlink child Pen-test scoping call' }))
    // The ping and its re-read land while unlinkCardChild is still pending.
    rerender(tab(state({ data: read(kids.slice(1)), reload }), 1))
    expect(screen.queryByText(/Children updated/)).toBeNull()
    await act(async () => { resolveUnlink() })
    await waitFor(() => expect(status()).toHaveTextContent('Unlinked Pen-test scoping call.'))
    expect(screen.queryByText(/Children updated/)).toBeNull()
  })

  it('gives phone targets 44px: the card link, Move and Unlink', () => {
    const RO = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) { this.cb = cb }
      observe() { this.cb([{ contentRect: { width: 390 } } as ResizeObserverEntry], this as never) }
      disconnect() {}
      unobserve() {}
    } as never
    try {
      renderTab(state({ data: read(kids) }), vi.fn(), { ...parentBoard, current_user_role: 'admin' as never })
      expect(screen.getByRole('link', { name: /^Pen-test/ })).toHaveClass('min-h-11')
      for (const name of ['Move Pen-test scoping call', 'Unlink child Pen-test scoping call']) {
        expect(screen.getByRole('button', { name })).toHaveClass('min-h-11', 'min-w-11')
      }
    } finally {
      globalThis.ResizeObserver = RO
    }
  })

  it.each([[840, true], [800, true], [799, false], [500, false]])('lays the columns side by side from a measured 800px container (%ipx: %s)', (px, wide) => {
    const RO = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) { this.cb = cb }
      observe() { this.cb([{ contentRect: { width: px } } as ResizeObserverEntry], this as never) }
      disconnect() {}
      unobserve() {}
    } as never
    try {
      renderTab(state({ data: read(kids) }))
      expect(screen.getAllByRole('region')).toHaveLength(wide ? 3 : 1)
    } finally {
      globalThis.ResizeObserver = RO
    }
  })
})

describe('own-write echo before the write resolves (#2209 rule R-C)', () => {
  const tab = (s: ChildrenState) => <CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={s} onExitToTabs={vi.fn()} />

  it('Add child: an echo re-read while the default write is pending is not announced as someone else\'s', async () => {
    vi.mocked(getChildBoardOptions).mockResolvedValue({
      fixed_board: null, default: null, can_set_default: true,
      boards: [{ id: 7, name: 'Delivery', can_set_default: true }],
    })
    vi.mocked(addChild).mockResolvedValue({} as never)
    let release!: () => void
    vi.mocked(patchBoard).mockReturnValue(new Promise<never>((res) => { release = () => res({} as never) }))
    const user = userEvent.setup()
    const reload = vi.fn()
    const { rerender } = render(tab(state({ data: read(kids), reload })))
    await user.click(screen.getByRole('button', { name: 'Add child' }))
    await user.click(await screen.findByRole('combobox', { name: /Child board/ }))
    await user.click(await screen.findByRole('option', { name: 'Delivery' }))
    await user.click(screen.getByRole('checkbox'))
    await user.type(screen.getByLabelText('Title'), 'Task')
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    await waitFor(() => expect(patchBoard).toHaveBeenCalled())
    // The echo ping's re-read lands while patchBoard is still pending.
    rerender(tab(state({ data: read([...kids, row({ id: 13, title: 'Task' })]), reload })))
    expect(screen.queryByText(/Children updated/)).toBeNull()
    release()
    await waitFor(() => expect(screen.getByText('Added "Task" to Delivery.')).toBeInTheDocument())
    expect(screen.queryByText(/Children updated/)).toBeNull()
  })

  it('Link existing: an echo re-read while the link is pending is not announced; only Linked is', async () => {
    vi.mocked(getChildBoardOptions).mockResolvedValue({
      fixed_board: { hidden: false, id: 7, name: 'Delivery', can_add: true }, default: null, can_set_default: false, boards: [],
    })
    vi.mocked(getChildCandidates).mockResolvedValue([{
      id: 20, title: 'Loose task', column_id: 100, column_name: 'To do', swimlane_id: 50, swimlane_name: 'Lane',
      assignee: null, disabled_reason: null, parent_title: null,
    }])
    let release!: () => void
    vi.mocked(linkCardParent).mockReturnValue(new Promise<never>((res) => { release = () => res({ parent_id: 5, child_id: 20 } as never) }))
    const reload = vi.fn()
    const { rerender } = render(tab(state({ data: read(kids), reload })))
    await userEvent.click(screen.getByRole('button', { name: 'Link existing' }))
    const dialog = await screen.findByRole('dialog', { name: 'Link existing card' })
    await userEvent.type(within(dialog).getByRole('combobox'), 'task')
    await waitFor(() => expect(getChildCandidates).toHaveBeenCalled())
    await within(dialog).findByText('Loose task')
    await userEvent.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(linkCardParent).toHaveBeenCalled())
    rerender(tab(state({ data: read([...kids, row({ id: 20, title: 'Loose task' })]), reload })))
    expect(screen.queryByText(/Children updated/)).toBeNull()
    release()
    await waitFor(() => expect(screen.getByText('Linked Loose task.')).toBeInTheDocument())
    expect(screen.queryByText(/Children updated/)).toBeNull()
  })

  it('a refused Add child clears the pending mark so the next remote change is announced', async () => {
    vi.mocked(getChildBoardOptions).mockResolvedValue({
      fixed_board: null, default: null, can_set_default: false, boards: [{ id: 7, name: 'Delivery', can_set_default: false }],
    })
    vi.mocked(addChild).mockRejectedValue({ isAxiosError: true, response: { status: 403, data: {} } })
    const user = userEvent.setup()
    const reload = vi.fn()
    const { rerender } = render(tab(state({ data: read(kids), reload })))
    await user.click(screen.getByRole('button', { name: 'Add child' }))
    await user.click(await screen.findByRole('combobox', { name: /Child board/ }))
    await user.click(await screen.findByRole('option', { name: 'Delivery' }))
    await user.type(screen.getByLabelText('Title'), 'Task')
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    await waitFor(() => expect(addChild).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to Delivery' })).toBeEnabled())
    rerender(tab(state({ data: read(kids.slice(1)), reload })))
    expect(screen.getByText('Children updated. 1 of 2 done.')).toBeInTheDocument()
  })
})

describe('a WIP limit of 0 is a real limit for the Move picker (#2209, as on the server)', () => {
  const zero = () => {
    const d = read(kids)
    d.board!.columns = columns.map((c) => (c.id === 101 ? { ...c, wip_limit: 0, card_count: 0 } : c))
    return d
  }

  it('shows no limit text but disables the Move option for a member under an enforced limit', async () => {
    renderTab(state({ data: zero() }))
    expect(screen.queryByText(/· limit/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Move Pen-test scoping call' }))
    const group = screen.getByRole('radiogroup', { name: 'Column on Delivery' })
    expect(within(group).getByRole('radio', { name: /^Doing/ })).toBeDisabled()
    expect(within(group).getByText('At its limit of 0')).toBeInTheDocument()
  })

  it('still shows a positive limit', () => {
    renderTab(state({ data: read(kids) }))
    expect(screen.getByText(/limit 5, at limit/)).toBeInTheDocument()
  })
})

describe('Children tab remainder (#2209 slice 3)', () => {
  const doing = columns[1] // limit 5, card_count 5: at its limit
  it('moveTargetState mirrors the move endpoint for each WIP mode and role', () => {
    const b = (over: object) => ({ role: 'member', enforce_wip_limits: false, enforce_wip_hard: false, ...over })
    expect(moveTargetState(columns[0], b({ enforce_wip_hard: true }))).toEqual({ disabled: false, reason: '', force: false })
    // The server treats wip_limit 0 as a real limit (services/cards.py), so a hard 0 refuses every move in.
    expect(moveTargetState({ ...doing, wip_limit: 0, card_count: 0 }, b({ enforce_wip_hard: true }))).toEqual({ disabled: true, reason: 'At its limit of 0', force: false })
    expect(moveTargetState({ ...doing, wip_limit: 0, card_count: 0 }, b({ enforce_wip_limits: true, role: 'admin' })).force).toBe(true)
    expect(moveTargetState(doing, b({}))).toEqual({ disabled: false, reason: 'At its limit of 5 · not enforced', force: false })
    expect(moveTargetState(doing, b({ enforce_wip_limits: true }))).toEqual({ disabled: true, reason: 'At its limit of 5', force: false })
    expect(moveTargetState(doing, b({ enforce_wip_limits: true, role: 'admin' }))).toEqual({ disabled: false, reason: 'At its limit of 5 · admin override', force: true })
    expect(moveTargetState(doing, b({ enforce_wip_limits: true, enforce_wip_hard: true, role: 'site_admin' }))).toEqual({ disabled: true, reason: 'At its limit of 5', force: false })
  })

  function withMode(enforce_wip_limits: boolean, enforce_wip_hard: boolean, role = 'member'): CardChildrenRead {
    const d = read(kids, role)
    return { ...d, board: { ...d.board!, enforce_wip_limits, enforce_wip_hard } }
  }

  it('advisory limits keep an at-limit row enabled and say so; a hard limit disables it', async () => {
    const { unmount } = renderTab(state({ data: withMode(false, false) }))
    await userEvent.click(screen.getByRole('button', { name: 'Move Pen-test scoping call' }))
    const row = screen.getByRole('radio', { name: /^Doing 5 of 5/ })
    expect(row).not.toBeDisabled()
    expect(screen.getByText('At its limit of 5 · not enforced')).toBeInTheDocument()
    unmount()
    renderTab(state({ data: withMode(false, true, 'admin') }))
    await userEvent.click(screen.getByRole('button', { name: 'Move Pen-test scoping call' }))
    expect(screen.getByRole('radio', { name: /^Doing 5 of 5/ })).toBeDisabled()
  })

  it('a child-board admin moves past an enforced limit with force', async () => {
    vi.mocked(moveCard).mockResolvedValue({ card: {} as never })
    renderTab(state({ data: withMode(true, false, 'admin') }))
    await userEvent.click(screen.getByRole('button', { name: 'Move Pen-test scoping call' }))
    await userEvent.click(screen.getByRole('radio', { name: /^Doing 5 of 5/ }))
    expect(screen.getByText('At its limit of 5 · admin override')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(moveCard).toHaveBeenCalledWith(7, 10, { column_id: 101, swimlane_id: 50, position: 5 }, true)
  })

  it('shows "Work moved" from the rollup, and nothing without one', () => {
    const recent = new Date(Date.now() - 26 * 3600_000).toISOString()
    const { rerender } = render(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ data: read(kids) })} onExitToTabs={vi.fn()} lastMovedAt={recent} />)
    expect(screen.getByTestId('children-work-moved')).toHaveTextContent('Work moved 1d ago')
    rerender(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ data: read(kids) })} onExitToTabs={vi.fn()} lastMovedAt={null} />)
    expect(screen.queryByTestId('children-work-moved')).not.toBeInTheDocument()
  })

  it('"Work moved" ticks forward while the tab stays open', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-11-22T12:00:00Z'))
      const moved = new Date('2026-11-22T11:01:00Z').toISOString() // 59m before "now"
      const { unmount } = render(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ data: read(kids) })} onExitToTabs={vi.fn()} lastMovedAt={moved} />)
      expect(screen.getByTestId('children-work-moved')).toHaveTextContent('Work moved 59m ago')
      act(() => { vi.advanceTimersByTime(2 * 60_000) })
      expect(screen.getByTestId('children-work-moved')).toHaveTextContent('Work moved 1h ago')
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it("draws the child board's card face: labels, priority in words, due date", () => {
    const labels = [1, 2, 3].map((i) => ({ id: i, name: `L${i}`, color: '#EF4444' }))
    const face = [
      row({ id: 10, title: 'Faced', column_id: 100, priority: 'high', due_date: '2020-01-02', labels }),
      row({ id: 11, title: 'Plain', column_id: 100, position: 1 }),
    ]
    renderTab(state({ data: read(face) }))
    const faces = screen.getAllByTestId('child-card-face')
    expect(faces).toHaveLength(1)
    expect(faces[0]).toHaveTextContent('L1')
    expect(faces[0]).toHaveTextContent('L2')
    expect(faces[0]).not.toHaveTextContent('L3')
    expect(faces[0]).toHaveTextContent('+1')
    expect(faces[0]).toHaveTextContent('High')
    expect(within(faces[0]).getByText(/^Due /).closest('span.text-danger')).not.toBeNull()
    expect(faces[0]).toHaveTextContent('Overdue, Due')
  })

  it('links Movement history to the child board History with Parent = this card', () => {
    renderTab(state({ data: read(kids) }))
    expect(screen.getByRole('link', { name: 'Movement history of these children' })).toHaveAttribute('href', '/boards/7?view=history&parent=5')
  })

  it('focuses the child a Back link returns to', async () => {
    render(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ data: read(kids) })} onExitToTabs={vi.fn()} focusChildId={12} />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: /^Contract/ })))
  })

  it('Unlink acts at once and offers Undo, which links the child again; a failed Undo says so', async () => {
    const notify = vi.fn(() => 1)
    const dismiss = vi.fn()
    const reload = vi.fn()
    vi.mocked(unlinkCardChild).mockResolvedValue({} as never)
    render(
      <ToastContext.Provider value={{ notify, dismiss }}>
        <CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ data: read(kids), reload })} onExitToTabs={vi.fn()} />
      </ToastContext.Provider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Unlink child Pen-test scoping call' }))
    expect(unlinkCardChild).toHaveBeenCalledWith(1, 5, 10)
    const toast = (notify.mock.calls[0] as unknown as [{ key: string; title: string; announce: boolean; action: { label: string; onAction: () => Promise<void> } }])[0]
    expect(toast).toMatchObject({ key: 'unlink-child:10', title: 'Unlinked Pen-test scoping call', announce: false })
    expect(toast.action.label).toBe('Undo')
    vi.mocked(linkCardParent).mockResolvedValueOnce({ parent_id: 5, child_id: 10 })
    await act(async () => { await toast.action.onAction() })
    expect(linkCardParent).toHaveBeenCalledWith(7, 10, 5)
    expect(dismiss).toHaveBeenCalledWith('unlink-child:10')
    expect(reload).toHaveBeenCalledTimes(2)
    vi.mocked(linkCardParent).mockRejectedValueOnce(new Error('gone'))
    await act(async () => { await toast.action.onAction() })
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'unlink-child:10', variant: 'danger' }))
  })
})

// #2446: a leftover parent on a board whose Child cards switch is off keeps Add child and Link existing.
describe('CardChildrenTab per-card capability (#2446)', () => {
  const offBoard = { ...parentBoard, cards_can_have_children: false }
  const empty = { count: 0, visible: true, offset: 0, limit: 50, results: [] }
  it('offers Add child and Link existing on a flag-off board when the card can still have children', () => {
    render(<CardChildrenTab board={offBoard} cardId={5} cardTitle="P" canHaveChildren state={state({ data: empty })} onExitToTabs={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Add child' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Link existing' })).toBeInTheDocument()
  })
  it('offers neither on a flag-off board without the prop, or with it false on a parent board', () => {
    const { rerender } = render(<CardChildrenTab board={offBoard} cardId={5} cardTitle="P" state={state({ data: empty })} onExitToTabs={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Add child' })).not.toBeInTheDocument()
    rerender(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" canHaveChildren={false} state={state({ data: empty })} onExitToTabs={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Link existing' })).not.toBeInTheDocument()
  })
})

describe('Children tab assignee override (#1923)', () => {
  const me = 9
  const mine = row({ id: 10, title: 'Mine', column_id: 100, assignee: { id: me, username: 'me', display_name: 'Me' } as never, assigned_by: 1 })
  function overrideData(switchOn = true): CardChildrenRead {
    const d = read([mine], 'member')
    return { ...d, board: { ...d.board!, enforce_wip_limits: true, enforce_wip_hard: false, allow_assignee_override: switchOn } }
  }
  const open = async (data: CardChildrenRead, currentUserId: number | null = me) => {
    render(<CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={state({ data })} onExitToTabs={vi.fn()} currentUserId={currentUserId} />)
    await userEvent.click(screen.getByRole('button', { name: 'Move Mine' }))
  }

  it('collects a reason, keeps it after a failure, and sends the forced move', async () => {
    vi.mocked(moveCard).mockReset()
    vi.mocked(moveCard).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ card: {} as never })
    await open(overrideData())
    await userEvent.click(screen.getByRole('radio', { name: /^Doing 5 of 5/ }))
    expect(screen.getByText('At its limit of 5 · assignee override')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Move anyway (assignee override)' }))
    expect(moveCard).not.toHaveBeenCalled()
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'urgent')
    await userEvent.click(screen.getByRole('button', { name: 'Move anyway' }))
    expect(await screen.findByText("Couldn't move Mine. Try again.")).toBeInTheDocument()
    expect(screen.getByLabelText('Reason (required)')).toHaveValue('urgent')
    await userEvent.click(screen.getByRole('button', { name: 'Move anyway' }))
    expect(moveCard).toHaveBeenLastCalledWith(7, 10, { column_id: 101, swimlane_id: 50, position: 5, override_reason: 'urgent' }, true)
  })

  it('Escape closes the reason box only and returns focus to its trigger', async () => {
    await open(overrideData())
    await userEvent.click(screen.getByRole('radio', { name: /^Doing 5 of 5/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Move anyway (assignee override)' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByLabelText('Reason (required)')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move anyway (assignee override)' })).toHaveFocus())
  })

  it('offers nothing with the switch off or no known viewer', async () => {
    await open(overrideData(false))
    expect(screen.getByRole('radio', { name: /^Doing 5 of 5/ })).toBeDisabled()
    const doing = columns[1]
    const b = { role: 'member', enforce_wip_limits: true, allow_assignee_override: true }
    expect(moveTargetState(doing, b).disabled).toBe(true)
    expect(moveTargetState(doing, b, { userId: null, child: mine }).disabled).toBe(true)
    expect(moveTargetState(doing, b, { userId: me, child: { ...mine, assigned_by: undefined } }).disabled).toBe(true)
    expect(moveTargetState(doing, b, { userId: me, child: mine }).needsReason).toBe(true)
  })
})

describe('Unlink child focus (#2608)', () => {
  const tab = (st: ChildrenState) => (
    <CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={st} onExitToTabs={vi.fn()} />
  )
  const unlinkButton = () => screen.getByRole('button', { name: 'Unlink child Pen-test scoping call' })

  it('moves focus to the next child in the same update that removes the unlinked row', async () => {
    vi.mocked(unlinkCardChild).mockResolvedValue(undefined as never)
    const reload = vi.fn()
    const { rerender } = render(tab(state({ data: read(kids), reload })))
    await userEvent.click(unlinkButton())
    await waitFor(() => expect(reload).toHaveBeenCalled())
    rerender(tab(state({ data: read(kids.slice(1)), reload })))
    // No waitFor: a deferred focus move leaves focus on <body> here.
    expect(screen.getByRole('link', { name: /^Kickoff/ })).toHaveFocus()
  })

  it('moves focus when the row goes before the unlink request answers', async () => {
    vi.mocked(unlinkCardChild).mockReturnValue(new Promise(() => {}) as never)
    const { rerender } = render(tab(state({ data: read(kids) })))
    await userEvent.click(unlinkButton())
    rerender(tab(state({ data: read(kids.slice(1)) })))
    expect(screen.getByRole('link', { name: /^Kickoff/ })).toHaveFocus()
  })

  it('moves focus to Add child in the same update when the last child goes', async () => {
    vi.mocked(unlinkCardChild).mockReturnValue(new Promise(() => {}) as never)
    const { rerender } = render(tab(state({ data: read(kids.slice(0, 1)) })))
    await userEvent.click(unlinkButton())
    rerender(tab(state({ data: read([]) })))
    expect(screen.getByRole('button', { name: 'Add child' })).toHaveFocus()
  })

  it('leaves focus alone on a later re-read when the unlink failed', async () => {
    vi.mocked(unlinkCardChild).mockRejectedValue(new Error('no'))
    const { rerender } = render(tab(state({ data: read(kids) })))
    await userEvent.click(unlinkButton())
    await screen.findByText("Couldn't unlink Pen-test scoping call. Try again.")
    rerender(tab(state({ data: read(kids.slice(1)) })))
    expect(screen.getByRole('link', { name: /^Kickoff/ })).not.toHaveFocus()
  })
})

describe('Move and Undo child focus (#2611)', () => {
  const tab = (st: ChildrenState) => (
    <CardChildrenTab board={parentBoard} cardId={5} cardTitle="P" state={st} onExitToTabs={vi.fn()} />
  )
  const moved = () => read([{ ...kids[0], column_id: 102, column_name: 'Done' }, ...kids.slice(1)])
  const link = () => screen.getByRole('link', { name: /^Pen-test scoping call/ })
  const moveToDone = async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Move Pen-test scoping call' }))
    await userEvent.click(screen.getByRole('radio', { name: /^Done/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
  }

  it('focuses the card in the update that closes the picker and again in the one that moves its row', async () => {
    vi.mocked(moveCard).mockResolvedValue({ card: {} as never })
    const reload = vi.fn()
    const { rerender } = render(tab(state({ data: read(kids), reload })))
    await moveToDone()
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(link()).toHaveFocus()
    })
    rerender(tab(state({ data: moved(), reload })))
    // No waitFor: a deferred focus move leaves focus on <body> here.
    expect(link()).toHaveFocus()
  })

  it('leaves focus where the user went before the re-read landed', async () => {
    vi.mocked(moveCard).mockResolvedValue({ card: {} as never })
    const { rerender } = render(tab(state({ data: read(kids) })))
    await moveToDone()
    await waitFor(() => expect(link()).toHaveFocus())
    screen.getByRole('button', { name: 'Add child' }).focus()
    rerender(tab(state({ data: moved() })))
    expect(screen.getByRole('button', { name: 'Add child' })).toHaveFocus()
  })

  it('shows the column the child moved to when only one column is on screen', async () => {
    const original = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      private cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) { this.cb = cb }
      observe() { this.cb([{ contentRect: { width: 320 } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    try {
      vi.mocked(moveCard).mockResolvedValue({ card: {} as never })
      const { rerender } = render(tab(state({ data: read(kids) })))
      await moveToDone()
      await waitFor(() => expect(link()).toHaveFocus())
      rerender(tab(state({ data: moved() })))
      expect(link()).toHaveFocus()
    } finally {
      globalThis.ResizeObserver = original
    }
  })

  async function undoFromToast(remaining: CardChildRow[]) {
    vi.mocked(unlinkCardChild).mockResolvedValue(undefined as never)
    const view = render(<ToastProvider>{tab(state({ data: read(kids.slice(0, 1)) }))}</ToastProvider>)
    await userEvent.click(screen.getByRole('button', { name: 'Unlink child Pen-test scoping call' }))
    view.rerender(<ToastProvider>{tab(state({ data: read(remaining) }))}</ToastProvider>)
    const undo = await screen.findByRole('button', { name: 'Undo' })
    // Reach the toast with nothing to go back to, as a mouse user does.
    ;(document.activeElement as HTMLElement | null)?.blur()
    undo.focus()
    return view
  }

  it('Undo parks focus on the tab as the toast goes, then focuses the row that returns', async () => {
    vi.mocked(linkCardParent).mockResolvedValue({ parent_id: 5, child_id: 10 })
    const view = await undoFromToast([])
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument())
    expect(screen.getByTestId('card-children-tab')).toHaveFocus()
    view.rerender(<ToastProvider>{tab(state({ data: read(kids.slice(0, 1)) }))}</ToastProvider>)
    expect(link()).toHaveFocus()
  })

  it('a failed Undo takes its button away too, and parks focus on the tab', async () => {
    vi.mocked(linkCardParent).mockRejectedValue(new Error('gone'))
    await undoFromToast([])
    await userEvent.keyboard('{Enter}')
    await screen.findAllByText(/Couldn't link Pen-test scoping call again/)
    expect(screen.getByTestId('card-children-tab')).toHaveFocus()
  })
})

describe('Children tab Try again focus (#2575)', () => {
  it.each([
    ['the first read failed', state({ error: true })],
    ['a refresh failed', state({ error: true, data: read(kids) })],
  ])('hands focus to the tab before the re-read when %s', async (_name, st) => {
    renderTab(st)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByTestId('card-children-tab')).toHaveFocus()
  })
})
