import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HATCH_CSS, HATCH_GROUND_COLOR, HATCH_PERIOD, HATCH_SPEC, HATCH_STRIPE_COLOR } from '../components/Board/flowMetrics/hatch'
import { useRef } from 'react'
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { REFERENCE_LABEL_MARGIN } from '../components/Common/Chart'
import WipAgeChart from '../components/Board/flowMetrics/WipAgeChart'
import AnalyticsOverview from '../components/Board/flowMetrics/AnalyticsOverview'
import { useAnalyticsFilters } from '../components/Board/flowMetrics/useAnalyticsFilters'
import {
  PERCENTILE_APPEARS_AT, bottleneckSentence, columnsOverLimit, shareOfCycle, shareOfCyclePhrase,
  ageMarkColor, ageMarkLabel, cumulativeFlowSummary, cycleTimeSummary, excludedNote, percentileLines, sparseNote, throughputSummary, wipAgeSummary,
} from '../components/Board/flowMetrics/flowFormat'
import type {
  FlowAttention, FlowBlocked, FlowCard, FlowCumulativeFlow, FlowCycleTime, FlowDwell, FlowThroughput, FlowWipAge,
} from '../types'

vi.mock('../api/flowMetrics', () => ({
  getFlowCycleTime: vi.fn(),
  getFlowThroughput: vi.fn(),
  getFlowCumulativeFlow: vi.fn(),
  getFlowCumulativeDay: vi.fn(),
  getFlowWipAge: vi.fn(),
  getFlowDwell: vi.fn(),
  getFlowBlocked: vi.fn(),
  getFlowAttention: vi.fn(),
}))
vi.mock('../api/cards', () => ({ getCardMovements: vi.fn() }))
vi.mock('../api/boards', () => ({ getBoardAnalytics: vi.fn() }))

import {
  getFlowAttention, getFlowBlocked, getFlowCumulativeDay, getFlowCumulativeFlow, getFlowCycleTime, getFlowDwell,
  getFlowThroughput, getFlowWipAge,
} from '../api/flowMetrics'
import { getCardMovements } from '../api/cards'
import { getBoardAnalytics } from '../api/boards'

/** The Overview under the page's filter state, as AnalyticsView hosts it (#2261). */
function FlowMetricsDashboard(extra: Partial<ComponentProps<typeof AnalyticsOverview>>) {
  const { filters, setFilters } = useAnalyticsFilters()
  const headingRef = useRef<HTMLHeadingElement>(null)
  return (
    <>
      <h1 ref={headingRef} tabIndex={-1}>Analytics</h1>
      <AnalyticsOverview {...props} {...extra} filters={filters} onFiltersChange={setFilters} headingRef={headingRef} />
    </>
  )
}

const cycleMock = vi.mocked(getFlowCycleTime)
const throughputMock = vi.mocked(getFlowThroughput)
const cumulativeMock = vi.mocked(getFlowCumulativeFlow)
const dayMock = vi.mocked(getFlowCumulativeDay)
const ageMock = vi.mocked(getFlowWipAge)
const movementsMock = vi.mocked(getCardMovements)
const dwellMock = vi.mocked(getFlowDwell)
const blockedMock = vi.mocked(getFlowBlocked)
const attentionMock = vi.mocked(getFlowAttention)
const analyticsMock = vi.mocked(getBoardAnalytics)

const owner = { id: 7, username: 'pat', display_name: 'Pat Lee', avatar_url: '' }
const cardA: FlowCard = { uid: 'a'.repeat(16), id: 1, title: 'Fix the login', archived: false, assignee: owner, swimlane: { id: 1, name: 'Lane' } }
const cardB: FlowCard = { uid: 'b'.repeat(16), id: 2, title: 'Old archived job', archived: true, assignee: null, swimlane: { id: 1, name: 'Lane' } }

const cycle: FlowCycleTime = {
  definition: 'cycle definition',
  sample_size: 7,
  excluded_incomplete_history: 2,
  percentiles: { p50: 4.04, p85: 8.14, p95: null },
  samples: [
    { card_uid: cardA.uid, value_days: 8.14, start: '2026-06-01T00:00:00Z', end: '2026-06-09T03:00:00Z', reopened: false },
    { card_uid: cardB.uid, value_days: 2.5, start: '2026-06-01T00:00:00Z', end: '2026-06-03T12:00:00Z', reopened: true },
  ],
  cards: [cardA, cardB],
}
const throughput: FlowThroughput = {
  definition: 'throughput definition',
  period: 'week',
  total: 2,
  median: 1,
  samples: [
    { start: '2026-06-01', count: 2, card_uids: [cardA.uid, cardB.uid], started: 0 },
    { start: '2026-06-08', count: 0, card_uids: [], started: 0 },
  ],
  cards: [cardA, cardB],
}
const cumulative: FlowCumulativeFlow = {
  definition: 'cumulative definition',
  columns: [
    { column_uid: 'col-doing', column_name: 'Doing', is_done: false, start_count: 0, end_count: 0, entered: 0, left: 0, entered_per_week: 0, left_per_week: 0 },
    { column_uid: 'col-done', column_name: 'Done', is_done: true, start_count: 0, end_count: 0, entered: 0, left: 0, entered_per_week: 0, left_per_week: 0 },
    { column_uid: null, column_name: null, is_done: false, start_count: 0, end_count: 0, entered: 0, left: 0, entered_per_week: 0, left_per_week: 0 },
  ],
  days: [
    { date: '2026-06-01', counts: { 'col-doing': 1, 'col-done': 0, null: 0 } },
    { date: '2026-06-02', counts: { 'col-doing': 2, 'col-done': 3, null: 0 } },
  ],
  bottleneck_column_uid: 'col-doing',
}
// Doing holds four cards (#2287) but only one has an age: two have not
// started and one has incomplete history, so neither of those has a sample.
const age: FlowWipAge = {
  definition: 'age definition',
  sample_size: 1,
  excluded_incomplete_history: 1,
  cycle_time_percentiles: { p50: 4, p85: 8, p95: 12 },
  columns: [{ column_uid: 'col-doing', column_name: 'Doing', wip_count: 4 }, { column_uid: 'col-review', column_name: 'Review', wip_count: 0 }],
  samples: [{
    card_uid: cardA.uid,
    column_uid: 'col-doing',
    value_days: 15.44,
    start: '2026-06-01T00:00:00Z',
    dwell_by_column: [
      { column_uid: 'col-doing', value_days: 10 },
      { column_uid: null, value_days: 5.44 },
    ],
    is_blocked: true,
    blocked_days: 1.5,
  }],
  cards: [cardA],
}

const dwell: FlowDwell = {
  definition: 'dwell definition',
  sample_size: 7,
  excluded_incomplete_history: 0,
  columns: [{ column_uid: 'col-doing', column_name: 'Doing', sample_size: 7, percentiles: { p50: 2.1, p85: 5, p95: null } }],
}
const blocked: FlowBlocked = {
  definition: 'blocked definition',
  total: { days: 3.5, blocks: 2 },
  blocked_now: 1,
  columns: [{ column_uid: 'col-doing', column_name: 'Doing', days: 3.5, blocks: 2 }],
  reasons: [{ reason: 'Waiting on review', days: 3.5, blocks: 2 }],
  reason_count: 1,
}
const attention: FlowAttention = {
  definition: 'attention definition',
  stalled_threshold_days: 7,
  cycle_time_percentiles: { p50: 4, p85: 8, p95: 12 },
  items: [],
  cards: [],
}

function mockAll(overrides: Partial<{
  cycle: FlowCycleTime; throughput: FlowThroughput; cumulative: FlowCumulativeFlow; age: FlowWipAge
  dwell: FlowDwell; blocked: FlowBlocked; attention: FlowAttention
}> = {}) {
  cycleMock.mockResolvedValue(overrides.cycle ?? cycle)
  throughputMock.mockResolvedValue(overrides.throughput ?? throughput)
  cumulativeMock.mockResolvedValue(overrides.cumulative ?? cumulative)
  ageMock.mockResolvedValue(overrides.age ?? age)
  dwellMock.mockResolvedValue(overrides.dwell ?? dwell)
  blockedMock.mockResolvedValue(overrides.blocked ?? blocked)
  attentionMock.mockResolvedValue(overrides.attention ?? attention)
  analyticsMock.mockResolvedValue(null)
}

const empty = {
  cycle: { ...cycle, sample_size: 0, excluded_incomplete_history: 0, percentiles: { p50: null, p85: null, p95: null }, samples: [], cards: [] },
  throughput: { ...throughput, total: 0, median: 0, samples: [{ start: '2026-06-01', count: 0, card_uids: [], started: 0 }], cards: [] },
  cumulative: { ...cumulative, days: [{ date: '2026-06-01', counts: { 'col-doing': 0, 'col-done': 0, null: 0 } }], bottleneck_column_uid: null },
  age: { ...age, sample_size: 0, samples: [], cards: [], cycle_time_percentiles: { p50: null, p85: null, p95: null } },
}

const props = {
  boardId: 9,
  swimlanes: [{ id: 3, name: 'Customer A' }],
  labels: [{ id: 4, name: 'Urgent' }],
}

beforeEach(() => {
  vi.clearAllMocks()
  movementsMock.mockResolvedValue([])
})

async function renderLoaded(extra: Partial<Parameters<typeof FlowMetricsDashboard>[0]> = {}) {
  render(<FlowMetricsDashboard {...props} {...extra} />)
  await screen.findByTestId('flow-cycle-time')
}

