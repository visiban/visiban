import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { filterCards } from '../utils/filterCards'
import { countActiveFilters, EMPTY_FILTER } from '../components/Board/FilterBar'
import type { Card, Priority, User } from '../types'

// ---- Test helpers ----

const alice: User = {
  id: 1, username: 'alice', email: 'alice@example.com',
  first_name: 'Alice', last_name: 'Smith', avatar_url: '',
  display_name: 'Alice Smith', is_site_admin: false, must_change_password: false, must_change_username: false,
}

const bob: User = {
  id: 2, username: 'bob', email: 'bob@example.com',
  first_name: 'Bob', last_name: 'Jones', avatar_url: '',
  display_name: 'Bob Jones', is_site_admin: false, must_change_password: false, must_change_username: false,
}

function makeCard(overrides: Partial<Card> & { id: number; title: string }): Card {
  return {
    uid: 'carduid00001',
    column: 1,
    swimlane: 1,
    description: '',
    priority: 'medium' as Priority,
    assignee: null,
    labels: [],
    due_date: null,
    weight: 0,
    position: 0,
    created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_moved_at: null,
    attachment_count: 0,
    checklist_total: 0,
    checklist_done: 0,
    is_stale: false,
    archived_at: null,
    version: 1,
    ...overrides,
  }
}

const cards: Card[] = [
  makeCard({ id: 1, title: 'Setup CI pipeline', description: 'Configure GitHub Actions', priority: 'high', assignee: alice, labels: [{ id: 1, uid: 'lbluid000001', name: 'devops', color: '#00f' }] }),
  makeCard({ id: 2, title: 'Fix login bug', description: 'Users cannot log in with SSO', priority: 'urgent', assignee: bob }),
  makeCard({ id: 3, title: 'Write docs', description: 'Add API documentation', priority: 'low', assignee: null, labels: [{ id: 2, uid: 'lbluid000002', name: 'docs', color: '#0f0' }] }),
  makeCard({ id: 4, title: 'Refactor auth', description: 'Clean up auth module', priority: 'medium', assignee: alice, labels: [{ id: 1, uid: 'lbluid000001', name: 'devops', color: '#00f' }, { id: 2, uid: 'lbluid000002', name: 'docs', color: '#0f0' }] }),
]

describe('filterCards — search filter', () => {
  it('matches card title', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, search: 'login' })).toEqual([2])
  })

  it('matches card description', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, search: 'GitHub Actions' })).toEqual([1])
  })

  it('is case-insensitive', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, search: 'SETUP CI' })).toEqual([1])
  })

  it('matches assignee display name', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, search: 'Bob' })).toEqual([2])
  })

  it('matches label name', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, search: 'devops' })).toEqual([1, 4])
  })

  it('returns nothing when search does not match', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, search: 'nonexistent' })).toEqual([])
  })
})

describe('filterCards — assignee filter', () => {
  it('matches assigned user by id', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, assigneeIds: [alice.id] })).toEqual([1, 4])
  })

  it('matches unassigned cards with -1', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, assigneeIds: [-1] })).toEqual([3])
  })

  it('matches multiple assignees with OR logic', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, assigneeIds: [alice.id, bob.id] })).toEqual([1, 2, 4])
  })

  it('matches assigned + unassigned together', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, assigneeIds: [alice.id, -1] })).toEqual([1, 3, 4])
  })
})

describe('filterCards — priority filter', () => {
  it('matches single priority', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, priorities: ['urgent'] })).toEqual([2])
  })

  it('matches multiple priorities (OR logic)', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, priorities: ['high', 'urgent'] })).toEqual([1, 2])
  })
})

describe('filterCards — label filter', () => {
  it('matches cards with a specific label', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, labelIds: [1] })).toEqual([1, 4])
  })

  it('requires all labels (AND logic)', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, labelIds: [1, 2] })).toEqual([4])
  })
})

