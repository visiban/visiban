import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useOverflowSeenPref } from '../hooks/useOverflowSeenPref'

const STORAGE_KEY = 'user:prefs:overflow-seen'

describe('useOverflowSeenPref', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
  })

  it('defaults to false when nothing is stored', () => {
    const { result } = renderHook(() => useOverflowSeenPref())
    const [seen] = result.current
    expect(seen).toBe(false)
  })

  it('returns true after markSeen() is called', () => {
    const { result } = renderHook(() => useOverflowSeenPref())
    const [, markSeen] = result.current
    act(() => {
      markSeen()
    })
    const [seen] = result.current
    expect(seen).toBe(true)
  })

  it('persists seen=true to localStorage', () => {
    const { result } = renderHook(() => useOverflowSeenPref())
    const [, markSeen] = result.current
    act(() => {
      markSeen()
    })
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true')
  })

  it('rehydrates seen=true from localStorage on next mount', () => {
    window.localStorage.setItem(STORAGE_KEY, 'true')
    const { result } = renderHook(() => useOverflowSeenPref())
    const [seen] = result.current
    expect(seen).toBe(true)
  })

  it('is independent from export-seen and shortcuts-seen keys', () => {
    window.localStorage.setItem('user:prefs:export-seen', 'true')
    window.localStorage.setItem('user:prefs:shortcuts-seen', 'true')
    const { result } = renderHook(() => useOverflowSeenPref())
    const [seen] = result.current
    expect(seen).toBe(false)
  })

  it('tolerates malformed stored values and falls back to false', () => {
    window.localStorage.setItem(STORAGE_KEY, 'not-json')
    const { result } = renderHook(() => useOverflowSeenPref())
    const [seen] = result.current
    expect(seen).toBe(false)
  })
})
