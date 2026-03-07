import { describe, it, expect } from 'vitest'
import { countActiveFilters, EMPTY_FILTER } from '../components/Board/FilterBar'

describe('countActiveFilters', () => {
  it('returns 0 for empty filter state', () => {
    expect(countActiveFilters(EMPTY_FILTER)).toBe(0)
  })

  it('counts search as one active filter', () => {
    expect(countActiveFilters({ ...EMPTY_FILTER, search: 'hello' })).toBe(1)
  })

  it('counts assigneeId as one active filter', () => {
    expect(countActiveFilters({ ...EMPTY_FILTER, assigneeId: 5 })).toBe(1)
  })

  it('counts unassigned (-1) as one active filter', () => {
    expect(countActiveFilters({ ...EMPTY_FILTER, assigneeId: -1 })).toBe(1)
  })

  it('counts non-empty labelIds as one active filter', () => {
    expect(countActiveFilters({ ...EMPTY_FILTER, labelIds: [1, 2] })).toBe(1)
  })

  it('does not count empty labelIds array', () => {
    expect(countActiveFilters({ ...EMPTY_FILTER, labelIds: [] })).toBe(0)
  })

  it('counts non-empty priorities as one active filter', () => {
    expect(countActiveFilters({ ...EMPTY_FILTER, priorities: ['high'] })).toBe(1)
  })

  it('counts dueDate as one active filter', () => {
    expect(countActiveFilters({ ...EMPTY_FILTER, dueDate: 'overdue' })).toBe(1)
  })

  it('counts all active filters together', () => {
    expect(countActiveFilters({
      search: 'test',
      assigneeId: 1,
      labelIds: [3],
      priorities: ['urgent'],
      dueDate: 'today',
    })).toBe(5)
  })
})
