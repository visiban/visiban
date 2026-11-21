import { vi } from 'vitest'

const none = { p50: null, p85: null, p95: null }

/**
 * `api/flowMetrics` for a test that renders AnalyticsView but is not about the
 * flow panels (#2261): a board with a little history, so the heatmap and the
 * stalled and blocked sections render. Use as
 * `vi.mock('../api/flowMetrics', async () => (await import('./flowMetricsStubs')).flowMetricsStub())`.
 */
export function flowMetricsStub() {
  return withOverview({
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
  })
}

type Getter = (...args: never[]) => Promise<unknown>
interface ChartGetters {
  getFlowCycleTime: Getter
  getFlowThroughput: Getter
  getFlowCumulativeFlow: Getter
  getFlowWipAge: Getter
  getFlowDwell: Getter
  getFlowBlocked: Getter
  getFlowAttention: Getter
}

/**
 * Adds `getFlowOverview` (#2426) to a mocked `api/flowMetrics`, answered from the
 * module's own per-chart mocks, so a test can still give each chart its data with
 * `vi.mocked(getFlowCycleTime).mockResolvedValue(...)` and assert the filters each
 * chart was asked for. It settles all-or-nothing, as the real endpoint does: one
 * rejected chart rejects the whole overview. Each chart mock is called with the
 * arguments its own endpoint call took (`grouping` only for the four breakdown charts).
 */
export function withOverview<T extends ChartGetters>(mod: T) {
  const call = (getter: Getter, ...args: unknown[]) => (getter as (...a: unknown[]) => Promise<unknown>)(...args)
  const getFlowOverview = vi.fn((boardId: number, filters: unknown, ...grouping: unknown[]) =>
    Promise.all([
      call(mod.getFlowCycleTime, boardId, filters, ...grouping),
      call(mod.getFlowThroughput, boardId, filters, ...grouping),
      call(mod.getFlowCumulativeFlow, boardId, filters),
      call(mod.getFlowWipAge, boardId, filters, ...grouping),
      call(mod.getFlowDwell, boardId, filters, ...grouping),
      call(mod.getFlowBlocked, boardId, filters),
      call(mod.getFlowAttention, boardId, filters),
    ]).then(([cycle_time, throughput, cumulative_flow, wip_age, dwell, blocked, attention]) => ({
      cycle_time, throughput, cumulative_flow, wip_age, dwell, blocked, attention,
    })))
  return { ...mod, getFlowOverview }
}
