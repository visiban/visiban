import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useBoardSocket } from '../hooks/useBoardSocket'
import type { BoardEvent } from '../hooks/useBoardSocket'

// A 4003 close probes the session (#2037); stub it so these tests make no real
// network call. The probe's own behavior is covered in demoReset.test.ts.
vi.mock('../utils/sessionProbe', () => ({ probeSession: vi.fn().mockResolvedValue(undefined) }))

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
  it('connects to the correct board path based on board ID', () => {
    vi.stubEnv('VITE_API_URL', 'http://api.example.com')
    const onEvent = vi.fn()
    renderHook(() => useBoardSocket(42, onEvent))

    expect(instances).toHaveLength(1)
    expect(latestWS().url).toBe('ws://api.example.com/ws/boards/42/')
  })

  it('uses a different board ID in the URL when the ID changes', () => {
    vi.stubEnv('VITE_API_URL', 'http://api.example.com')
    const onEvent = vi.fn()
    renderHook(() => useBoardSocket(99, onEvent))

    expect(instances).toHaveLength(1)
    expect(latestWS().url).toBe('ws://api.example.com/ws/boards/99/')
  })

  it('falls back to window.location.origin when VITE_API_URL is empty', () => {
    vi.stubEnv('VITE_API_URL', '')
    const onEvent = vi.fn()
    renderHook(() => useBoardSocket(42, onEvent))

    expect(instances).toHaveLength(1)
    // window.location.origin in vitest/jsdom is "http://localhost:3000"; replace http→ws
    expect(latestWS().url).toBe('ws://localhost:3000/ws/boards/42/')
    vi.unstubAllEnvs()
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

  it('does not reconnect or re-read when its own unmount closes the socket (code 1000)', () => {
    const onServerClose = vi.fn()
    const { unmount } = renderHook(() => useBoardSocket(1, vi.fn(), { onServerClose }))
    const ws = latestWS()
    unmount()
    expect(ws.close).toHaveBeenCalledWith(1000)
    // The browser delivers the close event after the hook has been torn down.
    act(() => { ws.onclose?.({ code: 1000 }) })
    act(() => { vi.advanceTimersByTime(5000) })

    expect(instances).toHaveLength(1)
    expect(onServerClose).not.toHaveBeenCalled()
  })

  it('does not treat a board change as a server close', () => {
    const onServerClose = vi.fn()
    const { rerender } = renderHook(({ id }) => useBoardSocket(id, vi.fn(), { onServerClose }), { initialProps: { id: 1 } })
    const first = latestWS()
    rerender({ id: 2 })
    act(() => { first.onclose?.({ code: 1000 }) })
    expect(onServerClose).not.toHaveBeenCalled()
    expect(instances).toHaveLength(2)
  })

  it('a server-sent 1000 (member removed) calls onServerClose and reconnects once, with no session probe (#2041)', async () => {
    const { probeSession } = await import('../utils/sessionProbe')
    const expired = vi.fn()
    window.addEventListener('auth:sessionExpired', expired)
    const onServerClose = vi.fn()
    const { result } = renderHook(() => useBoardSocket(1, vi.fn(), { onServerClose }))
    act(() => { latestWS().onopen?.() })

    act(() => { latestWS().onclose?.({ code: 1000 }) })
    expect(onServerClose).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('reconnecting')
    act(() => { vi.advanceTimersByTime(3000) })
    expect(instances).toHaveLength(2)
    expect(probeSession).not.toHaveBeenCalled()
    expect(expired).not.toHaveBeenCalled()
    window.removeEventListener('auth:sessionExpired', expired)
  })

  it('a second server 1000 before any frame stops as failed instead of looping (#2041)', () => {
    const onServerClose = vi.fn()
    const { result } = renderHook(() => useBoardSocket(1, vi.fn(), { onServerClose }))
    act(() => { latestWS().onclose?.({ code: 1000 }) })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(instances).toHaveLength(2)
    act(() => { latestWS().onclose?.({ code: 1000 }) })
    act(() => { vi.advanceTimersByTime(10000) })
    expect(instances).toHaveLength(2)
    expect(result.current.status).toBe('failed')
  })

  it('a frame between server closes resets the one-reconnect allowance', () => {
    const { result } = renderHook(() => useBoardSocket(1, vi.fn(), { onServerClose: vi.fn() }))
    act(() => { latestWS().onclose?.({ code: 1000 }) })
    act(() => { vi.advanceTimersByTime(3000) })
    act(() => { latestWS().onopen?.() })
    act(() => { latestWS().onmessage?.({ data: JSON.stringify({ event: 'ping', data: {} }) }) })
    act(() => { latestWS().onclose?.({ code: 1000 }) })
    expect(result.current.status).toBe('reconnecting')
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

  // The server refuses a handshake by accepting and closing at once (#2145), so
  // a refusal reaches the hook as onopen followed by the 4001/4003 close.
  describe('handshake refusal: open, then the close code (#2145)', () => {
    function signOutSpy() {
      const expired = vi.fn()
      window.addEventListener('auth:sessionExpired', expired)
      return { expired, stop: () => window.removeEventListener('auth:sessionExpired', expired) }
    }

    it('a 4003 right after open stops as failed and probes the session once', async () => {
      const { probeSession } = await import('../utils/sessionProbe')
      vi.mocked(probeSession).mockClear()
      const { expired, stop } = signOutSpy()
      const { result } = renderHook(() => useBoardSocket(1, vi.fn()))

      act(() => { latestWS().onopen?.() })
      act(() => { latestWS().onclose?.({ code: 4003 }) })
      act(() => { vi.advanceTimersByTime(10_000) })

      expect(result.current.status).toBe('failed')
      expect(instances).toHaveLength(1)
      expect(probeSession).toHaveBeenCalledTimes(1)
      expect(expired).not.toHaveBeenCalled()
      stop()
    })

    it('a 4001 right after open signs out and does not reconnect', () => {
      const { expired, stop } = signOutSpy()
      const { result } = renderHook(() => useBoardSocket(1, vi.fn()))

      act(() => { latestWS().onopen?.() })
      act(() => { latestWS().onclose?.({ code: 4001 }) })
      act(() => { vi.advanceTimersByTime(10_000) })

      expect(result.current.status).toBe('failed')
      expect(instances).toHaveLength(1)
      expect(expired).toHaveBeenCalledTimes(1)
      stop()
    })

    it('a reconnect refused at the handshake stops the retries', () => {
      const onReconnected = vi.fn()
      const { result } = renderHook(() => useBoardSocket(1, vi.fn(), { onReconnected }))

      act(() => { latestWS().onopen?.() })
      act(() => { latestWS().onclose?.({ code: 1006 }) })
      act(() => { vi.advanceTimersByTime(3000) })
      expect(instances).toHaveLength(2)
      // Access was lost while the socket was down: the reconnect is refused.
      act(() => { latestWS().onopen?.() })
      act(() => { latestWS().onclose?.({ code: 4003 }) })
      act(() => { vi.advanceTimersByTime(10_000) })

      expect(result.current.status).toBe('failed')
      expect(instances).toHaveLength(2)
      expect(onReconnected).toHaveBeenCalledTimes(1)
    })
  })

  // 4503: the server's re-check failure since #2142. 1011: what it sent
  // before (Daphne still sends it on an unexpected server error, as may a
  // proxy), so it must stay retryable too.
  it.each([4503, 1011])('reconnects on a transient server failure (code %i), not failed (#2003, #2142)', (code) => {
    // The demo-reset routing that 4001/4003 trigger is pinned NOT to fire for
    // these codes in demoReset.test.ts, where a past reset time is stashed.
    const onReconnected = vi.fn()
    const expired = vi.fn()
    window.addEventListener('auth:sessionExpired', expired)
    const { result } = renderHook(() => useBoardSocket(1, vi.fn(), { onReconnected }))

    act(() => { latestWS().onopen?.() })
    act(() => { latestWS().onclose?.({ code }) })
    window.removeEventListener('auth:sessionExpired', expired)
    expect(expired).not.toHaveBeenCalled()

    expect(result.current.status).toBe('reconnecting')
    expect(result.current.reconnectAttempt).toBe(1)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(instances).toHaveLength(2)
    act(() => { latestWS().onopen?.() })
    expect(result.current.status).toBe('connected')
    expect(onReconnected).toHaveBeenCalledTimes(1)
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

  // ---------------------------------------------------------------------------
  // lastEventAt / reconnectAttempt (#851)
  // ---------------------------------------------------------------------------

  it('lastEventAt is null before any message arrives', () => {
    const onEvent = vi.fn()
    const { result } = renderHook(() => useBoardSocket(1, onEvent))

    act(() => { latestWS().onopen?.() })
    expect(result.current.lastEventAt).toBeNull()
  })

  it('lastEventAt ticks when an event arrives (including pings)', () => {
    vi.setSystemTime(new Date('2026-04-23T12:00:00Z'))
    const onEvent = vi.fn()
    const { result } = renderHook(() => useBoardSocket(1, onEvent))

    act(() => { latestWS().onopen?.() })

    const before = Date.now()
    act(() => {
      latestWS().onmessage?.({ data: JSON.stringify({ event: 'ping' }) })
    })
    expect(result.current.lastEventAt).toBe(before)

    // A real event also updates it.
    vi.setSystemTime(new Date('2026-04-23T12:00:05Z'))
    act(() => {
      latestWS().onmessage?.({ data: JSON.stringify({ event: 'card.created', data: { id: 1 } }) })
    })
    expect(result.current.lastEventAt).toBe(Date.now())
  })

  it('reconnectAttempt increments on each reconnect and resets on open', () => {
    const onEvent = vi.fn()
    const { result } = renderHook(() => useBoardSocket(1, onEvent))

    act(() => { latestWS().onopen?.() })
    expect(result.current.reconnectAttempt).toBe(0)

    act(() => { latestWS().onclose?.({ code: 1006 }) })
    expect(result.current.reconnectAttempt).toBe(1)

    act(() => { vi.advanceTimersByTime(3000) })
    act(() => { latestWS().onclose?.({ code: 1006 }) })
    expect(result.current.reconnectAttempt).toBe(2)

    // Successful open resets the counter.
    act(() => { vi.advanceTimersByTime(3000) })
    act(() => { latestWS().onopen?.() })
    expect(result.current.reconnectAttempt).toBe(0)
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

describe('useBoardSocket onReconnected (#1463)', () => {
  it('does not fire on the initial open', () => {
    const onReconnected = vi.fn()
    renderHook(() => useBoardSocket(1, vi.fn(), { onReconnected }))
    act(() => { latestWS().onopen?.() })
    expect(onReconnected).not.toHaveBeenCalled()
  })

  it('fires on each open after a drop', () => {
    const onReconnected = vi.fn()
    renderHook(() => useBoardSocket(1, vi.fn(), { onReconnected }))
    act(() => { latestWS().onopen?.() })
    for (let i = 1; i <= 2; i++) {
      act(() => { latestWS().onclose?.({ code: 1006 }) })
      act(() => { vi.advanceTimersByTime(3000) })
      act(() => { latestWS().onopen?.() })
      expect(onReconnected).toHaveBeenCalledTimes(i)
    }
  })

  it('treats a board change as an initial connect, not a reconnect', () => {
    const onReconnected = vi.fn()
    const { rerender } = renderHook(
      ({ id }) => useBoardSocket(id, vi.fn(), { onReconnected }),
      { initialProps: { id: 1 } },
    )
    act(() => { latestWS().onopen?.() })
    rerender({ id: 2 })
    act(() => { latestWS().onopen?.() })
    expect(onReconnected).not.toHaveBeenCalled()
  })

  it('does not fire when auth rejection stops reconnecting', () => {
    const onReconnected = vi.fn()
    renderHook(() => useBoardSocket(1, vi.fn(), { onReconnected }))
    act(() => { latestWS().onopen?.() })
    act(() => { latestWS().onclose?.({ code: 4003 }) })
    act(() => { vi.advanceTimersByTime(10000) })
    expect(instances).toHaveLength(1)
    expect(onReconnected).not.toHaveBeenCalled()
  })
})

describe('useBoardSocket onFirstConnected (#1968)', () => {
  it('fires once on the initial open, and not on later reconnects', () => {
    const onFirstConnected = vi.fn()
    const onReconnected = vi.fn()
    renderHook(() => useBoardSocket(1, vi.fn(), { onFirstConnected, onReconnected }))
    expect(onFirstConnected).not.toHaveBeenCalled()
    act(() => { latestWS().onopen?.() })
    expect(onFirstConnected).toHaveBeenCalledTimes(1)
    expect(onReconnected).not.toHaveBeenCalled()
    act(() => { latestWS().onclose?.({ code: 1006 }) })
    act(() => { vi.advanceTimersByTime(3000) })
    act(() => { latestWS().onopen?.() })
    expect(onFirstConnected).toHaveBeenCalledTimes(1)
    expect(onReconnected).toHaveBeenCalledTimes(1)
  })

  it('fires on a first open that only succeeds after failed attempts', () => {
    // A connect that never opened is not a reconnect, so onReconnected stays
    // silent; this first open is the caller's only chance to cover the gap.
    const onFirstConnected = vi.fn()
    const onReconnected = vi.fn()
    renderHook(() => useBoardSocket(1, vi.fn(), { onFirstConnected, onReconnected }))
    act(() => { latestWS().onclose?.({ code: 1006 }) })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(instances).toHaveLength(2)
    act(() => { latestWS().onopen?.() })
    expect(onFirstConnected).toHaveBeenCalledTimes(1)
    expect(onReconnected).not.toHaveBeenCalled()
  })

  it('fires again for the first open of another board', () => {
    const onFirstConnected = vi.fn()
    const { rerender } = renderHook(
      ({ id }) => useBoardSocket(id, vi.fn(), { onFirstConnected }),
      { initialProps: { id: 1 } },
    )
    act(() => { latestWS().onopen?.() })
    rerender({ id: 2 })
    act(() => { latestWS().onopen?.() })
    expect(onFirstConnected).toHaveBeenCalledTimes(2)
  })

  it('calls the latest callback without reopening the socket', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(
      ({ cb }) => useBoardSocket(1, vi.fn(), { onFirstConnected: cb }),
      { initialProps: { cb: first } },
    )
    rerender({ cb: second })
    act(() => { latestWS().onopen?.() })
    expect(instances).toHaveLength(1)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
