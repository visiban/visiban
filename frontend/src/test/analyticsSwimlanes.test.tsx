import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AnalyticsView from '../components/Board/AnalyticsView'
import { barScale, cycleText, findingText, niceCeil, sortRows } from '../components/Board/flowMetrics/swimlanesFormat'

vi.mock('../api/boards', () => ({ getBoardAnalytics: vi.fn() }))
vi.mock('../api/flowMetrics', async () => ({
  ...(await import('./flowMetricsStubs')).flowMetricsStub(),
  getFlowSwimlanes: vi.fn(),
}))

import { getBoardAnalytics } from '../api/boards'
import { getFlowCycleTime, getFlowSwimlanes } from '../api/flowMetrics'

const points = (v: number | null) => Array.from({ length: 8 }, (_, i) => ({ at: `2026-10-0${i + 1}`, median_days: v, sample_size: 6 }))
const row = (over: Record<string, unknown>) => ({
  id: 1, name: 'Lane', position: 0, group: null, finished: 20, in_progress: 2, median_days: 11, p85_days: 15,
  blocked_share: 0.1, rolling_median: points(11), status: 'in_line', trend: { direction: 'steady', first_days: 11, last_days: 11 },
  ...over,
}) as never
const data = (swimlanes: unknown[], grouping: unknown = null) => ({
  definition: 'd', board: { finished: 80, median_days: 11, p85_days: 20 }, status_threshold_pct: 20, status_min_finished: 10,
  swimlanes, grouping,
}) as never

const lanes = [
  row({ id: 1, name: 'Growth', position: 0, median_days: 11.2, p85_days: 17 }),
  row({ id: 2, name: 'Platform', position: 1, median_days: 14.5, p85_days: 24, status: 'slower', blocked_share: 0.31,
    trend: { direction: 'slower', first_days: 10, last_days: 16 } }),
  row({ id: 3, name: 'Support', position: 2, median_days: 7.5, p85_days: 12, status: 'faster' }),
  row({ id: 4, name: 'Ops', position: 3, finished: 7, median_days: 9, p85_days: 14, status: null }),
  row({ id: 5, name: 'Design', position: 4, finished: 4, median_days: null, p85_days: null, status: null, trend: null, rolling_median: points(null), blocked_share: null }),
  row({ id: 6, name: 'Legal', position: 5, finished: 5, median_days: 8, p85_days: null, status: null }),
]

const props = {
  boardId: 9, currentUserRole: 'member', swimlanes: [{ id: 1, name: 'Growth' }, { id: 2, name: 'Platform' }],
  labels: [{ id: 4, name: 'Urgent' }], boardName: 'Roadmap', swimlaneFields: [{ id: 8, name: 'Team' }],
}

async function openSwimlanes() {
  const user = userEvent.setup()
  render(<AnalyticsView {...props} />)
  await user.click(screen.getByRole('link', { name: 'Swimlanes' }))
  await screen.findByTestId('swimlanes-finding')
  return user
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getBoardAnalytics).mockResolvedValue({ days: 90, columns: [], done_columns: [], swimlanes: [], stalled_threshold_days: 7, staleness_threshold_days: 7, stale_warning_pct: 50 } as never)
  vi.mocked(getFlowSwimlanes).mockResolvedValue(data(lanes))
})

