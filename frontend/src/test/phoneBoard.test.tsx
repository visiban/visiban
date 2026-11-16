import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PhoneBoard from '../components/Board/PhoneBoard'
import type { Card, Column, Swimlane } from '../types'

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
    await user.click(screen.getByRole('button', { name: 'Collapse lane APAC' }))
    expect(onToggleSwimlane).toHaveBeenCalledWith(2)
  })

  it('hides cards of a collapsed lane and respects the filter', () => {
    setup({ collapsedSwimlaneIds: new Set([2]), filteredCardIds: new Set([1, 2]) })
    expect(screen.getByText('Card 1')).toBeInTheDocument()
    expect(screen.queryByText('Card 2')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand lane APAC' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('counts overdue cards in the lane band', () => {
    setup({ cards: [card(1, 1, 1, { due_date: '2000-01-01' })] })
    expect(screen.getByText('1 overdue')).toBeInTheDocument()
  })

  it('renders nothing without columns', () => {
    setup({ columns: [] })
    expect(screen.queryByTestId('phone-board')).not.toBeInTheDocument()
  })
})
