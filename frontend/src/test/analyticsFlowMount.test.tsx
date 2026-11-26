import { docsUrl } from '../help/docsUrl'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OVERVIEW_LIST_LIMIT } from '../api/analyticsLimits'
import { useEffect } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AnalyticsView from '../components/Board/AnalyticsView'

// Each chart counts its own mounts: a filter change must refetch every panel
// once and remount none of them, or a keyboard user loses their place and the
// page replays every card's history again (#448, #2261).
const mounts = vi.hoisted(() => ({ cycle: 0, throughput: 0, cumulative: 0, age: 0 }))

function counted(name: keyof typeof mounts) {
  return function CountedChart() {
    useEffect(() => { mounts[name] += 1 }, [])
    return <svg role="img" aria-label={name} />
  }
}

vi.mock('../components/Board/flowMetrics/CycleTimeChart', () => ({ default: counted('cycle') }))
vi.mock('../components/Board/flowMetrics/ThroughputChart', () => ({ default: counted('throughput') }))
vi.mock('../components/Board/flowMetrics/CumulativeFlowChart', () => ({ default: counted('cumulative') }))
vi.mock('../components/Board/flowMetrics/WipAgeChart', () => ({ default: counted('age') }))
vi.mock('../api/boards', () => ({ getBoardAnalytics: vi.fn() }))
vi.mock('../api/flowMetrics', async () => (await import('./flowMetricsStubs')).withOverview({
  getFlowCycleTime: vi.fn(),
  getFlowThroughput: vi.fn(),
  getFlowCumulativeFlow: vi.fn(),
  getFlowCumulativeDay: vi.fn(),
  getFlowWipAge: vi.fn(),
  getFlowDwell: vi.fn(),
  getFlowBlocked: vi.fn(),
  getFlowAttention: vi.fn(),
}))

import { getBoardAnalytics } from '../api/boards'
import {
  getFlowAttention, getFlowBlocked, getFlowCumulativeFlow, getFlowCycleTime, getFlowDwell, getFlowThroughput, getFlowWipAge,
} from '../api/flowMetrics'

const analytics = {
  days: 90, columns: ['Doing'], done_columns: [], swimlanes: [],
  stalled_threshold_days: 7, staleness_threshold_days: 7, stale_warning_pct: 50,
}
const percentiles = { p50: null, p85: null, p95: null }
const fetchers = [
  getFlowCycleTime, getFlowThroughput, getFlowCumulativeFlow, getFlowWipAge, getFlowDwell, getFlowBlocked, getFlowAttention,
  getBoardAnalytics,
].map((f) => vi.mocked(f))
const calls = () => fetchers.map((f) => f.mock.calls.length)

const props = {
  boardId: 9,
  currentUserRole: 'member',
  swimlanes: [{ id: 3, name: 'Customer A' }],
  labels: [{ id: 4, name: 'Urgent' }],
  boardName: 'Platform roadmap',
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  for (const key of Object.keys(mounts) as (keyof typeof mounts)[]) mounts[key] = 0
  vi.mocked(getBoardAnalytics).mockResolvedValue(analytics as never)
  vi.mocked(getFlowCycleTime).mockResolvedValue({
    definition: 'd', sample_size: 0, excluded_incomplete_history: 0, percentiles, samples: [], cards: [],
  })
  vi.mocked(getFlowThroughput).mockResolvedValue({
    definition: 'd', period: 'week', total: 1, median: null, samples: [{ start: '2026-06-01', count: 1, card_uids: [], started: 0 }], cards: [],
  })
  vi.mocked(getFlowCumulativeFlow).mockResolvedValue({ definition: 'd', columns: [], days: [], bottleneck_column_uid: null })
  vi.mocked(getFlowWipAge).mockResolvedValue({
    definition: 'd', sample_size: 0, excluded_incomplete_history: 0, cycle_time_percentiles: percentiles, columns: [], samples: [], cards: [],
  })
  vi.mocked(getFlowDwell).mockResolvedValue({ definition: 'd', sample_size: 0, excluded_incomplete_history: 0, columns: [] })
  vi.mocked(getFlowBlocked).mockResolvedValue({
    definition: 'd', total: { days: 0, blocks: 0 }, blocked_now: 0, columns: [], reasons: [], reason_count: 0,
  })
  vi.mocked(getFlowAttention).mockResolvedValue({
    definition: 'd', stalled_threshold_days: 7, cycle_time_percentiles: percentiles, items: [], cards: [],
  })
})

async function choose(trigger: RegExp, option: string) {
  await userEvent.click(screen.getByRole('button', { name: trigger }))
  await userEvent.click(screen.getByRole('menuitem', { name: option }))
}

describe('AnalyticsView title row (#2012, #2261)', () => {
  it('shows the title, Beta badge and board name, and hides the decorative "·" divider from assistive tech', () => {
    render(<AnalyticsView {...props} />)
    // An h2: the header's last breadcrumb is the page's only h1 (#2473).
    expect(screen.getByRole('heading', { name: 'Analytics', level: 2 })).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText(/Platform roadmap/)).toBeInTheDocument()
    expect(screen.getByText('·')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText(/results are best used as directional guidance/)).toBeInTheDocument()
  })

  it('links the flow metric definitions beside the title (#2593)', () => {
    render(<AnalyticsView {...props} />)
    expect(screen.getByRole('link', { name: 'Learn more about flow metric definitions, opens docs' })).toHaveAttribute('href', docsUrl('analytics.definitions'))
  })

  it('sits on the page ground, never the sunken one (#2311)', () => {
    render(<AnalyticsView {...props} />)
    expect(screen.getByTestId('analytics-page').className).toContain('bg-page')
    expect(screen.getByTestId('analytics-page').className).not.toContain('bg-sunken')
  })
})

