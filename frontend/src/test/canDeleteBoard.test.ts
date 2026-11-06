import { describe, it, expect } from 'vitest'
import { canDeleteBoard } from '../utils/canDeleteBoard'

describe('canDeleteBoard (#2034)', () => {
  it('allows the owner', () => expect(canDeleteBoard({ ownerId: 1, userId: 1, hasAllContentAccess: false })).toBe(true))
  it('allows all-content access', () => expect(canDeleteBoard({ ownerId: 1, userId: 2, hasAllContentAccess: true })).toBe(true))
  it('refuses a non-owner', () => expect(canDeleteBoard({ ownerId: 1, userId: 2, hasAllContentAccess: false })).toBe(false))
  it('refuses when ids are unknown', () => {
    expect(canDeleteBoard({ ownerId: null, userId: null, hasAllContentAccess: false })).toBe(false)
    expect(canDeleteBoard({ ownerId: 1, userId: undefined, hasAllContentAccess: false })).toBe(false)
  })
})
