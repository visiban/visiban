import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import { useIsMediumViewport } from '../hooks/useIsMediumViewport'

type MQListener = (e: { matches: boolean }) => void

function makeMatchMedia(initialMatches: boolean) {
  let matches = initialMatches
  const listeners = new Set<MQListener>()
  const mq = {
    get matches() {
      return matches
    },
    addEventListener: vi.fn((_event: string, cb: MQListener) => {
      listeners.add(cb)
    }),
    removeEventListener: vi.fn((_event: string, cb: MQListener) => {
      listeners.delete(cb)
    }),
  }
  const matchMedia = vi.fn(() => mq)
  function setMatches(next: boolean) {
    matches = next
    listeners.forEach((cb) => cb({ matches: next }))
  }
  return { matchMedia, mq, setMatches, listeners }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useIsMediumViewport', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    })
  })

  it('returns true on initial render when matchMedia is unavailable (SSR/test fallback)', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    })
    const { result } = renderHook(() => useIsMediumViewport())
    expect(result.current).toBe(true)
  })

  it('returns true when the viewport is at least md (768px)', () => {
    const { matchMedia } = makeMatchMedia(true)
    window.matchMedia = matchMedia as unknown as typeof window.matchMedia
    const { result } = renderHook(() => useIsMediumViewport())
    expect(result.current).toBe(true)
    expect(matchMedia).toHaveBeenCalledWith('(min-width: 768px)')
  })

  it('returns false when the viewport is below the md breakpoint', () => {
    const { matchMedia } = makeMatchMedia(false)
    window.matchMedia = matchMedia as unknown as typeof window.matchMedia
    const { result } = renderHook(() => useIsMediumViewport())
    expect(result.current).toBe(false)
  })

  it('updates when the matchMedia change listener fires', () => {
    const { matchMedia, setMatches } = makeMatchMedia(true)
    window.matchMedia = matchMedia as unknown as typeof window.matchMedia
    const { result } = renderHook(() => useIsMediumViewport())
    expect(result.current).toBe(true)

    act(() => {
      setMatches(false)
    })
    expect(result.current).toBe(false)

    act(() => {
      setMatches(true)
    })
    expect(result.current).toBe(true)
  })

  it('removes the change listener on unmount', () => {
    const { matchMedia, mq } = makeMatchMedia(true)
    window.matchMedia = matchMedia as unknown as typeof window.matchMedia
    const { unmount } = renderHook(() => useIsMediumViewport())
    expect(mq.addEventListener).toHaveBeenCalledTimes(1)
    unmount()
    expect(mq.removeEventListener).toHaveBeenCalledTimes(1)
  })
})
