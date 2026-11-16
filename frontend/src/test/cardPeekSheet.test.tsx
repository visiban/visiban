import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError } from 'axios'
import CardPeekSheet, { dwellKey } from '../components/Card/CardPeekSheet'
import type { BoardFull, Card, CardMovement } from '../types'

const getCardMovements = vi.fn()
vi.mock('../api/cards', () => ({ getCardMovements: (...a: unknown[]) => getCardMovements(...a) }))

const DAY = 86_400_000
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString()

const board = {
  id: 1,
  columns: [
    { id: 1, name: 'Prospect', position: 0 }, { id: 2, name: 'Qualified', position: 1 }, { id: 3, name: 'Discovery', position: 2 },
  ],
  swimlanes: [{ id: 5, name: 'North America' }, { id: 6, name: 'APAC' }],
  custom_field_definitions: [
    { id: 1, name: 'Deal value', field_type: 'text', choices: [], position: 0, show_on_card: true },
    { id: 2, name: 'Notes', field_type: 'text', choices: [], position: 1, show_on_card: false },
  ],
} as unknown as BoardFull

const card = {
  id: 9, column: 2, swimlane: 5, title: 'Sakura Electronics', description: '<p>100-Seat Board</p>', due_date: null, assignee: null,
  is_stale: true, last_moved_at: iso(39), version: 3, created_at: iso(53),
  custom_field_values: [{ field_definition: 1, value: '$52,000' }],
} as unknown as Card

const movements = [
  { id: 1, from_column: null, from_column_name: '', to_column: 1, to_column_name: 'Prospect', moved_at: iso(53), movement_type: 'move', from_swimlane: null, to_swimlane: 5 },
  { id: 2, from_column: 1, from_column_name: 'Prospect', to_column: 2, to_column_name: 'Qualified', moved_at: iso(39), movement_type: 'move', from_swimlane: 5, to_swimlane: 5 },
] as unknown as CardMovement[]

function setup(over: Partial<Parameters<typeof CardPeekSheet>[0]> = {}) {
  const props = { card, board, canEdit: true, onClose: vi.fn(), onOpenCard: vi.fn(), onMoveCard: vi.fn().mockResolvedValue({ ok: true }), ...over }
  render(<CardPeekSheet {...props} />)
  return props
}

describe('dwellKey', () => {
  it('cannot collide when a deleted column\'s name equals a live column\'s id', () => {
    expect(dwellKey({ columnId: 5, name: 'Live' })).not.toBe(dwellKey({ columnId: null, name: '5' }))
  })
})

