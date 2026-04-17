import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  listSavedFilters,
  createSavedFilter,
  deleteSavedFilter,
  CURRENT_SAVED_FILTER_SCHEMA_VERSION,
} from '../api/savedFilters'
import client from '../api/client'
import type { SavedFilter } from '../types'

vi.mock('../api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}))

const mockFilter: SavedFilter = {
  id: 1,
  name: 'Sprint filters',
  state_json: { search: '', assigneeIds: [2], labelIds: [], priorities: [], dueDate: null },
  state_version: 1,
  created_at: '2026-03-25T10:00:00Z',
}

describe('savedFilters API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('listSavedFilters calls GET /api/boards/{id}/saved-filters/', async () => {
    vi.mocked(client.get).mockResolvedValue({ data: [mockFilter] })
    const result = await listSavedFilters(5)
    expect(client.get).toHaveBeenCalledWith('/api/v1/boards/5/saved-filters/')
    expect(result).toEqual([mockFilter])
  })

  it('createSavedFilter calls POST /api/boards/{id}/saved-filters/ with the current schema version', async () => {
    vi.mocked(client.post).mockResolvedValue({ data: mockFilter })
    const result = await createSavedFilter(5, { name: 'Sprint filters', state_json: { search: '' } })
    expect(client.post).toHaveBeenCalledWith(
      '/api/v1/boards/5/saved-filters/',
      {
        state_version: CURRENT_SAVED_FILTER_SCHEMA_VERSION,
        name: 'Sprint filters',
        state_json: { search: '' },
      },
    )
    expect(result).toEqual(mockFilter)
  })

  it('createSavedFilter lets callers override state_version (forward-compat)', async () => {
    vi.mocked(client.post).mockResolvedValue({ data: mockFilter })
    await createSavedFilter(5, { name: 'Future', state_json: { search: '' }, state_version: 2 })
    expect(client.post).toHaveBeenCalledWith(
      '/api/v1/boards/5/saved-filters/',
      { state_version: 2, name: 'Future', state_json: { search: '' } },
    )
  })

  it('deleteSavedFilter calls DELETE /api/boards/{id}/saved-filters/{filterId}/', async () => {
    vi.mocked(client.delete).mockResolvedValue({ data: null })
    await deleteSavedFilter(5, 42)
    expect(client.delete).toHaveBeenCalledWith('/api/v1/boards/5/saved-filters/42/')
  })
})
