import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { countActiveFilters, EMPTY_FILTER } from '../components/Board/FilterBar'
import type { FilterState } from '../components/Board/FilterBar'
import type { Card, Priority, User } from '../types'
import { userDisplayName } from '../types'

/**
 * The card-filtering logic lives inline inside BoardView's `filteredCardIds`
 * computed value. We replicate it here as a pure function so we can test
 * the filtering behavior without rendering the full board component.
 */
function filterCards(cards: Card[], filters: FilterState): Card[] {
  if (countActiveFilters(filters) === 0) return cards

  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const nextWeek = new Date(now)
  nextWeek.setDate(now.getDate() + 7)
  const nextWeekStr = `${nextWeek.getFullYear()}-${pad(nextWeek.getMonth() + 1)}-${pad(nextWeek.getDate())}`

  return cards.filter((card) => {
    if (filters.search) {
      const q = filters.search.toLowerCase()
      const matches =
        card.title.toLowerCase().includes(q) ||
        card.description.toLowerCase().includes(q) ||
        (card.assignee && userDisplayName(card.assignee).toLowerCase().includes(q)) ||
        card.labels.some((l) => l.name.toLowerCase().includes(q))
      if (!matches) return false
    }
    if (filters.assigneeIds.length > 0) {
      const matches = filters.assigneeIds.some((id) =>
        id === -1 ? card.assignee === null : card.assignee?.id === id
      )
      if (!matches) return false
    }
    if (filters.labelIds.length > 0 && !filters.labelIds.every((id) => card.labels.some((l) => l.id === id))) return false
    if (filters.priorities.length > 0 && !filters.priorities.includes(card.priority)) return false
    if (filters.dueDate !== null) {
      if (filters.dueDate === 'none' && card.due_date !== null) return false
      if (filters.dueDate === 'overdue') {
        if (!card.due_date || card.due_date >= todayStr) return false
      }
      if (filters.dueDate === 'today') {
        if (card.due_date !== todayStr) return false
      }
      if (filters.dueDate === 'this_week') {
        if (!card.due_date || card.due_date < todayStr || card.due_date >= nextWeekStr) return false
      }
    }
    return true
  })
}

// ---- Test helpers ----

const alice: User = {
  id: 1, username: 'alice', email: 'alice@example.com',
  first_name: 'Alice', last_name: 'Smith', avatar_url: '',
  display_name: 'Alice Smith', is_site_admin: false, must_change_password: false,
}

const bob: User = {
  id: 2, username: 'bob', email: 'bob@example.com',
  first_name: 'Bob', last_name: 'Jones', avatar_url: '',
  display_name: 'Bob Jones', is_site_admin: false, must_change_password: false,
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
    created_by: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_moved_at: null,
    attachment_count: 0,
    checklist_total: 0,
    checklist_done: 0,
    is_stale: false,
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
    const result = filterCards(cards, { ...EMPTY_FILTER, search: 'login' })
    expect(result.map((c) => c.id)).toEqual([2])
  })

  it('matches card description', () => {
    const result = filterCards(cards, { ...EMPTY_FILTER, search: 'GitHub Actions' })
    expect(result.map((c) => c.id)).toEqual([1])
  })

  it('is case-insensitive', () => {
    const result = filterCards(cards, { ...EMPTY_FILTER, search: 'SETUP CI' })
    expect(result.map((c) => c.id)).toEqual([1])
  })

  it('matches assignee display name', () => {
    const result = filterCards(cards, { ...EMPTY_FILTER, search: 'Bob' })
    expect(result.map((c) => c.id)).toEqual([2])
  })

  it('matches label name', () => {
    const result = filterCards(cards, { ...EMPTY_FILTER, search: 'devops' })
    expect(result.map((c) => c.id)).toEqual([1, 4])
  })

  it('returns nothing when search does not match', () => {
    const result = filterCards(cards, { ...EMPTY_FILTER, search: 'nonexistent' })
    expect(result).toEqual([])
  })
})

