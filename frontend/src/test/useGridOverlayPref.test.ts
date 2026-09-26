/** Tests for the board-scoped grid-overlay preference hook (#1147). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useGridOverlayPref } from '../hooks/useGridOverlayPref'

const KEY = 'board:7:grid-overlay'

describe('useGridOverlayPref', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('defaults to None when nothing is stored', () => {
    const { result } = renderHook(() => useGridOverlayPref(7))
    expect(result.current[0]).toBe('none')
  })

  it('reads a stored overlay id back', () => {
    localStorage.setItem(KEY, 'card-count')
    const { result } = renderHook(() => useGridOverlayPref(7))
    expect(result.current[0]).toBe('card-count')
  })

  it('degrades an id this build does not know to None rather than throwing', () => {
    // What a #1146 preset naming a newer overlay, or a stale value, looks like.
    localStorage.setItem(KEY, 'dwell-time')
    const { result } = renderHook(() => useGridOverlayPref(7))
    expect(result.current[0]).toBe('none')
  })

  it('persists a new choice under the board-scoped key', () => {
    const { result } = renderHook(() => useGridOverlayPref(7))
    act(() => result.current[1]('card-count'))
    expect(result.current[0]).toBe('card-count')
    expect(localStorage.getItem(KEY)).toBe('card-count')
  })

  it('treats null as turning the overlay off', () => {
    localStorage.setItem(KEY, 'card-count')
    const { result } = renderHook(() => useGridOverlayPref(7))
    act(() => result.current[1](null))
    expect(result.current[0]).toBe('none')
  })

  it('never stores an id this build cannot render', () => {
    const { result } = renderHook(() => useGridOverlayPref(7))
    act(() => result.current[1]('dwell-time'))
    expect(result.current[0]).toBe('none')
    expect(localStorage.getItem(KEY)).toBe('none')
  })

  it('keeps each board separate', () => {
    localStorage.setItem('board:7:grid-overlay', 'card-count')
    const { result } = renderHook(() => useGridOverlayPref(8))
    expect(result.current[0]).toBe('none')
  })

  it('falls back to None when localStorage reads throw (private browsing)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const { result } = renderHook(() => useGridOverlayPref(7))
    expect(result.current[0]).toBe('none')
  })

  it('still updates state when localStorage writes throw (quota exceeded)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const { result } = renderHook(() => useGridOverlayPref(7))
    act(() => result.current[1]('card-count'))
    expect(result.current[0]).toBe('card-count')
  })
})
