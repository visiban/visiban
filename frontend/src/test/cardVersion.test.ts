import { describe, it, expect } from 'vitest'
import { isStaleCard } from '../utils/cardVersion'

// #1969: an HTTP response and a socket frame for the same card are not ordered
// against each other; only a strictly older version is discarded.
describe('isStaleCard (#1969)', () => {
  it('is stale when the incoming version is lower', () => {
    expect(isStaleCard({ version: 2 }, { version: 3 })).toBe(true)
  })

  it('is not stale when the versions are equal (counters change without a bump)', () => {
    expect(isStaleCard({ version: 3 }, { version: 3 })).toBe(false)
  })

  it('is not stale when the incoming version is higher', () => {
    expect(isStaleCard({ version: 4 }, { version: 3 })).toBe(false)
  })

  it('is not stale when either side has no usable version', () => {
    expect(isStaleCard({} as never, { version: 3 })).toBe(false)
    expect(isStaleCard({ version: 1 }, {} as never)).toBe(false)
    expect(isStaleCard({ version: Number.NaN }, { version: 3 })).toBe(false)
    expect(isStaleCard({ version: '1' } as never, { version: 3 })).toBe(false)
    expect(isStaleCard(undefined, { version: 3 })).toBe(false)
    expect(isStaleCard({ version: 1 }, null)).toBe(false)
  })
})