describe('Swimlanes view', () => {
  it('has a nav with aria-current and carries Period and Label over', async () => {
    const user = await openSwimlanes()
    const nav = screen.getByRole('navigation', { name: 'Analytics views' })
    expect(within(nav).getByRole('link', { name: 'Swimlanes' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Swimlane/ })).toBeNull() // no Swimlane filter
    await user.click(screen.getByRole('button', { name: /^Date range/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Last 30 days' }))
    await waitFor(() => expect(getFlowSwimlanes).toHaveBeenLastCalledWith(9, { days: 30, labelId: null }, undefined))
    await user.click(within(nav).getByRole('link', { name: 'Overview' }))
    await waitFor(() => expect(vi.mocked(getFlowCycleTime).mock.calls.at(-1)?.[1]).toMatchObject({ days: 30 }))
  })

  it('carries the Label over in both directions', async () => {
    const user = await openSwimlanes()
    await user.click(screen.getByRole('button', { name: /^Label/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Urgent' }))
    await waitFor(() => expect(getFlowSwimlanes).toHaveBeenLastCalledWith(9, { days: 90, labelId: 4 }, undefined))
    await user.click(screen.getByRole('link', { name: 'Overview' }))
    await waitFor(() => expect(vi.mocked(getFlowCycleTime).mock.calls.at(-1)?.[1]).toMatchObject({ labelId: 4 }))
  })

  it('leaves a modified click on the view links alone', async () => {
    render(<AnalyticsView {...props} />)
    const user = userEvent.setup()
    await user.keyboard('{Control>}')
    await user.click(screen.getByRole('link', { name: 'Swimlanes' }))
    await user.keyboard('{/Control}')
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  })

  it('names the two slowest lanes in the finding', async () => {
    await openSwimlanes()
    const finding = screen.getByTestId('swimlanes-finding')
    expect(within(finding).getByRole('heading')).toHaveTextContent('Platform is where cards slow down')
  })

  it('renders slower, in line, faster and small-sample rows by the spec rules', async () => {
    await openSwimlanes()
    const rows = screen.getAllByTestId('swimlane-row')
    const byName = (n: string) => rows.find((r) => within(r).queryByRole('button', { name: `${n}, open in Overview` }))!
    const platform = byName('Platform')
    expect(platform).toHaveTextContent('Slower than the board')
    expect(platform).toHaveTextContent('14.5 days median · 85% finish within 24 days')
    expect(platform).toHaveTextContent('Slower, 10 to 16 days')
    expect(platform).toHaveTextContent('31% of elapsed time')
    expect(byName('Growth')).toHaveTextContent('In line with the board')
    expect(byName('Growth')).toHaveTextContent('Steady')
    expect(byName('Support')).toHaveTextContent('Faster than the board')
    // 5 to 9 finished: a median, no status line
    expect(byName('Ops')).not.toHaveTextContent(/the board/)
    expect(byName('Ops')).toHaveTextContent('9.0 days median')
    // 5 or 6 finished: no 85th line
    expect(within(byName('Legal')).queryByTestId('p85-line')).toBeNull()
    expect(byName('Legal')).toHaveTextContent('needs 7 finished cards')
    // under 5: no median, bar fill or trend
    const design = byName('Design')
    expect(design).toHaveTextContent('Too few finished cards')
    expect(design).toHaveTextContent('No median yet: only 4 cards finished.')
    expect(design).toHaveTextContent('Not enough cards')
    expect(within(design).queryByTestId('trend-bars')).toBeNull()
    expect(within(design).getByTestId('cycle-bar').children).toHaveLength(1) // board tick only
    expect(within(platform).getByTestId('p85-line')).toBeInTheDocument()
  })

  it('sorts slowest first by default and re-sorts by name', async () => {
    const user = await openSwimlanes()
    const names = () => screen.getAllByTestId('swimlane-row').map((r) => within(r).getAllByRole('button')[0].textContent)
    expect(names()).toEqual(['Platform', 'Growth', 'Ops', 'Legal', 'Support', 'Design'].sort((a, b) => {
      const m: Record<string, number> = { Platform: 14.5, Growth: 11.2, Ops: 9, Legal: 8, Support: 7.5, Design: -1 }
      return m[b] - m[a]
    }))
    await user.click(screen.getByRole('button', { name: /^Sort/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Name' }))
    expect(names()).toEqual(['Design', 'Growth', 'Legal', 'Ops', 'Platform', 'Support'])
  })

  it('opens the Overview filtered to the selected swimlane', async () => {
    const user = await openSwimlanes()
    await user.click(screen.getByRole('button', { name: 'Platform, open in Overview' }))
    await waitFor(() => expect(vi.mocked(getFlowCycleTime).mock.calls.at(-1)?.[1]).toMatchObject({ swimlaneId: 2 }))
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  })

  it('shows the Sort and Group lanes by prefixes and checks None by default', async () => {
    const user = await openSwimlanes()
    expect(screen.getByRole('button', { name: /^Group lanes by/ })).toHaveTextContent('Group lanes by:')
    expect(screen.getByRole('button', { name: /^Sort/ })).toHaveTextContent('Sort:')
    await user.click(screen.getByRole('button', { name: /^Group lanes by/ }))
    expect(screen.getByRole('menuitem', { name: 'None' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('menuitem', { name: 'Team' })).not.toHaveAttribute('aria-current')
  })

  it('colors trend text warning only when the trend itself is slower', async () => {
    vi.mocked(getFlowSwimlanes).mockResolvedValue(data([
      row({ id: 1, name: 'Mobile', status: 'slower', median_days: 14, trend: { direction: 'faster', first_days: 16, last_days: 12 } }),
    ]))
    await openSwimlanes()
    const text = within(screen.getByTestId('swimlane-row')).getByText(/^Faster, 16 to 12 days/)
    expect(text.className).not.toContain('text-warning')
    expect(text.className).toContain('text-success')
  })

  it('groups lanes by a swimlane field', async () => {
    const user = await openSwimlanes()
    vi.mocked(getFlowSwimlanes).mockResolvedValue(data(
      [row({ id: 1, name: 'A', group: 'x' }), row({ id: 2, name: 'B', group: null })],
      { field_id: 8, field_name: 'Team', field_type: 'dropdown', groups: [{ key: 'x', name: 'Team X' }] },
    ))
    await user.click(screen.getByRole('button', { name: /^Group lanes by/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Team' }))
    expect(await screen.findByRole('heading', { name: 'Team X' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'No Team' })).toBeInTheDocument()
    expect(getFlowSwimlanes).toHaveBeenLastCalledWith(9, { days: 90, labelId: null }, 8)
  })

  it('colors a slower lane\'s trend bars with the warning color even when its trend is steady', async () => {
    vi.mocked(getFlowSwimlanes).mockResolvedValue(data([
      row({ id: 1, name: 'Mobile', status: 'slower', median_days: 14 }),
      row({ id: 2, name: 'Growth', status: 'in_line' }),
    ]))
    await openSwimlanes()
    const [mobile, growth] = screen.getAllByTestId('swimlane-row')
    const fill = (r: HTMLElement) => (within(r).getByTestId('trend-bars').firstElementChild as HTMLElement).style.background
    expect(fill(mobile)).toContain('--warning')
    expect(fill(growth)).not.toContain('--warning')
  })

  it('explains too much history without a Retry, and is not retried (#2428)', async () => {
    const user = userEvent.setup()
    vi.mocked(getFlowSwimlanes).mockReset()
    vi.mocked(getFlowSwimlanes).mockRejectedValue({ response: { status: 422, data: { code: 'analytics_too_large', detail: 'x' } } })
    render(<AnalyticsView {...props} />)
    await user.click(screen.getByRole('link', { name: 'Swimlanes' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This board has more history than this server is set up to analyze. Try a shorter period')
    expect(within(alert).queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(vi.mocked(getFlowSwimlanes)).toHaveBeenCalledTimes(1)
  })

  it('explains a refused refetch and keeps the old numbers without a Retry (#2428)', async () => {
    const user = await openSwimlanes()
    vi.mocked(getFlowSwimlanes).mockRejectedValueOnce({ response: { status: 422, data: { code: 'analytics_too_large', detail: 'x' } } })
    await user.click(screen.getByRole('button', { name: /^Date range/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Last 30 days' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This board has more history than this server is set up to analyze. Try a shorter period')
    expect(alert).toHaveTextContent('The numbers below are from the last load.')
    expect(within(alert).queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.getAllByTestId('swimlane-row').length).toBeGreaterThan(0)
  })

  it('keeps old numbers with an alert and Retry when a refetch fails, and hides the legend without rows', async () => {
    const user = await openSwimlanes()
    expect(screen.getByTestId('swimlanes-legend')).toBeInTheDocument()
    vi.mocked(getFlowSwimlanes).mockRejectedValueOnce(new Error('x'))
    await user.click(screen.getByRole('button', { name: /^Date range/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Last 30 days' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not refresh swimlanes')
    expect(screen.getAllByTestId('swimlane-row').length).toBeGreaterThan(0)
    vi.mocked(getFlowSwimlanes).mockResolvedValue(data([]))
    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.queryByTestId('swimlanes-legend')).toBeNull()
    expect(screen.getByText('This board has no swimlanes.')).toBeInTheDocument()
  })

  it('shows a failure with Retry', async () => {
    vi.mocked(getFlowSwimlanes).mockRejectedValueOnce(new Error('x'))
    const user = userEvent.setup()
    render(<AnalyticsView {...props} />)
    await user.click(screen.getByRole('link', { name: 'Swimlanes' }))
    await user.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('swimlanes-finding')).toBeInTheDocument()
  })
})

describe('swimlanesFormat', () => {
  it('uses the singular for a median that shows as 1.0', () => {
    expect(cycleText(row({ median_days: 0.96, p85_days: null }) as never)).toMatch(/^1\.0 day median/)
    expect(cycleText(row({ median_days: 2, p85_days: null }) as never)).toMatch(/^2\.0 days median/)
  })
  it('rounds the shared scale up to a round number', () => {
    expect(niceCeil(24)).toBe(50)
    expect(niceCeil(17)).toBe(20)
    expect(niceCeil(0.3)).toBe(0.5)
    expect(niceCeil(0)).toBe(1)
    expect(barScale({ swimlanes: lanes as never, board: { finished: 1, median_days: 11, p85_days: 20 } })).toBe(50)
  })
  it('says no lane is slower, or compares nothing without a board median', () => {
    expect(findingText(data([row({})])).heading).toBe('No swimlane is slower than the board')
    const empty = { ...(data([]) as object), board: { finished: 0, median_days: null, p85_days: null } } as never
    expect(findingText(empty).sentence).toMatch(/too few finished cards/)
  })
  it('never overstates a whole-number or fractional median in the finding', () => {
    const pair = (a: number, b: number) => findingText(data([
      row({ id: 7, name: 'A', median_days: a, status: 'slower' }), row({ id: 8, name: 'B', median_days: b, status: 'slower' })]))
    expect(pair(14, 15).sentence).toMatch(/^Both take 14 days or more against/)
    expect(pair(14.5, 14.2).sentence).toMatch(/^Both take 14\.2 days or more against/)
  })
  it('names one slower lane alone and sorts missing medians last', () => {
    const two = findingText(data([lanes[1], row({ id: 7, name: 'Mobile', median_days: 14.2, status: 'slower' })]))
    expect(two.heading).toBe('Platform and Mobile are where cards slow down')
    expect(two.sentence).toMatch(/^Both take 14\.2 days or more against a board median of 11\./)
    expect(findingText(data([lanes[1]])).heading).toBe('Platform is where cards slow down')
    expect(sortRows(lanes as never, 'fastest').at(-1)!.name).toBe('Design')
    expect(sortRows(lanes as never, 'blocked')[0].name).toBe('Platform')
    expect(sortRows(lanes as never, 'board')[0].name).toBe('Growth')
  })
})
