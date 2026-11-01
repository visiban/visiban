import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRecentBoardsPref, clearRecentBoardsPrefs } from '../hooks/useRecentBoardsPref'
import type { RecentBoardEntry } from '../hooks/useRecentBoardsPref'

const STORAGE_KEY = 'user:prefs:recent-boards:1'

const board = (id: number, name = `Board ${id}`): RecentBoardEntry => ({ id, name })

describe('useRecentBoardsPref', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('returns empty array when no stored value', () => {
    const { result } = renderHook(() => useRecentBoardsPref(1))
    expect(result.current.recentBoards).toEqual([])
  })

  it('loads previously stored entries from localStorage', () => {
    const entries = [board(1), board(2)]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
    const { result } = renderHook(() => useRecentBoardsPref(1))
    expect(result.current.recentBoards).toHaveLength(2)
    expect(result.current.recentBoards[0].id).toBe(1)
    expect(result.current.recentBoards[1].id).toBe(2)
  })

  it('recordVisit prepends the new entry to the list', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([board(1)]))
    const { result } = renderHook(() => useRecentBoardsPref(1))
    act(() => { result.current.recordVisit(board(2)) })
    expect(result.current.recentBoards[0].id).toBe(2)
    expect(result.current.recentBoards[1].id).toBe(1)
  })

  it('recordVisit deduplicates by id — re-visiting moves entry to front', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([board(1), board(2), board(3)]))
    const { result } = renderHook(() => useRecentBoardsPref(1))
    act(() => { result.current.recordVisit(board(2, 'Board 2 Updated')) })
    expect(result.current.recentBoards[0].id).toBe(2)
    expect(result.current.recentBoards[0].name).toBe('Board 2 Updated')
    expect(result.current.recentBoards).toHaveLength(3)
  })

  it('caps the list at 5 entries (FIFO)', () => {
    const { result } = renderHook(() => useRecentBoardsPref(1))
    act(() => {
      result.current.recordVisit(board(1))
      result.current.recordVisit(board(2))
      result.current.recordVisit(board(3))
      result.current.recordVisit(board(4))
      result.current.recordVisit(board(5))
      result.current.recordVisit(board(6))
    })
    expect(result.current.recentBoards).toHaveLength(5)
    // Oldest entry (board 1) should have been evicted
    expect(result.current.recentBoards.map((e) => e.id)).not.toContain(1)
    // Most recent entry (board 6) should be first
    expect(result.current.recentBoards[0].id).toBe(6)
  })

  it('persists to localStorage after recordVisit', () => {
    const { result } = renderHook(() => useRecentBoardsPref(1))
    act(() => { result.current.recordVisit(board(42)) })
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    expect(stored[0].id).toBe(42)
  })

  it('a new hook instance reads the persisted value from a previous instance', () => {
    const { result: first } = renderHook(() => useRecentBoardsPref(1))
    act(() => { first.current.recordVisit(board(7)) })
    const { result: second } = renderHook(() => useRecentBoardsPref(1))
    expect(second.current.recentBoards[0].id).toBe(7)
  })

  it('falls back to empty array when localStorage throws on read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('quota') })
    const { result } = renderHook(() => useRecentBoardsPref(1))
    expect(result.current.recentBoards).toEqual([])
  })

  it('falls back to empty array when stored value is malformed JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json}')
    const { result } = renderHook(() => useRecentBoardsPref(1))
    expect(result.current.recentBoards).toEqual([])
  })

  it('falls back to empty array when stored value is not an array', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: 1, name: 'Board' }))
    const { result } = renderHook(() => useRecentBoardsPref(1))
    expect(result.current.recentBoards).toEqual([])
  })

  it('filters out entries with invalid shape', () => {
    const mixed = [{ id: 1, name: 'Valid' }, { id: 'bad', name: 'Bad id' }, null, { name: 'No id' }]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mixed))
    const { result } = renderHook(() => useRecentBoardsPref(1))
    expect(result.current.recentBoards).toHaveLength(1)
    expect(result.current.recentBoards[0].id).toBe(1)
  })

  it('fails silently when localStorage throws on write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const { result } = renderHook(() => useRecentBoardsPref(1))
    expect(() => act(() => { result.current.recordVisit(board(1)) })).not.toThrow()
    // State should still update even if persistence fails
    expect(result.current.recentBoards[0].id).toBe(1)
  })

  it('preserves groupAncestors on stored entries', () => {
    const entry: RecentBoardEntry = { id: 10, name: 'Design', groupAncestors: ['Engineering'] }
    const { result } = renderHook(() => useRecentBoardsPref(1))
    act(() => { result.current.recordVisit(entry) })
    expect(result.current.recentBoards[0].groupAncestors).toEqual(['Engineering'])
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    expect(stored[0].groupAncestors).toEqual(['Engineering'])
  })

  it('pruneByIds drops entries whose id is not in the valid set and persists the result', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([board(1), board(2), board(3), board(4)]))
    const { result } = renderHook(() => useRecentBoardsPref(1))
    act(() => { result.current.pruneByIds(new Set([2, 4, 99])) })
    expect(result.current.recentBoards.map((e) => e.id)).toEqual([2, 4])
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    expect(stored.map((e: RecentBoardEntry) => e.id)).toEqual([2, 4])
  })

  it('pruneByIds preserves order and is a no-op when nothing changes', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([board(3), board(1), board(2)]))
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const { result } = renderHook(() => useRecentBoardsPref(1))
    act(() => { result.current.pruneByIds(new Set([1, 2, 3])) })
    expect(result.current.recentBoards.map((e) => e.id)).toEqual([3, 1, 2])
    // No write when no entries were removed.
    expect(setItemSpy).not.toHaveBeenCalled()
  })

  it('pruneByIds with empty set clears the list entirely (e.g. user has no accessible boards)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([board(1), board(2)]))
    const { result } = renderHook(() => useRecentBoardsPref(1))
    act(() => { result.current.pruneByIds(new Set()) })
    expect(result.current.recentBoards).toEqual([])
  })
})

