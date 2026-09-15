import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCardDensityOverride } from '../hooks/useCardDensityOverride'

const KEY = (boardId: number) => `board:${boardId}:card-density-override`

describe('useCardDensityOverride (#974)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('defaults to null (follow board default) when nothing is stored', () => {
    const { result } = renderHook(() => useCardDensityOverride(1))
    expect(result.current[0]).toBeNull()
  })

  it('returns the stored value when present', () => {
    localStorage.setItem(KEY(1), 'standard')
    const { result } = renderHook(() => useCardDensityOverride(1))
    expect(result.current[0]).toBe('standard')
  })

  it('is scoped per board — board 1 and board 2 never share a key', () => {
    localStorage.setItem(KEY(1), 'dense')
    const { result: board1 } = renderHook(() => useCardDensityOverride(1))
    const { result: board2 } = renderHook(() => useCardDensityOverride(2))
    expect(board1.current[0]).toBe('dense')
    expect(board2.current[0]).toBeNull()
  })

  it('setting a value persists it under the board-scoped key and updates state', () => {
    const { result } = renderHook(() => useCardDensityOverride(5))
    act(() => { result.current[1]('comfortable') })
    expect(result.current[0]).toBe('comfortable')
    expect(localStorage.getItem(KEY(5))).toBe('comfortable')
  })

  it('setting null removes the key rather than storing a literal "null"', () => {
    localStorage.setItem(KEY(5), 'dense')
    const { result } = renderHook(() => useCardDensityOverride(5))
    act(() => { result.current[1](null) })
    expect(result.current[0]).toBeNull()
    expect(localStorage.getItem(KEY(5))).toBeNull()
  })

  it('falls back to null when localStorage throws on read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('quota') })
    const { result } = renderHook(() => useCardDensityOverride(1))
    expect(result.current[0]).toBeNull()
  })

  it('fails silently when localStorage throws on write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const { result } = renderHook(() => useCardDensityOverride(1))
    expect(() => act(() => { result.current[1]('dense') })).not.toThrow()
    // State still updates in-memory even if persistence fails
    expect(result.current[0]).toBe('dense')
  })

  it('falls back to null when the stored value is not a valid density (stale/removed tier)', () => {
    localStorage.setItem(KEY(1), 'compact') // "compact" was never a valid card_density value
    const { result } = renderHook(() => useCardDensityOverride(1))
    expect(result.current[0]).toBeNull()

    localStorage.setItem(KEY(1), '{"density":"dense"}')
    const { result: json } = renderHook(() => useCardDensityOverride(1))
    expect(json.current[0]).toBeNull()
  })

  it('never falls back to the board admin default — that layering happens in BoardView, not here', () => {
    // The hook only knows about the personal override; resolving against
    // board.card_density is BoardView's job (effectiveCardDensity).
    const { result } = renderHook(() => useCardDensityOverride(1))
    expect(result.current[0]).toBeNull()
  })

  it('new hook instance for the same board reads the persisted value set by a previous instance', () => {
    const { result: first } = renderHook(() => useCardDensityOverride(9))
    act(() => { first.current[1]('standard') })
    const { result: second } = renderHook(() => useCardDensityOverride(9))
    expect(second.current[0]).toBe('standard')
  })
})
