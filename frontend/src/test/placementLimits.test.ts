import { describe, it, expect } from 'vitest'
import {
  columnLimitModes, laneCountsColumn, laneLimitState, laneUsage, placementVerdict,
  pruneLaneLimitColumn, swimlaneLimitModes, trippedLimitLabel, trippedLimitSentence,
  type LimitFlags,
} from '../utils/placementLimits'
import type { Card, Column, Swimlane } from '../types'

// The client mirror of the server's placement rules (#1150,
// backend/boards/services/cards.py enforce_column_limits).

const OFF: LimitFlags = { enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false }
const SOFT: LimitFlags = { enforce_wip_limits: true, enforce_wip_hard: false, enforce_weight_limits: true }

function col(id: number, name: string, overrides: Partial<Column> = {}): Column {
  return { id, uid: `c${id}`, name, position: id, color: '#000000', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, ...overrides }
}

function lane(id: number, name: string, overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id, uid: `s${id}`, name, position: id, color: '#000000', is_collapsed: false, created_at: '',
    wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, ...overrides,
  }
}

let nextId = 100
function card(column: number, swimlane: number, overrides: Partial<Card> = {}): Card {
  nextId += 1
  return {
    id: nextId, uid: `k${nextId}`, column, swimlane, title: 't', description: '', priority: 'medium',
    assignee: null, labels: [], due_date: null, weight: 1, position: 0,
    created_by: { id: 1, username: 'u', display_name: '', avatar_url: '' }, created_at: '', updated_at: '',
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false,
    archived_at: null, version: 1, custom_field_values: [], blocker_count: 0, external_ref: null,
    ...overrides,
  }
}

const backlog = col(1, 'Backlog')
const doing = col(2, 'Doing')
const done = col(3, 'Done', { is_done: true })
const columns = [backlog, doing, done]

describe('modes', () => {
  it('derives column modes from the board flags, hard first', () => {
    expect(columnLimitModes(OFF)).toEqual({ wip: null, weight: null })
    expect(columnLimitModes(SOFT)).toEqual({ wip: 'block', weight: 'block' })
    expect(columnLimitModes({ ...OFF, enforce_wip_hard: true })).toEqual({ wip: 'hard', weight: null })
  })

  it('lets a lane choose, or inherit when null; weight is never hard', () => {
    expect(swimlaneLimitModes(OFF, lane(1, 'A', { limit_enforcement: 'hard' }))).toEqual({ wip: 'hard', weight: 'block' })
    expect(swimlaneLimitModes({ ...OFF, enforce_wip_hard: true }, lane(1, 'A', { limit_enforcement: 'block' }))).toEqual({ wip: 'block', weight: 'block' })
    expect(swimlaneLimitModes(SOFT, lane(1, 'A'))).toEqual({ wip: 'block', weight: 'block' })
  })
})

describe('counting', () => {
  it('counts every non-done column by default, or the listed ones', () => {
    expect(laneCountsColumn(lane(1, 'A'), backlog)).toBe(true)
    expect(laneCountsColumn(lane(1, 'A'), done)).toBe(false)
    expect(laneCountsColumn(lane(1, 'A', { limit_column_ids: [3] }), done)).toBe(true)
    expect(laneCountsColumn(lane(1, 'A', { limit_column_ids: [3] }), backlog)).toBe(false)
  })

  it('sums active cards in counted columns of the lane only', () => {
    const a = lane(1, 'A')
    const cards = [
      card(1, 1, { weight: 2 }), card(2, 1, { weight: 3 }),
      card(3, 1), // done: not counted
      card(2, 1, { archived_at: '2026-01-01' }), // archived: not counted
      card(2, 2), // another lane
    ]
    expect(laneUsage(a, columns, cards)).toEqual({ count: 2, weight: 5 })
    expect(laneUsage(a, columns, cards, cards[0].id)).toEqual({ count: 1, weight: 3 })
  })
})

describe('laneLimitState', () => {
  it('is null without limits and picks the worst state', () => {
    expect(laneLimitState(lane(1, 'A'), { count: 9, weight: 9 })).toBeNull()
    const both = lane(1, 'A', { wip_limit: 3, weight_limit: 10 })
    expect(laneLimitState(both, { count: 4, weight: 20 })).toBe('overWip')
    expect(laneLimitState(both, { count: 3, weight: 20 })).toBe('overWeight')
    expect(laneLimitState(both, { count: 3, weight: 5 })).toBe('at')
    expect(laneLimitState(both, { count: 1, weight: 10 })).toBe('at')
    expect(laneLimitState(both, { count: 1, weight: 5 })).toBe('under')
  })
})

