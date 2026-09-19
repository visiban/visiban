import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('../api/gitLens', () => ({
  getLensBoard: vi.fn(),
}))

import { getLensBoard } from '../api/gitLens'
import { useLensData } from '../hooks/useLensData'
import type { LensData } from '../types'

const mockGetLensBoard = getLensBoard as ReturnType<typeof vi.fn>

const sampleData: LensData = {
  columns: [{ key: 'open', label: 'Open', is_current: false }],
  swimlanes: [{ key: '__none__', label: '(no milestone)', is_current: false }],
  issues: [],
  fetched_at: '2026-06-06T12:00:00Z',
  source: { provider: 'github', repo: 'acme/widgets', url: 'https://github.com/acme/widgets' },
  truncated: false,
  total_count: 0,
  available_milestones: [],
}

// Build an object that passes axios.isAxiosError (which checks isAxiosError === true).
function axiosError(status: number, data: unknown) {
  return { isAxiosError: true, response: { status, data } }
}

describe('useLensData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts in loading, then resolves to data on success', async () => {
    mockGetLensBoard.mockResolvedValue(sampleData)
    const { result } = renderHook(() =>
      useLensData(5, { columnDim: 'status', swimlaneDim: 'milestone' }),
    )

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toEqual(sampleData)
    expect(result.current.error).toBeNull()
    expect(mockGetLensBoard).toHaveBeenCalledWith(5, {
      column_dim: 'status',
      swimlane_dim: 'milestone',
      state: undefined,
      milestone: undefined,
      labels: undefined,
      assignee: undefined,
      refresh: undefined,
    })
  })

  it('sends label and assignee as server-side params', async () => {
    mockGetLensBoard.mockResolvedValue(sampleData)
    const { result } = renderHook(() =>
      useLensData(5, { filters: { labels: ['bug', 'backend'], assignee: 'alice' } }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    // Labels arrive sorted — the server hashes the sorted list into the board
    // cache key, so an unsorted value would mint a second key for one filter.
    expect(mockGetLensBoard.mock.calls[0][1]).toMatchObject({
      labels: 'backend,bug',
      assignee: 'alice',
    })
  })

  it('does not refetch when an equivalent labels array is passed again', async () => {
    mockGetLensBoard.mockResolvedValue(sampleData)
    const { result, rerender } = renderHook(
      ({ labels }: { labels: string[] }) => useLensData(5, { filters: { labels } }),
      { initialProps: { labels: ['bug'] } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockGetLensBoard).toHaveBeenCalledTimes(1)

    // A fresh array with the same contents is the same question. Depending on the
    // array identity here would refetch on every render.
    rerender({ labels: ['bug'] })
    await waitFor(() => expect(result.current.refetching).toBe(false))
    expect(mockGetLensBoard).toHaveBeenCalledTimes(1)
  })

  it('maps a 409 auth_required response to an auth_required error code', async () => {
    mockGetLensBoard.mockRejectedValue(
      axiosError(409, { detail: 'Connect your GitHub account.', code: 'auth_required' }),
    )
    const { result } = renderHook(() => useLensData(5))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toBeNull()
    expect(result.current.error?.code).toBe('auth_required')
    expect(result.current.error?.detail).toBe('Connect your GitHub account.')
  })

  it('maps a 429 rate_limited response and carries retry_after', async () => {
    mockGetLensBoard.mockRejectedValue(
      axiosError(429, { detail: 'Slow down.', code: 'rate_limited', retry_after: 30 }),
    )
    const { result } = renderHook(() => useLensData(5))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error?.code).toBe('rate_limited')
    expect(result.current.error?.retryAfter).toBe(30)
  })

  it('refresh re-fetches and keeps existing data while refetching', async () => {
    mockGetLensBoard.mockResolvedValue(sampleData)
    const { result } = renderHook(() => useLensData(5))
    await waitFor(() => expect(result.current.data).toEqual(sampleData))

    const updated = { ...sampleData, total_count: 7 }
    mockGetLensBoard.mockResolvedValue(updated)
    result.current.refresh()

    // Data stays on screen during the refetch (loading stays false).
    expect(result.current.loading).toBe(false)
    await waitFor(() => expect(result.current.data?.total_count).toBe(7))
    expect(result.current.refetching).toBe(false)
  })
})
