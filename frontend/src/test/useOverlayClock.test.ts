import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useOverlayClock } from '../hooks/useOverlayClock'

const STEP = 5 * 60_000
const START = STEP * 1_000_000

describe('useOverlayClock (#459)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(START)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is 0 and never ticks for an overlay that declares no refresh', () => {
    const { result } = renderHook(() => useOverlayClock(undefined))
    expect(result.current).toBe(0)
    act(() => { vi.advanceTimersByTime(STEP * 3) })
    expect(result.current).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('floors to the interval, so sub-interval time passing does not re-render', () => {
    vi.setSystemTime(START + 1234)
    let renders = 0
    const { result } = renderHook(() => { renders += 1; return useOverlayClock(STEP) })
    expect(result.current).toBe(START)
    const settled = renders
    act(() => { vi.advanceTimersByTime(STEP - 2000) })
    expect(result.current).toBe(START)
    expect(renders).toBe(settled)
  })

  it('advances when the interval passes', () => {
    const { result } = renderHook(() => useOverlayClock(STEP))
    act(() => { vi.advanceTimersByTime(STEP) })
    expect(result.current).toBe(START + STEP)
  })

  it('catches up at once on returning to a tab whose interval was throttled', () => {
    const { result } = renderHook(() => useOverlayClock(STEP))
    vi.setSystemTime(START + STEP * 7)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(result.current).toBe(START + STEP * 7)
  })

  it('starts current when the overlay is switched on later', () => {
    const { result, rerender } = renderHook(({ ms }: { ms: number | undefined }) => useOverlayClock(ms), {
      initialProps: { ms: undefined as number | undefined },
    })
    vi.setSystemTime(START + STEP * 2)
    rerender({ ms: STEP })
    expect(result.current).toBe(START + STEP * 2)
  })

  it('stops ticking and listening on unmount', () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    const { unmount } = renderHook(() => useOverlayClock(STEP))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    remove.mockRestore()
  })
})
