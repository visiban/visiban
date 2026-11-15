import { vi } from 'vitest'

const none = { p50: null, p85: null, p95: null }

/**
 * `api/flowMetrics` for a test that renders AnalyticsView but is not about the
 * flow panels (#2261): a board with a little history, so the heatmap and the
 * stalled and blocked sections render. Use as
 * `vi.mock('../api/flowMetrics', async () => (await import('./flowMetricsStubs')).flowMetricsStub())`.
 */
export function flowMetricsStub() {
  return {
    getFlowCycleTime: vi.fn(() => Promise.resolve({ definition: 'd', sample_size: 0, excluded_incomplete_history: 0, percentiles: none, samples: [], cards: [] })),
    getFlowThroughput: vi.fn(() => Promise.resolve({
      definition: 'd', period: 'week', total: 1, median: null, samples: [{ start: '2026-06-01', count: 1, card_uids: [], started: 0 }], cards: [],
    })),
    getFlowCumulativeFlow: vi.fn(() => Promise.resolve({ definition: 'd', columns: [], days: [], bottleneck_column_uid: null })),
    getFlowCumulativeDay: vi.fn(),
    getFlowWipAge: vi.fn(() => Promise.resolve({
      definition: 'd', sample_size: 0, excluded_incomplete_history: 0, cycle_time_percentiles: none, columns: [], samples: [], cards: [],
    })),
    getFlowDwell: vi.fn(() => Promise.resolve({ definition: 'd', sample_size: 0, excluded_incomplete_history: 0, columns: [] })),
    getFlowBlocked: vi.fn(() => Promise.resolve({
      definition: 'd', total: { days: 0, blocks: 0 }, blocked_now: 0, columns: [], reasons: [], reason_count: 0,
    })),
    getFlowAttention: vi.fn(() => Promise.resolve({ definition: 'd', stalled_threshold_days: 7, cycle_time_percentiles: none, items: [], cards: [] })),
  }
}
