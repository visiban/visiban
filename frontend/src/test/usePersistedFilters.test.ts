import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { loadCustomFields, usePersistedFilters } from '../hooks/usePersistedFilters'
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
  it('round-trips sub-column and track-state filters through localStorage (#2367)', () => {
    const store = makeLocalStorageMock()
    Object.defineProperty(globalThis, 'localStorage', { value: store, writable: true, configurable: true })
    store.setItem('board:9:filters', JSON.stringify({ subColumnIds: [5, 'x'], trackStates: ['done', 'bogus'] }))
    const { result } = renderHook(() => usePersistedFilters(9))
    expect(result.current.filters).toMatchObject({ subColumnIds: [5], trackStates: ['done'] })
    store.setItem('board:9:filters', JSON.stringify({ subColumnIds: 'no', trackStates: [] }))
    const again = renderHook(() => usePersistedFilters(9))
    expect(again.result.current.filters).not.toHaveProperty('subColumnIds')
    expect(again.result.current.filters).not.toHaveProperty('trackStates')
  })

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
    // Stored before #1149 added the toggle: it loads as off.
    expect(result.current.filters).toEqual({ ...stored, blockedOnly: false })
  })

  // #2357
  it('writes a blank between to localStorage normalized, leaves live state and active filters alone', () => {
    const blank = { kind: 'number' as const, equals: '', op: 'between' as const, min: '', max: '' }
    const active = { kind: 'number' as const, equals: '', op: 'between' as const, min: '3', max: '' }
    const { result } = renderHook(() => usePersistedFilters(1))
    act(() => {
      result.current.setFilters({ ...EMPTY_FILTER, customFields: { 7: blank, 8: active } })
    })
    const stored = JSON.parse(mockStorage.getItem('board:1:filters')!)
    expect(stored.customFields['7']).toEqual({ kind: 'number', equals: '' })
    expect(stored.customFields['8']).toEqual(active)
    expect(result.current.filters.customFields[7]).toEqual(blank)
  })

  // #1149
  it('restores the Blocked only toggle and ignores a non-boolean value', () => {
    mockStorage.setItem('board:1:filters', JSON.stringify({ ...EMPTY_FILTER, blockedOnly: true }))
    const { result } = renderHook(() => usePersistedFilters(1))
    expect(result.current.filters.blockedOnly).toBe(true)

    mockStorage.setItem('board:2:filters', JSON.stringify({ ...EMPTY_FILTER, blockedOnly: 'yes' }))
    const { result: other } = renderHook(() => usePersistedFilters(2))
    expect(other.current.filters.blockedOnly).toBe(false)
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

  // #1391
  it('restores a multi_choice filter and drops a malformed one', () => {
    mockStorage.setItem(
      'board:1:filters',
      JSON.stringify({
        ...EMPTY_FILTER,
        customFields: {
          4: { kind: 'multi_choice', values: ['web', 'ios'] },
          5: { kind: 'multi_choice', values: [1] }, // malformed — values must be string[]
        },
      }),
    )
    const { result } = renderHook(() => usePersistedFilters(1))
    expect(result.current.filters.customFields).toEqual({ 4: { kind: 'multi_choice', values: ['web', 'ios'] } })
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

  // #2205
  it('restores a persisted laneFilter and drops a malformed one', () => {
    const laneFilter = { items: [{ kind: 'rule', id: 1, join: 'or', field: 3, op: 'between', min: '5' }] }
    localStorage.setItem('board:1:filters', JSON.stringify({ ...EMPTY_FILTER, laneFilter }))
    expect(renderHook(() => usePersistedFilters(1)).result.current.filters.laneFilter).toEqual(laneFilter)
    localStorage.setItem('board:2:filters', JSON.stringify({ ...EMPTY_FILTER, laneFilter: 'nope' }))
    expect(renderHook(() => usePersistedFilters(2)).result.current.filters).not.toHaveProperty('laneFilter')
  })
})

describe('loadCustomFields — number operators (#2357)', () => {
  it('keeps legacy and new number shapes and drops malformed ones', () => {
    const raw = {
      1: { kind: 'number', equals: '5' },
      2: { kind: 'number', equals: '', op: 'between', min: '3', max: '8' },
      3: { kind: 'number', equals: '', op: 'empty' },
      4: { kind: 'number', equals: '', op: 'not_empty' },
      5: { kind: 'number', equals: '', op: 'gte', min: '3' },
      6: { kind: 'number', equals: '', op: ['between'] },
      7: { kind: 'number', equals: '', op: 'between', min: 3 },
      8: { kind: 'number', equals: '', op: 'between', max: null },
      9: { kind: 'number', op: 'empty' },
      10: { kind: 'date', equals: '2026-11-13', op: 'between' },
    }
    const out = loadCustomFields(raw)
    expect(Object.keys(out).map(Number)).toEqual([1, 2, 3, 4, 10])
    expect(out[2]).toEqual(raw[2])
  })
})
