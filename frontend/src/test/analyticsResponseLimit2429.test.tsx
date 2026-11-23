import { describe, it, expect, vi } from 'vitest'
import { act, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AttentionSection from '../components/Board/flowMetrics/AttentionSection'
import FlowDrillDrawer from '../components/Board/flowMetrics/FlowDrillDrawer'
import type { DrillSelection } from '../components/Board/flowMetrics/FlowDrillDrawer'

import { buildColumnSelection } from '../components/Board/flowMetrics/columnDrill'
import { cardsPastP85, sampledNote, wipAgeSummary } from '../components/Board/flowMetrics/flowFormat'
import { buildCsv, type AnalyticsData } from '../components/Board/flowMetrics/heatmap'
import { useFlowDrill } from '../components/Board/flowMetrics/useFlowDrill'
import { OVERVIEW_LIST_LIMIT } from '../api/analyticsLimits'
import type { FlowAgeSample, FlowAttention, FlowAttentionItem, FlowThroughputSample, FlowWipAge } from '../types'

// A capped Overview response (#2429): counts come from the whole set, the lists are a sample.

const ageSample = (uid: string, days: number, column = 'c-doing'): FlowAgeSample => ({
  card_uid: uid, column_uid: column, value_days: days, start: '2026-01-01T00:00:00Z',
  dwell_by_column: [], is_blocked: false, blocked_days: 0,
})

const wipAge = (over: Partial<FlowWipAge> = {}): FlowWipAge => ({
  definition: 'd',
  sample_size: 40,
  excluded_incomplete_history: 0,
  cycle_time_percentiles: { p50: 5, p85: 10, p95: 20 },
  columns: [{ column_uid: 'c-doing', column_name: 'Doing', wip_count: 45, sample_count: 40, past_p85_count: 12 }],
  samples: [ageSample('a', 30), ageSample('b', 11), ageSample('c', 2)],
  cards: [],
  samples_total: 40,
  past_p85_count: 12,
  sampled: true,
  ...over,
})

describe('capped analytics responses (#2429)', () => {
  it('caps each Overview list at a bounded size, so per-card lists stop growing with the board', () => {
    expect(OVERVIEW_LIST_LIMIT).toBeGreaterThan(0)
    expect(OVERVIEW_LIST_LIMIT).toBeLessThanOrEqual(500)
  })

  it('takes the past-p85 count from the whole set, not the sampled dots', () => {
    const data = wipAge()
    expect(cardsPastP85(data)).toBe(12)
    expect(wipAgeSummary(data)).toBe('12 of 40 cards in progress are past the 85th percentile.')
    // An uncapped response has no count and is counted from its samples, as before.
    expect(cardsPastP85(wipAge({ past_p85_count: undefined }))).toBe(2)
  })

  it('the column drawer states the whole column and how many aged cards the sample left out', () => {
    const selection = buildColumnSelection('c-doing', { cumulative: undefined, dwell: undefined, wipAge: wipAge(), columns: [] })
    expect(selection.count).toBe(45)
    expect(selection.pastP85).toBe(12)
    expect(selection.cards).toHaveLength(3)
    expect(selection.notSampled).toBe(37)
    const plain = buildColumnSelection('c-doing', {
      cumulative: undefined, dwell: undefined, columns: [],
      wipAge: wipAge({ columns: [{ column_uid: 'c-doing', column_name: 'Doing', wip_count: 5 }], past_p85_count: undefined }),
    })
    expect(plain.pastP85).toBe(2)
    expect(plain.notSampled).toBe(0)
  })

  it('a sampled scatter says how many dots it shows', () => {
    expect(sampledNote(wipAge(), 'oldest')).toBe('Showing 3 of 40 cards, the oldest always included.')
    expect(sampledNote(wipAge({ sampled: false }), 'oldest')).toBeNull()
    expect(sampledNote(wipAge({ sampled: undefined, samples_total: undefined }), 'longest')).toBeNull()
  })

  it('the heatmap CSV counts every stalled card, not only the listed ones', () => {
    const data = {
      days: 30, columns: ['Doing'], done_columns: [], board_medians: {},
      stalled_threshold_days: 7, staleness_threshold_days: 7, stale_warning_pct: 50,
      swimlanes: [
        { id: 1, name: 'Capped', avg_days_per_column: {}, is_outlier: {}, deal_velocity_days: null, stalled_cards: [], stalled_cards_total: 9 },
        { id: 2, name: 'Plain', avg_days_per_column: {}, is_outlier: {}, deal_velocity_days: null, stalled_cards: [{ id: 1, uid: 'u', title: 't', days_since_move: 8 }] },
      ],
    } as unknown as AnalyticsData
    const rows = buildCsv(data, 'age').split('\n')
    expect(rows[1].endsWith(',9')).toBe(true)
    expect(rows[2].endsWith(',1')).toBe(true)
  })

  it('Needs attention names the whole count and says the list is the oldest part of it', async () => {
    const item = (n: number): FlowAttentionItem => ({
      card_uid: `uid-${n}`, column_uid: 'c', swimlane_id: 1, age_days: 100 - n, unmoved_days: null, reasons: ['past_p85'], block_reason: null,
    })
    const items = Array.from({ length: 8 }, (_, i) => item(i + 1))
    const data: FlowAttention = {
      definition: 'd', stalled_threshold_days: 7, cycle_time_percentiles: { p50: 1, p85: 2, p95: null },
      items, cards: [], items_total: 950, sampled: true,
    }
    render(<AttentionSection attention={{ data }} swimlanes={[]} />)
    await userEvent.click(screen.getByRole('button', { name: 'All 950 cards' }))
    expect(screen.getByText('Showing the first 8 of 950 cards, in progress first.')).toBeTruthy()
  })

  it('the drawers say how many cards they could not list', () => {
    const cards = new Map()
    const column: DrillSelection = {
      kind: 'column', uid: 'c-doing', name: 'Doing', limit: null, count: 10, medianWait: null, pastP85: 1, notSampled: 4, cards: [],
    }
    const { unmount } = render(<FlowDrillDrawer boardId={1} selection={column} cards={cards} onChange={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText(/4 more cards not listed: a large column shows a sample/)).toBeTruthy()
    expect(screen.getByText(/6 cards not listed: no age yet/)).toBeTruthy()
    unmount()
    const list: DrillSelection = { kind: 'cards', title: 'Finished', groups: [{ label: null, uids: ['u1'] }], more: 5 }
    render(<FlowDrillDrawer boardId={1} selection={list} cards={cards} onChange={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('5 more cards not listed.')).toBeTruthy()
  })

  it('a throughput period opens with its whole count, the unlisted cards named as more', () => {
    // One filters object: a new one each render would close the drawer (a filter change does).
    const filters = { days: 90, swimlaneId: null, labelId: null }
    const data = {}
    const { result } = renderHook(() => useFlowDrill(1, filters, data))
    const sample: FlowThroughputSample = { start: '2026-06-01', count: 7, card_uids: ['a', 'b'], started: 0 }
    act(() => result.current.selectThroughputSample(sample))
    expect(result.current.drill).toMatchObject({ kind: 'cards', more: 5, groups: [{ label: null, uids: ['a', 'b'] }] })
    act(() => result.current.selectThroughputSample({ ...sample, count: 2 }))
    expect(result.current.drill).not.toHaveProperty('more')
  })
})