describe('FlowMetricsDashboard states', () => {
  it('shows skeletons with an sr status on first load only; a refetch keeps the panels, dimmed', async () => {
    const pending = () => new Promise<never>(() => {})
    for (const mock of [cycleMock, throughputMock, cumulativeMock, ageMock, dwellMock, blockedMock, attentionMock]) {
      mock.mockReturnValue(pending())
    }
    analyticsMock.mockReturnValue(pending())
    const { unmount } = render(<FlowMetricsDashboard />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading flow metrics')
    expect(screen.getByTestId('analytics-bottleneck')).toBeInTheDocument()
    expect(screen.queryByTestId('flow-cycle-time')).not.toBeInTheDocument()
    // Skeletons are sized like the final panels (#2264): four chart frames at the real 260px, with the note lines.
    const frames = screen.getAllByTestId('panel-skeleton')
    const chartBlocks = frames.flatMap((frame) => [...frame.querySelectorAll('.h-\\[260px\\]')])
    expect(chartBlocks).toHaveLength(4)
    expect(screen.getByText('Loading flow metrics…')).toBeInTheDocument()
    for (const block of chartBlocks) expect(block.className).toContain('motion-reduce:animate-none')
    unmount()

    mockAll()
    await renderLoaded()
    cycleMock.mockReturnValue(pending())
    await userEvent.click(screen.getByRole('button', { name: /^Label/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Urgent' }))
    const panel = screen.getByTestId('flow-cycle-time')
    expect(panel).toHaveTextContent('85% of 7 cards')
    expect(panel.parentElement).toHaveAttribute('aria-busy', 'true')
    expect(panel.parentElement?.className).toContain('opacity-60')
    expect(screen.getByRole('status')).toHaveTextContent('Updating')
  })

  it('shows the error state, and Retry refetches', async () => {
    mockAll()
    cycleMock.mockRejectedValueOnce(new Error('no'))
    render(<FlowMetricsDashboard {...props} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Some panels failed to load.')
    // The failed panel says so in its own frame; the others still draw.
    expect(screen.getByTestId('flow-throughput')).toBeInTheDocument()
    expect(screen.getByText('Could not load this panel.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('flow-cycle-time')).toBeInTheDocument()
    expect(cycleMock).toHaveBeenCalledTimes(2)
    // The Retry button is gone; focus must not have dropped to <body>.
    expect(screen.getByRole('heading', { name: 'Analytics' })).toHaveFocus()
  })

  it('shows the empty state, and Go to board calls back', async () => {
    mockAll(empty)
    const onGoToBoard = vi.fn()
    render(<FlowMetricsDashboard {...props} onGoToBoard={onGoToBoard} />)
    expect(await screen.findByRole('heading', { name: 'Nothing has moved yet' })).toBeInTheDocument()
    expect(screen.getByText('Example of what you will see.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Go to board' }))
    expect(onGoToBoard).toHaveBeenCalled()
  })

  it('says the filters match nothing instead of "no history" when one is on', async () => {
    mockAll()
    await renderLoaded()
    mockAll(empty)
    await userEvent.click(screen.getByRole('button', { name: /^Swimlane/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Customer A' }))
    expect(await screen.findByRole('heading', { name: 'No cards match these filters' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Nothing has moved yet' })).not.toBeInTheDocument()
  })

  it('renders four panels with a 90-day default request', async () => {
    mockAll()
    await renderLoaded()
    for (const id of ['flow-cycle-time', 'flow-throughput', 'flow-cumulative', 'flow-wip-age']) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    const filters = { days: 90, swimlaneId: null, labelId: null }
    expect(cycleMock).toHaveBeenCalledWith(9, filters)
    expect(throughputMock).toHaveBeenCalledWith(9, filters)
    expect(cumulativeMock).toHaveBeenCalledWith(9, filters)
    expect(ageMock).toHaveBeenCalledWith(9, filters)
  })

  it('ignores an answer to a superseded request', async () => {
    mockAll()
    let release: (value: FlowCycleTime) => void = () => {}
    cycleMock.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    render(<FlowMetricsDashboard {...props} />)
    await userEvent.click(screen.getByRole('button', { name: /^Label/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Urgent' }))
    const panel = await screen.findByTestId('flow-cycle-time')
    expect(panel).toHaveTextContent('85% of 7 cards')
    release({ ...cycle, sample_size: 99 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.getByTestId('flow-cycle-time')).not.toHaveTextContent('99 cards')
  })

  it('ignores a failure of a superseded request', async () => {
    mockAll()
    let fail: (reason: Error) => void = () => {}
    cycleMock.mockReturnValueOnce(new Promise((_, reject) => { fail = reject }))
    render(<FlowMetricsDashboard {...props} />)
    await userEvent.click(screen.getByRole('button', { name: /^Label/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Urgent' }))
    await screen.findByTestId('flow-cycle-time')
    fail(new Error('late'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('Some panels failed to load.')).not.toBeInTheDocument()
    expect(screen.getByTestId('flow-cycle-time')).toBeInTheDocument()
  })

  it('keeps each panel on Table across a filter change, and only that panel', async () => {
    mockAll()
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-throughput')).getByRole('button', { name: 'table' }))
    await userEvent.click(screen.getByRole('button', { name: /^Label/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Urgent' }))
    await waitFor(() => expect(cycleMock).toHaveBeenLastCalledWith(9, { days: 90, swimlaneId: null, labelId: 4 }))
    const throughputPanel = within(await screen.findByTestId('flow-throughput'))
    expect(throughputPanel.getByRole('button', { name: 'table' })).toHaveAttribute('aria-pressed', 'true')
    expect(throughputPanel.getByRole('region', { name: 'Cards finished per week' })).toBeInTheDocument()
    expect(within(screen.getByTestId('flow-cycle-time')).getByRole('button', { name: 'chart' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(throughputPanel.getByRole('button', { name: 'chart' }))
    expect(within(screen.getByTestId('flow-throughput')).getByRole('img')).toBeInTheDocument()
  })

  it('refetches with each filter, and the default range does not read as an active filter', async () => {
    mockAll()
    await renderLoaded()
    const range = screen.getByRole('button', { name: 'Date range: Last 90 days' })
    expect(range.className).not.toContain('border-primary-soft')
    await userEvent.click(range)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Last 30 days' }))
    await waitFor(() => expect(cycleMock).toHaveBeenLastCalledWith(9, { days: 30, swimlaneId: null, labelId: null }))
    await screen.findByTestId('flow-cycle-time')
    await userEvent.click(screen.getByRole('button', { name: /^Label/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Urgent' }))
    await waitFor(() => expect(cycleMock).toHaveBeenLastCalledWith(9, { days: 30, swimlaneId: null, labelId: 4 }))
    await screen.findByTestId('flow-cycle-time')
    expect(screen.getByRole('button', { name: 'Date range: Last 30 days' }).className).toContain('border-primary-soft')
    // Clearing the date range falls back to the default rather than no range.
    await userEvent.click(screen.getByRole('button', { name: /^Date range/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Last 30 days' }))
    await waitFor(() => expect(cycleMock).toHaveBeenLastCalledWith(9, { days: 90, swimlaneId: null, labelId: 4 }))
  })
})

describe('the panels', () => {
  beforeEach(() => mockAll())

  it('names each chart by its heading and summary, and quotes the definition', async () => {
    await renderLoaded()
    const panel = within(screen.getByTestId('flow-cycle-time'))
    expect(panel.getByRole('heading', { name: 'Cycle time' })).toBeInTheDocument()
    expect(panel.getByRole('img')).toHaveAccessibleName('Cycle time 85% of 7 cards finished within 8.1d.')
    expect(panel.getByText('Cycle time: cycle definition')).toBeInTheDocument()
  })

  it('draws a percentile line only for a percentile the server returned, labelled directly', async () => {
    await renderLoaded()
    const svg = within(screen.getByTestId('flow-cycle-time')).getByRole('img')
    expect(svg).toHaveTextContent('50th · 4.0d')
    expect(svg).toHaveTextContent('85th · 8.1d')
    expect(svg).not.toHaveTextContent('95th')
    expect(screen.getByTestId('flow-cycle-time')).toHaveTextContent('Too few cards to draw the higher percentile lines.')
    expect(screen.getByTestId('flow-cycle-time')).toHaveTextContent('2 cards left out for missing or broken history.')
    expect(screen.getByTestId('flow-cycle-time')).toHaveTextContent('Hollow points were reopened after finishing.')
  })

  it('prints throughput values on the points and labels the median', async () => {
    await renderLoaded()
    const svg = within(screen.getByTestId('flow-throughput')).getByRole('img')
    expect(svg).toHaveTextContent('Median · 1')
    expect(within(screen.getByTestId('flow-throughput')).getAllByRole('button', { name: /^Week of/ })).toHaveLength(1)
  })

  it('hides the median line with a note when it is null', async () => {
    mockAll({ throughput: { ...throughput, median: null } })
    await renderLoaded()
    expect(within(screen.getByTestId('flow-throughput')).getByRole('img')).not.toHaveTextContent('Median')
    expect(screen.getByTestId('flow-throughput')).toHaveTextContent('Too few whole weeks to draw a median.')
  })

  it('hatches the bottleneck, labels bands directly and hides an empty deleted band', async () => {
    await renderLoaded()
    const panel = screen.getByTestId('flow-cumulative')
    const svg = within(panel).getByRole('img')
    expect(svg).toHaveTextContent('Doing')
    expect(svg).toHaveTextContent('Done')
    expect(svg).not.toHaveTextContent('Deleted columns')
    const fill = panel.querySelector('[data-band="col-doing"] polygon')?.getAttribute('fill')
    expect(fill).toMatch(/^url\(#cfd-hatch-/)
    expect(panel.querySelector('[data-band="col-done"] polygon')?.getAttribute('fill')).toContain('--border-strong')
    const pattern = panel.querySelector('pattern') as SVGElement
    expect(pattern.getAttribute('patternTransform')).toBe(`rotate(${HATCH_SPEC.angle})`)
    expect(pattern.getAttribute('width')).toBe(String(HATCH_PERIOD))
    expect(pattern.querySelector('rect')?.getAttribute('fill')).toBe(HATCH_GROUND_COLOR)
    const line = pattern.querySelector('line')
    expect(line?.getAttribute('stroke')).toBe(HATCH_STRIPE_COLOR)
    expect(line?.getAttribute('stroke-width')).toBe(String(HATCH_SPEC.stripe))
    expect(panel).toHaveTextContent('The hatched band is the bottleneck.')
  })

  it('keys the hatched bottleneck band with a swatch drawn from the shared hatch, and only when it is on screen (#2284)', async () => {
    await renderLoaded()
    const panel = screen.getByTestId('flow-cumulative')
    const legend = within(panel).getByTestId('cfd-legend')
    expect(legend).toHaveTextContent('Bottleneck column')
    const swatch = legend.querySelector('pattern') as SVGElement
    expect(swatch.getAttribute('patternTransform')).toBe(`rotate(${HATCH_SPEC.angle})`)
    expect(swatch.querySelector('rect')?.getAttribute('fill')).toBe(HATCH_GROUND_COLOR)
    expect(swatch.querySelector('line')?.getAttribute('stroke')).toBe(HATCH_STRIPE_COLOR)
    expect(legend.querySelector('[data-testid="cfd-legend-hatch"] > rect')?.getAttribute('fill')).toBe(`url(#${swatch.id})`)
    cleanup()
    mockAll({ cumulative: { ...cumulative, bottleneck_column_uid: null } })
    await renderLoaded()
    expect(within(screen.getByTestId('flow-cumulative')).queryByTestId('cfd-legend')).toBeNull()
  })

  it('gives the three chart legends distinct accessible names (#2284)', async () => {
    const at = (uid: string, value: number) => ({ ...age.samples[0], card_uid: uid, value_days: value, is_blocked: false })
    mockAll({ age: { ...age, sample_size: 1, cards: [cardA, cardB], samples: [at('n1', 2)] } })
    await renderLoaded()
    const names = ['Throughput legend', 'Cumulative flow legend', 'WIP aging legend']
    for (const name of names) expect(screen.getByRole('list', { name })).toBeInTheDocument()
  })

  it('shows the deleted band when it holds cards', async () => {
    mockAll({
      cumulative: {
        ...cumulative,
        days: [{ date: '2026-06-01', counts: { 'col-doing': 1, 'col-done': 0, null: 2 } }],
        bottleneck_column_uid: null,
      },
    })
    await renderLoaded()
    expect(within(screen.getByTestId('flow-cumulative')).getByRole('img')).toHaveTextContent('Deleted columns')
  })

  it('stacks Done at the bottom with the deleted band above it, so Done tops out at departures (#2289)', async () => {
    mockAll({
      cumulative: {
        ...cumulative,
        // Server order: board order with the deleted band last.
        columns: [
          ...cumulative.columns.filter((c) => c.column_uid !== null),
          cumulative.columns.find((c) => c.column_uid === null)!,
        ],
        days: [
          { date: '2026-06-01', counts: { 'col-doing': 2, 'col-done': 4, null: 3 } },
          { date: '2026-06-02', counts: { 'col-doing': 2, 'col-done': 5, null: 3 } },
        ],
        bottleneck_column_uid: null,
      },
    })
    await renderLoaded()
    const panel = screen.getByTestId('flow-cumulative')
    const order = Array.from(panel.querySelectorAll('[data-band]')).map((g) => g.getAttribute('data-band'))
    expect(order.indexOf('col-done')).toBe(0)
    expect(order.indexOf('null')).toBe(1)
    const top = (key: string) => Number(Array.from(panel.querySelectorAll('[data-band]')).find((g) => g.getAttribute('data-band') === key)?.getAttribute('data-top-count'))
    expect(top('col-done')).toBe(5)
    expect(top('null')).toBe(8)
    expect(top('col-doing')).toBe(10)
  })

  it('keeps each day hit area one gap wide and inside the plot (#2289)', async () => {
    mockAll({
      cumulative: {
        ...cumulative,
        days: [
          { date: '2026-06-01', counts: { 'col-doing': 1, 'col-done': 0, null: 0 } },
          { date: '2026-06-02', counts: { 'col-doing': 1, 'col-done': 1, null: 0 } },
          { date: '2026-06-03', counts: { 'col-doing': 1, 'col-done': 2, null: 0 } },
        ],
      },
    })
    await renderLoaded()
    const hits = within(screen.getByTestId('flow-cumulative')).getAllByRole('button', { name: /card/ })
    const rects = hits.map((h) => h.querySelector('rect') as SVGRectElement)
    const [a, b, c] = rects.map((r) => ({ x: Number(r.getAttribute('x')), w: Number(r.getAttribute('width')) }))
    expect(a.w).toBeCloseTo(b.w / 2, 3)
    expect(c.w).toBeCloseTo(b.w / 2, 3)
    expect(a.x + a.w).toBeCloseTo(b.x, 3)
    expect(b.x + b.w).toBeCloseTo(c.x, 3)
  })

  it('squares blocked cards, rings cards past P85, and names them in column order', async () => {
    await renderLoaded()
    const panel = screen.getByTestId('flow-wip-age')
    expect(panel.querySelector('[data-blocked="true"] rect')).not.toBeNull()
    const dot = within(panel).getByRole('button', { name: 'Fix the login, 15.4 days in progress, beyond 95th percentile, blocked' })
    expect(dot).toHaveAttribute('tabindex', '0')
    expect(panel).toHaveTextContent('Squares are blocked cards.')
    expect(panel).toHaveTextContent('Ringed cards are past the 85th percentile.')
    expect(within(panel).getByRole('img')).toHaveTextContent('Fix the l…')
  })

  it('rings only the cards past P85, in the image layer', async () => {
    const under = { ...age.samples[0], card_uid: cardB.uid, value_days: 3, is_blocked: false }
    mockAll({ age: { ...age, sample_size: 2, samples: [age.samples[0], under], cards: [cardA, cardB] } })
    await renderLoaded()
    const image = within(screen.getByTestId('flow-wip-age')).getByRole('img')
    const rings = image.querySelectorAll('circle[r="8"]')
    expect(rings).toHaveLength(1)
    // The blocked card past P85 is the one ringed: its square sits at the ring's center.
    const square = image.querySelector('[data-blocked="true"] rect') as SVGRectElement
    expect(Number(rings[0].getAttribute('cx'))).toBe(Number(square.getAttribute('x')) + 4)
  })

  it('tints the zones above P50 and P85 with the neutral tint at 5% and 10%, never the chart hue', async () => {
    await renderLoaded()
    const image = within(screen.getByTestId('flow-wip-age')).getByRole('img')
    expect(image.querySelector('[data-age-zone="p50"]')?.getAttribute('fill')).toBe('rgb(var(--border-strong) / 0.05)')
    expect(image.querySelector('[data-age-zone="p85"]')?.getAttribute('fill')).toBe('rgb(var(--border-strong) / 0.1)')
    expect(image.querySelector('rect[fill*="primary-emphasis"]')).toBeNull()
  })

  it('strokes the Done band top edge neutral (the contrast exception) and labels it only when it has height', async () => {
    await renderLoaded()
    const image = within(screen.getByTestId('flow-cumulative')).getByRole('img')
    // Every band separator is the panel surface, so the bands read as separate shapes on one ramp (#2311).
    expect(image.querySelector('[data-band="col-done"] polyline')?.getAttribute('stroke')).toBe('rgb(var(--surface))')
    expect(image.querySelector('[data-band="col-doing"] polyline')?.getAttribute('stroke')).toBe('rgb(var(--surface))')
    expect(image).toHaveTextContent('Done')
  })

  it('draws no Done label while the Done band is empty, but still strokes it neutral', async () => {
    mockAll({
      cumulative: {
        ...cumulative,
        days: cumulative.days.map((day) => ({ ...day, counts: { ...day.counts, 'col-done': 0 } })),
      },
    })
    await renderLoaded()
    const image = within(screen.getByTestId('flow-cumulative')).getByRole('img')
    expect(image.querySelector('[data-band="col-done"] polyline')?.getAttribute('stroke')).toBe('rgb(var(--surface))')
    expect(image).not.toHaveTextContent('Done')
  })

  it('rings nothing and draws no zones without a P85', async () => {
    mockAll({ age: { ...age, cycle_time_percentiles: { p50: null, p85: null, p95: null } } })
    await renderLoaded()
    const image = within(screen.getByTestId('flow-wip-age')).getByRole('img')
    expect(image.querySelectorAll('circle[r="8"]')).toHaveLength(0)
    expect(screen.getByTestId('flow-wip-age')).not.toHaveTextContent('Ringed cards')
  })

  it('draws the percentile lines in their shared encoding, in the chart itself', async () => {
    mockAll({ cycle: { ...cycle, percentiles: { p50: 4, p85: 8, p95: 12 } } })
    await renderLoaded()
    const lines = [...within(screen.getByTestId('flow-cycle-time')).getByRole('img').querySelectorAll('line[stroke*="primary-emphasis"]')]
    const encodings = lines.map((line) => [line.getAttribute('stroke-width'), line.getAttribute('stroke-dasharray')])
    expect(encodings).toEqual([['1.5', '6 4'], ['2.5', null], ['1.5', '1.5 3.5']])
  })

  it('keeps only aging dots in the tab order: other marks are reached through the table', async () => {
    await renderLoaded()
    for (const id of ['flow-cycle-time', 'flow-throughput', 'flow-cumulative']) {
      for (const mark of within(screen.getByTestId(id)).getByRole('group', { name: 'Chart marks' }).querySelectorAll('[role="button"]')) {
        expect(mark).toHaveAttribute('tabindex', '-1')
      }
    }
  })

  it('toggles to a table with a pinned first column in a focusable region', async () => {
    await renderLoaded()
    const panel = within(screen.getByTestId('flow-cycle-time'))
    const chartToggle = panel.getByRole('button', { name: 'chart' })
    const tableToggle = panel.getByRole('button', { name: 'table' })
    expect(chartToggle).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(tableToggle)
    expect(tableToggle).toHaveAttribute('aria-pressed', 'true')
    expect(panel.queryByRole('img')).not.toBeInTheDocument()
    const region = panel.getByRole('region', { name: 'Cycle time per card' })
    expect(region).toHaveAttribute('tabindex', '0')
    const row = within(region).getByRole('button', { name: 'Fix the login' }).closest('tr') as HTMLElement
    expect(within(row).getAllByRole('cell')[0].className).toContain('sticky')
    expect(row).toHaveTextContent('8.1d')
    expect(row).toHaveTextContent('Pat Lee')
    const unowned = within(region).getByRole('button', { name: 'Old archived job' }).closest('tr') as HTMLElement
    expect(unowned).toHaveTextContent('—')
    expect(unowned).toHaveTextContent('Yes')
  })

  it('shows every panel table with its keyboard path', async () => {
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-throughput')).getByRole('button', { name: 'table' }))
    const weeks = within(screen.getByRole('region', { name: 'Cards finished per week' }))
    expect(weeks.getByRole('button', { name: /2 cards the week of/ })).toBeInTheDocument()
    expect(weeks.getAllByText('—').length).toBeGreaterThan(0)

    await userEvent.click(within(screen.getByTestId('flow-cumulative')).getByRole('button', { name: 'table' }))
    const days = within(screen.getByRole('region', { name: 'Cards per column per day' }))
    expect(days.getByText('Doing (bottleneck)')).toBeInTheDocument()
    expect(days.queryByText('Deleted columns')).not.toBeInTheDocument()

    await userEvent.click(within(screen.getByTestId('flow-wip-age')).getByRole('button', { name: 'table' }))
    const aging = within(screen.getByRole('region', { name: 'Age per in-progress card' }))
    expect(aging.getByText('15.4d')).toBeInTheDocument()
    expect(aging.getByText('1.5d')).toBeInTheDocument()
    expect(aging.getByText('Pat Lee')).toBeInTheDocument()
  })

  it('an empty table says so', async () => {
    mockAll({ age: empty.age })
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-wip-age')).getByRole('button', { name: 'table' }))
    expect(within(screen.getByTestId('flow-wip-age')).getByText('No cards are in progress.', { selector: 'p.py-6' })).toBeInTheDocument()
  })
})

describe('the drill-down drawer', () => {
  beforeEach(() => mockAll())

  it('opens from an aging dot with Enter: age, P85, blocked time, dwell bars, transitions, Open card', async () => {
    movementsMock.mockResolvedValue([
      { id: 2, from_column_name: 'Doing', to_column_name: 'Review', movement_type: 'move', moved_at: '2026-06-02T00:00:00Z', moved_by: owner },
      { id: 1, from_column_name: '', to_column_name: 'Doing', movement_type: 'move', moved_at: '2026-06-01T00:00:00Z', moved_by: null },
    ] as never)
    const onOpenCard = vi.fn()
    await renderLoaded({ onOpenCard })
    const dot = within(screen.getByTestId('flow-wip-age')).getByRole('button', { name: /^Fix the login/ })
    fireEvent.keyDown(dot, { key: 'Enter' })
    const dialog = await screen.findByRole('dialog', { name: 'Fix the login' })
    const body = within(dialog)
    expect(body.getByText('15.4d')).toBeInTheDocument()
    expect(body.getByText('8.0d')).toBeInTheDocument()
    expect(body.getByText('1.5d')).toBeInTheDocument()
    expect(body.getByText('Blocked')).toBeInTheDocument()
    expect(body.getByText('Pat Lee')).toBeInTheDocument()
    expect(body.getByText('Deleted column')).toBeInTheDocument()
    expect(body.getByRole('region', { name: 'Time per column' })).toHaveTextContent('Doing')
    const transitions = await body.findByRole('list', { name: 'Transitions' })
    const rows = within(transitions).getAllByRole('listitem')
    // Oldest first, though the endpoint answers newest first.
    expect(rows[0]).toHaveTextContent('Created in Doing')
    expect(rows[1]).toHaveTextContent('Doing → Review')
    expect(rows[1]).toHaveTextContent('Pat Lee')
    expect(movementsMock).toHaveBeenCalledWith(9, cardA.id)
    await userEvent.click(body.getByRole('button', { name: 'Open card' }))
    expect(onOpenCard).toHaveBeenCalledWith(cardA.id)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens from a cycle-time point; an archived card has no Open card', async () => {
    await renderLoaded({ onOpenCard: vi.fn() })
    await userEvent.click(within(screen.getByTestId('flow-cycle-time')).getByRole('button', { name: /^Old archived job/ }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Old archived job' }))
    expect(dialog.getByText('2.5d')).toBeInTheDocument()
    expect(dialog.getByText('Unassigned')).toBeInTheDocument()
    expect(dialog.getByText('Yes, after finishing')).toBeInTheDocument()
    expect(dialog.getByText('This card is archived.')).toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'Open card' })).not.toBeInTheDocument()
    await dialog.findByText('No recorded transitions.')
  })

  it('lists a week of throughput, opens a card from it, and comes back', async () => {
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-throughput')).getByRole('button', { name: /^Week of/ }))
    const list = within(await screen.findByRole('dialog', { name: /^Finished the week of/ }))
    expect(list.getByText('Pat Lee')).toBeInTheDocument()
    await userEvent.click(list.getByRole('button', { name: /Fix the login/ }))
    const card = within(await screen.findByRole('dialog', { name: 'Fix the login' }))
    await card.findByText('No recorded transitions.')
    await userEvent.click(card.getByRole('button', { name: /Back/ }))
    expect(await screen.findByRole('dialog', { name: /^Finished the week of/ })).toBeInTheDocument()
  })

  it('opens the same list from the throughput table', async () => {
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-throughput')).getByRole('button', { name: 'table' }))
    await userEvent.click(screen.getByRole('button', { name: /2 cards the week of/ }))
    const list = within(await screen.findByRole('dialog', { name: /^Finished the week of/ }))
    expect(list.getByRole('button', { name: /Fix the login/ })).toBeInTheDocument()
  })

  it('fetches a cumulative-flow day with the current filters and groups its cards by column', async () => {
    dayMock.mockResolvedValue({
      definition: 'd',
      date: '2026-06-02',
      columns: [
        { column_uid: 'col-doing', card_uids: [cardA.uid] },
        { column_uid: 'col-done', card_uids: [] },
        { column_uid: null, card_uids: [cardB.uid] },
      ],
      cards: [cardA, cardB],
    })
    await renderLoaded()
    const panel = within(screen.getByTestId('flow-cumulative'))
    await userEvent.click(panel.getAllByRole('button', { name: /5 cards$/ })[0])
    const dialog = within(await screen.findByRole('dialog', { name: /^Cards on/ }))
    await dialog.findByRole('region', { name: 'Doing' })
    expect(dayMock).toHaveBeenCalledWith(9, { days: 90, swimlaneId: null, labelId: null }, '2026-06-02')
    expect(dialog.getByRole('region', { name: 'Deleted columns' })).toHaveTextContent('Old archived job')
    expect(dialog.queryByRole('region', { name: 'Done' })).not.toBeInTheDocument()
  })

  it('does not reopen the drawer when a closed day list answers late', async () => {
    let answer: (value: Awaited<ReturnType<typeof getFlowCumulativeDay>>) => void = () => {}
    dayMock.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-cumulative')).getByRole('button', { name: /1 card$/ }))
    await screen.findByRole('dialog', { name: /^Cards on/ })
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    answer({ definition: 'd', date: '2026-06-01', columns: [], cards: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('does not reopen the drawer when a closed day list fails late', async () => {
    let fail: (reason: Error) => void = () => {}
    dayMock.mockReturnValueOnce(new Promise((_, reject) => { fail = reject }))
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-cumulative')).getByRole('button', { name: /1 card$/ }))
    await screen.findByRole('dialog', { name: /^Cards on/ })
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    fail(new Error('late'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('reports a failed day list and retries it', async () => {
    dayMock.mockRejectedValueOnce(new Error('no'))
    dayMock.mockResolvedValueOnce({ definition: 'd', date: '2026-06-01', columns: [], cards: [] })
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-cumulative')).getByRole('button', { name: /1 card$/ }))
    const dialog = within(await screen.findByRole('dialog', { name: /^Cards on/ }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('Failed to load these cards.')
    await userEvent.click(dialog.getByRole('button', { name: 'Retry' }))
    expect(await dialog.findByText('No cards.')).toBeInTheDocument()
  })

  it('reports failed transitions and retries them', async () => {
    movementsMock.mockRejectedValueOnce(new Error('no'))
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-wip-age')).getByRole('button', { name: /^Fix the login/ }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Fix the login' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('Failed to load transitions.')
    await userEvent.click(dialog.getByRole('button', { name: 'Retry' }))
    expect(await dialog.findByText('No recorded transitions.')).toBeInTheDocument()
  })

  it('closes with Escape and the Close button, and is a modal dialog', async () => {
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-wip-age')).getByRole('button', { name: /^Fix the login/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Fix the login' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    await within(dialog).findByText('No recorded transitions.')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await userEvent.click(within(screen.getByTestId('flow-wip-age')).getByRole('button', { name: /^Fix the login/ }))
    await within(await screen.findByRole('dialog')).findByText('No recorded transitions.')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('labels transitions for archive, restore, swimlane moves and deleted columns', async () => {
    movementsMock.mockResolvedValue([
      { id: 4, from_column_name: 'Doing', to_column_name: '', movement_type: 'move', moved_at: '2026-06-04T00:00:00Z', moved_by: null },
      { id: 3, from_column_name: 'Doing', to_column_name: 'Doing', movement_type: 'unarchived', moved_at: '2026-06-03T00:00:00Z', moved_by: null },
      { id: 2, from_column_name: 'Doing', to_column_name: 'Doing', movement_type: 'archived', moved_at: '2026-06-02T00:00:00Z', moved_by: null },
      { id: 1, from_column_name: 'Doing', to_column_name: 'Doing', movement_type: 'move', moved_at: '2026-06-01T00:00:00Z', moved_by: null },
    ] as never)
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-wip-age')).getByRole('button', { name: /^Fix the login/ }))
    const list = await within(await screen.findByRole('dialog')).findByRole('list', { name: 'Transitions' })
    const rows = within(list).getAllByRole('listitem').map((row) => row.textContent)
    expect(rows[0]).toContain('Changed swimlane in Doing')
    expect(rows[1]).toContain('Archived in Doing')
    expect(rows[2]).toContain('Restored in Doing')
    expect(rows[3]).toContain('Doing → a deleted column')
  })
})

describe('flow summaries', () => {
  it('cycle time says what the percentiles allow', () => {
    expect(cycleTimeSummary(empty.cycle)).toBe('No card with a measurable cycle time finished in this range.')
    expect(cycleTimeSummary({ ...cycle, sample_size: 5, percentiles: { p50: 2, p85: null, p95: null } }))
      .toBe('Half of 5 cards finished within 2.0d.')
    expect(cycleTimeSummary({ ...cycle, sample_size: 1, percentiles: { p50: null, p85: null, p95: null } }))
      .toBe('1 card finished in this range.')
  })

  it('throughput handles no periods, no completions, and a null median', () => {
    expect(throughputSummary({ ...throughput, samples: [] })).toBe('No whole week in this range yet.')
    expect(throughputSummary({ ...throughput, total: 0 })).toBe('No cards finished in the whole weeks of this range.')
    expect(throughputSummary({ ...throughput, median: null, samples: [{ start: 'x', count: 1, card_uids: [], started: 0 }] }))
      .toBe('1 card finished in the last whole week.')
    expect(throughputSummary(throughput)).toBe('0 cards finished in the last whole week, against a median of 1.')
  })

  it('cumulative flow names the bottleneck or says none grew', () => {
    expect(cumulativeFlowSummary(cumulative)).toBe('Doing grew the most in this range.')
    expect(cumulativeFlowSummary({ ...cumulative, bottleneck_column_uid: null })).toBe('No column that is not done grew in this range.')
    expect(cumulativeFlowSummary({ ...cumulative, days: [] })).toBe('No whole day in this range yet.')
  })

  it('aging counts cards past P85 and copes with no zones', () => {
    expect(wipAgeSummary({ ...empty.age, columns: empty.age.columns.map((c) => ({ ...c, wip_count: 0 })) })).toBe('No cards are in progress.')
    // Live WIP counts unstarted cards, so no ages must not claim nothing is in progress (#2293).
    expect(wipAgeSummary({ ...empty.age, columns: [{ column_uid: 'c', column_name: 'C', wip_count: 9 }] })).toBe('No card in progress has an age yet.')
    expect(wipAgeSummary(age)).toBe('1 of 1 card in progress is past the 85th percentile.')
    expect(wipAgeSummary({ ...age, cycle_time_percentiles: { p50: null, p85: null, p95: null } })).toBe('1 card in progress.')
  })

  it('notes name no number and are absent when not needed', () => {
    expect(sparseNote({ p50: 1, p85: 2, p95: 3 })).toBeNull()
    expect(sparseNote({ p50: null, p85: null, p95: null })).toBe('Too few cards to draw percentile lines.')
    expect(excludedNote(0)).toBeNull()
    expect(excludedNote(1)).toBe('1 card left out for missing or broken history.')
  })

  it('encodes each percentile line differently, and P85 heaviest', () => {
    const lines = percentileLines({ p50: 4, p85: 8, p95: 12 }, (days) => days * 10)
    expect(lines.map((line) => line.y)).toEqual([40, 80, 120])
    expect(lines[1].strokeWidth).toBeGreaterThan(lines[0].strokeWidth ?? 1.5)
    expect(lines[1].dash).toBeUndefined()
    expect(lines[0].dash).not.toBe(lines[2].dash)
    expect(percentileLines({ p50: 4, p85: null, p95: null }, (days) => days)).toHaveLength(1)
  })

  it('names a mark by its zone', () => {
    const sample = age.samples[0]
    expect(ageMarkLabel({ ...sample, is_blocked: false, value_days: 9 }, 'T', age.cycle_time_percentiles))
      .toBe('T, 9.0 days in progress, beyond 85th percentile')
    expect(ageMarkLabel({ ...sample, is_blocked: false, value_days: 1 }, 'T', age.cycle_time_percentiles))
      .toBe('T, 1.0 days in progress')
  })
})

describe('the bottleneck panel (#2261)', () => {
  const grown: FlowCumulativeFlow = {
    ...cumulative,
    columns: cumulative.columns.map((c) => c.column_uid === 'col-doing'
      ? { ...c, start_count: 2, end_count: 5, entered_per_week: 3.5, left_per_week: 2 }
      : c),
  }

  it('names the column and states its numbers, and its buttons open its cards and the board', async () => {
    mockAll({ cumulative: grown })
    const onGoToBoard = vi.fn()
    await renderLoaded({ columns: [{ uid: 'col-doing', wip_limit: 3 }], onGoToBoard })
    const panel = within(screen.getByTestId('analytics-bottleneck'))
    expect(panel.getByRole('heading', { name: 'Doing' })).toBeInTheDocument()
    expect(panel.getByText(
      'Cards wait 2.1 days here, about half of the whole cycle. The queue grew from 2 to 5 cards against a limit of 3, '
      + 'because 3.5 cards arrive each week and 2 leave.',
    )).toBeInTheDocument()
    expect(screen.getByTestId('analytics-bottleneck').className).toContain('border-warning')
    expect(screen.getByTestId('analytics-bottleneck').className).toContain('ring-1')
    expect(screen.getByTestId('analytics-bottleneck').className).toContain('ring-inset')
    expect(screen.getByTestId('analytics-bottleneck').className).toContain('ring-warning')
    const seeButton = panel.getByRole('button', { name: 'See the 4 cards' })
    await userEvent.click(seeButton)
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByRole('heading', { name: 'Doing' })).toBeInTheDocument()
    expect(within(drawer).getByText('4 cards in this column now, limit 3')).toBeInTheDocument()
    expect(within(drawer).getByText('3 cards not listed: no age yet (not started, or missing history).')).toBeInTheDocument()
    expect(within(drawer).getByText('Fix the login')).toBeInTheDocument()
    await userEvent.click(within(drawer).getByRole('button', { name: /close/i }))
    await waitFor(() => expect(seeButton).toHaveFocus())
    await userEvent.click(panel.getByRole('button', { name: 'Open on board' }))
    expect(onGoToBoard).toHaveBeenCalled()
  })

  it('says "Too early to say" when no column is named and the 85th percentile is withheld', async () => {
    mockAll({
      cumulative: { ...cumulative, bottleneck_column_uid: null },
      cycle: { ...cycle, sample_size: 4, percentiles: { p50: null, p85: null, p95: null } },
    })
    await renderLoaded()
    const panel = within(screen.getByTestId('analytics-bottleneck'))
    expect(panel.getByRole('heading', { name: 'Too early to say' })).toBeInTheDocument()
    expect(panel.getByText(
      "4 cards have finished and no column after the first has a growing queue yet. A bottleneck is named when one does.",
    )).toBeInTheDocument()
    expect(screen.getByTestId('analytics-bottleneck').className).not.toContain('border-warning')
    expect(screen.getByTestId('analytics-bottleneck').className).not.toContain('ring-warning')
  })

  it('says "No bottleneck" with the period when there is enough history', async () => {
    mockAll({ cumulative: { ...cumulative, bottleneck_column_uid: null } })
    await renderLoaded()
    const panel = within(screen.getByTestId('analytics-bottleneck'))
    expect(panel.getByRole('heading', { name: 'No bottleneck' })).toBeInTheDocument()
    expect(panel.getByText("No column after the first grew its queue between Jun 1 and Jun 2. The first column is where new work arrives, so it is never named.")).toBeInTheDocument()
  })

  it('leaves out what the server did not return', () => {
    const bare: FlowCumulativeFlow = {
      ...cumulative,
      columns: cumulative.columns.map((c) => ({ ...c, start_count: 1, end_count: 4, entered_per_week: null, left_per_week: null })),
    }
    expect(bottleneckSentence('col-doing', { cumulative: bare, dwell: undefined, cycle, columns: [] }))
      .toBe('The median wait here is not available yet. The queue grew from 1 to 4 cards.')
    const noCycleMedian = { ...cycle, percentiles: { p50: null, p85: null, p95: null } }
    expect(bottleneckSentence('col-doing', { cumulative: bare, dwell, cycle: noCycleMedian, columns: [] }))
      .toBe('Cards wait 2.1 days here. The queue grew from 1 to 4 cards.')
  })
})

describe('the headline tiles (#2261)', () => {
  const tile = (label: string) => screen.getByRole('heading', { name: label, level: 3 }).closest('div')!.parentElement as HTMLElement

  it('state each number with its supporting sentence', async () => {
    mockAll()
    await renderLoaded({ columns: [{ uid: 'col-doing', wip_limit: 0 }] })
    expect(tile('Cycle time')).toHaveTextContent('4.0days')
    // Hierarchy (#2311): a bold primary-ink number, a small unit, an uppercase label, and a danger over-limit.
    const cycle = tile('Cycle time')
    expect(within(cycle).getByRole('heading', { name: 'Cycle time' }).className).toContain('uppercase')
    expect(within(cycle).getByRole('heading', { name: 'Cycle time' }).className).toContain('font-semibold')
    const number = within(cycle).getByText('4.0')
    expect(number.className).toContain('text-3xl')
    expect(number.className).toContain('font-bold')
    expect(number.className).toContain('text-fg')
    expect(number.className).toContain('tabular-nums')
    expect(within(cycle).getByText('days').className).toContain('text-sm')
    expect(tile('Cycle time')).toHaveTextContent('Half finish within this. 85% within 8.1 days. Based on 7 cards.')
    expect(tile('Throughput')).toHaveTextContent('1/ week')
    expect(tile('Throughput')).toHaveTextContent('Median of 2 weeks. 2 cards finished.')
    expect(tile('Work in progress')).toHaveTextContent('0 columns over their limit. 1 card past 8 days.')
    expect(tile('Blocked time')).toHaveTextContent('3.5days')
    expect(tile('Blocked time')).toHaveTextContent('2 blocks. 1 card blocked right now.')
  })

  it('counts the live WIP, unstarted cards included, and falls back to the aged cards (#2287)', async () => {
    // Nothing has an age yet, but nine cards sit in the columns now.
    mockAll({ age: { ...age, sample_size: 0, samples: [], cards: [], columns: [
      { column_uid: 'col-doing', column_name: 'Doing', wip_count: 6 }, { column_uid: 'col-review', column_name: 'Review', wip_count: 3 },
    ] } })
    await renderLoaded({ columns: [{ uid: 'col-doing', wip_limit: 0 }] })
    expect(tile('Work in progress')).toHaveTextContent('9cards')
    cleanup()
    // A server older than #2287 sends no wip_count: the aged cards are the number.
    mockAll({ age: { ...age, sample_size: 2, columns: [{ column_uid: 'col-doing', column_name: 'Doing', sample_size: 2, percentiles: { p50: 2.1, p85: 5, p95: null } }] as never } })
    await renderLoaded({ columns: [{ uid: 'col-doing', wip_limit: 0 }] })
    expect(tile('Work in progress')).toHaveTextContent('2cards')
  })

  it('shows the same finished count as the Done box when the range holds partial weeks (#2288)', async () => {
    mockAll({ throughput: { ...throughput, median: 1, total: 2, completed_in_range: 5 } })
    await renderLoaded({ columns: [{ uid: 'col-doing', wip_limit: 0 }] })
    expect(tile('Throughput')).toHaveTextContent('Median of 2 weeks. 5 cards finished.')
    expect(screen.getByTestId('flow-done-box')).toHaveTextContent('5')
    cleanup()
    mockAll({ throughput: { ...throughput, median: null, total: 2, completed_in_range: 5 } })
    await renderLoaded({ columns: [{ uid: 'col-doing', wip_limit: 0 }] })
    expect(tile('Throughput')).toHaveTextContent('5cards so far')
  })

  it('withhold what the server withheld and say when it appears', async () => {
    mockAll({
      cycle: { ...cycle, sample_size: 3, percentiles: { p50: null, p85: null, p95: null } },
      throughput: { ...throughput, median: null },
      age: { ...age, cycle_time_percentiles: { p50: null, p85: null, p95: null } },
    })
    await renderLoaded({ columns: [{ uid: 'col-doing', wip_limit: 0 }] })
    expect(tile('Cycle time')).toHaveTextContent('Withheld')
    expect(tile('Cycle time')).toHaveTextContent('Median appears at 5. 3 so far.')
    expect(tile('Throughput')).toHaveTextContent('2cards so far')
    expect(tile('Throughput')).toHaveTextContent('Too few whole weeks for a weekly median. 2 so far.')
    expect(tile('Work in progress')).toHaveTextContent('0 columns over their limit.')
    expect(tile('Work in progress')).toHaveTextContent('The 85th-percentile age appears at 7 finished cards. 3 so far.')
    expect(tile('Work in progress')).not.toHaveTextContent('past')
  })

  it('mark a median without an 85th percentile provisional, and drop the limit clause under a filter', async () => {
    mockAll({ cycle: { ...cycle, sample_size: 6, percentiles: { p50: 4, p85: null, p95: null } } })
    await renderLoaded({ columns: [{ uid: 'col-doing', wip_limit: 0 }] })
    expect(tile('Cycle time')).toHaveTextContent('Provisional')
    expect(tile('Cycle time')).toHaveTextContent('Median of 6 cards. The 85% figure appears at 7.')
    await userEvent.click(screen.getByRole('button', { name: /^Swimlane/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Customer A' }))
    await waitFor(() => expect(cycleMock).toHaveBeenLastCalledWith(9, { days: 90, swimlaneId: 3, labelId: null }))
    await waitFor(() => expect(tile('Work in progress')).not.toHaveTextContent('limit'))
    expect(tile('Work in progress')).toHaveTextContent('1 card past 8 days.')
  })

  it('drops the limit from the bottleneck sentence under a filter', async () => {
    const grown: FlowCumulativeFlow = {
      ...cumulative,
      columns: cumulative.columns.map((c) => c.column_uid === 'col-doing'
        ? { ...c, start_count: 2, end_count: 5, entered_per_week: 3.5, left_per_week: 2 }
        : c),
    }
    mockAll({ cumulative: grown })
    await renderLoaded({ columns: [{ uid: 'col-doing', wip_limit: 3 }] })
    expect(screen.getByTestId('analytics-bottleneck')).toHaveTextContent('against a limit of 3')
    await userEvent.click(screen.getByRole('button', { name: /^Swimlane/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Customer A' }))
    await waitFor(() => expect(screen.getByTestId('analytics-bottleneck')).not.toHaveTextContent('limit'))
    expect(screen.getByTestId('analytics-bottleneck')).toHaveTextContent('The queue grew from 2 to 5 cards, because')
  })

  it('says why when the period has no days, and "Every card not done yet." when a filter hides the rest', async () => {
    mockAll({
      cumulative: { ...cumulative, bottleneck_column_uid: null, days: [] },
      age: { ...age, cycle_time_percentiles: { p50: null, p85: null, p95: null } },
    })
    await renderLoaded({ columns: [{ uid: 'col-doing', wip_limit: 0 }] })
    expect(screen.getByTestId('analytics-bottleneck')).toHaveTextContent("No column after the first grew its queue in this period. The first column is where new work arrives, so it is never named.")
    await userEvent.click(screen.getByRole('button', { name: /^Swimlane/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Customer A' }))
    await waitFor(() => expect(tile('Work in progress')).not.toHaveTextContent('limit'))
    expect(tile('Work in progress')).not.toHaveTextContent('limit')
    expect(tile('Work in progress')).toHaveTextContent('The 85th-percentile age appears at 7 finished cards. 7 so far.')
  })

  it('says "Every card not done yet." under a filter when the 85th percentile is shown', async () => {
    mockAll()
    await renderLoaded({ columns: [{ uid: 'col-doing', wip_limit: 0 }] })
    await userEvent.click(screen.getByRole('button', { name: /^Swimlane/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Customer A' }))
    await waitFor(() => expect(tile('Work in progress')).not.toHaveTextContent('limit'))
    expect(tile('Work in progress')).not.toHaveTextContent('The 85th-percentile age appears')
  })

  it('shows a per-tile and a bottleneck error when one endpoint fails, and the other panels still render', async () => {
    mockAll()
    cumulativeMock.mockRejectedValue(new Error('no'))
    blockedMock.mockRejectedValue(new Error('no'))
    await renderLoaded()
    expect(screen.getByTestId('analytics-bottleneck')).toHaveTextContent('Could not load the bottleneck.')
    expect(tile('Blocked time')).toHaveTextContent('Could not load.')
    expect(tile('Cycle time')).toHaveTextContent('4.0days')
    expect(screen.getByTestId('flow-wip-age')).toBeInTheDocument()
  })
})

describe('period labels during a refetch (#2261)', () => {
  it('keep naming the period of the numbers on screen until the new answers arrive', async () => {
    mockAll()
    // Three even reasons keep the fixed subtitle, which is the one that names the period (#2282).
    const even: FlowBlocked = {
      ...blocked,
      reasons: [1, 2, 3].map((n) => ({ reason: `Reason ${n}`, days: 3.5 / 3, blocks: 1 })),
      reason_count: 3,
    }
    blockedMock.mockResolvedValue(even)
    await renderLoaded()
    expect(screen.getByText('Block reasons over the last 90 days, longest first.')).toBeInTheDocument()
    let release: (value: FlowBlocked) => void = () => {}
    blockedMock.mockReturnValue(new Promise<FlowBlocked>((resolve) => { release = resolve }))
    await userEvent.click(screen.getByRole('button', { name: /^Date range/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Last 30 days' }))
    await waitFor(() => expect(blockedMock).toHaveBeenLastCalledWith(9, { days: 30, swimlaneId: null, labelId: null }))
    expect(screen.getByText('Block reasons over the last 90 days, longest first.')).toBeInTheDocument()
    expect(screen.queryByText('Block reasons over the last 30 days, longest first.')).not.toBeInTheDocument()
    release(even)
    expect(await screen.findByText('Block reasons over the last 30 days, longest first.')).toBeInTheDocument()
  })
})

describe('board-wide WIP-limit wording during a refetch (#2264)', () => {
  it('follows the filters the dimmed data was fetched for, not the live selection', async () => {
    mockAll()
    await renderLoaded({ columns: [{ uid: 'col-doing', wip_limit: 0 }] })
    expect(screen.getByText(/columns over their limit/)).toBeInTheDocument()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    ageMock.mockImplementation(async () => { await gate; return age })
    await userEvent.click(screen.getByRole('button', { name: /^Swimlane/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Customer A' }))
    await waitFor(() => expect(ageMock).toHaveBeenLastCalledWith(9, { days: 90, swimlaneId: 3, labelId: null }))
    // Still the unfiltered answers on screen, so the board-wide clause must stay.
    expect(screen.getByText(/columns over their limit/)).toBeInTheDocument()
    release()
    await waitFor(() => expect(screen.queryByText(/columns over their limit/)).not.toBeInTheDocument())
  })
})

describe('one filter selection for the whole Overview (#2261)', () => {
  it('sends every request with the same filters and closes an open drawer on a change', async () => {
    mockAll()
    await renderLoaded()
    await userEvent.click(within(screen.getByTestId('flow-throughput')).getByRole('button', { name: /^Week of/ }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^Label/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Urgent' }))
    const filters = { days: 90, swimlaneId: null, labelId: 4 }
    await waitFor(() => expect(attentionMock).toHaveBeenLastCalledWith(9, filters))
    for (const mock of [cycleMock, throughputMock, cumulativeMock, ageMock, dwellMock, blockedMock]) {
      expect(mock).toHaveBeenLastCalledWith(9, filters)
    }
    expect(analyticsMock).toHaveBeenLastCalledWith(9, 90, undefined, { swimlaneId: null, labelId: 4 })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('share of the cycle and limits (#2261)', () => {
  it('divides the column median by the cycle median, and withholds it on a null or zero', () => {
    expect(shareOfCycle(6.2, 11)).toBeCloseTo(0.5636)
    expect(shareOfCycle(null, 11)).toBeNull()
    expect(shareOfCycle(6.2, null)).toBeNull()
    expect(shareOfCycle(6.2, 0)).toBeNull()
  })

  it('phrases the share in words', () => {
    expect(shareOfCyclePhrase(0.56)).toBe('about half of the whole cycle')
    expect(shareOfCyclePhrase(1.4)).toBe('nearly all of the whole cycle')
    expect(shareOfCyclePhrase(0.7)).toBe('most of the whole cycle')
    expect(shareOfCyclePhrase(0.33)).toBe('about a third of the whole cycle')
    expect(shareOfCyclePhrase(0.2)).toBe('about a quarter of the whole cycle')
    expect(shareOfCyclePhrase(0.05)).toBe('a small part of the whole cycle')
  })

  it('counts unstarted cards against the limit (#2287)', async () => {
    // A column of five cards that never moved: no aging samples, but over a limit of 3.
    mockAll({ age: { ...age, sample_size: 0, samples: [], columns: [{ column_uid: 'col-doing', column_name: 'Doing', wip_count: 5 }] } })
    await renderLoaded({ columns: [{ uid: 'col-doing', wip_limit: 3 }] })
    const wipTile = screen.getByRole('heading', { name: 'Work in progress', level: 3 }).closest('div')!.parentElement as HTMLElement
    expect(wipTile).toHaveTextContent('1 column over its limit.')
    expect(columnsOverLimit({ columns: [{ column_uid: 'col-doing', column_name: 'Doing', wip_count: 5 }], samples: [] }, [
      { uid: 'col-doing', wip_limit: 3 },
    ])).toBe(1)
  })

  it('counts columns over their limit from the aging samples when the server sends no wip_count', () => {
    const samples = [age.samples[0], { ...age.samples[0], card_uid: 'x' }, { ...age.samples[0], column_uid: 'col-review' }]
    expect(columnsOverLimit({ columns: [], samples }, [
      { uid: 'col-doing', wip_limit: 1 }, { uid: 'col-review', wip_limit: 1 }, { uid: 'col-qa', wip_limit: null },
    ])).toBe(1)
  })

  it('treats a limit of 0 or null as no limit and counts a real limit', () => {
    const samples = [age.samples[0], { ...age.samples[0], card_uid: 'x' }]
    expect(columnsOverLimit({ columns: [], samples }, [{ uid: 'col-doing', wip_limit: 0 }])).toBe(0)
    expect(columnsOverLimit({ columns: [], samples }, [{ uid: 'col-doing', wip_limit: null }])).toBe(0)
    expect(columnsOverLimit({ columns: [], samples }, [{ uid: 'col-doing', wip_limit: 1 }])).toBe(1)
  })

  it('leaves "against a limit" out of the bottleneck sentence for a limit of 0', () => {
    const grown: FlowCumulativeFlow = {
      ...cumulative,
      columns: cumulative.columns.map((c) => ({ ...c, start_count: 1, end_count: 4, entered_per_week: null, left_per_week: null })),
    }
    const withLimit = (wip_limit: number) => bottleneckSentence('col-doing', { cumulative: grown, dwell, cycle, columns: [{ uid: 'col-doing', wip_limit }] })
    expect(withLimit(0)).not.toContain('against a limit')
    expect(withLimit(3)).toContain('against a limit of 3')
  })

  it('names the sample sizes at which percentiles appear', () => {
    expect(PERCENTILE_APPEARS_AT).toEqual({ p50: 5, p85: 7, p95: 20 })
  })
})

describe('the throughput started marker (#2264)', () => {
  it('draws a hollow diamond per week, a legend, and a Started table column', async () => {
    mockAll({ throughput: { ...throughput, samples: [{ ...throughput.samples[0], started: 5 }, throughput.samples[1]] } })
    await renderLoaded()
    const panel = screen.getByTestId('flow-throughput')
    const marks = [...within(panel).getByRole('img').querySelectorAll('polygon[data-started]')]
    expect(marks).toHaveLength(2)
    expect(marks[0].getAttribute('fill')).toBe('none')
    expect(within(panel).getByTestId('throughput-legend')).toHaveTextContent('FinishedStarted')
    await userEvent.click(within(panel).getByRole('button', { name: 'table' }))
    const table = within(screen.getByRole('region', { name: 'Cards finished per week' }))
    expect(table.getByRole('columnheader', { name: 'Started' })).toBeInTheDocument()
    expect(table.getByText('5')).toBeInTheDocument()
  })
})

describe('the throughput started marker placement (#2264)', () => {
  it('keeps the last diamond inside the plot, clear of the reference-label column', async () => {
    mockAll({ throughput: { ...throughput, samples: [{ ...throughput.samples[0], started: 5 }, { ...throughput.samples[1], started: 5 }] } })
    await renderLoaded()
    const image = within(screen.getByTestId('flow-throughput')).getByRole('img')
    const width = Number(image.getAttribute('width'))
    const xs = [...image.querySelectorAll('polygon[data-started]')].flatMap((mark) =>
      (mark.getAttribute('points') ?? '').split(' ').map((point) => Number(point.split(',')[0])))
    expect(Math.max(...xs)).toBeLessThanOrEqual(width - REFERENCE_LABEL_MARGIN)
  })
})

describe('the no-history example (#2264)', () => {
  it('draws the chart icon and an example bar with a hatched bottleneck segment', async () => {
    mockAll(empty)
    render(<FlowMetricsDashboard {...props} />)
    await screen.findByRole('heading', { name: 'Nothing has moved yet' })
    expect(screen.getByTestId('flow-empty-icon')).toHaveAttribute('aria-hidden', 'true')
    const hatched = screen.getByTestId('flow-empty-example').querySelectorAll('[data-hatched="true"]')
    expect(hatched).toHaveLength(1)
    expect((hatched[0] as HTMLElement).style.background).toBe(HATCH_CSS)
  })
})

describe('named chart colors (#2264)', () => {
  it('colors aging marks neutral to P50, warning past it, danger past P85', async () => {
    const at = (uid: string, value: number) => ({ ...age.samples[0], card_uid: uid, value_days: value, is_blocked: false })
    mockAll({
      age: {
        ...age, sample_size: 3, cards: [cardA, cardB],
        samples: [at('x1', 2), at('x2', 6), at('x3', 9)],
      },
    })
    await renderLoaded()
    const image = within(screen.getByTestId('flow-wip-age')).getByRole('img')
    const colors = [...image.querySelectorAll('[data-age-color]')].map((g) => g.getAttribute('data-age-color'))
    expect(colors).toEqual(['neutral', 'warning', 'danger'])
    expect(image.querySelector('[data-age-color="warning"] circle')?.getAttribute('fill')).toContain('--warning')
    expect(image.querySelector('[data-age-color="danger"] circle[r="8"]')?.getAttribute('stroke')).toContain('--danger')
    expect(screen.getByTestId('flow-wip-age')).toHaveTextContent('Orange marks')
  })

  it('names an aging color in the note only when a mark of that color is on screen', async () => {
    const at = (uid: string, value: number) => ({ ...age.samples[0], card_uid: uid, value_days: value, is_blocked: false })
    const note = async (values: number[]) => {
      mockAll({ age: { ...age, sample_size: values.length, cards: [cardA, cardB], samples: values.map((v, i) => at(`n${i}`, v)) } })
      await renderLoaded()
      return screen.getByTestId('flow-wip-age')
    }
    // Only orange (past P50 = 4, within P85 = 8): no red named.
    let panel = await note([2, 6])
    expect(panel).toHaveTextContent('Orange marks are older than half of finished cards.')
    expect(panel).not.toHaveTextContent('red marks')
    cleanup()
    // Only red (past P85): no orange named.
    panel = await note([2, 9])
    expect(panel).toHaveTextContent('Red marks are past the 85th percentile.')
    expect(panel).not.toHaveTextContent('Orange marks')
    cleanup()
    // Neither: no color note.
    panel = await note([2, 3])
    expect(panel).not.toHaveTextContent(/Orange marks|Red marks|red marks/)
    cleanup()
    // Both.
    panel = await note([6, 9])
    expect(panel).toHaveTextContent('Orange marks are older than half of finished cards; red marks are past the 85th percentile.')
  })

  it('keys the aging tiers in the chart legend only for tiers with a mark on screen (#2284)', async () => {
    const at = (uid: string, value: number) => ({ ...age.samples[0], card_uid: uid, value_days: value, is_blocked: false })
    const tiers = async (values: number[]) => {
      mockAll({ age: { ...age, sample_size: values.length, cards: [cardA, cardB], samples: values.map((v, i) => at(`k${i}`, v)) } })
      await renderLoaded()
      const legend = within(screen.getByTestId('flow-wip-age')).queryByTestId('wip-age-legend')
      return legend ? [...legend.querySelectorAll('[data-legend-tier]')].map((li) => li.getAttribute('data-legend-tier')) : []
    }
    expect(await tiers([2, 6, 9])).toEqual(['neutral', 'warning', 'danger'])
    const legend = within(screen.getByTestId('flow-wip-age')).getByTestId('wip-age-legend')
    expect(legend).toHaveTextContent('Under the 50th percentile')
    expect(legend).toHaveTextContent('Past the 50th percentile')
    expect(legend).toHaveTextContent('Past the 85th percentile')
    // The red tier swatch carries the ring, the shape the chart draws for it.
    expect(legend.querySelector('[data-legend-tier="danger"] circle[r="8"]')).not.toBeNull()
    expect(legend.querySelector('[data-legend-tier="warning"] circle[r="8"]')).toBeNull()
    cleanup()
    expect(await tiers([2, 3])).toEqual(['neutral'])
    cleanup()
    expect(await tiers([6])).toEqual(['warning'])
    cleanup()
    expect(await tiers([])).toEqual([])
    expect(within(screen.getByTestId('flow-wip-age')).queryByTestId('wip-age-legend')).toBeNull()
  })

  it('keys the blocked square only when a blocked card is drawn (#2284)', async () => {
    const at = (uid: string, blocked: boolean) => ({ ...age.samples[0], card_uid: uid, value_days: 2, is_blocked: blocked })
    mockAll({ age: { ...age, sample_size: 2, cards: [cardA, cardB], samples: [at('b1', true), at('b2', false)] } })
    await renderLoaded()
    expect(within(screen.getByTestId('flow-wip-age')).getByTestId('wip-age-legend').querySelector('[data-legend-blocked]')).toHaveTextContent('Blocked card')
    cleanup()
    mockAll({ age: { ...age, sample_size: 1, cards: [cardA, cardB], samples: [at('b3', false)] } })
    await renderLoaded()
    expect(within(screen.getByTestId('flow-wip-age')).getByTestId('wip-age-legend').querySelector('[data-legend-blocked]')).toBeNull()
  })

  it('draws no aging tier key under a breakdown, where marks take group colors (#2284)', () => {
    const { container } = render(
      <WipAgeChart
        data={{ ...age, grouping: { by: 'swimlane', field_id: null, excluded: 0, groups: [{ key: 'a', name: 'A', sample_size: 1 }] } } as unknown as FlowWipAge}
        cards={new Map()}
        labelledBy="x"
        onSelect={() => {}}
      />,
    )
    expect(container.querySelector('[data-legend-tier]')).toBeNull()
  })

  it('keys the blocked square, with no tier items, under a breakdown (#2284)', () => {
    const { container } = render(
      <WipAgeChart
        data={{
          ...age,
          samples: [{ ...age.samples[0], is_blocked: true }],
          grouping: { by: 'swimlane', field_id: null, excluded: 0, groups: [{ key: 'a', name: 'A', sample_size: 1 }] },
        } as unknown as FlowWipAge}
        cards={new Map()}
        labelledBy="x"
        onSelect={() => {}}
      />,
    )
    expect(container.querySelector('[data-legend-blocked]')).toHaveTextContent('Blocked card')
    expect(container.querySelector('[data-legend-tier]')).toBeNull()
  })

  it('adds no tier for a withheld percentile', () => {
    const sample = age.samples[0]
    expect(ageMarkColor(sample, { p50: null, p85: null, p95: null })).toBe('neutral')
    expect(ageMarkColor(sample, { p50: 4, p85: null, p95: null })).toBe('warning')
  })
})

describe('the page states (#2264)', () => {
  it('names every active filter, removes one chip at a time and offers a wider period', async () => {
    mockAll()
    render(<FlowMetricsDashboard {...props} />)
    await screen.findByTestId('flow-cycle-time')
    mockAll(empty)
    await userEvent.click(screen.getByRole('button', { name: /^Swimlane/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Customer A' }))
    const state = await screen.findByTestId('flow-no-match')
    expect(state).toHaveTextContent('No card in the Customer A swimlane moved in the last 90 days.')
    await userEvent.click(within(state).getByRole('button', { name: 'Remove filter: Customer A' }))
    expect(await screen.findByRole('heading', { name: 'Nothing has moved yet' })).toBeInTheDocument()
  })

  it('shows Show last 90 days only for a shorter period, and Clear all filters resets everything', async () => {
    mockAll()
    render(<FlowMetricsDashboard {...props} />)
    await screen.findByTestId('flow-cycle-time')
    expect(screen.queryByRole('button', { name: 'Show last 90 days' })).not.toBeInTheDocument()
    mockAll(empty)
    await userEvent.click(screen.getByRole('button', { name: /^Date range/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Last 30 days' }))
    const state = await screen.findByTestId('flow-no-match')
    expect(within(state).getByRole('button', { name: 'Remove filter: Last 30 days' })).toBeInTheDocument()
    // states.png: the period shortcut is the primary button, above the secondary Clear all filters.
    const show = within(state).getByRole('button', { name: 'Show last 90 days' })
    const clear = within(state).getByRole('button', { name: 'Clear all filters' })
    expect(show).toHaveClass('bg-button-primary')
    expect(clear).toHaveClass('border-line-strong')
    expect(clear).not.toHaveClass('bg-button-primary')
    expect(show.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await userEvent.click(show)
    expect(await screen.findByRole('heading', { name: 'Nothing has moved yet' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^Date range/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Last 30 days' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Clear all filters' }))
    expect(await screen.findByRole('heading', { name: 'Nothing has moved yet' })).toBeInTheDocument()
  })

  it('keeps the no-match state, dimmed, while a refetch after Clear all filters is pending (#2264)', async () => {
    mockAll()
    render(<FlowMetricsDashboard {...props} />)
    await screen.findByTestId('flow-cycle-time')
    mockAll(empty)
    await userEvent.click(screen.getByRole('button', { name: /^Swimlane/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Customer A' }))
    await screen.findByTestId('flow-no-match')
    // The next answer is held back; the page must keep describing the filters it was fetched for.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    cycleMock.mockImplementation(async () => { await gate; return empty.cycle })
    throughputMock.mockImplementation(async () => { await gate; return empty.throughput })
    cumulativeMock.mockImplementation(async () => { await gate; return empty.cumulative })
    ageMock.mockImplementation(async () => { await gate; return empty.age })
    await userEvent.click(screen.getByRole('button', { name: 'Clear all filters' }))
    expect(screen.getByRole('heading', { name: 'No cards match these filters' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Nothing has moved yet' })).not.toBeInTheDocument()
    expect(screen.getByTestId('flow-no-match').parentElement).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByTestId('flow-no-match').parentElement?.className).toContain('opacity-60')
    release()
    expect(await screen.findByRole('heading', { name: 'Nothing has moved yet' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'No cards match these filters' })).not.toBeInTheDocument()
  })

  it('keeps "Nothing has moved yet" while a refetch after picking a filter is pending (#2264)', async () => {
    mockAll(empty)
    render(<FlowMetricsDashboard {...props} />)
    await screen.findByRole('heading', { name: 'Nothing has moved yet' })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    cycleMock.mockImplementation(async () => { await gate; return empty.cycle })
    throughputMock.mockImplementation(async () => { await gate; return empty.throughput })
    cumulativeMock.mockImplementation(async () => { await gate; return empty.cumulative })
    ageMock.mockImplementation(async () => { await gate; return empty.age })
    await userEvent.click(screen.getByRole('button', { name: /^Swimlane/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Customer A' }))
    expect(screen.getByRole('heading', { name: 'Nothing has moved yet' })).toBeInTheDocument()
    expect(screen.queryByTestId('flow-no-match')).not.toBeInTheDocument()
    release()
    expect(await screen.findByTestId('flow-no-match')).toBeInTheDocument()
  })

  it('says too little data on the bottleneck and tiles while charts still draw', async () => {
    mockAll({
      cycle: { ...cycle, sample_size: 6, percentiles: { p50: 4, p85: null, p95: null } },
      cumulative: { ...cumulative, bottleneck_column_uid: null },
    })
    await renderLoaded()
    expect(screen.getByTestId('analytics-bottleneck')).toHaveTextContent('Too early to say')
    expect(screen.getByTestId('analytics-tiles')).toHaveTextContent('Provisional')
    expect(screen.getByTestId('flow-cumulative')).toBeInTheDocument()
  })
})
