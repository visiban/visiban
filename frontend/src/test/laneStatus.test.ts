import { describe, it, expect } from 'vitest'
import { cardBoardStatus, STATUS_SQUARE_CLASS, STATUS_LABEL } from '../constants/laneStatus'

const card = (o: Partial<{ due_date: string | null; is_stale: boolean }> = {}) => ({ due_date: null, is_stale: false, last_moved_at: null, ...o })

describe('cardBoardStatus (#2271)', () => {
  it('is overdue for a past due date, ahead of stale', () => {
    expect(cardBoardStatus(card({ due_date: '2020-01-01', is_stale: true }), false)).toBe('overdue')
  })
  it('is stale for a stale card outside a done column', () => {
    expect(cardBoardStatus(card({ is_stale: true }), false)).toBe('stale')
  })
  it('ignores stale in a done column', () => {
    expect(cardBoardStatus(card({ is_stale: true }), true)).toBe('ok')
  })
  it('is ok for an on-track card and for a future due date', () => {
    expect(cardBoardStatus(card(), false)).toBe('ok')
    expect(cardBoardStatus(card({ due_date: '2999-01-01' }), false)).toBe('ok')
  })
  it('exposes token-only square classes and labels for reuse by the Show chips (#2272)', () => {
    expect(STATUS_SQUARE_CLASS).toEqual({ overdue: 'bg-danger-emphasis', stale: 'bg-warning-emphasis', ok: 'bg-primary-emphasis/60' })
    expect(STATUS_LABEL.ok).toBe('on track')
  })
})