describe('filterCards — assignee filter', () => {
  it('matches assigned user by id', () => {
    const result = filterCards(cards, { ...EMPTY_FILTER, assigneeIds: [alice.id] })
    expect(result.map((c) => c.id)).toEqual([1, 4])
  })

  it('matches unassigned cards with -1', () => {
    const result = filterCards(cards, { ...EMPTY_FILTER, assigneeIds: [-1] })
    expect(result.map((c) => c.id)).toEqual([3])
  })

  it('matches multiple assignees with OR logic', () => {
    const result = filterCards(cards, { ...EMPTY_FILTER, assigneeIds: [alice.id, bob.id] })
    expect(result.map((c) => c.id)).toEqual([1, 2, 4])
  })

  it('matches assigned + unassigned together', () => {
    const result = filterCards(cards, { ...EMPTY_FILTER, assigneeIds: [alice.id, -1] })
    expect(result.map((c) => c.id)).toEqual([1, 3, 4])
  })
})

describe('filterCards — priority filter', () => {
  it('matches single priority', () => {
    const result = filterCards(cards, { ...EMPTY_FILTER, priorities: ['urgent'] })
    expect(result.map((c) => c.id)).toEqual([2])
  })

  it('matches multiple priorities (OR logic)', () => {
    const result = filterCards(cards, { ...EMPTY_FILTER, priorities: ['high', 'urgent'] })
    expect(result.map((c) => c.id)).toEqual([1, 2])
  })
})

describe('filterCards — label filter', () => {
  it('matches cards with a specific label', () => {
    const result = filterCards(cards, { ...EMPTY_FILTER, labelIds: [1] })
    expect(result.map((c) => c.id)).toEqual([1, 4])
  })

  it('requires all labels (AND logic)', () => {
    const result = filterCards(cards, { ...EMPTY_FILTER, labelIds: [1, 2] })
    expect(result.map((c) => c.id)).toEqual([4])
  })
})

describe('filterCards — due date filter', () => {
  const FIXED_NOW = new Date('2026-03-09T12:00:00Z')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
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
    const result = filterCards(overdueCards, { ...EMPTY_FILTER, dueDate: 'overdue' })
    expect(result.map((c) => c.id)).toEqual([10])
  })

  it('matches cards due today', () => {
    const todayCards = [
      makeCard({ id: 10, title: 'Yesterday', due_date: '2026-03-08' }),
      makeCard({ id: 11, title: 'Today', due_date: '2026-03-09' }),
      makeCard({ id: 12, title: 'Tomorrow', due_date: '2026-03-10' }),
    ]
    const result = filterCards(todayCards, { ...EMPTY_FILTER, dueDate: 'today' })
    expect(result.map((c) => c.id)).toEqual([11])
  })

  it('matches cards due this week', () => {
    const weekCards = [
      makeCard({ id: 10, title: 'Past', due_date: '2026-03-08' }),
      makeCard({ id: 11, title: 'Today', due_date: '2026-03-09' }),
      makeCard({ id: 12, title: 'Mid-week', due_date: '2026-03-12' }),
      makeCard({ id: 13, title: 'Next week', due_date: '2026-03-16' }),
      makeCard({ id: 14, title: 'Exactly 7 days', due_date: '2026-03-16' }),
    ]
    const result = filterCards(weekCards, { ...EMPTY_FILTER, dueDate: 'this_week' })
    expect(result.map((c) => c.id)).toEqual([11, 12])
  })

  it('matches cards with no due date', () => {
    const mixedCards = [
      makeCard({ id: 10, title: 'Has date', due_date: '2026-03-10' }),
      makeCard({ id: 11, title: 'No date', due_date: null }),
    ]
    const result = filterCards(mixedCards, { ...EMPTY_FILTER, dueDate: 'none' })
    expect(result.map((c) => c.id)).toEqual([11])
  })
})

describe('filterCards — multiple filters stack (AND logic)', () => {
  it('combines search + assignee', () => {
    const result = filterCards(cards, { ...EMPTY_FILTER, search: 'auth', assigneeIds: [alice.id] })
    expect(result.map((c) => c.id)).toEqual([4])
  })

  it('combines search + priority', () => {
    const result = filterCards(cards, { ...EMPTY_FILTER, search: 'CI', priorities: ['high'] })
    expect(result.map((c) => c.id)).toEqual([1])
  })

  it('returns empty when filters conflict', () => {
    const result = filterCards(cards, { ...EMPTY_FILTER, search: 'login', assigneeIds: [alice.id] })
    // "Fix login bug" is assigned to bob, not alice
    expect(result).toEqual([])
  })
})

describe('filterCards — clearing filters shows all cards', () => {
  it('returns all cards when filter state is empty', () => {
    const result = filterCards(cards, EMPTY_FILTER)
    expect(result).toEqual(cards)
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
