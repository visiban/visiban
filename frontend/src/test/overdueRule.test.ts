import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { classifyCardUrgency, isOverdue } from '../utils/cardUrgency'
import { instanceTimezone, setInstanceTimezone } from '../utils/instanceTimezone'
import { cardShowChip } from '../utils/showChips'
import { cardBoardStatus } from '../constants/laneStatus'

// #2313: the backend runs the same fixture through overdue_signal_q and the
// auto health counts (backend/boards/tests/test_overdue_rule.py), so the card
// face and the server cannot disagree on any of these cases.
interface OverdueCase {
  name: string
  now: string
  tz: string
  due_date: string | null
  done: boolean
  archived: boolean
  overdue: boolean
}

const { cases } = JSON.parse(
  readFileSync(resolve(__dirname, '../../../backend/boards/tests/fixtures/overdue_rule_cases.json'), 'utf8'),
) as { cases: OverdueCase[] }

afterEach(() => setInstanceTimezone('UTC'))

describe('the shared overdue rule (#2313)', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    setInstanceTimezone(c.tz)
    const now = Date.parse(c.now)
    const closed = c.done || c.archived
    expect(isOverdue(c.due_date, closed, now)).toBe(c.overdue)
    const kind = classifyCardUrgency({ due_date: c.due_date, closed, is_stale: false, last_moved_at: null }, now)?.kind
    expect(kind === 'overdue').toBe(c.overdue)
    if (!c.archived) {
      // The list helpers take the done flag from the column.
      expect(cardShowChip({ due_date: c.due_date, is_stale: false }, c.done, now) === 'overdue').toBe(c.overdue)
    }
  })

  it('a card due today is due soon, not overdue, until the instance midnight', () => {
    const now = Date.parse('2026-03-11T23:59:00Z')
    expect(classifyCardUrgency({ due_date: '2026-03-11', is_stale: false, last_moved_at: null }, now)?.kind).toBe('due-soon')
  })

  it('a closed card carries no due-soon signal either', () => {
    const now = Date.parse('2026-03-11T12:00:00Z')
    expect(classifyCardUrgency({ due_date: '2026-03-12', closed: true, is_stale: false, last_moved_at: null }, now)).toBeNull()
  })

  it('lane status skips a done-column card', () => {
    // Real clock: a date long past is overdue unless the card is done.
    expect(cardBoardStatus({ due_date: '2020-01-01', is_stale: false, last_moved_at: null }, true)).toBe('ok')
    expect(cardBoardStatus({ due_date: '2020-01-01', is_stale: false, last_moved_at: null }, false)).toBe('overdue')
  })

  it('the instance zone defaults to UTC and ignores a blank value', () => {
    setInstanceTimezone('Asia/Tokyo')
    expect(instanceTimezone()).toBe('Asia/Tokyo')
    setInstanceTimezone('')
    expect(instanceTimezone()).toBe('UTC')
    setInstanceTimezone(undefined)
    expect(instanceTimezone()).toBe('UTC')
  })
})