describe('CardPeekSheet', () => {
  it('goes full-screen at exactly 640px and floats from 641px', () => {
    setup()
    const cls = screen.getByTestId('card-peek-sheet').className
    expect(cls).toContain('max-[640px]:inset-0')
    expect(cls).toContain('min-[641px]:w-[400px]')
    expect(cls).not.toMatch(/(^|\s)sm:/)
  })

  it('is content-height with a max height from 641px, not pinned to the viewport bottom', () => {
    setup()
    const cls = screen.getByTestId('card-peek-sheet').className
    expect(cls).toContain('min-[641px]:bottom-auto')
    expect(cls).toContain('min-[641px]:max-h-[calc(100vh-6.75rem)]')
    expect(cls).not.toContain('min-[641px]:bottom-3')
  })

  it('renders stage chips as rounded rectangles, not pills', () => {
    setup()
    const chip = screen.getByTestId('card-peek-sheet').querySelector('[aria-current="step"]') as HTMLElement
    expect(chip.className).toContain('rounded-md')
    expect(chip.className).not.toContain('rounded-full')
  })

  it('shows history times relative with the absolute timestamp as the title', async () => {
    setup()
    const history = await screen.findByTestId('card-peek-history')
    const rows = within(history).getAllByRole('listitem')
    const time = rows[0].querySelector('span[title]') as HTMLElement
    expect(time.textContent).toBe('39 d ago')
    expect(time.getAttribute('title')).toMatch(/\d/)
    expect(within(history).getByText('53 d ago')).toBeInTheDocument()
  })

  it('hides the pinned note when the board has no custom fields', () => {
    setup({ board: { ...board, custom_field_definitions: [] } as unknown as BoardFull })
    expect(screen.queryByText(/pinned to the card/)).not.toBeInTheDocument()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    getCardMovements.mockResolvedValue(movements)
  })

  it('shows lane, title, banner, status strip, every field with Not set, and the pinned note', async () => {
    setup()
    expect(screen.getAllByText('Loading history...')).toHaveLength(2)
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('heading', { name: 'Sakura Electronics' })).toBeInTheDocument()
    expect(screen.getByText('North America')).toBeInTheDocument()
    expect(screen.getByTestId('card-peek-banner')).toHaveTextContent('No movement for 39 days')
    const strip = screen.getByTestId('card-peek-strip')
    expect(within(strip).getByText('Qualified').closest('[aria-current]')).toHaveAttribute('aria-current', 'step')
    expect(within(strip).getByText('Prospect')).toBeInTheDocument()
    expect(within(strip).getByText('Discovery')).toBeInTheDocument()
    expect(screen.getByText('1 of 2 pinned to the card')).toBeInTheDocument()
    expect(screen.getByText('Deal value')).toBeInTheDocument()
    // Notes, Assignee, Due date are empty.
    expect(screen.getAllByText('Not set')).toHaveLength(3)
    await screen.findByTestId('card-peek-history')
  })

  it('renders time in each column and history newest first', async () => {
    setup()
    const history = await screen.findByTestId('card-peek-history')
    const rows = within(history).getAllByRole('listitem').map((r) => r.textContent)
    expect(rows[0]).toContain('Prospect to Qualified')
    expect(rows[1]).toContain('Created in Prospect')
    const segs = screen.getAllByTestId('card-peek-segment')
    expect(segs).toHaveLength(2)
    expect(segs[1]).toHaveAttribute('data-current', 'true')
    expect(screen.getByText('14 d')).toBeInTheDocument()
    expect(screen.getByText('39 d')).toBeInTheDocument()
  })

  it('shows a banner for an overdue card in preference to stale', () => {
    setup({ card: { ...card, due_date: '2020-01-01' } })
    expect(screen.getByTestId('card-peek-banner')).toHaveTextContent('Was due')
  })

  it('handles empty and failed history', async () => {
    getCardMovements.mockResolvedValueOnce([])
    const { unmount } = (() => { setup(); return { unmount: () => {} } })()
    expect(await screen.findByText('Qualified')).toBeInTheDocument()
    expect(screen.getAllByTestId('card-peek-segment')).toHaveLength(1)
    expect(screen.getByText('No history yet.')).toBeInTheDocument()
    unmount()
  })

  it('reports a history load failure', async () => {
    getCardMovements.mockRejectedValueOnce(new Error('x'))
    setup()
    expect(await screen.findByRole('alert')).toHaveTextContent('History could not be loaded.')
    expect(screen.getAllByText('History could not be loaded.')).toHaveLength(2)
  })

  it('reads Never moved for a card that has never moved', async () => {
    setup({ card: { ...card, last_moved_at: null } as typeof card })
    expect(screen.getByText('Never moved')).toBeInTheDocument()
    await screen.findByTestId('card-peek-history')
  })

  it('focuses Open card on open; Escape and Close call onClose', async () => {
    const p = setup()
    expect(screen.getByRole('button', { name: 'Open card' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(p.onClose).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Close card peek' }))
    expect(p.onClose).toHaveBeenCalledTimes(2)
  })

  it('closes on a click in board space but not on a card or inside the sheet', async () => {
    const p = setup()
    const space = document.body.appendChild(document.createElement('div'))
    space.setAttribute('data-board-scroll', '')
    const inner = space.appendChild(document.createElement('div'))
    const faceHost = space.appendChild(document.createElement('div'))
    faceHost.setAttribute('data-card-id', '4')
    await userEvent.click(faceHost)
    await userEvent.click(screen.getByRole('heading', { name: 'Sakura Electronics' }))
    expect(p.onClose).not.toHaveBeenCalled()
    await userEvent.click(inner)
    expect(p.onClose).toHaveBeenCalledTimes(1)
    space.remove()
  })

  it('Open card hands the card off', async () => {
    const p = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Open card' }))
    expect(p.onOpenCard).toHaveBeenCalledWith(card)
  })

  it('Move reuses the move action, appends to the cell, and closes on success', async () => {
    const p = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    await userEvent.selectOptions(screen.getByLabelText('Column'), '3')
    await userEvent.click(screen.getByRole('button', { name: 'Move card' }))
    expect(p.onMoveCard).toHaveBeenCalledWith(9, 3, 5, 9999)
    await waitFor(() => expect(screen.queryByTestId('card-peek-move-form')).not.toBeInTheDocument())
  })

  it('Move is a no-op for the same location, and Escape closes only the form first', async () => {
    const p = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    await userEvent.click(screen.getByRole('button', { name: 'Move card' }))
    expect(p.onMoveCard).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('card-peek-move-form')).not.toBeInTheDocument()
    expect(p.onClose).not.toHaveBeenCalled()
  })

  it('shows a refused or thrown move inline', async () => {
    const p = setup({ onMoveCard: vi.fn().mockResolvedValueOnce({ ok: false, error: new Error('limit') }).mockRejectedValueOnce(new Error('boom')) })
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    await userEvent.selectOptions(screen.getByLabelText('Swimlane'), '6')
    await userEvent.click(screen.getByRole('button', { name: 'Move card' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Card could not be moved')
    await userEvent.selectOptions(screen.getByLabelText('Column'), '1')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Move card' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Card could not be moved')
    expect(p.onMoveCard).toHaveBeenCalledTimes(2)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('Move earlier / Move later reorder within the cell through onMoveCard, disabled at the ends (#2277)', async () => {
    // Raw slots (cellOrderOf): the previous card's position, the next card's + 1.
    // Not index +/- 1: index + 1 (here 2) is the server's no-op on a same-cell move.
    const p = setup({ cellOrder: { index: 1, count: 3, earlier: 4, later: 8 } })
    await userEvent.click(screen.getByRole('button', { name: 'Move earlier' }))
    expect(p.onMoveCard).toHaveBeenLastCalledWith(9, 2, 5, 4)
    await userEvent.click(screen.getByRole('button', { name: 'Move later' }))
    expect(p.onMoveCard).toHaveBeenLastCalledWith(9, 2, 5, 8)
  })

  it('disables Move earlier on the first card and Move later on the last', () => {
    setup({ cellOrder: { index: 0, count: 2, earlier: null, later: 2 } })
    expect(screen.getByRole('button', { name: 'Move earlier' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move later' })).toBeEnabled()
  })

  it('offline: a Move form already open closes, returns focus to Move, and sends nothing (#2325)', async () => {
    const props = { card, board, canEdit: true, onClose: vi.fn(), onOpenCard: vi.fn(), onMoveCard: vi.fn().mockResolvedValue({ ok: true }) }
    const { rerender } = render(<CardPeekSheet {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByTestId('card-peek-move-form')).toBeInTheDocument()
    rerender(<CardPeekSheet {...props} movesPaused />)
    expect(screen.queryByTestId('card-peek-move-form')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move' })).toHaveFocus())
    expect(props.onMoveCard).not.toHaveBeenCalled()
  })

  it('offline: Move and both steps are disabled, with the reason in text (#2325)', async () => {
    const p = setup({ movesPaused: true, cellOrder: { index: 1, count: 3, earlier: 4, later: 8 } })
    const move = screen.getByRole('button', { name: 'Move' })
    expect(move).toHaveAttribute('aria-disabled', 'true')
    expect(move).toHaveAccessibleDescription('Moves are paused while the board is offline.')
    await userEvent.click(move)
    expect(screen.queryByLabelText('Column')).not.toBeInTheDocument()
    for (const name of ['Move earlier', 'Move later']) {
      const step = screen.getByRole('button', { name })
      expect(step).toHaveAttribute('aria-disabled', 'true')
      expect(step).not.toBeDisabled()
      expect(step).toHaveAccessibleDescription('Moves are paused while the board is offline.')
      await userEvent.click(step)
    }
    expect(p.onMoveCard).not.toHaveBeenCalled()
  })

  it('offers no reorder alone in the cell', () => {
    setup({ cellOrder: { index: 0, count: 1, earlier: null, later: null } })
    expect(screen.queryByTestId('card-peek-reorder')).not.toBeInTheDocument()
  })

  it('hides reorder from a viewer and on the grid (no cellOrder)', () => {
    const { unmount } = render(<span />)
    unmount()
    setup({ canEdit: false, cellOrder: { index: 0, count: 2, earlier: null, later: 2 } })
    expect(screen.queryByTestId('card-peek-reorder')).not.toBeInTheDocument()
  })

  it('shows a refused or thrown reorder inline', async () => {
    setup({ cellOrder: { index: 1, count: 2, earlier: 0, later: null }, onMoveCard: vi.fn().mockResolvedValueOnce({ ok: false, error: new Error('limit') }).mockRejectedValueOnce(new Error('boom')) })
    await userEvent.click(screen.getByRole('button', { name: 'Move earlier' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Card could not be moved')
    await userEvent.click(screen.getByRole('button', { name: 'Move earlier' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Card could not be moved')
  })

  it('hides Move for a viewer', () => {
    setup({ canEdit: false })
    expect(screen.queryByRole('button', { name: 'Move' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open card' })).toBeInTheDocument()
  })

  it('shows description text with entities decoded and never injects markup', () => {
    setup({ card: { ...card, description: '<p>Terms &amp; Conditions <b>apply</b></p><img src=x onerror="window.__peekXss=1">' } })
    expect(screen.getByText('Terms & Conditions apply')).toBeInTheDocument()
    expect((window as unknown as { __peekXss?: number }).__peekXss).toBeUndefined()
  })

  describe('click-catcher (same rules as the card detail sheet)', () => {
    function boardSpace() {
      const space = document.body.appendChild(document.createElement('div'))
      space.setAttribute('data-board-scroll', '')
      const cell = space.appendChild(document.createElement('div'))
      const add = cell.appendChild(document.createElement('button'))
      const onAdd = vi.fn()
      add.addEventListener('click', onAdd)
      return { space, cell, add, onAdd }
    }

    it('consumes the dismissing click on board space so "+ Add card" does not also fire', async () => {
      const p = setup()
      const { space, add, onAdd } = boardSpace()
      await userEvent.click(add)
      expect(p.onClose).toHaveBeenCalledTimes(1)
      expect(onAdd).not.toHaveBeenCalled()
      space.remove()
    })

    it('does not let the press move focus off the sheet (so focus can return to the card)', () => {
      setup()
      const { space, cell } = boardSpace()
      cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      const notCanceled = cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
      expect(notCanceled).toBe(false)
      space.remove()
    })

    it('keeps focus off the board: a press on this card\'s own face is default-prevented, another card\'s is not', () => {
      setup()
      const { space, cell } = boardSpace()
      const own = cell.appendChild(document.createElement('div'))
      own.setAttribute('data-card-id', String(card.id))
      const other = cell.appendChild(document.createElement('div'))
      other.setAttribute('data-card-id', '4')
      own.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      expect(own.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))).toBe(false)
      other.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      expect(other.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))).toBe(true)
      space.remove()
    })

    it('does not close when the press started in the sheet and ended on the board (text selection)', () => {
      const p = setup()
      const { space, cell } = boardSpace()
      screen.getByRole('heading', { name: 'Sakura Electronics' }).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      cell.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
      expect(p.onClose).not.toHaveBeenCalled()
      space.remove()
    })

    it('does not close for a non-primary button', () => {
      const p = setup()
      const { space, cell } = boardSpace()
      cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }))
      cell.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
      expect(p.onClose).not.toHaveBeenCalled()
      space.remove()
    })
  })

  describe('soft WIP limit override', () => {
    const axiosRefusal = (data: object) =>
      new AxiosError('conflict', 'ERR_BAD_REQUEST', undefined, undefined, { status: 409, data } as never)
    const softRefusal = () => axiosRefusal({ code: 'wip_limit_exceeded', column_name: 'Prospect', wip_limit: 2, current_count: 2 })
    const adminBoard = { ...board, current_user_role: 'admin' } as unknown as BoardFull

    async function refuse(over: Partial<Parameters<typeof CardPeekSheet>[0]>) {
      const p = setup({
        board: adminBoard,
        onMoveCard: vi.fn().mockResolvedValue({ ok: false, error: softRefusal() }),
        ...over,
      })
      await userEvent.click(screen.getByRole('button', { name: 'Move' }))
      await userEvent.selectOptions(screen.getByLabelText('Column'), '1')
      await userEvent.click(screen.getByRole('button', { name: 'Move card' }))
      await screen.findByRole('alert')
      return p
    }

    it('offers Move anyway to an admin, forcing the form target, and closes on success', async () => {
      const onForceMoveCard = vi.fn().mockResolvedValue({ ok: true })
      await refuse({ onForceMoveCard })
      expect(screen.getByRole('alert')).toHaveTextContent('"Prospect" has reached its limit')
      await userEvent.click(screen.getByRole('button', { name: /Move anyway/ }))
      expect(onForceMoveCard).toHaveBeenCalledWith(9, 1, 5, 9999)
      await waitFor(() => expect(screen.queryByTestId('card-peek-move-form')).not.toBeInTheDocument())
    })

    it('keeps the form and error when the override itself fails', async () => {
      const onForceMoveCard = vi.fn().mockResolvedValue({ ok: false, error: new Error('nope') })
      await refuse({ onForceMoveCard })
      await userEvent.click(screen.getByRole('button', { name: /Move anyway/ }))
      expect(await screen.findByTestId('card-peek-move-form')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Move anyway/ })).not.toBeInTheDocument()
    })

    it('offers nothing to a non-admin, for a hard limit, or without the prop', async () => {
      await refuse({ board: { ...board, current_user_role: 'member' } as unknown as BoardFull, onForceMoveCard: vi.fn() })
      expect(screen.queryByRole('button', { name: /Move anyway/ })).not.toBeInTheDocument()
    })

    it('never offers it for a hard limit', async () => {
      const hard = axiosRefusal({ code: 'wip_hard_blocked', column_name: 'Prospect', wip_limit: 2, current_count: 2 })
      await refuse({ onForceMoveCard: vi.fn(), onMoveCard: vi.fn().mockResolvedValue({ ok: false, error: hard }) })
      expect(screen.queryByRole('button', { name: /Move anyway/ })).not.toBeInTheDocument()
    })

    it('offers nothing without onForceMoveCard', async () => {
      await refuse({})
      expect(screen.queryByRole('button', { name: /Move anyway/ })).not.toBeInTheDocument()
    })
  })
})
