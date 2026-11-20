import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyCardUrgency } from '../utils/cardUrgency'
import { formatDueDate } from '../utils/date'
import { setInstanceTimezone } from '../utils/instanceTimezone'

/**
 * #2393: CardItem dropped the overdue / due-soon / stale branches of its urgency
 * badge and the due pill's urgency glyph and tone. That is only safe while the
 * classifiers that decide them cannot disagree. These properties pin it over a
 * grid of due dates, clock instants around midnight and time zones at both ends
 * of the UTC offset range.
 */

const ZONES = ['Pacific/Kiritimati', 'Asia/Tokyo', 'UTC', 'America/New_York', 'Pacific/Pago_Pago']
// Instants just before and after midnight UTC, and mid-day.
const NOWS = ['2026-03-10T00:00:01Z', '2026-03-10T11:59:59Z', '2026-03-10T23:59:59Z', '2026-03-11T13:00:00Z']
const DAY = 86_400_000

function dueDates(now: number): string[] {
  const out: string[] = []
  for (let d = -4; d <= 6; d++) out.push(new Date(now + d * DAY).toISOString().slice(0, 10))
  return out
}

afterEach(() => {
  setInstanceTimezone('UTC')
  vi.useRealTimers()
})

describe('the status line and the badge agree (#2393)', () => {
  it('a badge kind other than "recent" is always the status-line kind', () => {
    let checked = 0
    for (const tz of ZONES) {
      setInstanceTimezone(tz)
      for (const iso of NOWS) {
        const now = Date.parse(iso)
        for (const due_date of [null, ...dueDates(now)]) {
          for (const is_stale of [false, true]) {
            for (const closed of [false, true]) {
              for (const last_moved_at of [null, new Date(now - 3_600_000).toISOString()]) {
                const badge = classifyCardUrgency({ due_date, closed, is_stale, last_moved_at }, now)
                const status = classifyCardUrgency({ due_date, closed, is_stale, last_moved_at: null }, now)
                if (badge && badge.kind !== 'recent') {
                  expect(status?.kind).toBe(badge.kind)
                  checked++
                } else {
                  // No status line, so the badge (if any) is the "Just moved" cue.
                  expect(status).toBeNull()
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100)
  })
})

describe('the due pill needs no urgency tone (#2393)', () => {
  it('a date formatDueDate calls past is overdue or due soon under the instance-zone rule', () => {
    let checked = 0
    for (const instanceTz of ZONES) {
      setInstanceTimezone(instanceTz)
      for (const userTz of ZONES) {
        for (const iso of NOWS) {
          const now = Date.parse(iso)
          vi.useFakeTimers({ now })
          for (const due_date of dueDates(now)) {
            if (!formatDueDate(due_date, userTz).overdue) continue
            const kind = classifyCardUrgency({ due_date, is_stale: false, last_moved_at: null }, now)?.kind
            expect(['overdue', 'due-soon']).toContain(kind)
            checked++
          }
          vi.useRealTimers()
        }
      }
    }
    expect(checked).toBeGreaterThan(100)
  })
})
