import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCardSearch } from '../hooks/useCardSearch'
import type { Card } from '../types'

vi.mock('../api/cards', () => ({
  searchCards: vi.fn(),
}))

import { searchCards } from '../api/cards'

const mockSearchCards = searchCards as ReturnType<typeof vi.fn>

function makeCard(id: number, title: string): Card {
  return {
    id,
    uid: `carduid${String(id).padStart(5, '0')}`,
    column: 1,
    swimlane: 1,
    title,
    description: '',
    priority: 'medium',
    assignee: null,
    labels: [],
    due_date: null,
    weight: 1,
    position: 0,
    created_by: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_moved_at: null,
    attachment_count: 0,
    checklist_total: 0,
    checklist_done: 0,
    is_stale: false,
    archived_at: null,
    version: 1,
  }
}

describe('useCardSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null searchMatchIds and false isSearching for empty query', () => {
    const { result } = renderHook(() => useCardSearch(1, ''))
    expect(result.current.searchMatchIds).toBeNull()
    expect(result.current.isSearching).toBe(false)
    // No API call should be made for an empty query
    expect(mockSearchCards).not.toHaveBeenCalled()
  })

  it('returns null searchMatchIds for whitespace-only query', () => {
    const { result } = renderHook(() => useCardSearch(1, '   '))
    expect(result.current.searchMatchIds).toBeNull()
    expect(result.current.isSearching).toBe(false)
    expect(mockSearchCards).not.toHaveBeenCalled()
  })

  it('fires request after debounce and returns matching IDs', async () => {
    const cards = [makeCard(10, 'Fix login bug'), makeCard(20, 'Fix logout')]
    mockSearchCards.mockResolvedValue(cards)

    const { result } = renderHook(() => useCardSearch(1, 'Fix', 300))

    // No request fired before debounce window
    expect(mockSearchCards).not.toHaveBeenCalled()

    // Advance the debounce timer and flush all pending promises
    await act(async () => {
      vi.runAllTimers()
    })

    expect(mockSearchCards).toHaveBeenCalledTimes(1)
    expect(result.current.searchMatchIds).toEqual(new Set([10, 20]))
    expect(result.current.isSearching).toBe(false)
  })

  it('does not fire before debounce delay elapses', () => {
    mockSearchCards.mockResolvedValue([])
    renderHook(() => useCardSearch(1, 'partial', 300))

    act(() => { vi.advanceTimersByTime(299) })

    expect(mockSearchCards).not.toHaveBeenCalled()
  })

  it('aborts stale request when query changes within debounce window', async () => {
    const cards = [makeCard(42, 'Final result')]
    mockSearchCards.mockResolvedValue(cards)

    const { result, rerender } = renderHook(
      ({ query }: { query: string }) => useCardSearch(1, query, 300),
      { initialProps: { query: 'first' } },
    )

    // Change query before debounce fires — the first timer should be cancelled
    act(() => { vi.advanceTimersByTime(200) })
    rerender({ query: 'second' })

    // Advance past the second debounce and flush promises
    await act(async () => {
      vi.runAllTimers()
    })

    expect(result.current.searchMatchIds).not.toBeNull()
    // Only one call should have been made (for 'second', not 'first')
    expect(mockSearchCards).toHaveBeenCalledTimes(1)
    expect(mockSearchCards).toHaveBeenCalledWith(1, 'second', expect.any(AbortSignal))
  })

  it('returns null and false isSearching on API error (silent fallback)', async () => {
    mockSearchCards.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useCardSearch(1, 'error-trigger', 300))

    await act(async () => {
      vi.runAllTimers()
    })

    expect(result.current.isSearching).toBe(false)
    expect(result.current.searchMatchIds).toBeNull()
  })

  it('clears results when query becomes empty', async () => {
    const cards = [makeCard(5, 'Match')]
    mockSearchCards.mockResolvedValue(cards)

    const { result, rerender } = renderHook(
      ({ query }: { query: string }) => useCardSearch(1, query, 300),
      { initialProps: { query: 'match' } },
    )

    await act(async () => {
      vi.runAllTimers()
    })

    expect(result.current.searchMatchIds).not.toBeNull()

    // Clear the query — should immediately reset to null
    rerender({ query: '' })

    expect(result.current.searchMatchIds).toBeNull()
    expect(result.current.isSearching).toBe(false)
  })
})
