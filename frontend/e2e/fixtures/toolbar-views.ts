// Success responses for the Summary, History and Analytics views (#2486). Long names on purpose:
// the 390px sideways-scroll check only means something when the real layout renders with them.
import type { BoardSummary, CardMovement, FlowOverview } from '../../src/types'
import { BOARD_FULL, BOARD_USER, CARD } from './board'

export const LONG_LANE = 'Enterprise onboarding and migration escalations for the northern region'
export const LONG_CARD = 'Reconcile the quarterly invoicing export with the finance warehouse before the audit window closes'

const [todo, done] = BOARD_FULL.columns
const lane = BOARD_FULL.swimlanes[0]
const at = '2026-01-15T14:30:00Z'

export const SUMMARY: BoardSummary = {
  swimlanes: [
    {
      id: lane.id, name: LONG_LANE, color: '#6B7280', total_cards: 1284,
      stage_distribution: { [todo.name]: 900, [done.name]: 384 },
      velocity_7d: 42, velocity_30d: 187, active_cards: 900, done_30d: 187, avg_cycle_days: 12.4,
      blocked_cards: 17,
    },
  ],
  extension_panels: [],
}

const movement: CardMovement = {
  id: 1, card_uid: CARD.uid, card_title: LONG_CARD,
  from_column: todo.id, from_column_name: 'Waiting on external security review', from_column_uid: todo.uid,
  to_column: done.id, to_column_name: 'Ready for production deployment', to_column_uid: done.uid,
  from_swimlane: lane.id, from_swimlane_name: lane.name, from_swimlane_uid: lane.uid,
  to_swimlane: lane.id, to_swimlane_name: LONG_LANE, to_swimlane_uid: lane.uid,
  moved_by: { ...BOARD_USER, display_name: 'Alexandria Montgomery-Whitfield' },
  moved_at: at, notes: '', movement_type: 'move', imported_from_username: null,
}

export const MOVEMENTS: { results: CardMovement[]; count: number; offset: number; page_size: number } = {
  results: [movement, { ...movement, id: 2, movement_type: 'archived' }],
  count: 2, offset: 0, page_size: 50,
}

const card = {
  uid: CARD.uid, id: CARD.id, title: LONG_CARD, archived: false, assignee: null,
  swimlane: { id: lane.id, name: LONG_LANE },
}
const percentiles = { p50: 4.2, p85: 8.1, p95: 12.6 }

export const ANALYTICS = {
  days: 90, columns: [todo.name], done_columns: [done.name], board_medians: {},
  swimlanes: [{
    id: lane.id, name: LONG_LANE, avg_days_per_column: { [todo.name]: 3 }, is_outlier: {},
    age_avg_days_per_column: { [todo.name]: 3 }, deal_velocity_days: 5, stalled_cards: [],
  }],
  stalled_threshold_days: 7, staleness_threshold_days: 7, stale_warning_pct: 50,
}

export const FLOW_OVERVIEW: FlowOverview = {
  cycle_time: {
    definition: 'the time from a first pull until the first done entry.',
    sample_size: 1, excluded_incomplete_history: 0, percentiles,
    samples: [{ card_uid: card.uid, value_days: 4.2, start: at, end: at, reopened: false }],
    cards: [card],
  },
  throughput: {
    definition: 'the number of cards first entering a done column in a period.',
    period: 'week', total: 1, completed_in_range: 1, median: 1,
    samples: [{ start: at.slice(0, 10), count: 1, card_uids: [card.uid], started: 1 }],
    cards: [card],
  },
  cumulative_flow: {
    definition: 'the number of cards in each column at the end of each day.',
    columns: [{
      column_uid: todo.uid, column_name: todo.name, is_done: false, start_count: 1, end_count: 2,
      entered: 1, left: 0, entered_per_week: 7, left_per_week: 0,
    }],
    days: [{ date: '2026-01-14', counts: { [todo.uid]: 1 } }, { date: '2026-01-15', counts: { [todo.uid]: 2 } }],
    bottleneck_column_uid: todo.uid,
  },
  wip_age: {
    definition: 'how long an in-progress card has been in progress.',
    sample_size: 1, excluded_incomplete_history: 0, cycle_time_percentiles: percentiles,
    columns: [{ column_uid: todo.uid, column_name: todo.name, wip_count: 1 }],
    samples: [{
      card_uid: card.uid, column_uid: todo.uid, value_days: 9, start: at,
      dwell_by_column: [{ column_uid: todo.uid, value_days: 9 }], is_blocked: true, blocked_days: 2,
    }],
    cards: [card],
  },
  dwell: {
    definition: 'completed time in each column.',
    sample_size: 1, excluded_incomplete_history: 0,
    columns: [{ column_uid: todo.uid, column_name: todo.name, sample_size: 1, percentiles }],
  },
  blocked: {
    definition: 'manual blocks that overlapped the period.',
    total: { days: 2, blocks: 1 }, blocked_now: 1,
    columns: [{ column_uid: todo.uid, column_name: todo.name, days: 2, blocks: 1 }],
    reasons: [{ reason: 'Waiting on the external security review and procurement sign-off', days: 2, blocks: 1 }],
    reason_count: 1,
  },
  attention: {
    definition: 'blocked, past the 85th percentile, or stalled.',
    stalled_threshold_days: 7, cycle_time_percentiles: percentiles,
    items: [{
      card_uid: card.uid, column_uid: todo.uid, swimlane_id: lane.id, age_days: 12, unmoved_days: 9,
      reasons: ['stalled'], block_reason: null,
    }],
    cards: [card],
  },
}
