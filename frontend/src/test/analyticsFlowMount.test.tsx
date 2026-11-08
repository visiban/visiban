import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AnalyticsView from '../components/Board/AnalyticsView'

// The real dashboard, so these count what a viewer's browser actually does: a
// remount is four full-history replays and loses every filter (#448).
vi.mock('../api/boards', () => ({ getBoardAnalytics: vi.fn() }))
vi.mock('../api/flowMetrics', () => ({
  getFlowCycleTime: vi.fn(),
  getFlowThroughput: vi.fn(),
  getFlowCumulativeFlow: vi.fn(),
  getFlowCumulativeDay: vi.fn(),
  getFlowWipAge: vi.fn(),
}))

import { getBoardAnalytics } from '../api/boards'
import { getFlowCumulativeFlow, getFlowCycleTime, getFlowThroughput, getFlowWipAge } from '../api/flowMetrics'

const analytics = {
  days: 30, columns: ['Doing'], done_columns: [], swimlanes: [],
  stalled_threshold_days: 7, staleness_threshold_days: 7, stale_warning_pct: 50,
}
const percentiles = { p50: null, p85: null, p95: null }
const flowEndpoints = [getFlowCycleTime, getFlowThroughput, getFlowCumulativeFlow, getFlowWipAge].map((f) => vi.mocked(f))
const requests = () => flowEndpoints.reduce((sum, endpoint) => sum + endpoint.mock.calls.length, 0)

const props = {
  boardId: 9,
  currentUserRole: 'member',
  swimlanes: [{ id: 3, name: 'Customer A' }],
  labels: [{ id: 4, name: 'Urgent' }],
}

async function changeHeatmapPeriod() {
  await userEvent.click(await screen.findByRole('button', { name: 'Throughput' }))
  await userEvent.click(screen.getByRole('button', { name: '7d' }))
  await waitFor(() => expect(vi.mocked(getBoardAnalytics)).toHaveBeenLastCalledWith(9, 7))
  await screen.findByRole('button', { name: '7d' })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.mocked(getBoardAnalytics).mockResolvedValue(analytics as never)
  vi.mocked(getFlowCycleTime).mockResolvedValue({
    definition: 'd', sample_size: 0, excluded_incomplete_history: 0, percentiles, samples: [], cards: [],
  })
  vi.mocked(getFlowThroughput).mockResolvedValue({
    definition: 'd', period: 'week', total: 1, median: null, samples: [{ start: '2026-06-01', count: 1, card_uids: [] }], cards: [],
  })
  vi.mocked(getFlowCumulativeFlow).mockResolvedValue({ definition: 'd', columns: [], days: [], bottleneck_column_uid: null })
  vi.mocked(getFlowWipAge).mockResolvedValue({
    definition: 'd', sample_size: 0, excluded_incomplete_history: 0, cycle_time_percentiles: percentiles, columns: [], samples: [], cards: [],
  })
})

describe('AnalyticsView beta notice (#2012)', () => {
  it('hides the decorative "·" divider from assistive tech', () => {
    render(<AnalyticsView {...props} />)
    expect(screen.getByText('·')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('AnalyticsView keeps one flow dashboard mounted', () => {
  it('makes one round of requests when the tab opens, not one per heatmap state', async () => {
    render(<AnalyticsView {...props} />)
    await screen.findByTestId('flow-wip-age')
    await screen.findByRole('button', { name: 'Throughput' })
    expect(requests()).toBe(flowEndpoints.length)
  })

  it('makes no new requests when the heatmap period changes', async () => {
    render(<AnalyticsView {...props} />)
    await changeHeatmapPeriod()
    expect(requests()).toBe(flowEndpoints.length)
  })

  it('keeps its filters and charts across a heatmap period change', async () => {
    render(<AnalyticsView {...props} />)
    await screen.findByTestId('flow-wip-age')
    await userEvent.click(screen.getByRole('button', { name: /^Swimlane/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Customer A' }))
    await userEvent.click(screen.getByRole('button', { name: /^Date range/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Last 30 days' }))
    await waitFor(() => expect(vi.mocked(getFlowWipAge)).toHaveBeenLastCalledWith(9, { days: 30, swimlaneId: 3, labelId: null }))
    await screen.findByTestId('flow-wip-age')
    const before = requests()

    await changeHeatmapPeriod()

    expect(screen.getByRole('button', { name: 'Swimlane: Customer A' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Date range: Last 30 days' })).toBeInTheDocument()
    expect(requests()).toBe(before)
  })

  it('keeps it mounted through a heatmap failure', async () => {
    vi.mocked(getBoardAnalytics).mockRejectedValue(new Error('no'))
    render(<AnalyticsView {...props} />)
    await screen.findByText('Failed to load analytics.')
    await screen.findByTestId('flow-wip-age')
    expect(requests()).toBe(flowEndpoints.length)
  })
})
