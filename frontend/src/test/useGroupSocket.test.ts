import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useGroupSocket } from '../hooks/useGroupSocket'
import type { BoardEvent } from '../hooks/useBoardSocket'
import { probeSession } from '../utils/sessionProbe'
import { stashDemoNextReset, DEMO_RESET_NOTICE_KEY, DEMO_NEXT_RESET_KEY } from '../utils/demoReset'

// A 4003 close probes the session (#2037, #2044); stub it so these tests make
// no real network call. The probe itself is covered in demoReset.test.ts.
vi.mock('../utils/sessionProbe', () => ({ probeSession: vi.fn().mockResolvedValue(undefined) }))

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
  vi.mocked(probeSession).mockClear()
  sessionStorage.removeItem(DEMO_RESET_NOTICE_KEY)
  sessionStorage.removeItem(DEMO_NEXT_RESET_KEY)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function latestWS(): MockWSInstance {
  return instances[instances.length - 1]
}

describe('useGroupSocket', () => {
  it('connects to the /ws/groups/<id>/ path', () => {
    vi.stubEnv('VITE_API_URL', 'http://api.example.com')
    renderHook(() => useGroupSocket(7, vi.fn()))
    expect(latestWS().url).toBe('ws://api.example.com/ws/groups/7/')
  })

  it('does not connect when groupId is null', () => {
    renderHook(() => useGroupSocket(null, vi.fn()))
    expect(instances).toHaveLength(0)
  })

  it('dispatches board.created events to onEvent', () => {
    const onEvent = vi.fn()
    renderHook(() => useGroupSocket(1, onEvent))
    const event: BoardEvent = { event: 'board.created', data: { id: 42, name: 'New' } }
    act(() => { latestWS().onmessage?.({ data: JSON.stringify(event) }) })
    expect(onEvent).toHaveBeenCalledWith(event)
  })

  it('silently ignores ping events', () => {
    const onEvent = vi.fn()
    renderHook(() => useGroupSocket(1, onEvent))
    act(() => { latestWS().onmessage?.({ data: JSON.stringify({ event: 'ping' }) }) })
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('reports status=failed on 4003 and does not reconnect', () => {
    const { result } = renderHook(() => useGroupSocket(1, vi.fn()))
    act(() => { latestWS().onclose?.({ code: 4003 }) })
    act(() => { vi.advanceTimersByTime(5000) })
    expect(result.current.status).toBe('failed')
    expect(instances).toHaveLength(1)
  })

  describe('auth close and session expiry (#2044)', () => {
    const RESET = '2026-06-01T12:00:00.000Z'
    const listen = () => {
      const expired = vi.fn()
      window.addEventListener('auth:sessionExpired', expired)
      return { expired, stop: () => window.removeEventListener('auth:sessionExpired', expired) }
    }

    it('4001 signs out directly, with no probe and no reconnect', () => {
      const { expired, stop } = listen()
      const { result } = renderHook(() => useGroupSocket(1, vi.fn()))
      act(() => { latestWS().onclose?.({ code: 4001 }) })
      act(() => { vi.advanceTimersByTime(10_000) })
      stop()
      expect(expired).toHaveBeenCalledTimes(1)
      expect(probeSession).not.toHaveBeenCalled()
      expect(result.current.status).toBe('failed')
      expect(instances).toHaveLength(1)
    })

    it('4003 probes the session once and dispatches nothing itself (live session = lost access stays signed in)', () => {
      const { expired, stop } = listen()
      const { result } = renderHook(() => useGroupSocket(1, vi.fn()))
      act(() => { latestWS().onclose?.({ code: 4003 }) })
      stop()
      expect(probeSession).toHaveBeenCalledTimes(1)
      expect(expired).not.toHaveBeenCalled()
      expect(result.current.status).toBe('failed')
    })

    it.each([4001, 4003])('close %i after the demo reset time routes to the reset notice without probing', (code) => {
      vi.setSystemTime(Date.parse(RESET) + 1_000)
      stashDemoNextReset(RESET)
      const { expired, stop } = listen()
      renderHook(() => useGroupSocket(1, vi.fn()))
      act(() => { latestWS().onclose?.({ code }) })
      stop()
      expect(expired).toHaveBeenCalledTimes(1)
      expect(probeSession).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(DEMO_RESET_NOTICE_KEY)).toBe(RESET)
    })

    // The server refuses a handshake by accepting and closing at once (#2145),
    // so a refusal reaches the hook as onopen followed by the close code.
    it.each([
      [4001, 1, 0],
      [4003, 0, 1],
    ])('a %i right after open (handshake refusal) stops as failed', (code, signOuts, probes) => {
      const { expired, stop } = listen()
      const { result } = renderHook(() => useGroupSocket(1, vi.fn()))
      act(() => { latestWS().onopen?.() })
      act(() => { latestWS().onclose?.({ code }) })
      act(() => { vi.advanceTimersByTime(10_000) })
      stop()
      expect(result.current.status).toBe('failed')
      expect(instances).toHaveLength(1)
      expect(expired).toHaveBeenCalledTimes(signOuts)
      expect(probeSession).toHaveBeenCalledTimes(probes)
    })

    it('a close after unmount neither dispatches nor probes', () => {
      const { expired, stop } = listen()
      const { unmount } = renderHook(() => useGroupSocket(1, vi.fn()))
      const ws = latestWS()
      unmount()
      act(() => { ws.onclose?.({ code: 4003 }) })
      stop()
      expect(probeSession).not.toHaveBeenCalled()
      expect(expired).not.toHaveBeenCalled()
    })
  })

  it('reconnects on a transient server re-check failure (code 1011), not failed (#2003)', () => {
    const onReconnected = vi.fn()
    const { result } = renderHook(() => useGroupSocket(1, vi.fn(), { onReconnected }))
    act(() => { latestWS().onopen?.() })
    act(() => { latestWS().onclose?.({ code: 1011 }) })
    expect(result.current.status).toBe('reconnecting')
    act(() => { vi.advanceTimersByTime(3000) })
    expect(instances).toHaveLength(2)
    act(() => { latestWS().onopen?.() })
    expect(result.current.status).toBe('connected')
    expect(onReconnected).toHaveBeenCalledTimes(1)
  })

  it('reconnects 3 s after an unexpected close', () => {
    const { result } = renderHook(() => useGroupSocket(1, vi.fn()))
    act(() => { latestWS().onopen?.() })
    act(() => { latestWS().onclose?.({ code: 1006 }) })
    expect(result.current.status).toBe('reconnecting')
    act(() => { vi.advanceTimersByTime(3000) })
    expect(instances).toHaveLength(2)
  })

  it('fires onReconnected only on the *second* open', () => {
    const onReconnected = vi.fn()
    renderHook(() => useGroupSocket(1, vi.fn(), { onReconnected }))
    act(() => { latestWS().onopen?.() })
    expect(onReconnected).not.toHaveBeenCalled()
    act(() => { latestWS().onclose?.({ code: 1006 }) })
    act(() => { vi.advanceTimersByTime(3000) })
    act(() => { latestWS().onopen?.() })
    expect(onReconnected).toHaveBeenCalledTimes(1)
  })

  it('closes the socket on unmount', () => {
    const { unmount } = renderHook(() => useGroupSocket(1, vi.fn()))
    const ws = latestWS()
    unmount()
    expect(ws.close).toHaveBeenCalledWith(1000)
  })

  it('does not reconnect or re-read when its own unmount closes the socket (code 1000)', () => {
    const onServerClose = vi.fn()
    const { unmount } = renderHook(() => useGroupSocket(7, vi.fn(), { onServerClose }))
    const ws = latestWS()
    unmount()
    act(() => { ws.onclose?.({ code: 1000 }) })
    act(() => { vi.advanceTimersByTime(5000) })
    expect(instances).toHaveLength(1)
    expect(onServerClose).not.toHaveBeenCalled()
  })

  it('does not treat a group change as a server close', () => {
    const onServerClose = vi.fn()
    const { rerender } = renderHook(({ id }) => useGroupSocket(id, vi.fn(), { onServerClose }), { initialProps: { id: 7 } })
    const first = latestWS()
    rerender({ id: 8 })
    act(() => { first.onclose?.({ code: 1000 }) })
    expect(onServerClose).not.toHaveBeenCalled()
  })

  it('a server-sent 1000 (member removed) calls onServerClose and reconnects once (#2041)', () => {
    const onServerClose = vi.fn()
    const { result } = renderHook(() => useGroupSocket(7, vi.fn(), { onServerClose }))
    act(() => { latestWS().onclose?.({ code: 1000 }) })
    expect(onServerClose).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('reconnecting')
    act(() => { vi.advanceTimersByTime(3000) })
    expect(instances).toHaveLength(2)
  })

  it('a second server 1000 before any frame stops as failed instead of looping (#2041)', () => {
    const { result } = renderHook(() => useGroupSocket(7, vi.fn(), { onServerClose: vi.fn() }))
    act(() => { latestWS().onclose?.({ code: 1000 }) })
    act(() => { vi.advanceTimersByTime(3000) })
    act(() => { latestWS().onclose?.({ code: 1000 }) })
    act(() => { vi.advanceTimersByTime(10000) })
    expect(instances).toHaveLength(2)
    expect(result.current.status).toBe('failed')
  })

  it('fires onFirstConnected on the first open only, and onReconnected on later opens (#2088)', () => {
    const onFirstConnected = vi.fn()
    const onReconnected = vi.fn()
    renderHook(() => useGroupSocket(7, vi.fn(), { onFirstConnected, onReconnected }))
    act(() => { latestWS().onopen?.() })
    expect(onFirstConnected).toHaveBeenCalledTimes(1)
    expect(onReconnected).not.toHaveBeenCalled()
    act(() => { latestWS().onclose?.({ code: 1006 }) })
    act(() => { vi.advanceTimersByTime(3000) })
    act(() => { latestWS().onopen?.() })
    expect(onFirstConnected).toHaveBeenCalledTimes(1)
    expect(onReconnected).toHaveBeenCalledTimes(1)
  })

  it('fires onFirstConnected for a first open that follows failed attempts (#2088)', () => {
    const onFirstConnected = vi.fn()
    renderHook(() => useGroupSocket(7, vi.fn(), { onFirstConnected }))
    act(() => { latestWS().onclose?.({ code: 1006 }) })
    expect(onFirstConnected).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(3000) })
    act(() => { latestWS().onopen?.() })
    expect(onFirstConnected).toHaveBeenCalledTimes(1)
  })
})
