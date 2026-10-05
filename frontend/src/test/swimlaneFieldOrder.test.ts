import { describe, it, expect } from 'vitest'
import { canEditSwimlaneFieldOrder } from '../utils/swimlaneFieldOrder'

describe('canEditSwimlaneFieldOrder (#1458)', () => {
  it('is true for an admin with 2 definitions', () => {
    expect(canEditSwimlaneFieldOrder(true, 2)).toBe(true)
  })
  it('is false for an admin with 1 definition', () => {
    expect(canEditSwimlaneFieldOrder(true, 1)).toBe(false)
  })
  it('is false for a non-admin with 5 definitions', () => {
    expect(canEditSwimlaneFieldOrder(false, 5)).toBe(false)
  })
})
