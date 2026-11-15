import { describe, it, expect, vi, afterEach } from 'vitest'
import { cardShowChip, parseShowChip, showChipCardIds, showChipCounts } from '../utils/showChips'
import { cardBoardStatus } from '../constants/laneStatus'
import { buildCardStatusLine, formatShortMonthDay } from '../utils/cardStatusLine'

const NOW = Date.parse('2026-06-15T12:00:00Z')
const columns = [{ id: 1, is_done: false }, { id: 2, is_done: true }]
const c = (o: Partial<{ id: number; column: number; due_date: string | null; is_stale: boolean; archived_at: string | null }> = {}) =>
  ({ id: 1, column: 1, due_date: null, is_stale: false, archived_at: null, ...o })

describe('show chips (#2272)', () => {
  afterEach(() => { vi.useRealTimers() })

  it('parses the URL param and falls back to all', () => {
    expect(parseShowChip('overdue')).toBe('overdue')
    expect(parseShowChip('due_soon')).toBe('due_soon')
    expect(parseShowChip('stale')).toBe('stale')
    expect(parseShowChip(null)).toBe('all')
    expect(parseShowChip('nope')).toBe('all')
  })

  it('classifies by the card-face precedence: overdue, then due soon, then stale', () => {
    expect(cardShowChip(c({ due_date: '2026-06-01', is_stale: true }), false, NOW)).toBe('overdue')
    expect(cardShowChip(c({ due_date: '2026-06-16', is_stale: true }), false, NOW)).toBe('due_soon')
    expect(cardShowChip(c({ is_stale: true }), false, NOW)).toBe('stale')
    expect(cardShowChip(c({ is_stale: true }), true, NOW)).toBeNull()
    expect(cardShowChip(c({ due_date: '2026-09-01' }), false, NOW)).toBeNull()
  })

  it('a stale card that is also due soon: the chips say due soon, the band and squares say stale (#2272)', () => {
    // Deliberate, documented difference (frontend/CLAUDE.md § Show chips): cardShowChip ranks
    // overdue > due soon > stale, cardBoardStatus ranks overdue > stale and ignores due soon.
    // cardBoardStatus reads the wall clock, so pin it to NOW.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const card = c({ due_date: '2026-06-16', is_stale: true })
    expect(cardShowChip(card, false, NOW)).toBe('due_soon')
    expect(cardBoardStatus({ ...card, last_moved_at: null }, false)).toBe('stale')
  })

  it('counts the whole board without archived cards', () => {
    const cards = [
      c({ id: 1, due_date: '2026-06-01' }), c({ id: 2, due_date: '2026-06-16' }), c({ id: 3, is_stale: true }),
      c({ id: 4 }), c({ id: 5, is_stale: true, column: 2 }), c({ id: 6, due_date: '2026-06-01', archived_at: '2026-06-01T00:00:00Z' }),
    ]
    expect(showChipCounts(cards, columns, NOW)).toEqual({ all: 5, overdue: 1, stale: 1, due_soon: 1 })
  })

  it('returns the ids a chip keeps', () => {
    const cards = [c({ id: 1, due_date: '2026-06-01' }), c({ id: 2 }), c({ id: 3, due_date: '2026-06-01' })]
    expect([...showChipCardIds(cards, columns, 'overdue', NOW)]).toEqual([1, 3])
  })
})

describe('buildCardStatusLine (#2272)', () => {
  it('formats the short month and day without a timezone shift, and passes through a bad date', () => {
    expect(formatShortMonthDay('2026-11-12')).toBe('Nov 12')
    expect(formatShortMonthDay('garbage')).toBe('garbage')
  })

  it('words overdue, due soon and stale, long and short', () => {
    expect(buildCardStatusLine({ kind: 'overdue', dueDate: '2026-11-12', dueLabel: 'Due 11/12/2026', idleDays: 0 }))
      .toMatchObject({ text: 'Overdue Nov 12', shortText: 'Overdue' })
    expect(buildCardStatusLine({ kind: 'overdue', dueDate: null, dueLabel: null, idleDays: 0 }).text).toBe('Overdue')
    expect(buildCardStatusLine({ kind: 'due-soon', dueDate: '2026-11-18', dueLabel: 'Due in 3 days', idleDays: 0 }))
      .toMatchObject({ text: 'Due in 3 days', shortText: 'Due soon' })
    expect(buildCardStatusLine({ kind: 'due-soon', dueDate: null, dueLabel: null, idleDays: 0 }).text).toBe('Due soon')
    expect(buildCardStatusLine({ kind: 'stale', dueDate: null, dueLabel: null, idleDays: 39 }))
      .toMatchObject({ text: 'Stale 39d', shortText: '39d', shortSrPrefix: 'Stale ' })
    expect(buildCardStatusLine({ kind: 'stale', dueDate: null, dueLabel: null, idleDays: 0 }))
      .toMatchObject({ text: 'Stale', shortText: 'Stale', shortSrPrefix: '' })
  })
})
