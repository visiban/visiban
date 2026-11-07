import { describe, it, expect } from 'vitest'
import { canDeleteGroup } from '../utils/canDeleteGroup'

describe('canDeleteGroup (#2129)', () => {
  it('allows the owner', () => {
    expect(canDeleteGroup({ ownerId: 1, userId: 1, hasAllContentAccess: false })).toBe(true)
  })
  it('refuses a non-owner', () => {
    expect(canDeleteGroup({ ownerId: 2, userId: 1, hasAllContentAccess: false })).toBe(false)
  })
  it('allows all-content access', () => {
    expect(canDeleteGroup({ ownerId: 2, userId: 1, hasAllContentAccess: true })).toBe(true)
  })
  it('refuses when ids are missing', () => {
    expect(canDeleteGroup({ ownerId: null, userId: null, hasAllContentAccess: false })).toBe(false)
  })
})
