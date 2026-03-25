import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useShowFullHistoryPref } from '../hooks/useShowFullHistoryPref'

describe('useShowFullHistoryPref', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('defaults to false when no stored value', () => {
    const { result } = renderHook(() => useShowFullHistoryPref())
    expect(result.current[0]).toBe(false)
  })

  it('returns true when stored value is true', () => {
    localStorage.setItem('user:prefs:show-full-history', 'true')
    const { result } = renderHook(() => useShowFullHistoryPref())
    expect(result.current[0]).toBe(true)
  })

  it('setting true persists to localStorage and updates state', () => {
    const { result } = renderHook(() => useShowFullHistoryPref())
    act(() => { result.current[1](true) })
    expect(result.current[0]).toBe(true)
    expect(localStorage.getItem('user:prefs:show-full-history')).toBe('true')
  })

  it('setting false persists false and updates state', () => {
    localStorage.setItem('user:prefs:show-full-history', 'true')
    const { result } = renderHook(() => useShowFullHistoryPref())
    act(() => { result.current[1](false) })
    expect(result.current[0]).toBe(false)
    expect(localStorage.getItem('user:prefs:show-full-history')).toBe('false')
  })

  it('falls back to false when localStorage throws on read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('quota') })
    const { result } = renderHook(() => useShowFullHistoryPref())
    expect(result.current[0]).toBe(false)
  })

  it('fails silently when localStorage throws on write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const { result } = renderHook(() => useShowFullHistoryPref())
    expect(() => act(() => { result.current[1](true) })).not.toThrow()
  })

  it('new hook instance reads the persisted value set by a previous instance', () => {
    const { result: first } = renderHook(() => useShowFullHistoryPref())
    act(() => { first.current[1](true) })
    const { result: second } = renderHook(() => useShowFullHistoryPref())
    expect(second.current[0]).toBe(true)
  })
})
