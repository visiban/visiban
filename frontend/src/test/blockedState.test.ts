import { describe, it, expect } from 'vitest'
import {
  blockedElapsedMs, blockedIndicatorLabel, formatBlockedDuration, isCardBlocked, isManuallyBlocked,
} from '../utils/blockedState'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('blockedState (#1149)', () => {
  it('isCardBlocked is the union of manual and relation blocks', () => {
    expect(isCardBlocked({ blocked_at: null, blocker_count: 0 })).toBe(false)
    expect(isCardBlocked({ blocked_at: '2026-10-01T00:00:00Z', blocker_count: 0 })).toBe(true)
    expect(isCardBlocked({ blocked_at: null, blocker_count: 2 })).toBe(true)
  })

  it('isManuallyBlocked ignores relation blocks', () => {
    expect(isManuallyBlocked({ blocked_at: null })).toBe(false)
    expect(isManuallyBlocked({ blocked_at: '2026-10-01T00:00:00Z' })).toBe(true)
  })

  it('formats one unit for the card face and two for the name', () => {
    expect(formatBlockedDuration(3 * DAY + 5 * HOUR, 1)).toBe('3d')
    expect(formatBlockedDuration(3 * DAY + 5 * HOUR, 2)).toBe('3d 5h')
    expect(formatBlockedDuration(3 * DAY, 2)).toBe('3d')
    expect(formatBlockedDuration(5 * HOUR + 12 * MIN, 2)).toBe('5h 12m')
    expect(formatBlockedDuration(5 * HOUR + 12 * MIN, 1)).toBe('5h')
    expect(formatBlockedDuration(12 * MIN, 2)).toBe('12m')
    expect(formatBlockedDuration(30_000)).toBe('<1m')
    expect(formatBlockedDuration(0)).toBe('<1m')
  })

  it('elapsed time never goes negative and tolerates a bad timestamp', () => {
    const now = Date.parse('2026-10-05T00:00:00Z')
    expect(blockedElapsedMs('2026-10-04T00:00:00Z', now)).toBe(DAY)
    expect(blockedElapsedMs('2026-10-06T00:00:00Z', now)).toBe(0)
    expect(blockedElapsedMs('not a date', now)).toBe(0)
  })

  it('labels manual, relation and combined blocks', () => {
    const now = Date.parse('2026-10-04T05:00:00Z')
    const at = '2026-10-01T00:00:00Z'
    expect(blockedIndicatorLabel({ blocked_at: at, blocked_reason: 'Waiting on customer', blocker_count: 0 }, now))
      .toBe('Blocked 3d 5h: Waiting on customer')
    expect(blockedIndicatorLabel({ blocked_at: at, blocked_reason: '  ', blocker_count: 0 }, now))
      .toBe('Blocked 3d 5h')
    expect(blockedIndicatorLabel({ blocked_at: null, blocked_reason: '', blocker_count: 1 }, now))
      .toBe('Blocked by 1 card')
    expect(blockedIndicatorLabel({ blocked_at: null, blocked_reason: '', blocker_count: 3 }, now))
      .toBe('Blocked by 3 cards')
    expect(blockedIndicatorLabel({ blocked_at: at, blocked_reason: 'Vendor', blocker_count: 1 }, now))
      .toBe('Blocked 3d 5h: Vendor. Also blocked by 1 card')
    expect(blockedIndicatorLabel({ blocked_at: at, blocked_reason: 'Vendor', blocker_count: 2 }, now))
      .toBe('Blocked 3d 5h: Vendor. Also blocked by 2 cards')
  })
})
