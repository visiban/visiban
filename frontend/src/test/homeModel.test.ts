import { describe, it, expect } from 'vitest'
import type { Board, Group } from '../types'
import {
  boardSignals, filterBoards, filterCounts, greeting, isAtRisk, needsAttention, openedAgo, phoneSummary,
  recentTiles, sortBoards, summarize, summaryClauses,
  SIDE_LIST_CAP, GROUP_AVATAR_LIMIT, capSideList, groupAvatarStack, sideListToggleLabel,
} from '../components/Dashboard/homeModel'

const DAY = 24 * 60 * 60 * 1000
const board = (id: number, extra: Partial<Board> = {}): Board => ({
  id, name: `Board ${id}`, group: null, group_name: null, is_starred: false, updated_at: '2026-11-01T00:00:00Z',
  effective_health_status: null, health_auto_enabled: false, health_computed_counts: null, ...extra,
} as unknown as Board)
const auto = (stale: number, blocked: number): Partial<Board> => ({
  health_auto_enabled: true, health_computed_counts: { open: 9, overdue: 0, stale, blocked, flagged: 0 },
})
const group = (id: number, extra: Partial<Group> = {}): Group => ({ id, name: `G${id}`, parent: null, navigation_only: false, ...extra } as unknown as Group)

describe('greeting', () => {
  const user = { first_name: 'Jane', display_name: 'Jane Doe', username: 'jdoe' }
  it('follows local time of day', () => {
    expect(greeting(user, new Date(2026, 10, 21, 8))).toBe('Good morning, Jane')
    expect(greeting(user, new Date(2026, 10, 21, 13))).toBe('Good afternoon, Jane')
    expect(greeting(user, new Date(2026, 10, 21, 20))).toBe('Good evening, Jane')
  })
  it('falls back to the display name, then the username', () => {
    expect(greeting({ ...user, first_name: '' }, new Date(2026, 10, 21, 8))).toBe('Good morning, Jane Doe')
    expect(greeting({ first_name: '', display_name: '', username: 'jdoe' }, new Date(2026, 10, 21, 8))).toBe('Good morning, jdoe')
  })
})

describe('signals', () => {
  it('is null (no data, never 0) where auto health is off or counts are missing', () => {
    expect(boardSignals(board(1))).toBeNull()
    expect(boardSignals(board(1, { health_auto_enabled: true, health_computed_counts: null }))).toBeNull()
  })
  it('reads stale and blocked from health_computed_counts', () => {
    expect(boardSignals(board(1, auto(5, 3)))).toEqual({ stale: 5, blocked: 3 })
    expect(boardSignals(board(1, auto(0, 0)))).toEqual({ stale: 0, blocked: 0 })
  })
})

describe('summary line', () => {
  it('builds every clause and marks the at-risk one separately', () => {
    const boards = [board(1, { ...auto(4, 1), effective_health_status: 'at_risk' }), board(2, { ...auto(1, 2), effective_health_status: 'off_track' }), board(3)]
    const c = summaryClauses(summarize(boards, [group(1), group(2), group(3, { navigation_only: true })]))
    expect(c.lead).toBe('3 boards across 2 groups.')
    expect(c.atRisk).toBe('2 boards are at risk.')
    expect(c.signals).toBe('5 stale and 3 blocked cards on the 2 boards with auto health on.')
  })
  it('leaves out clauses whose count is 0 and never says "this week"', () => {
    const c = summaryClauses(summarize([board(1, { ...auto(0, 0) })], [group(1)]))
    expect(c).toEqual({ lead: '1 board across 1 group.', atRisk: null, signals: null })
    expect(summaryClauses(summarize([board(1), board(2)], [])).lead).toBe('2 boards.')
    const one = summaryClauses(summarize([board(1, { ...auto(1, 0), effective_health_status: 'at_risk' })], []))
    expect(one.atRisk).toBe('1 board is at risk.')
    expect(one.signals).toBe('1 stale card on the 1 board with auto health on.')
    expect(JSON.stringify(one)).not.toMatch(/this week/i)
  })
  it('has a phone form', () => {
    expect(phoneSummary(summarize([board(1, { ...auto(4, 1), effective_health_status: 'at_risk' })], []))).toBe('1 board at risk · 4 stale, 1 blocked on boards with auto health')
    expect(phoneSummary(summarize([board(1)], []))).toBeNull()
  })
})

describe('filters', () => {
  const boards = [
    board(1, { is_starred: true }),
    board(2, { group: 5, effective_health_status: 'at_risk' }),
    board(3, { effective_health_status: 'on_track' }),
  ]
  it('counts and filters', () => {
    expect(filterCounts(boards)).toEqual({ all: 3, starred: 1, personal: 2, at_risk: 1 })
    expect(filterBoards(boards, 'personal').map((b) => b.id)).toEqual([1, 3])
    expect(filterBoards(boards, 'at_risk').map((b) => b.id)).toEqual([2])
    expect(filterBoards(boards, 'all')).toHaveLength(3)
  })
  it('counts off track as at risk', () => {
    expect(isAtRisk({ effective_health_status: 'off_track' })).toBe(true)
    expect(isAtRisk({ effective_health_status: 'on_track' })).toBe(false)
    expect(isAtRisk({ effective_health_status: null })).toBe(false)
  })
  it('sorts starred first, then newest update', () => {
    const sorted = sortBoards([board(1, { updated_at: '2026-11-01T00:00:00Z' }), board(2, { updated_at: '2026-11-09T00:00:00Z' }), board(3, { is_starred: true, updated_at: '2026-10-01T00:00:00Z' })])
    expect(sorted.map((b) => b.id)).toEqual([3, 2, 1])
  })
})

