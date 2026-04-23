import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useGroupSocket } from '../hooks/useGroupSocket'
import type { BoardEvent } from '../hooks/useBoardSocket'

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
})
