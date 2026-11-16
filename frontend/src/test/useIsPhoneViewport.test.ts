import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import { useIsPhoneViewport } from '../hooks/useIsPhoneViewport'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useIsPhoneViewport', () => {
  it('is false without matchMedia', () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined })
    expect(renderHook(() => useIsPhoneViewport()).result.current).toBe(false)
  })

  it('tracks the max-width query and cleans up', () => {
    let matches = true
    const listeners = new Set<() => void>()
    const mq = {
      get matches() { return matches },
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    }
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: vi.fn(() => mq) })
    const { result, unmount } = renderHook(() => useIsPhoneViewport())
    expect(result.current).toBe(true)
    act(() => { matches = false; listeners.forEach((cb) => cb()) })
    expect(result.current).toBe(false)
    unmount()
    expect(listeners.size).toBe(0)
  })
})
