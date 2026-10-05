import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useDeferredResync } from '../hooks/useDeferredResync'

describe('useDeferredResync (#1463)', () => {
  it('runs immediately when not blocked', () => {
    const resync = vi.fn()
    const { result } = renderHook(() => useDeferredResync(resync, false))
    result.current()
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it('defers while blocked and runs once when unblocked', () => {
    const resync = vi.fn()
    const { result, rerender } = renderHook(
      ({ blocked }) => useDeferredResync(resync, blocked),
      { initialProps: { blocked: true } },
    )
    result.current()
    result.current()
    expect(resync).not.toHaveBeenCalled()
    rerender({ blocked: false })
    expect(resync).toHaveBeenCalledTimes(1)
    rerender({ blocked: true })
    rerender({ blocked: false })
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it('does not resync on unblock when nothing was triggered', () => {
    const resync = vi.fn()
    const { rerender } = renderHook(
      ({ blocked }) => useDeferredResync(resync, blocked),
      { initialProps: { blocked: true } },
    )
    rerender({ blocked: false })
    expect(resync).not.toHaveBeenCalled()
  })

  it('keeps a stable trigger identity', () => {
    const { result, rerender } = renderHook(
      ({ blocked }) => useDeferredResync(vi.fn(), blocked),
      { initialProps: { blocked: false } },
    )
    const first = result.current
    rerender({ blocked: true })
    expect(result.current).toBe(first)
  })
})