describe('filterCards — due date filter', () => {
  const FIXED_TODAY = '2026-03-09'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-09T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('matches overdue cards', () => {
    const overdueCards = [
      makeCard({ id: 10, title: 'Overdue task', due_date: '2026-03-08' }),
      makeCard({ id: 11, title: 'Today task', due_date: '2026-03-09' }),
      makeCard({ id: 12, title: 'Future task', due_date: '2026-03-15' }),
    ]
    expect(filterCards(overdueCards, { ...EMPTY_FILTER, dueDate: 'overdue' }, undefined, FIXED_TODAY)).toEqual([10])
  })

  it('matches cards due today', () => {
    const todayCards = [
      makeCard({ id: 10, title: 'Yesterday', due_date: '2026-03-08' }),
      makeCard({ id: 11, title: 'Today', due_date: '2026-03-09' }),
      makeCard({ id: 12, title: 'Tomorrow', due_date: '2026-03-10' }),
    ]
    expect(filterCards(todayCards, { ...EMPTY_FILTER, dueDate: 'today' }, undefined, FIXED_TODAY)).toEqual([11])
  })

  it('matches cards due this week', () => {
    const weekCards = [
      makeCard({ id: 10, title: 'Past', due_date: '2026-03-08' }),
      makeCard({ id: 11, title: 'Today', due_date: '2026-03-09' }),
      makeCard({ id: 12, title: 'Mid-week', due_date: '2026-03-12' }),
      makeCard({ id: 13, title: 'Next week', due_date: '2026-03-16' }),
      makeCard({ id: 14, title: 'Exactly 7 days', due_date: '2026-03-16' }),
    ]
    expect(filterCards(weekCards, { ...EMPTY_FILTER, dueDate: 'this_week' }, undefined, FIXED_TODAY)).toEqual([11, 12])
  })

  it('matches cards with no due date', () => {
    const mixedCards = [
      makeCard({ id: 10, title: 'Has date', due_date: '2026-03-10' }),
      makeCard({ id: 11, title: 'No date', due_date: null }),
    ]
    expect(filterCards(mixedCards, { ...EMPTY_FILTER, dueDate: 'none' }, undefined, FIXED_TODAY)).toEqual([11])
  })
})

describe('filterCards — multiple filters stack (AND logic)', () => {
  it('combines search + assignee', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, search: 'auth', assigneeIds: [alice.id] })).toEqual([4])
  })

  it('combines search + priority', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, search: 'CI', priorities: ['high'] })).toEqual([1])
  })

  it('returns empty when filters conflict', () => {
    // "Fix login bug" is assigned to bob, not alice
    expect(filterCards(cards, { ...EMPTY_FILTER, search: 'login', assigneeIds: [alice.id] })).toEqual([])
  })
})

describe('filterCards — clearing filters shows all cards', () => {
  it('returns all card IDs when filter state is empty', () => {
    expect(filterCards(cards, EMPTY_FILTER)).toEqual(cards.map((c) => c.id))
  })
})

describe('filterCards — server search intersection', () => {
  it('intersects server search results with client filters', () => {
    // Server returned cards 1 and 2; client filter requires alice as assignee
    // → only card 1 (assigned to alice) passes
    expect(filterCards(cards, { ...EMPTY_FILTER, assigneeIds: [alice.id] }, [1, 2])).toEqual([1])
  })

  it('uses only server results when no client filters are active', () => {
    // When searchResults is provided but no client filters, all server results pass through
    expect(filterCards(cards, EMPTY_FILTER, [2, 3])).toEqual([2, 3])
  })

  it('returns empty when server results and client filter have no overlap', () => {
    // Server returned card 2 (assigned to bob); filter requires alice
    expect(filterCards(cards, { ...EMPTY_FILTER, assigneeIds: [alice.id] }, [2])).toEqual([])
  })
})

describe('countActiveFilters — additional cases', () => {
  it('counts multiple priorities as one active filter', () => {
    expect(countActiveFilters({ ...EMPTY_FILTER, priorities: ['high', 'urgent', 'low'] })).toBe(1)
  })

  it('counts multiple label ids as one active filter', () => {
    expect(countActiveFilters({ ...EMPTY_FILTER, labelIds: [1, 2, 3] })).toBe(1)
  })

  it('counts combination of two filter types as 2', () => {
    expect(countActiveFilters({ ...EMPTY_FILTER, search: 'test', dueDate: 'today' })).toBe(2)
  })

  it('counts 3 active filter types', () => {
    expect(countActiveFilters({
      ...EMPTY_FILTER,
      search: 'x',
      assigneeIds: [1],
      priorities: ['high'],
    })).toBe(3)
  })
})
