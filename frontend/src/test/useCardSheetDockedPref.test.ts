import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { CARD_SHEET_DOCKED_KEY, useCardSheetDockedPref } from '../hooks/useCardSheetDockedPref'

describe('useCardSheetDockedPref (#1915)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('uses the user:prefs namespace key', () => {
    expect(CARD_SHEET_DOCKED_KEY).toBe('user:prefs:card-sheet-docked')
  })

  it('defaults to false when nothing is stored', () => {
    expect(renderHook(() => useCardSheetDockedPref()).result.current[0]).toBe(false)
  })

  it('reads a stored true, and treats any other value as false', () => {
    localStorage.setItem(CARD_SHEET_DOCKED_KEY, 'true')
    expect(renderHook(() => useCardSheetDockedPref()).result.current[0]).toBe(true)
    localStorage.setItem(CARD_SHEET_DOCKED_KEY, 'garbage')
    expect(renderHook(() => useCardSheetDockedPref()).result.current[0]).toBe(false)
  })

  it('persists a change and a fresh mount reads it back', () => {
    const { result } = renderHook(() => useCardSheetDockedPref())
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
    expect(localStorage.getItem(CARD_SHEET_DOCKED_KEY)).toBe('true')
    expect(renderHook(() => useCardSheetDockedPref()).result.current[0]).toBe(true)
    act(() => result.current[1](false))
    expect(localStorage.getItem(CARD_SHEET_DOCKED_KEY)).toBe('false')
  })

  it('falls back to false when localStorage throws, and still updates state', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const { result } = renderHook(() => useCardSheetDockedPref())
    expect(result.current[0]).toBe(false)
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
  })
})
