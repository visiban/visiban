import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCardLayoutPref } from '../hooks/useCardLayoutPref'

const STORAGE_KEY = 'user:prefs:card-layout'

describe('useCardLayoutPref', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('defaults to expanded when no stored value', () => {
    const { result } = renderHook(() => useCardLayoutPref())
    expect(result.current[0]).toBe('expanded')
  })

  it('returns compact when stored value is compact', () => {
    localStorage.setItem(STORAGE_KEY, 'compact')
    const { result } = renderHook(() => useCardLayoutPref())
    expect(result.current[0]).toBe('compact')
  })

  it('returns expanded when stored value is expanded', () => {
    localStorage.setItem(STORAGE_KEY, 'expanded')
    const { result } = renderHook(() => useCardLayoutPref())
    expect(result.current[0]).toBe('expanded')
  })

  it('setting compact persists to localStorage and updates state', () => {
    const { result } = renderHook(() => useCardLayoutPref())
    act(() => { result.current[1]('compact') })
    expect(result.current[0]).toBe('compact')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('compact')
  })

  it('setting expanded persists to localStorage and updates state', () => {
    localStorage.setItem(STORAGE_KEY, 'compact')
    const { result } = renderHook(() => useCardLayoutPref())
    act(() => { result.current[1]('expanded') })
    expect(result.current[0]).toBe('expanded')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('expanded')
  })

  it('falls back to expanded when localStorage throws on read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('quota') })
    const { result } = renderHook(() => useCardLayoutPref())
    expect(result.current[0]).toBe('expanded')
  })

  it('falls back to expanded when stored value is malformed', () => {
    // Only "compact" is accepted; anything else (including garbage) resolves to "expanded"
    localStorage.setItem(STORAGE_KEY, 'COMPACT')
    const { result: upper } = renderHook(() => useCardLayoutPref())
    expect(upper.current[0]).toBe('expanded')

    localStorage.setItem(STORAGE_KEY, 'true')
    const { result: bool } = renderHook(() => useCardLayoutPref())
    expect(bool.current[0]).toBe('expanded')

    localStorage.setItem(STORAGE_KEY, '{"layout":"compact"}')
    const { result: json } = renderHook(() => useCardLayoutPref())
    expect(json.current[0]).toBe('expanded')
  })

  it('fails silently when localStorage throws on write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const { result } = renderHook(() => useCardLayoutPref())
    expect(() => act(() => { result.current[1]('compact') })).not.toThrow()
    // State should still update even if persistence fails
    expect(result.current[0]).toBe('compact')
  })

  it('new hook instance reads the persisted value set by a previous instance', () => {
    const { result: first } = renderHook(() => useCardLayoutPref())
    act(() => { first.current[1]('compact') })
    const { result: second } = renderHook(() => useCardLayoutPref())
    expect(second.current[0]).toBe('compact')
  })

  it('toggling compact then back to expanded round-trips correctly', () => {
    const { result } = renderHook(() => useCardLayoutPref())
    act(() => { result.current[1]('compact') })
    expect(result.current[0]).toBe('compact')
    act(() => { result.current[1]('expanded') })
    expect(result.current[0]).toBe('expanded')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('expanded')
  })
})
