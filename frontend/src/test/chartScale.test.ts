import { describe, expect, it } from 'vitest'
import { axisTicks, linearScale, niceCeil, spreadLabels } from '../utils/chartScale'

describe('linearScale', () => {
  it('maps a domain onto a range, including a reversed one', () => {
    expect(linearScale([0, 10], [100, 200])(5)).toBe(150)
    expect(linearScale([0, 10], [200, 100])(10)).toBe(100)
  })

  it('maps a flat domain to the range start instead of dividing by zero', () => {
    expect(linearScale([3, 3], [10, 20])(3)).toBe(10)
  })
})

describe('niceCeil', () => {
  it.each([[0, 1], [0.7, 1], [1, 1], [1.2, 2], [3, 5], [6, 10], [23, 50], [120, 200]])('%d -> %d', (value, expected) => {
    expect(niceCeil(value)).toBe(expected)
  })
})

describe('axisTicks', () => {
  it('runs from zero to the maximum in readable steps', () => {
    expect(axisTicks(20)).toEqual([0, 5, 10, 15, 20])
    expect(axisTicks(1)).toEqual([0, 0.5, 1])
  })
})

describe('spreadLabels', () => {
  it('leaves labels that do not collide alone', () => {
    expect(spreadLabels([10, 50, 100], 14)).toEqual([10, 50, 100])
  })

  it('pushes close labels apart and keeps input positions addressable', () => {
    expect(spreadLabels([50, 10, 12], 14)).toEqual([50, 10, 24])
    expect(spreadLabels([10, 11, 12], 14)).toEqual([10, 24, 38])
  })
})
