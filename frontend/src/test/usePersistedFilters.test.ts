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
      customFields: {},
      visibleCustomFieldFilterIds: [],
    }
    mockStorage.setItem('board:1:filters', JSON.stringify(stored))

    const { result } = renderHook(() => usePersistedFilters(1))
    expect(result.current.filters).toEqual(stored)
  })

  // #371
  it('restores a populated custom field filter from localStorage', () => {
    const stored: FilterState = {
      ...EMPTY_FILTER,
      customFields: { 7: { kind: 'text', query: 'sprint 14' } },
      visibleCustomFieldFilterIds: [7],
    }
    mockStorage.setItem('board:1:filters', JSON.stringify(stored))

    const { result } = renderHook(() => usePersistedFilters(1))
    expect(result.current.filters.customFields).toEqual({ 7: { kind: 'text', query: 'sprint 14' } })
    expect(result.current.filters.visibleCustomFieldFilterIds).toEqual([7])
  })

  it('drops a malformed custom field filter entry without failing the whole load', () => {
    mockStorage.setItem(
      'board:1:filters',
      JSON.stringify({
        ...EMPTY_FILTER,
        customFields: {
          1: { kind: 'text', query: 'valid' },
          2: { kind: 'choice', values: 'not-an-array' }, // malformed — values must be string[]
          3: { kind: 'bogus-kind' },
        },
      }),
    )
    const { result } = renderHook(() => usePersistedFilters(1))
    expect(result.current.filters.customFields).toEqual({ 1: { kind: 'text', query: 'valid' } })
  })

  it('self-heals visibleCustomFieldFilterIds to the board\'s current pinned fields when missing from storage', () => {
    // A pre-#371 stored filter genuinely omits the key — spreading EMPTY_FILTER
    // here would defeat the test by supplying a valid (empty) array instead.
    mockStorage.setItem(
      'board:1:filters',
      JSON.stringify({ search: 'x', assigneeIds: [], labelIds: [], priorities: [], dueDate: null }),
    )
    const { result } = renderHook(() => usePersistedFilters(1, [5, 9]))
    expect(result.current.filters.visibleCustomFieldFilterIds).toEqual([5, 9])
  })

  it('self-heals visibleCustomFieldFilterIds when the stored value is malformed', () => {
    mockStorage.setItem(
      'board:1:filters',
      JSON.stringify({ ...EMPTY_FILTER, visibleCustomFieldFilterIds: ['not', 'numbers'] }),
    )
    const { result } = renderHook(() => usePersistedFilters(1, [4]))
    expect(result.current.filters.visibleCustomFieldFilterIds).toEqual([4])
  })

  it('does not self-heal visibleCustomFieldFilterIds when a valid (even empty) array is already stored', () => {
    mockStorage.setItem('board:1:filters', JSON.stringify({ ...EMPTY_FILTER, visibleCustomFieldFilterIds: [] }))
    const { result } = renderHook(() => usePersistedFilters(1, [4]))
    expect(result.current.filters.visibleCustomFieldFilterIds).toEqual([])
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
