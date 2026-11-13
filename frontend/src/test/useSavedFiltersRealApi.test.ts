import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useSavedFilters } from '../hooks/useSavedFilters'
import { EMPTY_FILTER } from '../components/Board/FilterBar'
import client from '../api/client'

// #2213 — only the network (axios client) is mocked, so the real hook and the
// real API layer build the request. The other useSavedFilters test mocks the
// whole API module and could not see what is actually posted.
vi.mock('../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))

describe('useSavedFilters posts the real FilterState shape', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(client.get).mockResolvedValue({ data: [] })
  })

  it('sends only keys the backend accepts when saving EMPTY_FILTER', async () => {
    vi.mocked(client.post).mockResolvedValue({
      data: { id: 1, name: 'Mine', state_json: EMPTY_FILTER, state_version: 1, created_at: '2026-11-13T00:00:00Z' },
    })
    const { result } = renderHook(() => useSavedFilters(7))
    await waitFor(() => expect(result.current.loading).toBe(false))

    let outcome: { error?: string } = {}
    await act(async () => {
      outcome = await result.current.saveFilter('Mine', EMPTY_FILTER)
    })

    expect(outcome.error).toBeUndefined()
    const [url, body] = vi.mocked(client.post).mock.calls[0] as [string, { name: string; state_json: Record<string, unknown> }]
    expect(url).toContain('/boards/7/saved-filters/')
    expect(body.state_json).toEqual(EMPTY_FILTER)
    const fixture = JSON.parse(
      readFileSync(resolve(__dirname, '../../../backend/boards/tests/fixtures/filter_state_keys.json'), 'utf8'),
    ) as { keys: string[] }
    // #2205 — laneFilter is optional and absent from EMPTY_FILTER; every other
    // fixture key is always posted, and nothing outside the fixture ever is.
    expect(Object.keys(body.state_json).sort()).toEqual(fixture.keys.filter((k) => k !== 'laneFilter').sort())
    expect(result.current.savedFilters).toHaveLength(1)
  })

  it('surfaces the backend string detail when the save is rejected', async () => {
    vi.mocked(client.post).mockRejectedValue({
      response: { data: { detail: "Unknown keys in state_json: ['x']." } },
    })
    const { result } = renderHook(() => useSavedFilters(7))
    await waitFor(() => expect(result.current.loading).toBe(false))
    let outcome: { error?: string } = {}
    await act(async () => {
      outcome = await result.current.saveFilter('Mine', EMPTY_FILTER)
    })
    expect(outcome.error).toContain('Unknown keys')
  })
})
