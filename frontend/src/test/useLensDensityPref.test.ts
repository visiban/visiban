import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLensDensityPref } from '../hooks/useLensDensityPref'

describe('useLensDensityPref', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('defaults to comfortable when no stored value', () => {
    const { result } = renderHook(() => useLensDensityPref())
    expect(result.current[0]).toBe('comfortable')
  })

  it('returns compact when stored', () => {
    localStorage.setItem('user:prefs:lens-density', 'compact')
    const { result } = renderHook(() => useLensDensityPref())
    expect(result.current[0]).toBe('compact')
  })

  it('setting compact persists and updates state', () => {
    const { result } = renderHook(() => useLensDensityPref())
    act(() => { result.current[1]('compact') })
    expect(result.current[0]).toBe('compact')
    expect(localStorage.getItem('user:prefs:lens-density')).toBe('compact')
  })

  it('falls back to comfortable when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const { result } = renderHook(() => useLensDensityPref())
    expect(result.current[0]).toBe('comfortable')
  })
})
