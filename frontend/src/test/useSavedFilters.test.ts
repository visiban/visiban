import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useSavedFilters } from '../hooks/useSavedFilters'
import { EMPTY_FILTER } from '../components/Board/FilterBar'
import type { FilterState } from '../components/Board/FilterBar'
import type { SavedFilter } from '../types'

// Mock the API module so tests do not hit the network.
vi.mock('../api/savedFilters', () => ({
  listSavedFilters: vi.fn(),
  createSavedFilter: vi.fn(),
  deleteSavedFilter: vi.fn(),
}))

import * as savedFiltersApi from '../api/savedFilters'

const makeFilter = (id: number, name: string): SavedFilter => ({
  id,
  name,
  state_json: { search: 'bug', assigneeIds: [], labelIds: [], priorities: ['high'], dueDate: null },
  state_version: 1,
  created_at: '2026-03-25T10:00:00Z',
})

describe('useSavedFilters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads saved filters on mount', async () => {
    const filters = [makeFilter(1, 'Alpha'), makeFilter(2, 'Beta')]
    vi.mocked(savedFiltersApi.listSavedFilters).mockResolvedValue(filters)

    const { result } = renderHook(() => useSavedFilters(1))

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.savedFilters).toEqual(filters)
    expect(result.current.error).toBeNull()
  })

  it('sets error when load fails', async () => {
    vi.mocked(savedFiltersApi.listSavedFilters).mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useSavedFilters(1))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.savedFilters).toEqual([])
    expect(result.current.error).toBeTruthy()
  })

  it('empty state when no saved filters exist', async () => {
    vi.mocked(savedFiltersApi.listSavedFilters).mockResolvedValue([])

    const { result } = renderHook(() => useSavedFilters(1))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.savedFilters).toEqual([])
  })

  it('saveFilter adds the new filter to the list', async () => {
    vi.mocked(savedFiltersApi.listSavedFilters).mockResolvedValue([])
    const newFilter = makeFilter(10, 'My preset')
    vi.mocked(savedFiltersApi.createSavedFilter).mockResolvedValue(newFilter)

    const { result } = renderHook(() => useSavedFilters(1))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const filters: FilterState = { ...EMPTY_FILTER, search: 'hello' }
    await act(async () => {
      const outcome = await result.current.saveFilter('My preset', filters)
      expect(outcome.error).toBeUndefined()
    })

    expect(result.current.savedFilters).toHaveLength(1)
    expect(result.current.savedFilters[0].name).toBe('My preset')
  })

  it('saveFilter returns error when API rejects', async () => {
    vi.mocked(savedFiltersApi.listSavedFilters).mockResolvedValue([])
    vi.mocked(savedFiltersApi.createSavedFilter).mockRejectedValue({
      response: { data: { detail: 'A saved filter with this name already exists on this board.' } },
    })

    const { result } = renderHook(() => useSavedFilters(1))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      const outcome = await result.current.saveFilter('Dupe', EMPTY_FILTER)
      expect(outcome.error).toContain('already exists')
    })

    // List should be unchanged on failure
    expect(result.current.savedFilters).toHaveLength(0)
  })

  it('removeFilter removes the filter from the list immediately', async () => {
    const existing = [makeFilter(1, 'Alpha'), makeFilter(2, 'Beta')]
    vi.mocked(savedFiltersApi.listSavedFilters).mockResolvedValue(existing)
    vi.mocked(savedFiltersApi.deleteSavedFilter).mockResolvedValue(undefined as never)

    const { result } = renderHook(() => useSavedFilters(1))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.removeFilter(1)
    })

    expect(result.current.savedFilters).toHaveLength(1)
    expect(result.current.savedFilters[0].id).toBe(2)
  })

  describe('hydrateFilter', () => {
    it('converts a SavedFilter back to a valid FilterState', async () => {
      vi.mocked(savedFiltersApi.listSavedFilters).mockResolvedValue([])
      const { result } = renderHook(() => useSavedFilters(1))
      await waitFor(() => expect(result.current.loading).toBe(false))

      const sf = makeFilter(1, 'Test')
      const fs = result.current.hydrateFilter(sf)

      expect(fs.search).toBe('bug')
      expect(fs.priorities).toEqual(['high'])
      expect(fs.assigneeIds).toEqual([])
      expect(fs.labelIds).toEqual([])
      expect(fs.dueDate).toBeNull()
    })

    it('falls back to EMPTY_FILTER values for corrupt state_json fields', async () => {
      vi.mocked(savedFiltersApi.listSavedFilters).mockResolvedValue([])
      const { result } = renderHook(() => useSavedFilters(1))
      await waitFor(() => expect(result.current.loading).toBe(false))

      const corrupt: SavedFilter = {
        id: 1,
        name: 'Corrupt',
        state_json: {
          search: 123,         // wrong type
          assigneeIds: 'nope', // wrong type
          priorities: null,    // wrong type
          dueDate: 'badval',   // invalid value
        } as unknown as Record<string, unknown>,
        state_version: 1,
        created_at: '2026-01-01T00:00:00Z',
      }

      const fs = result.current.hydrateFilter(corrupt)

      expect(fs.search).toBe(EMPTY_FILTER.search)
      expect(fs.assigneeIds).toEqual(EMPTY_FILTER.assigneeIds)
      expect(fs.priorities).toEqual(EMPTY_FILTER.priorities)
      expect(fs.dueDate).toBe(EMPTY_FILTER.dueDate)
    })

    it('preserves all valid dueDate values', async () => {
      vi.mocked(savedFiltersApi.listSavedFilters).mockResolvedValue([])
      const { result } = renderHook(() => useSavedFilters(1))
      await waitFor(() => expect(result.current.loading).toBe(false))

      const validDueDates: FilterState['dueDate'][] = ['overdue', 'today', 'this_week', 'none', null]
      for (const dueDate of validDueDates) {
        const sf: SavedFilter = {
          id: 1,
          name: 'DueTest',
          state_json: { dueDate } as Record<string, unknown>,
          state_version: 1,
          created_at: '2026-01-01T00:00:00Z',
        }
        const fs = result.current.hydrateFilter(sf)
        expect(fs.dueDate).toBe(dueDate)
      }
    })

    it('hydrates payloads from a newer client (unknown higher version) via the v1 reader', async () => {
      // A mixed-version deploy — the user logs into an older client but a
      // newer client already wrote a v2 payload. Shared v1 keys must still
      // load rather than silently resetting to EMPTY_FILTER.
      vi.mocked(savedFiltersApi.listSavedFilters).mockResolvedValue([])
      const { result } = renderHook(() => useSavedFilters(1))
      await waitFor(() => expect(result.current.loading).toBe(false))

      const future: SavedFilter = {
        id: 1,
        name: 'From future client',
        state_json: { search: 'ship', priorities: ['urgent'] },
        state_version: 99,
        created_at: '2026-04-17T00:00:00Z',
      }

      const fs = result.current.hydrateFilter(future)

      expect(fs.search).toBe('ship')
      expect(fs.priorities).toEqual(['urgent'])
    })
  })
})
