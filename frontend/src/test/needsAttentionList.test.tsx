import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AttentionSection from '../components/Board/flowMetrics/AttentionSection'
import type { FlowAttention, FlowAttentionItem } from '../types'

const swimlanes = [{ id: 1, name: 'Mobile' }, { id: 2, name: 'Platform' }]
const columns = [{ uid: 'c-review', name: 'Review' }, { uid: 'c-doing', name: 'In progress' }]

const item = (n: number, over: Partial<FlowAttentionItem> = {}): FlowAttentionItem => ({
  card_uid: `uid-${n}`, column_uid: 'c-review', swimlane_id: 1, age_days: n, unmoved_days: null, reasons: ['past_p85'], ...over,
})
const payload = (items: FlowAttentionItem[]): FlowAttention => ({
  definition: 'd',
  stalled_threshold_days: 7,
  cycle_time_percentiles: { p50: 11, p85: 19, p95: null },
  items,
  cards: items.map((i) => ({ uid: i.card_uid, id: Number(i.card_uid.slice(4)), title: `Card ${i.card_uid.slice(4)}`, archived: false, assignee: null })),
})
const ok = (data: FlowAttention) => ({ data, error: undefined }) as never
const many = (n: number) => Array.from({ length: n }, (_, i) => item(i + 1))

const renderIt = (items: FlowAttentionItem[], onOpenCard?: (id: number) => void) =>
  render(<AttentionSection attention={ok(payload(items))} swimlanes={swimlanes} columns={columns} onOpenCard={onOpenCard} />)

describe('Needs attention (#2263)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists each card once, in the order the service returns, with column, swimlane and reason', () => {
    renderIt([
      item(1, { age_days: 12, reasons: ['blocked'] }),
      item(2, { age_days: 28, reasons: ['blocked', 'past_p85'], swimlane_id: 2, column_uid: 'c-doing' }),
      item(3, { age_days: null, unmoved_days: 9, reasons: ['stalled'] }),
    ])
    const rows = within(screen.getByRole('list', { name: 'Cards that need attention' })).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    // Order is the service's; the client never re-sorts (a 28d card after a 12d one stays there).
    expect(rows[1]).toHaveTextContent('Card 2')
    expect(rows[1]).toHaveTextContent('In progress · Platform · blocked, past 19 days')
    expect(rows[1]).toHaveTextContent('28d')
    expect(rows[0]).toHaveTextContent('Card 1')
    expect(rows[2]).toHaveTextContent('Review · Mobile · no movement for 9 days')
    expect(rows[2]).toHaveTextContent('9d')
    expect(within(rows[2]).getByLabelText('9 days without movement')).toBeInTheDocument()
    expect(within(rows[0]).getByLabelText('12 days old')).toBeInTheDocument()
  })

  it('colors age danger past the 85th percentile and warning otherwise', () => {
    renderIt([item(1, { age_days: 30 }), item(2, { age_days: 5, reasons: ['blocked'] })])
    expect(screen.getByText('30d')).toHaveClass('text-danger')
    expect(screen.getByText('5d')).toHaveClass('text-warning')
  })

  it('falls back to the card uid and drops an unknown column and swimlane', () => {
    const data = payload([item(1, { column_uid: 'gone', swimlane_id: 99, reasons: ['blocked'] })])
    data.cards = []
    render(<AttentionSection attention={ok(data)} swimlanes={[]} />)
    const row = screen.getByRole('listitem')
    expect(row).toHaveTextContent('uid-1')
    expect(row).toHaveTextContent(/^uid-1blocked1d$/)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('brightens the secondary line on row hover for contrast', () => {
    renderIt([item(1)], vi.fn())
    const row = screen.getByRole('button')
    expect(row).toHaveClass('group')
    expect(within(row).getByText(/Review · Mobile/)).toHaveClass('group-hover:text-fg-secondary')
  })

  it('shows five rows, then expands in place 25 per page', async () => {
    const user = userEvent.setup()
    renderIt(many(30))
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
    await user.click(screen.getByRole('button', { name: 'All 30 cards' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(25)
    expect(screen.getByText('1–25 of 30')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
    expect(screen.getByText('26–30 of 30')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '← Prev' }))
    expect(screen.getByText('1–25 of 30')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show fewer' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
  })

  it('has no expand control at five cards or fewer', () => {
    renderIt(many(5))
    expect(screen.queryByRole('button', { name: /All \d+ cards/ })).not.toBeInTheDocument()
  })

  it('opens the card from a keyboard-reachable row', async () => {
    const onOpenCard = vi.fn()
    const user = userEvent.setup()
    renderIt([item(42)], onOpenCard)
    await user.tab()
    expect(screen.getByRole('button', { name: /Card 42/ })).toHaveFocus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onOpenCard).toHaveBeenCalledTimes(2)
    expect(onOpenCard).toHaveBeenCalledWith(42)
  })

  it('renders plain rows without onOpenCard', () => {
    renderIt([item(1)])
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('says so when nothing needs attention', () => {
    renderIt([])
    expect(screen.getByText(/No card is blocked, stalled/)).toBeInTheDocument()
  })

  it('shows a placeholder before data and on error', () => {
    const { rerender } = render(<AttentionSection attention={undefined} swimlanes={[]} />)
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    rerender(<AttentionSection attention={{ data: undefined, error: new Error('x') } as never} swimlanes={[]} />)
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
  })
})
