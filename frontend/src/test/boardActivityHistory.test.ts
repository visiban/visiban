/**
 * #2596: the Activity drawer's saved-history rows. The drawer opens with the
 * board's saved moves and creations and merges live socket rows over them.
 */
import { describe, it, expect } from 'vitest'
import {
  ACTIVITY_FEED_LIMIT, createEntryId, mergeActivityFeeds, movementActivityEntry, movementEntryId,
} from '../components/Board/boardActivityHistory'
import type { ActivityEntry } from '../components/Board/BoardActivityDrawer'
import type { CardMovement } from '../types'

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

  it('keys a creation with no card uid by its movement id', () => {
    const e = movementActivityEntry(movement({ from_column_name: '', from_column_uid: '', card_uid: '' }))
    expect(e.id).toBe(movementEntryId(3))
  })
})

describe('mergeActivityFeeds', () => {
  it('lists newest first and keeps the live copy of a row both sides have', () => {
    const live = [{ ...entry('mv-1', 300), actor: 'live' }, entry('member-x', 100, 'member')]
    const saved = [entry('mv-1', 300), entry('mv-0', 200)]
    const merged = mergeActivityFeeds(saved, live)
    expect(merged.map((e) => e.id)).toEqual(['mv-1', 'mv-0', 'member-x'])
    expect(merged[0].actor).toBe('live')
  })

  it(`caps the feed at ${ACTIVITY_FEED_LIMIT} rows, dropping the oldest`, () => {
    const saved = Array.from({ length: ACTIVITY_FEED_LIMIT + 5 }, (_, i) => entry(`mv-${i}`, i))
    const merged = mergeActivityFeeds(saved, [])
    expect(merged).toHaveLength(ACTIVITY_FEED_LIMIT)
    expect(merged[merged.length - 1].id).toBe('mv-5')
  })
})
