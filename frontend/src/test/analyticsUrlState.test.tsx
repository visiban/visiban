import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useSearchParams } from 'react-router-dom'
import type { ReactNode } from 'react'
import AnalyticsView from '../components/Board/AnalyticsView'
import {
  clearAnalyticsParams, parseAnalyticsFilters, parseAnalyticsTab, useAnalyticsUrlParams, writeAnalyticsFilters, writeAnalyticsTab,
} from '../components/Board/flowMetrics/analyticsUrlState'
import { breakdownFromParam, breakdownToParam } from '../components/Board/flowMetrics/breakdown'
import { useAnalyticsFilters } from '../components/Board/flowMetrics/useAnalyticsFilters'

// The Analytics tab keeps Period, Swimlane, Label, Break down by and the Overview/Swimlanes
// choice in the URL beside ?view=analytics (#2318).

vi.mock('../api/boards', () => ({ getBoardAnalytics: vi.fn() }))
vi.mock('../api/flowMetrics', async () => (await import('./flowMetricsStubs')).withOverview({
  getFlowCycleTime: vi.fn(),
  getFlowThroughput: vi.fn(),
  getFlowCumulativeFlow: vi.fn(),
  getFlowCumulativeDay: vi.fn(),
  getFlowWipAge: vi.fn(),
  getFlowDwell: vi.fn(),
  getFlowBlocked: vi.fn(),
  getFlowAttention: vi.fn(),
  getFlowSwimlanes: vi.fn(),
}))

import { getBoardAnalytics } from '../api/boards'
import {
  getFlowAttention, getFlowBlocked, getFlowCumulativeFlow, getFlowCycleTime, getFlowDwell, getFlowSwimlanes, getFlowThroughput, getFlowWipAge,
} from '../api/flowMetrics'

const analytics = {
  days: 90, columns: ['Doing'], done_columns: [], swimlanes: [],
  stalled_threshold_days: 7, staleness_threshold_days: 7, stale_warning_pct: 50,
}
const percentiles = { p50: null, p85: null, p95: null }

const baseProps = {
  boardId: 9,
  currentUserRole: 'member',
  swimlanes: [{ id: 3, name: 'Customer A' }],
  labels: [{ id: 4, name: 'Urgent' }],
  boardName: 'Platform roadmap',
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.mocked(getBoardAnalytics).mockResolvedValue(analytics as never)
  vi.mocked(getFlowCycleTime).mockResolvedValue({
    definition: 'd', sample_size: 0, excluded_incomplete_history: 0, percentiles, samples: [], cards: [],
  })
  vi.mocked(getFlowThroughput).mockResolvedValue({
    definition: 'd', period: 'week', total: 1, median: null, samples: [{ start: '2026-06-01', count: 1, card_uids: [], started: 0 }], cards: [],
  })
  vi.mocked(getFlowCumulativeFlow).mockResolvedValue({ definition: 'd', columns: [], days: [], bottleneck_column_uid: null })
  vi.mocked(getFlowWipAge).mockResolvedValue({
    definition: 'd', sample_size: 0, excluded_incomplete_history: 0, cycle_time_percentiles: percentiles, columns: [], samples: [], cards: [],
  })
  vi.mocked(getFlowDwell).mockResolvedValue({ definition: 'd', sample_size: 0, excluded_incomplete_history: 0, columns: [] })
  vi.mocked(getFlowBlocked).mockResolvedValue({
    definition: 'd', total: { days: 0, blocks: 0 }, blocked_now: 0, columns: [], reasons: [], reason_count: 0,
  })
  vi.mocked(getFlowSwimlanes).mockResolvedValue({
    definition: 'd', board: { finished: 80, median_days: 11, p85_days: 20 }, status_threshold_pct: 20, status_min_finished: 10,
    swimlanes: [{
      id: 5, name: 'Customer B', position: 1, group: null, finished: 20, in_progress: 2, median_days: 11, p85_days: 15,
      blocked_share: 0.1, rolling_median: [], status: 'in_line', trend: null,
    }],
    grouping: null,
  } as never)
  vi.mocked(getFlowAttention).mockResolvedValue({
    definition: 'd', stalled_threshold_days: 7, cycle_time_percentiles: percentiles, items: [], cards: [],
  })
})


