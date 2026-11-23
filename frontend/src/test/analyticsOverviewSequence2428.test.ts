import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

vi.mock('../api/flowMetrics', () => ({ getFlowOverview: vi.fn() }))
vi.mock('../api/boards', () => ({ getBoardAnalytics: vi.fn() }))

import { getFlowOverview } from '../api/flowMetrics'
import { getBoardAnalytics } from '../api/boards'
import { useAnalyticsOverviewData } from '../components/Board/flowMetrics/useAnalyticsOverviewData'
import type { FlowOverview } from '../types'

const overviewMock = vi.mocked(getFlowOverview)
const analyticsMock = vi.mocked(getBoardAnalytics)
const busy = { response: { status: 503, headers: { 'retry-after': '5' }, data: { code: 'analytics_busy', detail: 'x' } } }
const filters = { days: 90, swimlaneId: null, labelId: null }
const overview = { cycle_time: {}, throughput: {}, cumulative_flow: {}, wip_age: {}, dwell: {}, blocked: {}, attention: {} } as unknown as FlowOverview

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('the Overview sends its two requests in sequence (#2428)', () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  it('starts the heatmap request only after the overview request settles', async () => {
    vi.useFakeTimers()
    const first = deferred<FlowOverview>()
    overviewMock.mockReturnValue(first.promise)
    analyticsMock.mockResolvedValue(null as never)
    renderHook(() => useAnalyticsOverviewData(1, filters, 0))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(overviewMock).toHaveBeenCalledTimes(1)
    expect(analyticsMock).not.toHaveBeenCalled()
    first.resolve(overview)
    await vi.advanceTimersByTimeAsync(0)
    expect(analyticsMock).toHaveBeenCalledTimes(1)
  })

  it('still attempts the heatmap when the overview failed, and each reports its own outcome', async () => {
    vi.useFakeTimers()
    overviewMock.mockRejectedValue({ response: { status: 422, data: { code: 'analytics_too_large' } } })
    analyticsMock.mockResolvedValue(null as never)
    const { result } = renderHook(() => useAnalyticsOverviewData(1, filters, 0))
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(analyticsMock).toHaveBeenCalledTimes(1)
    expect(result.current.results?.cycle.error).toBeDefined()
    expect(result.current.results?.analytics.error).toBeUndefined()
    expect(result.current.failedKind).toBe('too_large')
  })

  it('a filter change mid-chain cancels the heatmap request of the superseded chain', async () => {
    vi.useFakeTimers()
    const first = deferred<FlowOverview>()
    overviewMock.mockReturnValueOnce(first.promise).mockResolvedValue(overview)
    analyticsMock.mockResolvedValue(null as never)
    const { rerender } = renderHook(({ f }) => useAnalyticsOverviewData(1, f, 0), { initialProps: { f: filters } })
    await vi.advanceTimersByTimeAsync(0)
    rerender({ f: { ...filters, days: 30 } })
    await vi.advanceTimersByTimeAsync(0)
    first.resolve(overview)
    await vi.advanceTimersByTimeAsync(0)
    // Only the new chain's heatmap request was sent.
    expect(analyticsMock).toHaveBeenCalledTimes(1)
    expect(analyticsMock.mock.calls[0][1]).toBe(30)
  })

  it('retries a busy overview once, then sends the heatmap, which gets its own busy retry', async () => {
    vi.useFakeTimers()
    overviewMock.mockRejectedValueOnce(busy).mockResolvedValue(overview)
    analyticsMock.mockRejectedValueOnce(busy).mockResolvedValue(null as never)
    const { result } = renderHook(() => useAnalyticsOverviewData(1, filters, 0))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(overviewMock).toHaveBeenCalledTimes(1)
    expect(analyticsMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(overviewMock).toHaveBeenCalledTimes(2)
    expect(analyticsMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(analyticsMock).toHaveBeenCalledTimes(2)
    expect(result.current.failed).toBe(false)
  })
})
