import { describe, expect, it, vi } from 'vitest'
import { HATCH_CSS } from '../components/Board/flowMetrics/hatch'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import FlowSection from '../components/Board/flowMetrics/FlowSection'
import FlowDrillDrawer from '../components/Board/flowMetrics/FlowDrillDrawer'
import type { DrillSelection } from '../components/Board/flowMetrics/FlowDrillDrawer'
import { buildColumnSelection } from '../components/Board/flowMetrics/columnDrill'
import { buildFlowRow } from '../components/Board/flowMetrics/flowRowData'
import type { AnalyticsData } from '../components/Board/flowMetrics/heatmap'
import type { ChartPanelView } from '../components/Common/Chart'
import type { FlowCard, FlowCumulativeFlow, FlowDwell, FlowThroughput, FlowWipAge } from '../types'

vi.mock('../api/cards', () => ({ getCardMovements: vi.fn(() => Promise.resolve([])) }))

const cards: FlowCard[] = Array.from({ length: 8 }, (_, i) => ({
  uid: `card-${i}`.padEnd(16, 'x'), id: i + 1, title: `Card ${i}`, archived: false, assignee: null,
}))
const col = (uid: string | null, name: string | null, over: Partial<FlowCumulativeFlow['columns'][number]> = {}) => ({
  column_uid: uid, column_name: name, is_done: false, start_count: 1, end_count: 1, entered: 0, left: 0, entered_per_week: 5, left_per_week: 5, ...over,
})
const cumulative: FlowCumulativeFlow = {
  definition: 'd',
  columns: [
    col('ready', 'Ready'),
    col('review', 'Review', { start_count: 1, end_count: 8, entered_per_week: 8.4, left_per_week: 2 }),
    col('done', 'Done', { is_done: true, entered_per_week: 7.8 }),
  ],
  days: [{ date: '2026-08-16', counts: {} }, { date: '2026-08-17', counts: {} }],
  bottleneck_column_uid: 'review',
}
const sample = (i: number, column: string, days: number) => ({
  card_uid: cards[i].uid, column_uid: column, value_days: days, start: '2026-08-01T00:00:00Z', is_blocked: i === 1, blocked_days: 0,
  dwell_by_column: [{ column_uid: 'ready', value_days: 1 }, { column_uid: column, value_days: days - 1 }],
})
const wipAge: FlowWipAge = {
  definition: 'd', sample_size: 8, excluded_incomplete_history: 0,
  cycle_time_percentiles: { p50: 3, p85: 10, p95: null },
  columns: [{ column_uid: 'ready', column_name: 'Ready' }, { column_uid: 'review', column_name: 'Review' }],
  samples: [sample(0, 'ready', 2), ...[1, 2, 3, 4, 5, 6, 7].map((i) => sample(i, 'review', 20 - i))],
  cards,
}
const dwell: FlowDwell = {
  definition: 'd', sample_size: 9, excluded_incomplete_history: 0,
  columns: [
    { column_uid: 'ready', column_name: 'Ready', sample_size: 9, percentiles: { p50: 1.4, p85: null, p95: null } },
    { column_uid: 'review', column_name: 'Review', sample_size: 9, percentiles: { p50: 6.2, p85: null, p95: null } },
  ],
}
const throughput: FlowThroughput = { definition: 'd', period: 'week', total: 102, median: 7, samples: [], cards: [] }
const columns = [{ uid: 'ready', wip_limit: 5 }, { uid: 'review', wip_limit: 5 }]

const analytics: AnalyticsData = {
  days: 30, columns: ['Ready', 'Review', 'Done'], done_columns: ['Done'],
  stalled_threshold_days: 7, staleness_threshold_days: 10, stale_warning_pct: 50,
  swimlanes: [{
    id: 1, name: 'Platform', avg_days_per_column: {}, is_outlier: {},
    age_avg_days_per_column: { Ready: 1.5, Review: 12 },
    throughput_avg_days_per_column: { Ready: 2, Review: 4 },
    throughput_card_count_per_column: { Ready: 3, Review: 4 },
    deal_velocity_days: 9, stalled_cards: [],
  }],
}