describe('placementVerdict', () => {
  const flags = SOFT

  it('blocks entering a full lane from another lane, and says so', () => {
    const target = lane(2, 'Payouts', { wip_limit: 1 })
    const cards = [card(2, 2)]
    const mover = card(1, 1)
    const v = placementVerdict({ flags, columns, cards: [...cards, mover], card: mover, column: doing, lane: target })
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ scope: 'swimlane', kind: 'wip', mode: 'block', current: 1, limit: 1 })
    expect(trippedLimitSentence(v[0])).toBe('Swimlane "Payouts" is at its WIP limit (1/1), admins can override.')
    expect(trippedLimitLabel(v[0])).toBe('Payouts at WIP limit · 1/1')
  })

  it('never trips a lane on a move between two counted columns', () => {
    const a = lane(1, 'A', { wip_limit: 1, limit_enforcement: 'hard' })
    const mover = card(1, 1)
    const cards = [mover, card(2, 1)]
    expect(placementVerdict({ flags, columns, cards, card: mover, column: doing, lane: a })).toEqual([])
  })

  it('checks entering a counted column from an uncounted one in the same lane', () => {
    const a = lane(1, 'A', { wip_limit: 1, limit_column_ids: [2] })
    const mover = card(1, 1)
    const cards = [mover, card(2, 1)]
    expect(placementVerdict({ flags, columns, cards, card: mover, column: doing, lane: a })).toHaveLength(1)
  })

  it('never checks a move into an uncounted column', () => {
    const target = lane(2, 'B', { wip_limit: 1 })
    const mover = card(1, 1)
    expect(placementVerdict({ flags, columns, cards: [mover, card(2, 2)], card: mover, column: done, lane: target })).toEqual([])
  })

  it('checks the column only when the column changes', () => {
    const limited = col(2, 'Doing', { wip_limit: 1 })
    const cols = [backlog, limited, done]
    const mover = card(2, 1)
    const cards = [mover, card(2, 2)]
    // Swimlane-only move inside Doing: no column check.
    expect(placementVerdict({ flags, columns: cols, cards, card: mover, column: limited, lane: lane(2, 'B') })).toEqual([])
    const other = card(1, 1)
    const v = placementVerdict({ flags, columns: cols, cards: [...cards, other], card: other, column: limited, lane: lane(1, 'A') })
    expect(v[0]).toMatchObject({ scope: 'column', kind: 'wip', current: 2 })
  })

  it('orders strictest first: hard, then column before lane, then WIP before weight', () => {
    const limited = col(2, 'Doing', { wip_limit: 1, weight_limit: 1 })
    const cols = [backlog, limited, done]
    const hardLane = lane(2, 'B', { wip_limit: 1, weight_limit: 1, limit_enforcement: 'hard' })
    const mover = card(1, 1)
    const cards = [mover, card(2, 2)]
    const v = placementVerdict({ flags, columns: cols, cards, card: mover, column: limited, lane: hardLane })
    expect(v.map((t) => `${t.mode}:${t.scope}:${t.kind}`)).toEqual([
      'hard:swimlane:wip', 'block:column:wip', 'block:column:weight', 'block:swimlane:weight',
    ])
    expect(trippedLimitSentence(v[0])).toContain('no one can override it')
    expect(trippedLimitSentence(v[3])).toBe('Swimlane "B" would go over its weight limit (2/1), admins can override.')
    expect(trippedLimitLabel(v[3])).toBe('B at weight limit · 2/1')
  })

  it('ignores limits the board and lane do not enforce', () => {
    const target = lane(2, 'B', { wip_limit: 1 })
    const mover = card(1, 1)
    expect(placementVerdict({ flags: OFF, columns, cards: [mover, card(2, 2)], card: mover, column: doing, lane: target })).toEqual([])
  })
})

describe('pruneLaneLimitColumn', () => {
  it('drops the id, nulls an emptied list, and keeps identity when untouched', () => {
    const lanes = [lane(1, 'A', { limit_column_ids: [1, 2] }), lane(2, 'B', { limit_column_ids: [2] }), lane(3, 'C')]
    const next = pruneLaneLimitColumn(lanes, 2)
    expect(next.map((s) => s.limit_column_ids)).toEqual([[1], null, null])
    expect(next[2]).toBe(lanes[2])
    expect(pruneLaneLimitColumn(lanes, 9)).toBe(lanes)
  })
})