describe('useRecentBoardsPref — per-user scoping (#1955)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it("user B never sees user A's entries", () => {
    const a = renderHook(() => useRecentBoardsPref(1))
    act(() => { a.result.current.recordVisit({ id: 5, name: 'Secret', groupAncestors: ['Private Group'] }) })
    a.unmount()
    const b = renderHook(() => useRecentBoardsPref(2))
    expect(b.result.current.recentBoards).toEqual([])
    // A's list is intact under A's own key.
    expect(JSON.parse(localStorage.getItem('user:prefs:recent-boards:1') ?? '[]')[0].id).toBe(5)
  })

  it('reloads when the user id changes on a mounted hook', () => {
    localStorage.setItem('user:prefs:recent-boards:1', JSON.stringify([board(1)]))
    localStorage.setItem('user:prefs:recent-boards:2', JSON.stringify([board(2)]))
    const { result, rerender } = renderHook(({ id }) => useRecentBoardsPref(id), { initialProps: { id: 1 } })
    expect(result.current.recentBoards[0].id).toBe(1)
    rerender({ id: 2 })
    expect(result.current.recentBoards.map((e) => e.id)).toEqual([2])
  })

  it('returns nothing and persists nothing without a user id', () => {
    localStorage.setItem('user:prefs:recent-boards:1', JSON.stringify([board(1)]))
    const { result } = renderHook(() => useRecentBoardsPref(null))
    expect(result.current.recentBoards).toEqual([])
    act(() => { result.current.recordVisit(board(9)) })
    act(() => { result.current.pruneByIds(new Set()) })
    expect(localStorage.getItem('user:prefs:recent-boards:null')).toBeNull()
    expect(localStorage.getItem('user:prefs:recent-boards:1')).toBe(JSON.stringify([board(1)]))
  })

  it('removes the legacy unscoped key rather than surfacing it', () => {
    localStorage.setItem('user:prefs:recent-boards', JSON.stringify([board(77, 'Legacy A board')]))
    const { result } = renderHook(() => useRecentBoardsPref(2))
    expect(result.current.recentBoards).toEqual([])
    expect(localStorage.getItem('user:prefs:recent-boards')).toBeNull()
  })

  it('clearRecentBoardsPrefs removes every user key and the legacy key but leaves other prefs', () => {
    localStorage.setItem('user:prefs:recent-boards', '[]')
    localStorage.setItem('user:prefs:recent-boards:1', '[]')
    localStorage.setItem('user:prefs:recent-boards:2', '[]')
    localStorage.setItem('user:prefs:theme', 'dark')
    clearRecentBoardsPrefs()
    expect(localStorage.getItem('user:prefs:recent-boards')).toBeNull()
    expect(localStorage.getItem('user:prefs:recent-boards:1')).toBeNull()
    expect(localStorage.getItem('user:prefs:recent-boards:2')).toBeNull()
    expect(localStorage.getItem('user:prefs:theme')).toBe('dark')
  })

  it('clearRecentBoardsPrefs and legacy-key removal swallow storage errors', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => { throw new Error('blocked') })
    expect(() => clearRecentBoardsPrefs()).not.toThrow()
    expect(() => renderHook(() => useRecentBoardsPref(1))).not.toThrow()
  })
})
