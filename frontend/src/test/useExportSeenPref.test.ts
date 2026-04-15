import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useExportSeenPref } from '../hooks/useExportSeenPref'

describe('useExportSeenPref', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('seen is false by default when no localStorage entry exists', () => {
    const { result } = renderHook(() => useExportSeenPref())
    expect(result.current[0]).toBe(false)
  })

  it('seen is true when localStorage already has "true" stored at the key', () => {
    localStorage.setItem('user:prefs:export-seen', 'true')
    const { result } = renderHook(() => useExportSeenPref())
    expect(result.current[0]).toBe(true)
  })

  it('calling markSeen() sets seen to true and writes "true" to localStorage', () => {
    const { result } = renderHook(() => useExportSeenPref())
    act(() => { result.current[1]() })
    expect(result.current[0]).toBe(true)
    expect(localStorage.getItem('user:prefs:export-seen')).toBe('true')
  })

  it('invalid JSON in localStorage falls back to false', () => {
    localStorage.setItem('user:prefs:export-seen', 'not-valid-json{{{')
    const { result } = renderHook(() => useExportSeenPref())
    expect(result.current[0]).toBe(false)
  })

  it('a non-true JSON value in localStorage falls back to false', () => {
    // JSON.parse("false") === false, so the === true guard should return false
    localStorage.setItem('user:prefs:export-seen', 'false')
    const { result } = renderHook(() => useExportSeenPref())
    expect(result.current[0]).toBe(false)
  })

  it('localStorage write failure is silent — seen still updates in memory', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded') })
    const { result } = renderHook(() => useExportSeenPref())
    expect(() => act(() => { result.current[1]() })).not.toThrow()
    // State is still updated in memory even though the write failed
    expect(result.current[0]).toBe(true)
  })

  it('falls back to false when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('security error') })
    const { result } = renderHook(() => useExportSeenPref())
    expect(result.current[0]).toBe(false)
  })

  it('a new hook instance reads the persisted value set by a previous instance', () => {
    const { result: first } = renderHook(() => useExportSeenPref())
    act(() => { first.current[1]() })
    const { result: second } = renderHook(() => useExportSeenPref())
    expect(second.current[0]).toBe(true)
  })
})
