import { describe, it, expect } from 'vitest'
import { countActiveFilters, EMPTY_FILTER } from '../components/Board/FilterBar'

describe('countActiveFilters', () => {
  it('returns 0 for empty filter state', () => {
    expect(countActiveFilters(EMPTY_FILTER)).toBe(0)
  })

  it('counts search as one active filter', () => {
    expect(countActiveFilters({ ...EMPTY_FILTER, search: 'hello' })).toBe(1)
  })

  it('counts non-empty assigneeIds as one active filter', () => {
    expect(countActiveFilters({ ...EMPTY_FILTER, assigneeIds: [5] })).toBe(1)
  })

  it('counts unassigned (-1) in assigneeIds as one active filter', () => {
    expect(countActiveFilters({ ...EMPTY_FILTER, assigneeIds: [-1] })).toBe(1)
  })

  it('counts multiple assignees as one active filter', () => {
    expect(countActiveFilters({ ...EMPTY_FILTER, assigneeIds: [1, 2, 3] })).toBe(1)
  })

  it('does not count empty assigneeIds array', () => {
    expect(countActiveFilters({ ...EMPTY_FILTER, assigneeIds: [] })).toBe(0)
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
      assigneeIds: [1],
      labelIds: [3],
      priorities: ['urgent'],
      dueDate: 'today',
      customFields: {},
      visibleCustomFieldFilterIds: [],
    })).toBe(5)
  })

  // #371
  it('does not count an empty custom field filter value', () => {
    expect(countActiveFilters({
      ...EMPTY_FILTER,
      customFields: { 1: { kind: 'text', query: '' } },
    })).toBe(0)
  })

  it('counts a non-empty text custom field filter as one active filter', () => {
    expect(countActiveFilters({
      ...EMPTY_FILTER,
      customFields: { 1: { kind: 'text', query: 'sprint 14' } },
    })).toBe(1)
  })

  it('counts a non-empty choice custom field filter as one active filter', () => {
    expect(countActiveFilters({
      ...EMPTY_FILTER,
      customFields: { 2: { kind: 'choice', values: ['Beta'] } },
    })).toBe(1)
  })

  it('counts multiple populated custom field filters as one active filter, matching other multi-value dimensions', () => {
    expect(countActiveFilters({
      ...EMPTY_FILTER,
      customFields: {
        1: { kind: 'text', query: 'sprint 14' },
        2: { kind: 'choice', values: ['Beta'] },
      },
    })).toBe(1)
  })

  it('does not count visibleCustomFieldFilterIds by itself — an open control with no value filters nothing', () => {
    expect(countActiveFilters({
      ...EMPTY_FILTER,
      visibleCustomFieldFilterIds: [1, 2],
    })).toBe(0)
  })
})