function Harness({ onOpenColumn = () => {}, data = analytics, filtered = false, cols = columns, cum = cumulative }: {
  onOpenColumn?: (uid: string) => void; data?: AnalyticsData | null; filtered?: boolean
  cols?: { uid: string; wip_limit: number | null }[]; cum?: FlowCumulativeFlow
}) {
  const [view, setView] = useState<ChartPanelView>('chart')
  const [mode, setMode] = useState<'age' | 'throughput'>('age')
  return (
    <FlowSection
      analytics={{ data }} cumulative={cum} dwell={dwell} wipAge={wipAge} throughput={throughput}
      columns={cols} filtered={filtered} mode={mode} onModeChange={setMode} view={view} onViewChange={setView}
      filters={{ days: 30, swimlaneId: null, labelId: null }} settled onOpenColumn={onOpenColumn}
    />
  )
}

describe('the flow row and time bar (#2262)', () => {
  it('draws one box per in-progress column with hollow squares over the limit', () => {
    render(<Harness />)
    const boxes = screen.getAllByTestId('flow-column-box')
    expect(boxes).toHaveLength(2)
    const review = boxes[1]
    expect(review).toHaveTextContent('Review')
    expect(review).toHaveTextContent('7 of 5, 2 over limit')
    expect(review).toHaveTextContent('6.2d median wait')
    expect(review).toHaveTextContent('Queue +7 since Aug 16')
    expect(review.className).toContain('border-warning')
    const squares = within(review).getAllByTestId('flow-square')
    expect(squares).toHaveLength(5)
    squares.forEach((s) => expect((s as HTMLElement).style.backgroundImage).toBe(HATCH_CSS))
    // The 20% ground is translucent, so the opaque surface base must sit under it.
    expect(squares[0].className).toContain('bg-surface')
    expect(squares[0].className).not.toContain('bg-warning')
    expect((within(boxes[0]).getAllByTestId('flow-square')[0] as HTMLElement).style.backgroundImage).not.toContain('repeating-linear-gradient')
    expect(within(review).getAllByTestId('flow-square-over')).toHaveLength(2)
    expect(boxes[0]).toHaveTextContent('Queue steady')
    expect(screen.getByText(/Hollow squares are over the limit/)).toBeInTheDocument()
    expect(screen.getByTestId('flow-done-box')).toHaveTextContent('102')
    expect(screen.getByText('7.8 / wk')).toBeInTheDocument()
  })

  it('hatches the bottleneck segment and prints the total', () => {
    render(<Harness />)
    const segments = screen.getAllByTestId('time-segment')
    expect(segments.map((s) => s.getAttribute('data-bottleneck'))).toEqual(['false', 'true'])
    expect(segments[1].style.backgroundImage).toBe(HATCH_CSS)
    expect(segments[1].className).toContain('bg-surface')
    expect(segments[1].className).not.toContain('bg-warning')
    expect(segments[0].style.backgroundImage).not.toContain('repeating-linear-gradient')
    expect(screen.getByTestId('time-total')).toHaveTextContent('7.6d')
    expect(screen.getByText('All cards')).toBeInTheDocument()
  })

  it('hatches the bottleneck legend swatch with the shared pattern', () => {
    render(<Harness />)
    const item = within(screen.getByRole('list', { name: 'Time bar legend' })).getByText(/bottleneck, hatched/)
    const swatch = item.querySelector('span[aria-hidden="true"]') as HTMLElement
    expect(swatch.style.backgroundImage).toBe(HATCH_CSS)
  })

  it('colors the connector into Done after the bottleneck, and leaves connectors before it neutral', () => {
    render(<Harness />)
    const spans = screen.getAllByTestId('flow-connector').map((c) => c.querySelector('[aria-hidden="true"]')!.className)
    expect(spans[0]).toContain('bg-line-strong')
    expect(spans[1]).toContain('bg-line-strong')
    expect(spans[2]).toContain('bg-warning')
  })

  it('keeps the last connector neutral when no bottleneck is named', () => {
    render(<Harness cum={{ ...cumulative, bottleneck_column_uid: null }} />)
    const spans = screen.getAllByTestId('flow-connector').map((c) => c.querySelector('[aria-hidden="true"]')!.className)
    expect(spans[2]).toContain('bg-line-strong')
  })

  it('makes the time bar scroller a keyboard-reachable region', () => {
    render(<Harness />)
    const region = screen.getByRole('region', { name: 'Where the time goes, scrolls sideways' })
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region.className).toContain('focus:ring-2')
  })

  it('describes each box with its count, median wait and queue change', () => {
    render(<Harness />)
    const review = screen.getAllByTestId('flow-column-box')[1]
    const description = document.getElementById(review.getAttribute('aria-describedby')!)!
    expect(description).toHaveTextContent('7 of 5, 2 over limit')
    expect(description).toHaveTextContent('6.2d median wait')
    expect(description).toHaveTextContent('Queue +7 since Aug 16')
  })

  it('shows only the count, with no limit wording, while a filter is on', () => {
    render(<Harness filtered />)
    const review = screen.getAllByTestId('flow-column-box')[1]
    expect(review).toHaveTextContent('7 now')
    expect(review).not.toHaveTextContent('of 5')
    expect(review).not.toHaveTextContent('over limit')
    expect(within(review).queryAllByTestId('flow-square-over')).toHaveLength(0)
    expect(within(review).getAllByTestId('flow-square')).toHaveLength(7)
    expect(screen.queryByText(/Hollow squares/)).toBeNull()
  })

  it('treats a limit of 0 as no limit', () => {
    render(<Harness cols={[{ uid: 'ready', wip_limit: 0 }, { uid: 'review', wip_limit: 0 }]} />)
    const review = screen.getAllByTestId('flow-column-box')[1]
    expect(review).toHaveTextContent('7 now')
    expect(review).not.toHaveTextContent('over limit')
    expect(within(review).queryAllByTestId('flow-square-over')).toHaveLength(0)
    expect(buildColumnSelection('review', { cumulative, dwell, wipAge, columns: [{ uid: 'review', wip_limit: 0 }] }).limit).toBeNull()
  })

  it('opens the column from its box', async () => {
    const onOpen = vi.fn()
    render(<Harness onOpenColumn={onOpen} />)
    await userEvent.click(screen.getAllByTestId('flow-column-box')[1])
    expect(onOpen).toHaveBeenCalledWith('review')
  })

  it('handles withheld numbers', () => {
    const row = buildFlowRow({ ...cumulative, columns: [col('ready', 'Ready', { start_count: null, end_count: null, entered_per_week: null })] }, undefined, undefined, [])
    expect(row[0]).toMatchObject({ medianWait: null, queueDelta: null, enteredPerWeek: null, count: 0, limit: null })
  })
})

