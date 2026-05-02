import { describe, it, expect } from 'vitest'
import { classifyCardUrgency } from '../utils/cardUrgency'

const NOW = Date.parse('2026-05-02T12:00:00Z')

describe('classifyCardUrgency (#961)', () => {
  it('returns null when nothing is urgent', () => {
    expect(
      classifyCardUrgency(
        { due_date: null, is_stale: false, last_moved_at: null },
        NOW,
      ),
    ).toBeNull()
  })

  it('overdue (past due_date) is the highest-priority signal', () => {
    const result = classifyCardUrgency(
      { due_date: '2026-05-01', is_stale: true, last_moved_at: null },
      NOW,
    )
    expect(result).toEqual({ kind: 'overdue', label: 'Overdue', tone: 'danger' })
  })

  it('due-soon fires within 72 hours of the due date', () => {
    const result = classifyCardUrgency(
      { due_date: '2026-05-04T00:00:00Z', is_stale: false, last_moved_at: null },
      NOW,
    )
    expect(result).toEqual({ kind: 'due-soon', label: 'Due soon', tone: 'warning' })
  })

  it('due-soon does not fire 4 days out', () => {
    const result = classifyCardUrgency(
      { due_date: '2026-05-08T00:00:00Z', is_stale: false, last_moved_at: null },
      NOW,
    )
    expect(result).toBeNull()
  })

  it('stale fires when server flag is set and no due-date pressure', () => {
    const result = classifyCardUrgency(
      { due_date: null, is_stale: true, last_moved_at: null },
      NOW,
    )
    expect(result).toEqual({ kind: 'stale', label: 'Stale', tone: 'warning-soft' })
  })

  it('due-soon beats stale (worst-offender priority)', () => {
    const result = classifyCardUrgency(
      { due_date: '2026-05-03T00:00:00Z', is_stale: true, last_moved_at: null },
      NOW,
    )
    expect(result?.kind).toBe('due-soon')
  })

  it('overdue beats due-soon and stale', () => {
    const result = classifyCardUrgency(
      { due_date: '2026-04-30', is_stale: true, last_moved_at: '2026-05-02T11:00:00Z' },
      NOW,
    )
    expect(result?.kind).toBe('overdue')
  })

  it('recent (≤24h since last move) is the calmest cue', () => {
    const result = classifyCardUrgency(
      { due_date: null, is_stale: false, last_moved_at: '2026-05-02T06:00:00Z' },
      NOW,
    )
    expect(result).toEqual({ kind: 'recent', label: 'Just moved', tone: 'info' })
  })

  it('recent does not fire 25h after last move', () => {
    const result = classifyCardUrgency(
      { due_date: null, is_stale: false, last_moved_at: '2026-05-01T11:00:00Z' },
      NOW,
    )
    expect(result).toBeNull()
  })

  it('stale beats recent', () => {
    const result = classifyCardUrgency(
      { due_date: null, is_stale: true, last_moved_at: '2026-05-02T11:00:00Z' },
      NOW,
    )
    expect(result?.kind).toBe('stale')
  })

  it('an invalid due_date string falls through gracefully', () => {
    const result = classifyCardUrgency(
      { due_date: 'not-a-date', is_stale: true, last_moved_at: null },
      NOW,
    )
    expect(result?.kind).toBe('stale')
  })
})
