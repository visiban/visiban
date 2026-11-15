import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CardPeekSheet from '../components/Card/CardPeekSheet'
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

describe('CardPeekSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCardMovements.mockResolvedValue(movements)
  })

  it('shows lane, title, banner, status strip, every field with Not set, and the pinned note', async () => {
    setup()
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
    expect(await screen.findByText('No movement recorded yet.')).toBeInTheDocument()
    expect(screen.getByText('No history yet.')).toBeInTheDocument()
    unmount()
  })

  it('reports a history load failure', async () => {
    getCardMovements.mockRejectedValueOnce(new Error('x'))
    setup()
    expect(await screen.findByText('History could not be loaded.')).toBeInTheDocument()
  })

  it('focuses Close on open; Escape and Close call onClose', async () => {
    const p = setup()
    expect(screen.getByRole('button', { name: 'Close card peek' })).toHaveFocus()
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

  it('hides Move for a viewer', () => {
    setup({ canEdit: false })
    expect(screen.queryByRole('button', { name: 'Move' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open card' })).toBeInTheDocument()
  })
})
