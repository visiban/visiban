import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useBoardSocket } from '../hooks/useBoardSocket'
import type { BoardEvent } from '../hooks/useBoardSocket'

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type MockWSInstance = {
  url: string
  onopen: ((ev?: unknown) => void) | null
  onmessage: ((ev: { data: string }) => void) | null
  onclose: ((ev: { code: number }) => void) | null
  close: ReturnType<typeof vi.fn>
}

let instances: MockWSInstance[]

class MockWebSocket {
  url: string
  onopen: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  close = vi.fn()

  constructor(url: string) {
    this.url = url
    instances.push(this as unknown as MockWSInstance)
  }
}

beforeEach(() => {
  instances = []
  vi.stubGlobal('WebSocket', MockWebSocket)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function latestWS(): MockWSInstance {
  return instances[instances.length - 1]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useBoardSocket', () => {
  it('connects to the correct URL based on board ID', () => {
    const onEvent = vi.fn()
    renderHook(() => useBoardSocket(42, onEvent))

    expect(instances).toHaveLength(1)
    expect(latestWS().url).toBe('ws://localhost:8000/ws/boards/42/')
  })

  it('does not connect when boardId is null', () => {
    const onEvent = vi.fn()
    renderHook(() => useBoardSocket(null, onEvent))

    expect(instances).toHaveLength(0)
  })

  it('reports connected = true after onopen fires', () => {
    const onEvent = vi.fn()
    const { result } = renderHook(() => useBoardSocket(1, onEvent))

    expect(result.current.connected).toBe(false)

    act(() => {
      latestWS().onopen?.()
    })

    expect(result.current.connected).toBe(true)
  })

  it('dispatches parsed card.moved events to onEvent', () => {
    const onEvent = vi.fn()
    renderHook(() => useBoardSocket(1, onEvent))

    const event: BoardEvent = { event: 'card.moved', data: { id: 10, column: 2 } }
    act(() => {
      latestWS().onmessage?.({ data: JSON.stringify(event) })
    })

    expect(onEvent).toHaveBeenCalledWith(event)
  })

  it('dispatches card.created events to onEvent', () => {
    const onEvent = vi.fn()
    renderHook(() => useBoardSocket(1, onEvent))

    const event: BoardEvent = { event: 'card.created', data: { id: 5, title: 'New card' } }
    act(() => {
      latestWS().onmessage?.({ data: JSON.stringify(event) })
    })

    expect(onEvent).toHaveBeenCalledWith(event)
  })

  it('ignores malformed (non-JSON) messages', () => {
    const onEvent = vi.fn()
    renderHook(() => useBoardSocket(1, onEvent))

    act(() => {
      latestWS().onmessage?.({ data: 'not json' })
    })

    expect(onEvent).not.toHaveBeenCalled()
  })

  it('sets connected = false on close and schedules reconnect', () => {
    const onEvent = vi.fn()
    const { result } = renderHook(() => useBoardSocket(1, onEvent))

    act(() => { latestWS().onopen?.() })
    expect(result.current.connected).toBe(true)

    const firstWS = latestWS()
    act(() => { firstWS.onclose?.({ code: 1006 }) })

    expect(result.current.connected).toBe(false)

    // Reconnect after 3 seconds
    act(() => { vi.advanceTimersByTime(3000) })
    expect(instances).toHaveLength(2)
  })

  it('does not reconnect on intentional close (code 1000)', () => {
    const onEvent = vi.fn()
    renderHook(() => useBoardSocket(1, onEvent))

    act(() => { latestWS().onclose?.({ code: 1000 }) })
    act(() => { vi.advanceTimersByTime(5000) })

    expect(instances).toHaveLength(1)
  })

  it('does not reconnect on auth rejection (code 4001)', () => {
    const onEvent = vi.fn()
    renderHook(() => useBoardSocket(1, onEvent))

    act(() => { latestWS().onclose?.({ code: 4001 }) })
    act(() => { vi.advanceTimersByTime(5000) })

    expect(instances).toHaveLength(1)
  })

  it('does not reconnect on forbidden (code 4003)', () => {
    const onEvent = vi.fn()
    renderHook(() => useBoardSocket(1, onEvent))

    act(() => { latestWS().onclose?.({ code: 4003 }) })
    act(() => { vi.advanceTimersByTime(5000) })

    expect(instances).toHaveLength(1)
  })

  it('cleans up on unmount — closes socket and cancels reconnect', () => {
    const onEvent = vi.fn()
    const { unmount } = renderHook(() => useBoardSocket(1, onEvent))

    const ws = latestWS()
    unmount()

    expect(ws.close).toHaveBeenCalledWith(1000)

    // Should not reconnect after unmount
    act(() => { vi.advanceTimersByTime(5000) })
    expect(instances).toHaveLength(1)
  })

  // ---------------------------------------------------------------------------
  // Keepalive / ping timeout (#425)
  // ---------------------------------------------------------------------------

  it('silently ignores ping events — does not forward to onEvent', () => {
    const onEvent = vi.fn()
    renderHook(() => useBoardSocket(1, onEvent))

    act(() => { latestWS().onopen?.() })
    act(() => {
      latestWS().onmessage?.({ data: JSON.stringify({ event: 'ping' }) })
    })

    expect(onEvent).not.toHaveBeenCalled()
  })

  it('triggers reconnect when no message arrives within 45 seconds', () => {
    const onEvent = vi.fn()
    const { result } = renderHook(() => useBoardSocket(1, onEvent))

    act(() => { latestWS().onopen?.() })
    expect(result.current.connected).toBe(true)

    const firstWS = latestWS()

    // Advance time past the 45-second ping timeout
    act(() => { vi.advanceTimersByTime(45_000) })

    // The hook should have called close(4002) to signal a ping timeout
    expect(firstWS.close).toHaveBeenCalledWith(4002)

    // Simulate the browser firing onclose after our close() call
    act(() => { firstWS.onclose?.({ code: 4002 }) })

    expect(result.current.status).toBe('reconnecting')

    // After 3 s reconnect delay, a new WebSocket should be created
    act(() => { vi.advanceTimersByTime(3000) })
    expect(instances).toHaveLength(2)
  })

  it('resets the ping timeout when a message arrives', () => {
    const onEvent = vi.fn()
    renderHook(() => useBoardSocket(1, onEvent))

    act(() => { latestWS().onopen?.() })

    // Advance 30 seconds (within timeout), then send a message to reset
    act(() => { vi.advanceTimersByTime(30_000) })
    act(() => {
      latestWS().onmessage?.({ data: JSON.stringify({ event: 'ping' }) })
    })

    // Another 30 seconds — still within the reset window
    act(() => { vi.advanceTimersByTime(30_000) })

    // Socket should not have been closed because the ping reset the timer
    expect(latestWS().close).not.toHaveBeenCalled()

    // But if we wait the full 45 s without another message, it should close
    act(() => { vi.advanceTimersByTime(15_000) })
    expect(latestWS().close).toHaveBeenCalledWith(4002)
  })
})