const props = {
  ...baseProps,
  swimlanes: [{ id: 3, name: 'Customer A' }, { id: 5, name: 'Customer B' }],
  labels: [{ id: 4, name: 'Urgent' }],
  customFields: [
    { id: 11, name: 'Size', field_type: 'dropdown' as const, position: 0 },
    { id: 12, name: 'Notes', field_type: 'text' as const, position: 1 },
  ],
}

/** A board stand-in: passes the router's search params down as BoardView does, and shows the live URL. */
function Harness({ initial }: { initial: string }) {
  return <MemoryRouter initialEntries={[initial]}><Board /></MemoryRouter>
}
function Board() {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  return (
    <>
      <output data-testid="url">{location.pathname}{location.search}</output>
      <AnalyticsView {...props} urlSource={{ searchParams, setSearchParams }} />
    </>
  )
}
const url = () => screen.getByTestId('url').textContent ?? ''

async function choose(trigger: RegExp, option: string) {
  await userEvent.click(screen.getByRole('button', { name: trigger }))
  await userEvent.click(screen.getByRole('menuitem', { name: option }))
}

describe('Analytics URL state: parse and write (#2318)', () => {
  it('reads defaults from an empty query, so an old ?view=analytics link is unchanged', () => {
    const params = new URLSearchParams('view=analytics')
    expect(parseAnalyticsFilters(params)).toEqual({ days: 90, swimlaneId: null, labelId: null })
    expect(parseAnalyticsTab(params)).toBe('overview')
  })

  it('ignores unknown or malformed values', () => {
    const params = new URLSearchParams('a_days=45&a_swimlane=-3&a_label=abc&a_tab=nope&a_by=zzz')
    expect(parseAnalyticsFilters(params)).toEqual({ days: 90, swimlaneId: null, labelId: null })
    expect(parseAnalyticsTab(params)).toBe('overview')
    expect(parseAnalyticsFilters(new URLSearchParams('a_swimlane=1.5&a_label=1e3&a_days=')).swimlaneId).toBeNull()
  })

  it('writes only non-default values and keeps other params', () => {
    const next = new URLSearchParams('view=analytics&f_search=x')
    writeAnalyticsFilters(next, { days: 30, swimlaneId: 3, labelId: null })
    writeAnalyticsTab(next, 'swimlanes')
    expect(next.toString()).toBe('view=analytics&f_search=x&a_days=30&a_swimlane=3&a_tab=swimlanes')
    writeAnalyticsFilters(next, { days: 90, swimlaneId: null, labelId: null })
    writeAnalyticsTab(next, 'overview')
    expect(next.toString()).toBe('view=analytics&f_search=x')
  })

  it('clears only the Analytics params', () => {
    const next = new URLSearchParams('view=analytics&a_days=30&a_by=label&a_tab=swimlanes&f_search=x')
    clearAnalyticsParams(next)
    expect(next.toString()).toBe('view=analytics&f_search=x')
  })

  it('round-trips the breakdown and drops a field that is not a choice', () => {
    const fields = [{ id: 11, name: 'Size' }]
    expect(breakdownToParam({ by: 'none' })).toBeNull()
    expect(breakdownToParam({ by: 'label' })).toBe('label')
    expect(breakdownToParam({ by: 'custom_field', fieldId: 11, fieldName: 'Size' })).toBe('field_11')
    expect(breakdownFromParam('swimlane', fields)).toEqual({ by: 'swimlane' })
    expect(breakdownFromParam('field_11', fields)).toEqual({ by: 'custom_field', fieldId: 11, fieldName: 'Size' })
    expect(breakdownFromParam('field_99', fields)).toEqual({ by: 'none' })
    expect(breakdownFromParam('field_x', fields)).toEqual({ by: 'none' })
    expect(breakdownFromParam(null, fields)).toEqual({ by: 'none' })
  })
})

