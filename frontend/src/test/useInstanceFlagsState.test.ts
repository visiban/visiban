import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useInstanceFlagsState } from '../hooks/useInstanceFlagsState'
import { DEFAULT_INSTANCE_FLAGS } from '../contexts/InstanceFlagsContext'

vi.mock('../api/auth', () => ({
  getSiteConfig: vi.fn(),
}))

import { getSiteConfig } from '../api/auth'

const mockGetSiteConfig = getSiteConfig as ReturnType<typeof vi.fn>

const baseConfig = {
  registration_open: true,
  registration_mode: 'open',
  demo_mode: false,
  demo_login: null,
  invite_email_available: false,
  git_lens_enabled: false,
  maintenance_mode: false,
  maintenance_message: '',
}

describe('useInstanceFlagsState (#1913)', () => {
  let origVisibilityState: PropertyDescriptor | undefined

  function setVisibility(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { value: state, writable: true, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    origVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  })

  afterEach(() => {
    if (origVisibilityState) Object.defineProperty(document, 'visibilityState', origVisibilityState)
  })

  it('starts on the all-off defaults and loads the flags from site-config', async () => {
    mockGetSiteConfig.mockResolvedValue({
      ...baseConfig, maintenance_mode: true, maintenance_message: 'Back by 14:00 UTC.',
    })
    const { result } = renderHook(() => useInstanceFlagsState(true))
    expect(result.current.flags).toEqual(DEFAULT_INSTANCE_FLAGS)
    expect(result.current.loaded).toBe(false)
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.flags.maintenance_mode).toBe(true)
    expect(result.current.flags.maintenance_message).toBe('Back by 14:00 UTC.')
  })

  it('falls back to defaults and still reports loaded when site-config fails', async () => {
    mockGetSiteConfig.mockRejectedValue(new Error('network'))
    const { result } = renderHook(() => useInstanceFlagsState(true))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.flags).toEqual(DEFAULT_INSTANCE_FLAGS)
  })

  it('tolerates a site-config body that omits the optional fields', async () => {
    mockGetSiteConfig.mockResolvedValue({ registration_open: true, registration_mode: 'open', demo_mode: true })
    const { result } = renderHook(() => useInstanceFlagsState(true))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.flags).toEqual({
      maintenance_mode: false, maintenance_message: '', demo_mode: true, demo_next_reset_at: null,
    })
  })

  it('flips into maintenance mode on the 503 event without refetching', async () => {
    mockGetSiteConfig.mockResolvedValue(baseConfig)
    const { result } = renderHook(() => useInstanceFlagsState(true))
    await waitFor(() => expect(result.current.loaded).toBe(true))

    act(() => {
      window.dispatchEvent(new CustomEvent('auth:maintenanceBlocked', { detail: { message: 'Back by 14:00 UTC.' } }))
    })

    expect(result.current.flags.maintenance_mode).toBe(true)
    expect(result.current.flags.maintenance_message).toBe('Back by 14:00 UTC.')
    expect(mockGetSiteConfig).toHaveBeenCalledTimes(1)
  })

  it('leaves an already-flagged state untouched on the event', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, maintenance_mode: true, maintenance_message: 'Original notice.' })
    const { result } = renderHook(() => useInstanceFlagsState(true))
    await waitFor(() => expect(result.current.loaded).toBe(true))

    act(() => {
      window.dispatchEvent(new CustomEvent('auth:maintenanceBlocked', { detail: { message: 'Different notice.' } }))
    })

    expect(result.current.flags.maintenance_message).toBe('Original notice.')
  })

  it('tolerates an event with no detail', async () => {
    mockGetSiteConfig.mockResolvedValue(baseConfig)
    const { result } = renderHook(() => useInstanceFlagsState(true))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    act(() => { window.dispatchEvent(new CustomEvent('auth:maintenanceBlocked')) })
    expect(result.current.flags.maintenance_mode).toBe(true)
    expect(result.current.flags.maintenance_message).toBe('')
  })

  it('refetches on tab focus so the banner can go away, merging the new state', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, maintenance_mode: true, maintenance_message: 'Soon.' })
    const { result } = renderHook(() => useInstanceFlagsState(true))
    await waitFor(() => expect(result.current.flags.maintenance_mode).toBe(true))

    mockGetSiteConfig.mockResolvedValue(baseConfig)
    setVisibility('visible')
    await waitFor(() => expect(result.current.flags.maintenance_mode).toBe(false))
    expect(result.current.flags.maintenance_message).toBe('')
    expect(mockGetSiteConfig).toHaveBeenCalledTimes(2)
  })

  it('throttles rapid tab switching to a single refetch', async () => {
    mockGetSiteConfig.mockResolvedValue(baseConfig)
    const { result } = renderHook(() => useInstanceFlagsState(true))
    await waitFor(() => expect(result.current.loaded).toBe(true))

    setVisibility('visible')
    setVisibility('hidden')
    setVisibility('visible')
    await waitFor(() => expect(mockGetSiteConfig).toHaveBeenCalledTimes(2))
    expect(mockGetSiteConfig).toHaveBeenCalledTimes(2)
  })

  it('does not refetch on tab focus while signed out', async () => {
    mockGetSiteConfig.mockResolvedValue(baseConfig)
    const { result } = renderHook(() => useInstanceFlagsState(false))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    setVisibility('visible')
    expect(mockGetSiteConfig).toHaveBeenCalledTimes(1)
  })

  it('a failed focus refetch keeps the last known flags', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, maintenance_mode: true, maintenance_message: 'Soon.' })
    const { result } = renderHook(() => useInstanceFlagsState(true))
    await waitFor(() => expect(result.current.flags.maintenance_mode).toBe(true))

    mockGetSiteConfig.mockRejectedValueOnce(new Error('network'))
    setVisibility('visible')
    await waitFor(() => expect(mockGetSiteConfig).toHaveBeenCalledTimes(2))
    expect(result.current.flags.maintenance_mode).toBe(true)
  })

  it('does not refetch on sign-in right after the bootstrap fetch, but does once it is stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      mockGetSiteConfig.mockResolvedValue(baseConfig)
      const { result, rerender } = renderHook(({ signedIn }) => useInstanceFlagsState(signedIn), {
        initialProps: { signedIn: false },
      })
      await waitFor(() => expect(result.current.loaded).toBe(true))
      rerender({ signedIn: true })
      expect(mockGetSiteConfig).toHaveBeenCalledTimes(1)

      rerender({ signedIn: false })
      vi.setSystemTime(Date.now() + 60_000)
      rerender({ signedIn: true })
      await waitFor(() => expect(mockGetSiteConfig).toHaveBeenCalledTimes(2))
    } finally {
      vi.useRealTimers()
    }
  })

  it('stashes the next demo reset instant while signed in, and clears it outside demo mode', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, demo_mode: true, demo_next_reset_at: '2026-09-27T13:00:00Z' })
    const first = renderHook(() => useInstanceFlagsState(true))
    // stashDemoNextReset re-serializes to canonical ISO, so the stored form has milliseconds.
    await waitFor(() => expect(sessionStorage.getItem('demo_next_reset_at')).toBe('2026-09-27T13:00:00.000Z'))
    first.unmount()

    mockGetSiteConfig.mockResolvedValue(baseConfig)
    const second = renderHook(() => useInstanceFlagsState(true))
    await waitFor(() => expect(second.result.current.loaded).toBe(true))
    await waitFor(() => expect(sessionStorage.getItem('demo_next_reset_at')).toBeNull())
  })

  it('does not stash anything while signed out', async () => {
    mockGetSiteConfig.mockResolvedValue({ ...baseConfig, demo_mode: true, demo_next_reset_at: '2026-09-27T13:00:00Z' })
    const { result } = renderHook(() => useInstanceFlagsState(false))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(sessionStorage.getItem('demo_next_reset_at')).toBeNull()
  })
})