/** The heatmap is the flow panel's Table view since #2262. */
async function showFlowTable() {
  const group = await screen.findByRole('group', { name: 'How work flows view' })
  await userEvent.click(within(group).getByRole('button', { name: 'table' }))
}

describe('AnalyticsView passes the board custom fields to the breakdown control (#2268)', () => {
  it('offers a segment for a dropdown field and none for a text field', async () => {
    const customFields = [
      { id: 11, name: 'Size', field_type: 'dropdown' as const, position: 0 },
      { id: 12, name: 'Notes', field_type: 'text' as const, position: 1 },
    ]
    render(<AnalyticsView {...props} customFields={customFields} />)
    await screen.findByTestId('flow-wip-age')
    expect(screen.getByRole('button', { name: 'Break down by size' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Break down by notes/i })).toBeNull()
  })
})

describe('AnalyticsView: one filter bar drives the page without remounting the charts', () => {
  it('makes one request per endpoint when the tab opens', async () => {
    render(<AnalyticsView {...props} />)
    await screen.findByTestId('flow-wip-age')
    await screen.findByTestId('analytics-flow')
    expect(calls()).toEqual(fetchers.map(() => 1))
    expect(mounts).toEqual({ cycle: 1, throughput: 1, cumulative: 1, age: 1 })
  })

  it('refetches every panel exactly once per Period, Swimlane and Label change, and remounts no chart', async () => {
    render(<AnalyticsView {...props} />)
    await screen.findByTestId('flow-wip-age')
    let before = calls()

    for (const [trigger, option, filters] of [
      [/^Date range/, 'Last 30 days', { days: 30, swimlaneId: null, labelId: null }],
      [/^Swimlane/, 'Customer A', { days: 30, swimlaneId: 3, labelId: null }],
      [/^Label/, 'Urgent', { days: 30, swimlaneId: 3, labelId: 4 }],
    ] as const) {
      await choose(trigger, option)
      await waitFor(() => expect(vi.mocked(getFlowAttention)).toHaveBeenLastCalledWith(9, filters))
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe(''))
      expect(calls()).toEqual(before.map((n) => n + 1))
      expect(vi.mocked(getBoardAnalytics)).toHaveBeenLastCalledWith(9, filters.days, undefined, {
        swimlaneId: filters.swimlaneId, labelId: filters.labelId,
      }, OVERVIEW_LIST_LIMIT)
      expect(mounts).toEqual({ cycle: 1, throughput: 1, cumulative: 1, age: 1 })
      before = calls()
    }
    expect(screen.getByRole('button', { name: 'Swimlane: Customer A' })).toBeInTheDocument()
  })

  it('keeps the title row on the period of the numbers on screen until the new fetch resolves (#2261)', async () => {
    render(<AnalyticsView {...props} />)
    await screen.findByTestId('flow-wip-age')
    const periodLine = () => screen.getByText(/Platform roadmap/).textContent
    const before = periodLine()
    let release: (value: Awaited<ReturnType<typeof getFlowBlocked>>) => void = () => {}
    vi.mocked(getFlowBlocked).mockReturnValue(new Promise((resolve) => { release = resolve }))
    await choose(/^Date range/, 'Last 30 days')
    await waitFor(() => expect(vi.mocked(getFlowBlocked)).toHaveBeenLastCalledWith(9, { days: 30, swimlaneId: null, labelId: null }))
    expect(periodLine()).toBe(before)
    release({ definition: 'd', total: { days: 0, blocks: 0 }, blocked_now: 0, columns: [], reasons: [], reason_count: 0 })
    await waitFor(() => expect(periodLine()).not.toBe(before))
  })

  it('keeps the charts mounted through a heatmap failure', async () => {
    vi.mocked(getBoardAnalytics).mockRejectedValue(new Error('no'))
    render(<AnalyticsView {...props} />)
    await showFlowTable()
    await screen.findByText('Failed to load analytics.')
    await screen.findByTestId('flow-wip-age')
    expect(calls()).toEqual(fetchers.map(() => 1))
  })

  it('makes no request when the heatmap mode changes', async () => {
    render(<AnalyticsView {...props} />)
    await showFlowTable()
    await userEvent.click(await screen.findByRole('button', { name: 'In period' }))
    expect(calls()).toEqual(fetchers.map(() => 1))
  })
})

describe('AnalyticsView toggles mark the active state without color (#2185)', () => {
  it('checks the active mode button', async () => {
    render(<AnalyticsView {...props} />)
    await showFlowTable()
    const age = await screen.findByRole('button', { name: 'Current' })
    const inPeriod = screen.getByRole('button', { name: 'In period' })
    expect(age).toHaveAttribute('aria-pressed', 'true')
    expect(age.querySelector('[data-testid="active-mark"]')).not.toBeNull()
    expect(inPeriod.querySelector('[data-testid="active-mark"]')).toBeNull()
    await userEvent.click(inPeriod)
    expect(inPeriod.querySelector('[data-testid="active-mark"]')).not.toBeNull()
  })
})
