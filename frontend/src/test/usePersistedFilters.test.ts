import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePersistedFilters } from '../hooks/usePersistedFilters'
import { EMPTY_FILTER } from '../components/Board/FilterBar'
import type { FilterState } from '../components/Board/FilterBar'

// Use an in-memory localStorage substitute so tests are isolated.
function makeLocalStorageMock() {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
}

describe('usePersistedFilters', () => {
  const mockStorage = makeLocalStorageMock()

  beforeEach(() => {
    mockStorage.clear()
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    mockStorage.clear()
  })

  it('returns EMPTY_FILTER when no stored value exists', () => {
    const { result } = renderHook(() => usePersistedFilters(1))
    expect(result.current.filters).toEqual(EMPTY_FILTER)
  })

  it('restores filters from localStorage on mount', () => {
    const stored: FilterState = {
      search: 'bug',
      assigneeIds: [2, -1],
      labelIds: [10],
      priorities: ['high'],
      dueDate: 'overdue',
    }
    mockStorage.setItem('board:1:filters', JSON.stringify(stored))

    const { result } = renderHook(() => usePersistedFilters(1))
    expect(result.current.filters).toEqual(stored)
  })

  it('writes to localStorage when filters change', () => {
    const { result } = renderHook(() => usePersistedFilters(1))

    act(() => {
      result.current.setFilters({ ...EMPTY_FILTER, search: 'hello' })
    })

    const raw = mockStorage.getItem('board:1:filters')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.search).toBe('hello')
  })

  it('returns EMPTY_FILTER when localStorage contains corrupt JSON', () => {
    mockStorage.setItem('board:1:filters', 'not-valid-json{{{')
    const { result } = renderHook(() => usePersistedFilters(1))
    expect(result.current.filters).toEqual(EMPTY_FILTER)
  })

  it('returns EMPTY_FILTER when stored object has wrong types for all fields', () => {
    mockStorage.setItem(
      'board:1:filters',
      JSON.stringify({ search: 123, assigneeIds: 'oops', labelIds: null, priorities: {}, dueDate: 'invalid' }),
    )
    const { result } = renderHook(() => usePersistedFilters(1))
    expect(result.current.filters).toEqual(EMPTY_FILTER)
  })

  it('different board IDs have independent filter state', () => {
    const filtersBoard1: FilterState = { ...EMPTY_FILTER, search: 'alpha' }
    const filtersBoard2: FilterState = { ...EMPTY_FILTER, search: 'beta' }
    mockStorage.setItem('board:1:filters', JSON.stringify(filtersBoard1))
    mockStorage.setItem('board:2:filters', JSON.stringify(filtersBoard2))

    const { result: r1 } = renderHook(() => usePersistedFilters(1))
    const { result: r2 } = renderHook(() => usePersistedFilters(2))

    expect(r1.current.filters.search).toBe('alpha')
    expect(r2.current.filters.search).toBe('beta')
  })

  it('writing filters for board 1 does not affect board 2', () => {
    const { result: r1 } = renderHook(() => usePersistedFilters(1))
    const { result: r2 } = renderHook(() => usePersistedFilters(2))

    act(() => {
      r1.current.setFilters({ ...EMPTY_FILTER, search: 'board1only' })
    })

    // board 2 state should remain EMPTY_FILTER (nothing written)
    expect(r2.current.filters).toEqual(EMPTY_FILTER)
    // board 2 key should not exist in storage
    expect(mockStorage.getItem('board:2:filters')).toBeNull()
  })

  it('valid dueDate values are preserved', () => {
    const dueDates: FilterState['dueDate'][] = ['overdue', 'today', 'this_week', 'none', null]
    for (const dueDate of dueDates) {
      mockStorage.clear()
      mockStorage.setItem('board:1:filters', JSON.stringify({ ...EMPTY_FILTER, dueDate }))
      const { result } = renderHook(() => usePersistedFilters(1))
      expect(result.current.filters.dueDate).toBe(dueDate)
    }
  })
})
