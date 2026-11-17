import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { filterCards } from '../utils/filterCards'
import { EMPTY_FILTER } from '../components/Board/FilterBar'
import { setInstanceTimezone } from '../utils/instanceTimezone'
import type { Card } from '../types'

// #2313: the board's "Due: Overdue" filter follows the same shared fixture as the
// card face, the Show chip and the server, so the filter and the chip cannot disagree.
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

afterEach(() => {
  vi.useRealTimers()
  setInstanceTimezone('UTC')
})

describe('filterCards Due: Overdue follows the one rule (#2313)', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse(c.now))
    setInstanceTimezone(c.tz)
    const card = {
      id: 1, title: 'c', description: '', labels: [], assignee: null, priority: 'medium',
      due_date: c.due_date, column: c.done ? 2 : 1, archived_at: c.archived ? c.now : null,
    } as unknown as Card
    // The browser-local "today" passed in must not decide the overdue filter.
    const ids = filterCards([card], { ...EMPTY_FILTER, dueDate: 'overdue' }, undefined, '1999-01-01', undefined, new Set([2]))
    expect(ids.includes(1)).toBe(c.overdue)
  })
})