describe('the Table view is the heatmap table (#2262)', () => {
  it('shows today\'s numbers, renames the modes and marks the active one', async () => {
    render(<Harness />)
    const group = screen.getByRole('group', { name: 'How work flows view' })
    await userEvent.click(within(group).getByRole('button', { name: 'table' }))
    const table = screen.getByRole('table', { name: 'Dwell time heatmap' })
    expect(table).toHaveTextContent('1.5d')
    expect(table).toHaveTextContent('12d')
    expect(table).toHaveTextContent('9d')
    expect(screen.queryByRole('button', { name: 'Throughput' })).toBeNull()
    const current = screen.getByRole('button', { name: 'Current' })
    const period = screen.getByRole('button', { name: 'In period' })
    expect(current.querySelector('[data-testid="active-mark"]')).not.toBeNull()
    await userEvent.click(period)
    expect(period.querySelector('[data-testid="active-mark"]')).not.toBeNull()
    expect(screen.getByRole('table', { name: 'Dwell time heatmap' })).toHaveTextContent('4d')
    expect(screen.getByText(/exited in the last 30 days/)).toBeInTheDocument()
  })

  it('says so when there is no analytics data', async () => {
    render(<Harness data={null} />)
    await userEvent.click(within(screen.getByRole('group', { name: 'How work flows view' })).getByRole('button', { name: 'table' }))
    expect(screen.getByText('No analytics data')).toBeInTheDocument()
  })
})

