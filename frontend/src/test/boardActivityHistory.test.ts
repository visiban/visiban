/**
 * #2596: the Activity drawer's saved-history rows. The drawer opens with the
 * board's saved moves and creations and merges live socket rows over them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  ACTIVITY_FEED_LIMIT, createEntryId, mergeActivityFeeds, movementActivityEntry, movementEntryId,
  useBoardActivityHistory,
} from '../components/Board/boardActivityHistory'
import type { ActivityEntry } from '../components/Board/BoardActivityDrawer'
import type { CardMovement } from '../types'

const { getBoardMovements } = vi.hoisted(() => ({ getBoardMovements: vi.fn() }))
vi.mock('../api/boards', () => ({ getBoardMovements }))

const movement = (over: Partial<CardMovement> = {}): CardMovement => ({
  id: 3, card_uid: 'card-uid', card_title: 'Lease renewal',
  from_column: 1, from_column_name: 'Intake', from_column_uid: 'c1',
  to_column: 2, to_column_name: 'Review', to_column_uid: 'c2',
  from_swimlane: 1, from_swimlane_name: 'Lane', from_swimlane_uid: 's1',
  to_swimlane: 1, to_swimlane_name: 'Lane', to_swimlane_uid: 's1',
  moved_by: { id: 4, username: 'sam', display_name: 'Sam Lee' } as CardMovement['moved_by'],
  moved_at: '2026-11-20T10:00:00Z', notes: '', movement_type: 'move',
  ...over,
} as CardMovement)

const entry = (id: string, at: number, kind: ActivityEntry['kind'] = 'move'): ActivityEntry => ({
  id, timestamp: new Date(at), kind, actor: 'A', headline: 'h', detail: '',
})

describe('movementActivityEntry', () => {
  it('words a column move like the live row, keyed by the movement id', () => {
    expect(movementActivityEntry(movement())).toEqual({
      id: movementEntryId(3), timestamp: new Date('2026-11-20T10:00:00Z'), kind: 'move',
      actor: 'Sam Lee', headline: 'moved Lease renewal', subject: 'Lease renewal', detail: 'Intake → Review',
    })
  })

  it('reads the creation movement (no origin column) as a create row keyed by the card uid', () => {
    const e = movementActivityEntry(movement({ from_column: null, from_column_name: '', from_column_uid: '', notes: 'Card created' }))
    expect(e).toMatchObject({ id: createEntryId('card-uid'), kind: 'create', headline: 'created Lease renewal', detail: '' })
  })

  it('falls back to "Someone" and "a card" for a deleted actor and an untitled card', () => {
    const e = movementActivityEntry(movement({ moved_by: null, card_title: '' }))
    expect(e).toMatchObject({ actor: 'Someone', headline: 'moved a card', subject: undefined })
  })

  it('names the actor with the shared formatter: display name, then username', () => {
    const e = movementActivityEntry(movement({ moved_by: { id: 4, username: 'sam', display_name: '' } as CardMovement['moved_by'] }))
    expect(e.actor).toBe('sam')
  })

  it('keys a creation with no card uid by its movement id', () => {
    const e = movementActivityEntry(movement({ from_column_name: '', from_column_uid: '', card_uid: '' }))
    expect(e.id).toBe(movementEntryId(3))
  })
})

describe('mergeActivityFeeds', () => {
  it('lists newest first and keeps the live copy of a row both sides have', () => {
    const live = [{ ...entry('mv-1', 300), actor: 'live' }, entry('member-x', 100, 'member')]
    const saved = [entry('mv-1', 300), entry('mv-0', 200)]
    const { entries } = mergeActivityFeeds(saved, live)
    expect(entries.map((e) => e.id)).toEqual(['mv-1', 'mv-0', 'member-x'])
    expect(entries[0].actor).toBe('live')
  })

  it('on a collision the saved server timestamp wins over the live receipt time', () => {
    const live = [{ ...entry('mv-1', 900), actor: 'live' }]
    const saved = [entry('mv-1', 100), entry('mv-2', 500)]
    const { entries } = mergeActivityFeeds(saved, live)
    expect(entries.map((e) => e.id)).toEqual(['mv-2', 'mv-1'])
    expect(entries[1].timestamp.getTime()).toBe(100)
    expect(entries[1].actor).toBe('live')
  })

  it('breaks a tie on time by id, whichever feed each row came from', () => {
    const a = mergeActivityFeeds([entry('mv-9', 100)], [entry('mv-10', 100)]).entries.map((e) => e.id)
    const b = mergeActivityFeeds([entry('mv-10', 100)], [entry('mv-9', 100)]).entries.map((e) => e.id)
    expect(a).toEqual(['mv-10', 'mv-9'])
    expect(b).toEqual(a)
  })

  it(`caps the feed at ${ACTIVITY_FEED_LIMIT} rows, dropping the oldest, and says it truncated`, () => {
    const saved = Array.from({ length: ACTIVITY_FEED_LIMIT + 5 }, (_, i) => entry(`mv-${i}`, i))
    const { entries, truncated } = mergeActivityFeeds(saved, [])
    expect(entries).toHaveLength(ACTIVITY_FEED_LIMIT)
    expect(entries[entries.length - 1].id).toBe('mv-5')
    expect(truncated).toBe(true)
    expect(mergeActivityFeeds(saved.slice(0, ACTIVITY_FEED_LIMIT), []).truncated).toBe(false)
  })
})

describe('useBoardActivityHistory', () => {
  const page = (ids: number[], count: number) => ({
    results: ids.map((id) => movement({ id })), count, offset: 0, page_size: 50,
  })
  const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i)

  beforeEach(() => { getBoardMovements.mockReset() })

  it('is loading until the fetch lands, then ready; never fetches while disabled', async () => {
    getBoardMovements.mockResolvedValue(page([1], 1))
    const { result, rerender } = renderHook(({ on }) => useBoardActivityHistory(1, on), { initialProps: { on: false } })
    expect(result.current.status).toBe('loading')
    expect(getBoardMovements).not.toHaveBeenCalled()
    rerender({ on: true })
    expect(result.current.status).toBe('loading')
    expect(result.current.entries).toEqual([])
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.entries.map((e) => e.id)).toEqual([movementEntryId(1)])
    expect(result.current.truncated).toBe(false)
  })

  it('follows the 50-row pages up to the feed cap and reports the truncation', async () => {
    getBoardMovements
      .mockResolvedValueOnce(page(ids(1, 50), 130))
      .mockResolvedValueOnce(page(ids(51, 50), 130))
    const { result } = renderHook(() => useBoardActivityHistory(1, true))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(getBoardMovements).toHaveBeenCalledTimes(2)
    expect(getBoardMovements.mock.calls[0][1].offset).toBeUndefined()
    expect(getBoardMovements.mock.calls[1][1]).toMatchObject({ offset: '50', exclude_type: 'archived,unarchived' })
    expect(result.current.entries).toHaveLength(ACTIVITY_FEED_LIMIT)
    expect(result.current.truncated).toBe(true)
  })

  it('stops paging when the count is reached or a page comes back empty', async () => {
    getBoardMovements.mockResolvedValueOnce(page(ids(1, 50), 60)).mockResolvedValueOnce(page([], 60))
    const { result } = renderHook(() => useBoardActivityHistory(1, true))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(getBoardMovements).toHaveBeenCalledTimes(2)
    expect(result.current.entries).toHaveLength(50)
    expect(result.current.truncated).toBe(false)
  })

  it('a failure is an error, not loaded: Retry fetches again', async () => {
    getBoardMovements.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page([7], 1))
    const { result } = renderHook(() => useBoardActivityHistory(1, true))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.entries).toEqual([])
    act(() => result.current.retry())
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(getBoardMovements).toHaveBeenCalledTimes(2)
    expect(result.current.entries.map((e) => e.id)).toEqual([movementEntryId(7)])
  })

  it('loads again for a different board', async () => {
    getBoardMovements.mockResolvedValue(page([1], 1))
    const { result, rerender } = renderHook(({ id }) => useBoardActivityHistory(id, true), { initialProps: { id: 1 } })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ id: 2 })
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(getBoardMovements.mock.calls.map((c) => c[0])).toEqual([1, 2])
  })
})
