import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useShortcutsSeenPref } from '../hooks/useShortcutsSeenPref'

const STORAGE_KEY = 'user:prefs:shortcuts-seen'

describe('useShortcutsSeenPref', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('defaults to false when no stored value', () => {
    const { result } = renderHook(() => useShortcutsSeenPref())
    expect(result.current[0]).toBe(false)
  })

  it('returns true when stored value is true', () => {
    localStorage.setItem(STORAGE_KEY, 'true')
    const { result } = renderHook(() => useShortcutsSeenPref())
    expect(result.current[0]).toBe(true)
  })

  it('markSeen sets state to true', () => {
    const { result } = renderHook(() => useShortcutsSeenPref())
    act(() => { result.current[1]() })
    expect(result.current[0]).toBe(true)
  })

  it('markSeen persists true to localStorage', () => {
    const { result } = renderHook(() => useShortcutsSeenPref())
    act(() => { result.current[1]() })
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true')
  })

  it('new instance reads the value written by markSeen', () => {
    const { result: first } = renderHook(() => useShortcutsSeenPref())
    act(() => { first.current[1]() })
    const { result: second } = renderHook(() => useShortcutsSeenPref())
    expect(second.current[0]).toBe(true)
  })

  it('falls back to false when localStorage throws on read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('quota') })
    const { result } = renderHook(() => useShortcutsSeenPref())
    expect(result.current[0]).toBe(false)
  })

  it('fails silently when localStorage throws on write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const { result } = renderHook(() => useShortcutsSeenPref())
    expect(() => act(() => { result.current[1]() })).not.toThrow()
    expect(result.current[0]).toBe(true)
  })
})