describe('the column drawer (#2262)', () => {
  const selection = buildColumnSelection('review', { cumulative, dwell, wipAge, columns })

  it('builds the figures from the responses', () => {
    expect(selection).toMatchObject({ name: 'Review', limit: 5, count: 7, medianWait: 6.2, pastP85: 7 })
    expect(selection.cards[0].days).toBe(19)
    expect(buildColumnSelection('missing', { cumulative: undefined, dwell: undefined, wipAge: undefined, columns: [] }))
      .toMatchObject({ name: 'this column', count: 0, medianWait: null, pastP85: null })
  })

  function Host({ onOpenCard = () => {}, pick = selection }: { onOpenCard?: (id: number) => void; pick?: DrillSelection }) {
    const [drill, setDrill] = useState<DrillSelection | null>(null)
    return (
      <>
        <button type="button" onClick={() => setDrill(pick)}>open it</button>
        {drill && (
          <FlowDrillDrawer
            boardId={1} selection={drill} cards={new Map(cards.map((c) => [c.uid, c]))}
            onChange={setDrill} onClose={() => setDrill(null)} onOpenCard={onOpenCard}
          />
        )}
      </>
    )
  }

  it('shows five rows then "Show N more", opens a card, and returns focus on close', async () => {
    const onOpenCard = vi.fn()
    render(<Host onOpenCard={onOpenCard} />)
    const opener = screen.getByRole('button', { name: 'open it' })
    opener.focus()
    await userEvent.click(opener)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('7 cards in this column now, limit 5')).toBeInTheDocument()
    expect(within(dialog).getByText('7 of 5')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /movement history/i })).toBeNull()
    const list = within(dialog).getByRole('region', { name: 'Other cards, oldest first' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Show 1 more' }))
    expect(within(list).getAllByRole('listitem')).toHaveLength(6)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open card' }))
    expect(onOpenCard).toHaveBeenCalledWith(cards[1].id)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
  })

  it('omits the limit from the drawer while a filter is on', async () => {
    const filteredSelection = buildColumnSelection('review', { cumulative, dwell, wipAge, columns }, true)
    expect(filteredSelection.limit).toBeNull()
    render(<Host pick={filteredSelection} />)
    await userEvent.click(screen.getByRole('button', { name: 'open it' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('7 cards in this column now')).toBeInTheDocument()
    expect(within(dialog).queryByText(/limit/)).toBeNull()
    expect(within(dialog).queryByText('7 of 5')).toBeNull()
  })

  it('moves focus to the first revealed row after "Show N more", and Tab stays in the drawer', async () => {
    const extra = buildColumnSelection('review', { cumulative, dwell, wipAge, columns })
    render(<Host pick={extra} />)
    await userEvent.click(screen.getByRole('button', { name: 'open it' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Show 1 more' }))
    const rows = within(dialog).getAllByRole('listitem')
    expect(rows).toHaveLength(6)
    expect(rows[5].querySelector('button')).toHaveFocus()
    for (let i = 0; i < 20; i += 1) {
      await userEvent.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
    await userEvent.tab({ shift: true })
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('drills into a card and back, and closes with Escape', async () => {
    render(<Host />)
    await userEvent.click(screen.getByRole('button', { name: 'open it' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getAllByRole('listitem')[0].querySelector('button')!)
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '← Back' }))
    expect(within(screen.getByRole('dialog')).getByText('Oldest first')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says so for an empty column', async () => {
    const empty = buildColumnSelection('nope', { cumulative, dwell, wipAge, columns })
    render(<FlowDrillDrawer boardId={1} selection={empty} cards={new Map()} onChange={() => {}} onClose={() => {}} />)
    expect(screen.getByText('No cards in this column now.')).toBeInTheDocument()
  })
})
