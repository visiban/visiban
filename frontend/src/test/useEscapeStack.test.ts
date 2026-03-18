import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { useEscapeStack } from '../hooks/useEscapeStack'

afterEach(() => {
  cleanup()
})

describe('useEscapeStack', () => {
  it('calls the registered handler when Escape is pressed', () => {
    const handler = vi.fn()
    renderHook(() => useEscapeStack(handler, 0))
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('does not call the handler for other keys', () => {
    const handler = vi.fn()
    renderHook(() => useEscapeStack(handler, 0))
    act(() => { fireEvent.keyDown(document, { key: 'Enter' }) })
    act(() => { fireEvent.keyDown(document, { key: 'f' }) })
    expect(handler).not.toHaveBeenCalled()
  })

  it('fires only the highest-priority handler when multiple are registered', () => {
    const low = vi.fn()
    const high = vi.fn()
    renderHook(() => useEscapeStack(low, 0))
    renderHook(() => useEscapeStack(high, 40))
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(high).toHaveBeenCalledOnce()
    expect(low).not.toHaveBeenCalled()
  })

  it('falls through to the next handler when the top handler returns false', () => {
    const low = vi.fn()
    const high = vi.fn(() => false as const)
    renderHook(() => useEscapeStack(low, 0))
    renderHook(() => useEscapeStack(high, 40))
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(high).toHaveBeenCalledOnce()
    expect(low).toHaveBeenCalledOnce()
  })

  it('stops at the first handler that does not return false', () => {
    const bottom = vi.fn()
    const middle = vi.fn()  // returns void — consumes
    const top = vi.fn(() => false as const)
    renderHook(() => useEscapeStack(bottom, 0))
    renderHook(() => useEscapeStack(middle, 20))
    renderHook(() => useEscapeStack(top, 40))
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(top).toHaveBeenCalledOnce()
    expect(middle).toHaveBeenCalledOnce()
    expect(bottom).not.toHaveBeenCalled()
  })

  it('deregisters the handler on unmount', () => {
    const handler = vi.fn()
    const { unmount } = renderHook(() => useEscapeStack(handler, 0))
    unmount()
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(handler).not.toHaveBeenCalled()
  })

  it('always uses the latest fn without re-registering', () => {
    let callCount = 0
    const { rerender } = renderHook(
      ({ n }: { n: number }) => useEscapeStack(() => { callCount = n }, 0),
      { initialProps: { n: 1 } }
    )
    rerender({ n: 2 })
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(callCount).toBe(2)
  })
})
