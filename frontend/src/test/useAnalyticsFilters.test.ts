import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { DEFAULT_DAYS, RANGES, useAnalyticsFilters } from '../components/Board/flowMetrics/useAnalyticsFilters'

describe('useAnalyticsFilters (#2261)', () => {
  it('starts on the last 90 days with no swimlane or label, offered among 30/90/180/365', () => {
    const { result } = renderHook(() => useAnalyticsFilters())
    expect(result.current.filters).toEqual({ days: 90, swimlaneId: null, labelId: null })
    expect(DEFAULT_DAYS).toBe(90)
    expect(RANGES.map((r) => r.value)).toEqual([30, 90, 180, 365])
  })

  it('sets each filter on its own and clears back to the default', () => {
    const { result } = renderHook(() => useAnalyticsFilters())
    act(() => result.current.setDays(30))
    act(() => result.current.setSwimlaneId(3))
    act(() => result.current.setLabelId(4))
    expect(result.current.filters).toEqual({ days: 30, swimlaneId: 3, labelId: 4 })
    act(() => result.current.clear())
    expect(result.current.filters).toEqual({ days: 90, swimlaneId: null, labelId: null })
  })
})