describe('needsAttention', () => {
  const now = Date.now()
  const overdue = (days: number): Partial<Board> => ({
    effective_health_status: 'at_risk', health_status: 'at_risk', health_status_origin: 'manual',
    health_status_changed_at: new Date(now - (days + 14) * DAY).toISOString(), health_review_due_at: new Date(now - 4 * DAY).toISOString(),
  } as Partial<Board>)

  it('ranks by blocked, then stale, then days overdue, and writes the meta line', () => {
    const items = needsAttention(
      [
        board(1, { name: 'Stale only', ...auto(2, 0) }),
        board(2, { name: 'Blocked', ...auto(5, 3), effective_health_status: 'at_risk' }),
        board(3, { name: 'Overdue', ...overdue(20) }),
        board(4, { name: 'Quiet', ...auto(0, 0) }),
        board(5, { name: 'Overdue more', ...overdue(40) }),
      ],
      [],
      now,
    )
    expect(items.map((i) => i.name)).toEqual(['Blocked', 'Stale only', 'Overdue more', 'Overdue'])
    expect(items[0]).toMatchObject({ meta: '5 stale, 3 blocked · At risk', severity: 'danger' })
    expect(items[1]).toMatchObject({ meta: '2 stale', severity: 'warning' })
    expect(items[2].meta).toMatch(/^Health status not reviewed in \d+ days$/)
  })

  it('includes overdue subgroups but not top-level groups or navigation-only ones', () => {
    const g = (id: number, parent: number | null, extra: Record<string, unknown> = {}) => group(id, {
      parent, effective_health_status: 'at_risk', health_status: 'at_risk', health_status_source: null,
      health_status_changed_at: new Date(now - 18 * DAY).toISOString(), health_review_due_at: new Date(now - 4 * DAY).toISOString(), ...extra,
    } as Partial<Group>)
    const items = needsAttention([], [g(1, null), g(2, 1), g(3, 1, { navigation_only: true })], now)
    expect(items.map((i) => [i.kind, i.id])).toEqual([['group', 2]])
  })

  it('adds the review cue after counts when a board has both', () => {
    const [item] = needsAttention([board(1, { ...auto(1, 0), ...overdue(10) })], [], now)
    expect(item.meta).toMatch(/^1 stale · At risk · not reviewed in \d+ days$/)
  })
})

describe('recents', () => {
  it('formats "<N> ago" and tolerates a missing timestamp', () => {
    const now = 1_000_000_000
    expect(openedAgo(undefined, now)).toBe('')
    expect(openedAgo(now - 20_000, now)).toBe('just now')
    expect(openedAgo(now - 5 * 60_000, now)).toBe('5m ago')
    expect(openedAgo(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(openedAgo(now - 2 * 86_400_000, now)).toBe('2d ago')
  })
  it('keeps at most 3 recents that still resolve to a board', () => {
    const boards = [board(1), board(2), board(4), board(5)]
    const recents = [1, 3, 2, 4, 5].map((id) => ({ id, name: `B${id}` }))
    expect(recentTiles(recents, boards).map((t) => t.board.id)).toEqual([1, 2, 4])
  })
})

describe('side list caps and the group avatar stack (#2487)', () => {
  it('capSideList keeps the first SIDE_LIST_CAP rows until expanded', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7]
    expect(capSideList(rows, false)).toEqual([1, 2, 3, 4, 5])
    expect(capSideList(rows, true)).toEqual(rows)
    expect(capSideList(rows, false, 2)).toEqual([1, 2])
    expect(SIDE_LIST_CAP).toBe(5)
  })

  it('sideListToggleLabel names the total while capped', () => {
    expect(sideListToggleLabel(7, false)).toBe('Show all 7')
    expect(sideListToggleLabel(7, true)).toBe('Show fewer')
  })

  it('groupAvatarStack uses member_preview, capped, and never a negative +N', () => {
    const owner = { id: 1, username: 'o', display_name: 'O', avatar_url: '' }
    const m = (id: number) => ({ id, username: `u${id}`, display_name: '', avatar_url: '' })
    expect(groupAvatarStack({ owner, member_count: 10, member_preview: [m(1), m(2), m(3), m(4), m(5)] })).toEqual({ users: [m(1), m(2), m(3)], more: 7 })
    expect(groupAvatarStack({ owner, member_count: 1 })).toEqual({ users: [owner], more: 0 })
    expect(groupAvatarStack({ owner, member_count: 2, member_preview: [] })).toEqual({ users: [owner], more: 1 })
    // A navigation-only or stale count below the preview length is clamped at 0.
    expect(groupAvatarStack({ owner, member_count: 0, member_preview: [m(1), m(2)] }).more).toBe(0)
    expect(GROUP_AVATAR_LIMIT).toBe(3)
  })
})