describe('useAnalyticsFilters on the URL (#2318)', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={['/b?view=analytics&a_days=30']}>{children}</MemoryRouter>

  it('hydrates from the router and writes back with replace, never push', () => {
    const { result } = renderHook(() => {
      const [searchParams, setSearchParams] = useSearchParams()
      const urlParams = useAnalyticsUrlParams({ searchParams, setSearchParams })
      return { ...useAnalyticsFilters(urlParams), search: searchParams.toString() }
    }, { wrapper })
    expect(result.current.filters).toEqual({ days: 30, swimlaneId: null, labelId: null })
    act(() => result.current.setSwimlaneId(3))
    expect(result.current.search).toBe('view=analytics&a_days=30&a_swimlane=3')
    act(() => result.current.clear())
    expect(result.current.search).toBe('view=analytics')
  })

  it('accepts a functional update, like a state setter', () => {
    const { result } = renderHook(() => useAnalyticsFilters())
    act(() => result.current.setFilters((f) => ({ ...f, labelId: 4 })))
    expect(result.current.filters.labelId).toBe(4)
  })
})

describe('AnalyticsView on the URL (#2318)', () => {
  it('restores Period, Swimlane, Label and the breakdown from a copied link', async () => {
    render(<Harness initial="/b?view=analytics&a_days=30&a_swimlane=3&a_label=4&a_by=field_11" />)
    await screen.findByTestId('flow-wip-age')
    await waitFor(() => expect(vi.mocked(getFlowCycleTime)).toHaveBeenCalled())
    expect(vi.mocked(getFlowCycleTime).mock.calls[0][1]).toEqual({ days: 30, swimlaneId: 3, labelId: 4 })
    expect(screen.getByRole('button', { name: 'Break down by size' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('restores the Swimlanes view from a copied link', async () => {
    render(<Harness initial="/b?view=analytics&a_tab=swimlanes" />)
    expect(await screen.findByRole('link', { name: 'Swimlanes' })).toHaveAttribute('aria-current', 'page')
  })

  it('writes a filter change to the URL, leaves defaults out, and keeps ?view=analytics', async () => {
    render(<Harness initial="/b?view=analytics" />)
    await screen.findByTestId('flow-wip-age')
    await choose(/^Date range/, 'Last 30 days')
    expect(url()).toBe('/b?view=analytics&a_days=30')
    await choose(/^Date range/, 'Last 90 days')
    expect(url()).toBe('/b?view=analytics')
  })

  it('writes the Overview/Swimlanes choice and the breakdown', async () => {
    render(<Harness initial="/b?view=analytics" />)
    await screen.findByTestId('flow-wip-age')
    await userEvent.click(screen.getByRole('button', { name: 'Break down by size' }))
    expect(url()).toBe('/b?view=analytics&a_by=field_11')
    await userEvent.click(screen.getByRole('link', { name: 'Swimlanes' }))
    expect(url()).toContain('a_tab=swimlanes')
    await userEvent.click(screen.getByRole('link', { name: 'Overview' }))
    expect(url()).not.toContain('a_tab')
  })

  it('ignores invalid values: bad period, unknown swimlane and label, unknown breakdown field', async () => {
    render(<Harness initial="/b?view=analytics&a_days=45&a_swimlane=99&a_label=77&a_by=field_12&a_tab=bogus" />)
    await screen.findByTestId('flow-wip-age')
    await waitFor(() => expect(vi.mocked(getFlowCycleTime)).toHaveBeenCalled())
    expect(vi.mocked(getFlowCycleTime).mock.calls[0][1]).toEqual({ days: 90, swimlaneId: null, labelId: null })
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Break down by none' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('opening a lane from the Swimlanes view writes the lane and the Overview in one step', async () => {
    render(<Harness initial="/b?view=analytics&a_tab=swimlanes&a_days=30" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Customer B, open in Overview' }))
    expect(url()).toBe('/b?view=analytics&a_days=30&a_swimlane=5')
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  })
})
