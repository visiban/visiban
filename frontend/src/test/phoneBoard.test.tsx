import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createCard } from '../api/cards'
import PhoneBoard from '../components/Board/PhoneBoard'
import type { Card, Column, Swimlane } from '../types'

vi.mock('../api/cards', () => ({ createCard: vi.fn() }))
vi.mock('../components/Board/EditSwimlaneModal', () => ({
  default: (p: { swimlane: { name: string }; onUpdated: (s: unknown) => void; onDeleted: (id: number) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="Edit Swimlane"><span>{p.swimlane.name}</span>
      <button onClick={() => p.onUpdated({ id: 9 })}>save-lane</button><button onClick={() => p.onDeleted(1)}>delete-lane</button><button onClick={p.onClose}>close-lane</button></div>
  ),
}))
vi.mock('../components/Board/EditColumnModal', () => ({
  default: (p: { column: { name: string }; onUpdated: (c: unknown) => void; onRequestDelete: (c: unknown) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="Edit Column"><span>{p.column.name}</span>
      <button onClick={() => p.onUpdated({ id: 8 })}>save-col</button><button onClick={() => p.onRequestDelete(p.column)}>delete-col</button><button onClick={p.onClose}>close-col</button></div>
  ),
}))

const col = (id: number, name: string, extra: Partial<Column> = {}) =>
  ({ id, name, position: id, color: '#6B7280', wip_limit: null, weight_limit: null, is_done: false, allow_card_creation: true, policy: null, ...extra }) as unknown as Column
const lane = (id: number, name: string) => ({ id, name, color: '#3B82F6', position: id }) as unknown as Swimlane
const card = (id: number, column: number, swimlane: number, extra: Partial<Card> = {}) =>
  ({ id, title: `Card ${id}`, column, swimlane, position: id, labels: [], custom_field_values: [], weight: 1, priority: 'medium', due_date: null, is_stale: false, last_moved_at: null, column_entered_at: null, created_at: new Date().toISOString(), ...extra }) as unknown as Card

function setup(props: Partial<React.ComponentProps<typeof PhoneBoard>> = {}) {
  const onToggleSwimlane = vi.fn()
  render(
    <PhoneBoard
      columns={[col(1, 'Prospect', { wip_limit: 1 }), col(2, 'Qualified')]}
      swimlanes={[lane(1, 'North'), lane(2, 'APAC')]}
      cards={[card(1, 1, 1), card(2, 1, 2), card(3, 1, 2), card(4, 2, 1)]}
      boardId={1}
      canEdit
      filteredCardIds={null}
      collapsedSwimlaneIds={new Set()}
      onToggleSwimlane={onToggleSwimlane}
      selectedCardIds={new Set()}
      onToggleCardSelection={() => {}}
      onCardClick={() => {}}
      {...props}
    />,
  )
  return { onToggleSwimlane }
}

describe('PhoneBoard (#2277)', () => {
  it('shows one column at a time with counts, and switches', async () => {
    const user = userEvent.setup()
    setup()
    expect(screen.getByRole('tab', { name: /Prospect/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Card 1')).toBeInTheDocument()
    expect(screen.queryByText('Card 4')).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Qualified/ }))
    expect(screen.getByText('Card 4')).toBeInTheDocument()
    expect(screen.queryByText('Card 1')).not.toBeInTheDocument()
  })

  it('shows the selected column limit line and an over-limit warning', () => {
    setup()
    const limit = screen.getByTestId('phone-column-limit')
    expect(within(limit).getByText(/3 of 1 limit \(over\)/)).toBeInTheDocument()
    expect(within(limit).getByRole('meter')).toHaveAttribute('aria-valuenow', '1')
  })

  it('omits the limit line when the column has none', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('tab', { name: /Qualified/ }))
    expect(screen.queryByTestId('phone-column-limit')).not.toBeInTheDocument()
  })

  it('stacks lanes with "N here" and toggles collapse', async () => {
    const user = userEvent.setup()
    const { onToggleSwimlane } = setup()
    expect(screen.getAllByTestId('phone-lane')).toHaveLength(2)
    expect(screen.getByText('2 here')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Collapse lane APAC/ }))
    expect(onToggleSwimlane).toHaveBeenCalledWith(2)
  })

  it('hides cards of a collapsed lane and respects the filter', () => {
    setup({ collapsedSwimlaneIds: new Set([2]), filteredCardIds: new Set([1, 2]) })
    expect(screen.getByText('Card 1')).toBeInTheDocument()
    expect(screen.queryByText('Card 2')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Expand lane APAC/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('counts overdue cards in the lane band', () => {
    setup({ cards: [card(1, 1, 1, { due_date: '2000-01-01' })] })
    expect(screen.getByText('1 overdue')).toBeInTheDocument()
  })

  it('says so without columns', () => {
    setup({ columns: [] })
    expect(screen.getByText('No visible columns')).toBeInTheDocument()
  })

  it('moves between column tabs with the arrow keys (roving tabindex)', async () => {
    const user = userEvent.setup()
    setup()
    const first = screen.getByRole('tab', { name: /Prospect/ })
    expect(first).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('tab', { name: /Qualified/ })).toHaveAttribute('tabindex', '-1')
    first.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: /Qualified/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: /Prospect/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: /Qualified/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('says so without swimlanes', () => {
    setup({ swimlanes: [] })
    expect(screen.getByText('No swimlanes')).toBeInTheDocument()
  })
})

describe('PhoneBoard editing controls (#2277)', () => {
  const edit = () => ({
    isAdmin: true,
    onCardAdded: vi.fn(),
    onColumnUpdated: vi.fn(),
    onRequestDeleteColumn: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onSwimlaneDeleted: vi.fn(),
    onAddColumn: vi.fn(),
    onAddSwimlane: vi.fn(),
    onFocusLane: vi.fn(),
    onExitFocus: vi.fn(),
  })

  it('adds a card to the chosen lane and reports it', async () => {
    const user = userEvent.setup()
    const cb = edit()
    vi.mocked(createCard).mockResolvedValue(card(50, 1, 2))
    setup(cb)
    await user.click(screen.getAllByRole('button', { name: /Add card/ })[1])
    await user.type(screen.getByLabelText(/New card title/), 'Hello{Enter}')
    expect(createCard).toHaveBeenCalledWith(1, { column: 1, swimlane: 2, title: 'Hello' })
    expect(cb.onCardAdded).toHaveBeenCalled()
    expect(screen.queryByTestId('phone-add-card')).not.toBeInTheDocument()
  })

  it('shows the failure text and keeps the input open; Cancel and Escape close it', async () => {
    const user = userEvent.setup()
    vi.mocked(createCard).mockRejectedValue(new Error('x'))
    setup(edit())
    await user.click(screen.getAllByRole('button', { name: /Add card/ })[0])
    await user.type(screen.getByLabelText(/New card title/), 'A')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Failed to add card.')).toBeInTheDocument()
    await user.click(screen.getByLabelText(/New card title/))
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('phone-add-card')).not.toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: /Add card/ })[0])
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('phone-add-card')).not.toBeInTheDocument()
  })

  it('ignores an empty title', async () => {
    const user = userEvent.setup()
    vi.mocked(createCard).mockClear()
    setup(edit())
    await user.click(screen.getAllByRole('button', { name: /Add card/ })[0])
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(createCard).not.toHaveBeenCalled()
  })

  it('opens an outside add request: selects the column, expands the lane, opens the input', () => {
    const onToggleSwimlane = vi.fn()
    setup({ ...edit(), onToggleSwimlane, collapsedSwimlaneIds: new Set([2]), addRequest: { columnId: 2, swimlaneId: 2, nonce: 1 } })
    expect(screen.getByRole('tab', { name: /Qualified/ })).toHaveAttribute('aria-selected', 'true')
    expect(onToggleSwimlane).toHaveBeenCalledWith(2)
  })

  it('opens the input for an outside add request on an expanded lane', () => {
    setup({ ...edit(), addRequest: { columnId: 2, swimlaneId: 2, nonce: 1 } })
    expect(screen.getByLabelText(/New card title in Qualified, APAC/)).toBeInTheDocument()
  })

  it('edits and deletes a swimlane through the existing modal', async () => {
    const user = userEvent.setup()
    const cb = edit()
    setup(cb)
    await user.click(screen.getByRole('button', { name: 'Edit swimlane North' }))
    await user.click(screen.getByText('save-lane'))
    expect(cb.onSwimlaneUpdated).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Edit swimlane North' }))
    await user.click(screen.getByText('delete-lane'))
    expect(cb.onSwimlaneDeleted).toHaveBeenCalledWith(1)
    await user.click(screen.getByRole('button', { name: 'Edit swimlane North' }))
    await user.click(screen.getByText('close-lane'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('edits and deletes the selected column', async () => {
    const user = userEvent.setup()
    const cb = edit()
    setup(cb)
    await user.click(screen.getByTestId('phone-column-actions'))
    await user.click(screen.getByText('save-col'))
    expect(cb.onColumnUpdated).toHaveBeenCalled()
    await user.click(screen.getByTestId('phone-column-actions'))
    await user.click(screen.getByText('delete-col'))
    expect(cb.onRequestDeleteColumn).toHaveBeenCalled()
    await user.click(screen.getByText('close-col'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('adds a column or swimlane, and focuses or exits a lane', async () => {
    const user = userEvent.setup()
    const cb = edit()
    const { rerender } = { rerender: null }
    void rerender
    setup(cb)
    await user.click(screen.getByRole('button', { name: '+ Add column' }))
    await user.click(screen.getByRole('button', { name: '+ Add swimlane' }))
    await user.click(screen.getByRole('button', { name: 'Focus on North' }))
    expect(cb.onAddColumn).toHaveBeenCalled()
    expect(cb.onAddSwimlane).toHaveBeenCalled()
    expect(cb.onFocusLane).toHaveBeenCalledWith(1)
  })

  it('shows Exit focus on the focused lane', async () => {
    const user = userEvent.setup()
    const cb = edit()
    setup({ ...cb, focusedSwimlaneId: 1 })
    await user.click(screen.getByRole('button', { name: 'Exit focus' }))
    expect(cb.onExitFocus).toHaveBeenCalled()
  })

  it('withholds every admin control from a non-admin and Add card from a viewer', () => {
    setup({ ...edit(), isAdmin: false })
    expect(screen.queryByTestId('phone-column-actions')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Edit swimlane/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId('phone-add-structure')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Add card/ }).length).toBeGreaterThan(0)
  })

  it('shows no Add card for a viewer or a column that forbids creation', () => {
    setup({ ...edit(), isAdmin: false, canEdit: false })
    expect(screen.queryByRole('button', { name: /Add card/ })).not.toBeInTheDocument()
  })
})
