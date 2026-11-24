import { describe, it, expect } from 'vitest'
import { relativeTime } from '../utils/relativeTime'

// #1900 — the shared "X ago" formatter had no direct test.
describe('relativeTime', () => {
  const now = 1_000_000_000_000
  it.each([
    [0, 'just now'],
    [9_999, 'just now'],
    [10_000, '10 s ago'],
    [59_999, '59 s ago'],
    [60_000, '1 m ago'],
    [3_599_999, '59 m ago'],
    [3_600_000, '1 h ago'],
    [86_399_999, '23 h ago'],
    [86_400_000, '1 d ago'],
    [3 * 86_400_000 + 5, '3 d ago'],
  ])('diff of %i ms reads %s', (diff, expected) => {
    expect(relativeTime(now - diff, now)).toBe(expected)
  })
  it('clamps a timestamp in the future to just now', () => {
    expect(relativeTime(now + 60_000, now)).toBe('just now')
  })
})
