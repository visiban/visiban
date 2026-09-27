/**
 * Hosted-demo reset detection (#1179): the shared helper, and the two places
 * that call it — the REST 401 interceptor and the WebSocket 4001/4003 close.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  checkAndFlagDemoReset,
  consumeDemoResetNotice,
  stashDemoNextReset,
  DEMO_NEXT_RESET_KEY,
  DEMO_RESET_NOTICE_KEY,
} from '../utils/demoReset'
import { useBoardSocket } from '../hooks/useBoardSocket'

const RESET = '2026-09-27T13:00:00Z'

beforeEach(() => sessionStorage.clear())
afterEach(() => sessionStorage.clear())

describe('demoReset helper', () => {
  it('does nothing without a stashed reset instant', () => {
    expect(checkAndFlagDemoReset(Date.parse(RESET) + 1)).toBe(false)
    expect(sessionStorage.getItem(DEMO_RESET_NOTICE_KEY)).toBeNull()
  })

  it('does not flag an auth failure before the reset time', () => {
    stashDemoNextReset(RESET)
    expect(checkAndFlagDemoReset(Date.parse(RESET) - 1)).toBe(false)
    expect(sessionStorage.getItem(DEMO_NEXT_RESET_KEY)).toBe(RESET)
  })

  it('flags the notice once the reset time has passed, and consumes it once', () => {
    stashDemoNextReset(RESET)
    expect(checkAndFlagDemoReset(Date.parse(RESET))).toBe(true)
    expect(sessionStorage.getItem(DEMO_NEXT_RESET_KEY)).toBeNull()
    expect(consumeDemoResetNotice()).toBe(RESET)
    expect(consumeDemoResetNotice()).toBeNull()
  })

  it('stashing null forgets the instant (sign-out, non-demo user)', () => {
    stashDemoNextReset(RESET)
    stashDemoNextReset(null)
    expect(sessionStorage.getItem(DEMO_NEXT_RESET_KEY)).toBeNull()
  })
})

describe('api client — demo interceptors', () => {
  async function runRejection(response: unknown) {
    const client = (await import('../api/client')).default
    const handlers = (client.interceptors.response as unknown as {
      handlers: Array<{ rejected?: (e: unknown) => unknown }>
    }).handlers
    for (const h of handlers) {
      if (h.rejected) {
        try { await h.rejected({ response }) } catch { /* re-rejects by design */ }
      }
    }
  }

  it('a 401 after the reset flags the notice, then dispatches the usual sessionExpired', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse(RESET) + 60_000)
    stashDemoNextReset(RESET)
    const expired = vi.fn()
    window.addEventListener('auth:sessionExpired', expired)
    await runRejection({ status: 401, data: {} })
    window.removeEventListener('auth:sessionExpired', expired)
    vi.useRealTimers()
    expect(expired).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(DEMO_RESET_NOTICE_KEY)).toBe(RESET)
  })

  it('a 401 before the reset is a plain expiry — no notice', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse(RESET) - 60_000)
    stashDemoNextReset(RESET)
    await runRejection({ status: 401, data: {} })
    vi.useRealTimers()
    expect(sessionStorage.getItem(DEMO_RESET_NOTICE_KEY)).toBeNull()
  })

  it('a 403 demo_read_only dispatches auth:demoWriteBlocked with the detail', async () => {
    const received: string[] = []
    const listener = (e: Event) => received.push((e as CustomEvent<{ message: string }>).detail.message)
    window.addEventListener('auth:demoWriteBlocked', listener)
    await runRejection({ status: 403, data: { code: 'demo_read_only', detail: 'This is a shared demo — nope.' } })
    await runRejection({ status: 403, data: { detail: 'You do not have permission.' } })
    window.removeEventListener('auth:demoWriteBlocked', listener)
    expect(received).toEqual(['This is a shared demo — nope.'])
  })
})

describe('useBoardSocket — idle visitor across a reset', () => {
  let instances: Array<{ onclose: ((ev: { code: number }) => void) | null }> = []
  class MockWebSocket {
    onopen = null
    onmessage = null
    onclose: ((ev: { code: number }) => void) | null = null
    close = vi.fn()
    constructor() { instances.push(this) }
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

  it.each([4001, 4003])('close %i after the reset time routes to the reset notice', (code) => {
    vi.setSystemTime(Date.parse(RESET) + 1_000)
    stashDemoNextReset(RESET)
    const expired = vi.fn()
    window.addEventListener('auth:sessionExpired', expired)
    renderHook(() => useBoardSocket(1, vi.fn()))
    act(() => { instances[instances.length - 1].onclose?.({ code }) })
    window.removeEventListener('auth:sessionExpired', expired)
    expect(expired).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(DEMO_RESET_NOTICE_KEY)).toBe(RESET)
  })

  it('an auth close before the reset time keeps the old behavior (no sign-out event)', () => {
    vi.setSystemTime(Date.parse(RESET) - 1_000)
    stashDemoNextReset(RESET)
    const expired = vi.fn()
    window.addEventListener('auth:sessionExpired', expired)
    renderHook(() => useBoardSocket(1, vi.fn()))
    act(() => { instances[instances.length - 1].onclose?.({ code: 4001 }) })
    window.removeEventListener('auth:sessionExpired', expired)
    expect(expired).not.toHaveBeenCalled()
  })
})
