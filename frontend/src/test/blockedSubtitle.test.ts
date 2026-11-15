import { describe, expect, it } from 'vitest'
import { blockedSubtitle } from '../components/Board/flowMetrics/flowFormat'

const FIXED = 'Block reasons over the last 30 days, longest first.'
const HALF = 'One reason accounts for more than half of all blocked time.'
const NEARLY = 'One reason accounts for nearly half of all blocked time.'
const SAME = 'Every blocked day had the same reason.'

/** A top reason of `top` days among `rest` other reasons, total `top + sum(rest)`. */
const make = (top: number, rest: number[], reasonCount = rest.length + 1) => ({
  reasons: [top, ...rest].map((days, i) => ({ reason: `R${i}`, days, blocks: 1 })),
  reason_count: reasonCount,
  total: { days: top + rest.reduce((a, b) => a + b, 0), blocks: rest.length + 1 },
})

describe('blockedSubtitle (#2282)', () => {
  it('says every blocked day had the same reason when there is exactly one', () => {
    expect(blockedSubtitle(make(2, []), 30)).toBe(SAME)
  })

  it('counts distinct reasons before the cap, not the capped list', () => {
    // One listed reason of 11 distinct: a 10% share, not "the same reason".
    expect(blockedSubtitle({ ...make(1, [], 11), total: { days: 10, blocks: 11 } }, 30)).toBe(FIXED)
  })

  it('says more than half above 50%', () => {
    expect(blockedSubtitle(make(6, [4]), 30)).toBe(HALF)
  })

  it('takes "more than half" at exactly 50%', () => {
    expect(blockedSubtitle(make(5, [5]), 30)).toBe(HALF)
  })

  it('says nearly half just under 50%', () => {
    expect(blockedSubtitle(make(49.99, [30, 20.01]), 30)).toBe(NEARLY)
  })

  it('says nearly half at exactly 40%', () => {
    expect(blockedSubtitle(make(4, [3, 3]), 30)).toBe(NEARLY)
  })

  it('keeps the fixed sentence just under 40%', () => {
    expect(blockedSubtitle(make(39.99, [30, 30.01]), 30)).toBe(FIXED)
  })

  it('does not round before comparing: 49.6% is not half', () => {
    expect(blockedSubtitle(make(49.6, [30, 20.4]), 30)).toBe(NEARLY)
  })

  it('keeps the fixed sentence for an even spread', () => {
    expect(blockedSubtitle(make(1, [1, 1]), 30)).toBe(FIXED)
  })

  it('keeps the fixed sentence when total days is 0', () => {
    expect(blockedSubtitle({ reasons: [], reason_count: 0, total: { days: 0, blocks: 0 } }, 30)).toBe(FIXED)
    expect(blockedSubtitle({ reasons: [{ reason: 'A', days: 0, blocks: 1 }], reason_count: 1, total: { days: 0, blocks: 1 } }, 30)).toBe(FIXED)
  })
})
