import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AnalyticsRetryCanceled, analyticsErrorKind, analyticsErrorMessage, analyticsErrorRetryable, cancelableWait,
  withAnalyticsBusyRetry, worstAnalyticsErrorKind,
} from '../api/analyticsErrors'
import { retryAfterDelayMs } from '../api/retryAfter'
import { sessionRetryDelayMs } from '../hooks/useAuth'

const refusal = (status: number, code: string, retryAfter?: string) => ({
  response: { status, data: { code, detail: 'x' }, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } },
})
const busy = (retryAfter = '10') => refusal(503, 'analytics_busy', retryAfter)
const tooLarge = refusal(422, 'analytics_too_large')

describe('analyticsErrorKind (#2428)', () => {
  it('matches on status and code together', () => {
    expect(analyticsErrorKind(busy())).toBe('busy')
    expect(analyticsErrorKind(tooLarge)).toBe('too_large')
    expect(analyticsErrorKind(refusal(503, 'session_unavailable'))).toBe('other')
    expect(analyticsErrorKind(refusal(500, 'analytics_busy'))).toBe('other')
    expect(analyticsErrorKind(refusal(503, 'analytics_too_large'))).toBe('other')
    expect(analyticsErrorKind(new Error('network'))).toBe('other')
    expect(analyticsErrorKind(null)).toBe('other')
  })

  it('ranks too_large over busy over anything else', () => {
    expect(worstAnalyticsErrorKind([busy(), tooLarge, new Error('x')])).toBe('too_large')
    expect(worstAnalyticsErrorKind([new Error('x'), busy()])).toBe('busy')
    expect(worstAnalyticsErrorKind([new Error('x')])).toBe('other')
    expect(worstAnalyticsErrorKind([])).toBe('other')
  })

  it('has copy per kind, and only too_large is not retryable', () => {
    expect(analyticsErrorMessage('busy')).toBe('Analytics is busy right now. Try again in a moment.')
    expect(analyticsErrorMessage('too_large')).toBe(
      'This board has more history than this server is set up to analyze. Try a shorter period, or ask your administrator.',
    )
    expect(analyticsErrorMessage('other')).toBeNull()
    expect(analyticsErrorMessage('too_large', { wholeHistory: true })).toBe(
      "This board has more history than this server is set up to analyze, so these cards can't be listed here. Ask your administrator.",
    )
    expect(analyticsErrorMessage('busy', { wholeHistory: true })).toBe('Analytics is busy right now. Try again in a moment.')
    expect(analyticsErrorRetryable('busy')).toBe(true)
    expect(analyticsErrorRetryable('other')).toBe(true)
    expect(analyticsErrorRetryable('too_large')).toBe(false)
  })
})

describe('analytics_timeout (#2645)', () => {
  const timeout = refusal(503, 'analytics_timeout')

  it('matches status 503 with the code, and ranks between too_large and busy', () => {
    expect(analyticsErrorKind(timeout)).toBe('timeout')
    expect(analyticsErrorKind(refusal(422, 'analytics_timeout'))).toBe('other')
    expect(worstAnalyticsErrorKind([busy(), timeout])).toBe('timeout')
    expect(worstAnalyticsErrorKind([timeout, tooLarge])).toBe('too_large')
  })

  it('has per-surface copy and is not retryable', () => {
    expect(analyticsErrorMessage('timeout')).toBe(
      'This took longer than the server allows. Try a shorter period, or ask your administrator.',
    )
    expect(analyticsErrorMessage('timeout', { wholeHistory: true })).toBe(
      "This took longer than the server allows, so these cards can't be listed here. Ask your administrator.",
    )
    expect(analyticsErrorMessage('timeout', { noPeriod: true })).toBe(
      'This took longer than the server allows. Ask your administrator.',
    )
    expect(analyticsErrorRetryable('timeout')).toBe(false)
  })
})

describe('retryAfterDelayMs', () => {
  it('reads Retry-After in seconds, clamped to 1-60 s, with a default', () => {
    expect(retryAfterDelayMs(busy('10'), 5_000)).toBe(10_000)
    expect(retryAfterDelayMs(busy('0.2'), 5_000)).toBe(1_000)
    expect(retryAfterDelayMs(busy('600'), 5_000)).toBe(60_000)
    expect(retryAfterDelayMs(busy('soon'), 5_000)).toBe(5_000)
    expect(retryAfterDelayMs(busy('-3'), 5_000)).toBe(5_000)
    expect(retryAfterDelayMs(refusal(503, 'analytics_busy'), 5_000)).toBe(5_000)
    expect(retryAfterDelayMs(null, 5_000)).toBe(5_000)
  })

  it('is what the session retry uses', () => {
    expect(sessionRetryDelayMs(busy('7'))).toBe(7_000)
    expect(sessionRetryDelayMs({})).toBe(10_000)
  })
})

describe('withAnalyticsBusyRetry', () => {
  afterEach(() => { vi.useRealTimers() })

  it('retries a busy answer once after its Retry-After', async () => {
    vi.useFakeTimers()
    const request = vi.fn().mockRejectedValueOnce(busy('3')).mockResolvedValueOnce('ok')
    const result = withAnalyticsBusyRetry(request)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toBe('ok')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('clamps the wait and gives up after the second busy', async () => {
    const waits: number[] = []
    const request = vi.fn().mockRejectedValue(busy('600'))
    await expect(withAnalyticsBusyRetry(request, async (ms) => { waits.push(ms) })).rejects.toEqual(busy('600'))
    expect(waits).toEqual([60_000])
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('drops a pending retry once its signal aborts, clearing the timer', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const request = vi.fn().mockRejectedValueOnce(busy('5')).mockResolvedValueOnce('late')
    const result = withAnalyticsBusyRetry(request, cancelableWait, controller.signal)
    const outcome = expect(result).rejects.toBeInstanceOf(AnalyticsRetryCanceled)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    await outcome
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('never sends the retry when the signal aborts during a custom wait, or before it', async () => {
    const controller = new AbortController()
    const request = vi.fn().mockRejectedValue(busy('1'))
    await expect(withAnalyticsBusyRetry(request, async () => { controller.abort() }, controller.signal))
      .rejects.toBeInstanceOf(AnalyticsRetryCanceled)
    expect(request).toHaveBeenCalledTimes(1)
    await expect(cancelableWait(1_000, controller.signal)).rejects.toBeInstanceOf(AnalyticsRetryCanceled)
  })

  it('waits the full delay with no signal', async () => {
    vi.useFakeTimers()
    let done = false
    void cancelableWait(500).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(499)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })

  it('never retries too_large or other failures', async () => {
    for (const error of [tooLarge, new Error('x')]) {
      const wait = vi.fn(async () => {})
      const request = vi.fn().mockRejectedValue(error)
      await expect(withAnalyticsBusyRetry(request, wait)).rejects.toBe(error)
      expect(request).toHaveBeenCalledTimes(1)
      expect(wait).not.toHaveBeenCalled()
    }
  })
})
