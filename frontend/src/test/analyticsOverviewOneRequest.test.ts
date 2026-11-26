import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The real module shape, not the per-chart composition in flowMetricsStubs: this
// test is about which requests the Overview makes (#2426).
vi.mock('../api/flowMetrics', () => ({
  getFlowOverview: vi.fn(),
  getFlowCycleTime: vi.fn(),
  getFlowThroughput: vi.fn(),
  getFlowCumulativeFlow: vi.fn(),
  getFlowWipAge: vi.fn(),
  getFlowDwell: vi.fn(),
  getFlowBlocked: vi.fn(),
  getFlowAttention: vi.fn(),
}))
vi.mock('../api/boards', () => ({ getBoardAnalytics: vi.fn() }))

import * as flowApi from '../api/flowMetrics'
import { getBoardAnalytics } from '../api/boards'
import { useAnalyticsOverviewData } from '../components/Board/flowMetrics/useAnalyticsOverviewData'
import type { FlowOverview } from '../types'

const overview = {
  cycle_time: { definition: 'cycle' },
  throughput: { definition: 'throughput' },
  cumulative_flow: { definition: 'cumulative' },
  wip_age: { definition: 'age' },
  dwell: { definition: 'dwell' },
  blocked: { definition: 'blocked' },
  attention: { definition: 'attention' },
} as unknown as FlowOverview
const filters = { days: 30, swimlaneId: 3, labelId: null }
const perChart = ['getFlowCycleTime', 'getFlowThroughput', 'getFlowCumulativeFlow', 'getFlowWipAge', 'getFlowDwell', 'getFlowBlocked', 'getFlowAttention'] as const

describe('useAnalyticsOverviewData (#2426)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getBoardAnalytics).mockResolvedValue(null as never)
  })

  it('refetches when the board time zone changes (#2051)', async () => {
    vi.mocked(flowApi.getFlowOverview).mockResolvedValue(overview)
    const { result, rerender } = renderHook(({ tz }: { tz: string | null }) => useAnalyticsOverviewData(9, filters, 0, undefined, tz), {
      initialProps: { tz: null as string | null },
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(flowApi.getFlowOverview).toHaveBeenCalledTimes(1)
    rerender({ tz: null })
    expect(flowApi.getFlowOverview).toHaveBeenCalledTimes(1)
    rerender({ tz: 'Pacific/Auckland' })
    await waitFor(() => expect(flowApi.getFlowOverview).toHaveBeenCalledTimes(2))
  })

  it('asks for every chart in one overview request, not one request per chart', async () => {
    vi.mocked(flowApi.getFlowOverview).mockResolvedValue(overview)
    const { result } = renderHook(() => useAnalyticsOverviewData(9, filters, 0))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(flowApi.getFlowOverview).toHaveBeenCalledTimes(1)
    // No breakdown: the call carries no third argument.
    expect(flowApi.getFlowOverview).toHaveBeenCalledWith(9, filters)
    for (const name of perChart) expect(flowApi[name]).not.toHaveBeenCalled()
    expect(getBoardAnalytics).toHaveBeenCalledTimes(1)
    const results = result.current.results!
    expect(results.cycle.data).toBe(overview.cycle_time)
    expect(results.throughput.data).toBe(overview.throughput)
    expect(results.cumulative.data).toBe(overview.cumulative_flow)
    expect(results.wipAge.data).toBe(overview.wip_age)
    expect(results.dwell.data).toBe(overview.dwell)
    expect(results.blocked.data).toBe(overview.blocked)
    expect(results.attention.data).toBe(overview.attention)
    expect(result.current.failed).toBe(false)
  })

  it('passes a breakdown on to the overview request', async () => {
    vi.mocked(flowApi.getFlowOverview).mockResolvedValue(overview)
    const grouping = { by: 'custom_field' as const, fieldId: 11 }
    const { result } = renderHook(() => useAnalyticsOverviewData(9, filters, 0, grouping))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(flowApi.getFlowOverview).toHaveBeenCalledWith(9, filters, grouping)
  })

  it('fails every chart when the overview request fails, and keeps the heatmap', async () => {
    const error = new Error('no')
    vi.mocked(flowApi.getFlowOverview).mockRejectedValue(error)
    vi.mocked(getBoardAnalytics).mockResolvedValue({ columns: [] } as never)
    const { result } = renderHook(() => useAnalyticsOverviewData(9, filters, 0))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const { analytics, ...charts } = result.current.results!
    for (const chart of Object.values(charts)) expect(chart).toEqual({ error })
    expect(analytics).toEqual({ data: { columns: [] } })
    expect(result.current.failed).toBe(true)
  })
})
