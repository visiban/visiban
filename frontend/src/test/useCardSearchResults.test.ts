import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCardSearchResults } from '../hooks/useCardSearchResults'
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
    created_by: { id: 1, username: 'user1', display_name: 'User 1', avatar_url: '' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_moved_at: null,
    attachment_count: 0,
    checklist_total: 0,
    checklist_done: 0,
    is_stale: false,
    archived_at: null,
    version: 1,
    custom_field_values: [],
    blocker_count: 0,
  }
}

// The sibling `useCardSearch` has this same shape of coverage. This hook is
// only reachable through RelationCardPicker in component tests, which exercise
// the rendered copy but not the threshold, the debounce, the abort, or the
// error policy — the four things that actually differ between the two hooks.
describe('useCardSearchResults', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('issues no request below the 2-character minimum', () => {
    const { result } = renderHook(() => useCardSearchResults(1, 'a'))
    act(() => { vi.advanceTimersByTime(1000) })
    expect(mockSearchCards).not.toHaveBeenCalled()
    expect(result.current.results).toEqual([])
    expect(result.current.isSearching).toBe(false)
    expect(result.current.failed).toBe(false)
  })

  it('respects a custom minimum', () => {
    renderHook(() => useCardSearchResults(1, 'ab', 300, 3))
    act(() => { vi.advanceTimersByTime(1000) })
    expect(mockSearchCards).not.toHaveBeenCalled()
  })

  it('does not fire before the debounce window elapses', () => {
    mockSearchCards.mockResolvedValue([])
    renderHook(() => useCardSearchResults(1, 'fix', 300))
    act(() => { vi.advanceTimersByTime(299) })
    expect(mockSearchCards).not.toHaveBeenCalled()
  })

  it('returns the full Card objects, not just ids', async () => {
    // This is the whole reason the hook exists separately from useCardSearch,
    // which returns a Set<number>. The picker needs title and column.
    const cards = [makeCard(10, 'Fix login bug')]
    mockSearchCards.mockResolvedValue(cards)

    const { result } = renderHook(() => useCardSearchResults(1, 'fix', 300))
    await act(async () => { await vi.runAllTimersAsync() })

    expect(mockSearchCards).toHaveBeenCalledTimes(1)
    expect(result.current.results).toEqual(cards)
    expect(result.current.isSearching).toBe(false)
    expect(result.current.failed).toBe(false)
  })

  it('reports isSearching while the request is in flight', async () => {
    let resolvePromise: (cards: Card[]) => void = () => {}
    mockSearchCards.mockReturnValue(new Promise((resolve) => { resolvePromise = resolve }))

    const { result } = renderHook(() => useCardSearchResults(1, 'fix', 300))
    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.isSearching).toBe(true)

    await act(async () => { resolvePromise([]) })
    expect(result.current.isSearching).toBe(false)
  })

  it('aborts a superseded request when the query changes', () => {
    mockSearchCards.mockReturnValue(new Promise(() => {}))
    const { rerender } = renderHook(
      ({ query }: { query: string }) => useCardSearchResults(1, query, 300),
      { initialProps: { query: 'first' } },
    )
    act(() => { vi.advanceTimersByTime(300) })
    expect(mockSearchCards).toHaveBeenCalledTimes(1)

    const firstSignal = mockSearchCards.mock.calls[0][2] as AbortSignal
    expect(firstSignal.aborted).toBe(false)

    rerender({ query: 'second' })
    expect(firstSignal.aborted).toBe(true)
  })

  it('surfaces a real failure instead of swallowing it', async () => {
    // The opposite policy to useCardSearch, which falls back to "no filter".
    // An empty list here would read as "no such card" and send the user
    // looking for a card that is right there.
    mockSearchCards.mockRejectedValue(new Error('network error'))
    const { result } = renderHook(() => useCardSearchResults(1, 'fix', 300))
    await act(async () => { await vi.runAllTimersAsync() })

    expect(result.current.failed).toBe(true)
    expect(result.current.results).toEqual([])
    expect(result.current.isSearching).toBe(false)
  })

  it('does not report a superseded request as a failure', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    mockSearchCards.mockRejectedValue(abortError)
    const { result } = renderHook(() => useCardSearchResults(1, 'fix', 300))
    await act(async () => { await vi.runAllTimersAsync() })

    expect(result.current.failed).toBe(false)
  })

  it('clears results and the failed flag when the query drops below the minimum', async () => {
    mockSearchCards.mockRejectedValue(new Error('boom'))
    const { result, rerender } = renderHook(
      ({ query }: { query: string }) => useCardSearchResults(1, query, 300),
      { initialProps: { query: 'fix' } },
    )
    await act(async () => { await vi.runAllTimersAsync() })
    expect(result.current.failed).toBe(true)

    rerender({ query: 'f' })
    expect(result.current.failed).toBe(false)
    expect(result.current.results).toEqual([])
  })
})
