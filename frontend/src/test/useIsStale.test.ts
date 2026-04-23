import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIsStale } from '../hooks/useIsStale'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-04-23T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useIsStale', () => {
  it('is false while disconnected regardless of lastEventAt', () => {
    const { result } = renderHook(() => useIsStale('connecting', null))
    expect(result.current).toBe(false)

    const { result: result2 } = renderHook(() => useIsStale('reconnecting', Date.now() - 1_000_000))
    expect(result2.current).toBe(false)

    const { result: result3 } = renderHook(() => useIsStale('failed', Date.now()))
    expect(result3.current).toBe(false)
  })

  it('is false when connected with no event yet (lastEventAt null)', () => {
    const { result } = renderHook(() => useIsStale('connected', null))
    expect(result.current).toBe(false)
  })

  it('is false when connected and within the threshold', () => {
    const { result } = renderHook(() => useIsStale('connected', Date.now() - 30_000))
    expect(result.current).toBe(false)
  })

  it('is true immediately when connected and already past threshold', () => {
    const { result } = renderHook(() => useIsStale('connected', Date.now() - 90_000))
    expect(result.current).toBe(true)
  })

  it('flips to true after the threshold elapses', () => {
    const lastEventAt = Date.now()
    const { result } = renderHook(({ status, last }) => useIsStale(status, last), {
      initialProps: { status: 'connected' as const, last: lastEventAt as number | null },
    })
    expect(result.current).toBe(false)

    act(() => { vi.advanceTimersByTime(59_999) })
    expect(result.current).toBe(false)

    act(() => { vi.advanceTimersByTime(2) })
    expect(result.current).toBe(true)
  })

  it('reschedules when lastEventAt updates before the timer fires', () => {
    const initial = Date.now()
    const { result, rerender } = renderHook(
      ({ last }) => useIsStale('connected', last),
      { initialProps: { last: initial as number | null } },
    )

    // Advance halfway through the threshold.
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(result.current).toBe(false)

    // A fresh event arrives — advance clock and rerender with new lastEventAt.
    vi.setSystemTime(new Date(Date.now() + 30_000))
    rerender({ last: Date.now() })

    // The old timer would have fired at 60s — if it did, isStale would now be true.
    // Instead, we should still be false, and only become stale 60s from the new event.
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(result.current).toBe(false)

    act(() => { vi.advanceTimersByTime(30_001) })
    expect(result.current).toBe(true)
  })

  it('respects a custom threshold', () => {
    const last = Date.now()
    const { result } = renderHook(({ l }) => useIsStale('connected', l, 10_000), {
      initialProps: { l: last as number | null },
    })
    expect(result.current).toBe(false)
    act(() => { vi.advanceTimersByTime(9_999) })
    expect(result.current).toBe(false)
    act(() => { vi.advanceTimersByTime(2) })
    expect(result.current).toBe(true)
  })
})
