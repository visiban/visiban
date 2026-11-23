import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('../api/flowMetrics', () => ({ getFlowOverview: vi.fn() }))
vi.mock('../api/boards', () => ({ getBoardAnalytics: vi.fn() }))

import { getFlowOverview } from '../api/flowMetrics'
import { getBoardAnalytics } from '../api/boards'
import { useAnalyticsOverviewData } from '../components/Board/flowMetrics/useAnalyticsOverviewData'

const overviewMock = vi.mocked(getFlowOverview)
const analyticsMock = vi.mocked(getBoardAnalytics)
const busy = { response: { status: 503, headers: { 'retry-after': '5' }, data: { code: 'analytics_busy', detail: 'x' } } }

describe('the Overview busy retry (#2428)', () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  it('is dropped on unmount: the timer is cleared and nothing is sent again', async () => {
    vi.useFakeTimers()
    overviewMock.mockRejectedValue(busy)
    analyticsMock.mockRejectedValue(busy)
    const { unmount } = renderHook(() => useAnalyticsOverviewData(1, { days: 90, swimlaneId: null, labelId: null }, 0))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(vi.getTimerCount()).toBe(2)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(overviewMock).toHaveBeenCalledTimes(1)
    expect(analyticsMock).toHaveBeenCalledTimes(1)
  })

  it('is dropped on a filter change: only the new filters are retried', async () => {
    vi.useFakeTimers()
    overviewMock.mockRejectedValue(busy)
    analyticsMock.mockRejectedValue(busy)
    const first = { days: 90, swimlaneId: null, labelId: null }
    const { rerender } = renderHook(({ filters }) => useAnalyticsOverviewData(1, filters, 0), { initialProps: { filters: first } })
    await vi.advanceTimersByTimeAsync(1_000)
    const second = { days: 30, swimlaneId: null, labelId: null }
    rerender({ filters: second })
    await vi.advanceTimersByTimeAsync(10_000)
    const days = overviewMock.mock.calls.map(([, filters]) => filters.days)
    expect(days).toEqual([90, 30, 30])
  })
})
