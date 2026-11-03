import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SummaryView from '../components/Board/SummaryView'
import AnalyticsView from '../components/Board/AnalyticsView'

vi.mock('../api/boards', () => ({
  getBoardSummary: vi.fn(),
  getBoardAnalytics: vi.fn(),
}))

import { getBoardSummary, getBoardAnalytics } from '../api/boards'

const mockGetBoardSummary = getBoardSummary as ReturnType<typeof vi.fn>
const mockGetBoardAnalytics = getBoardAnalytics as ReturnType<typeof vi.fn>

describe('SummaryView', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('shows loading state', () => {
    mockGetBoardSummary.mockReturnValue(new Promise(() => {}))
    render(<SummaryView boardId={1} columns={['To Do', 'Done']} />)
    expect(screen.getByText(/Loading summary/)).toBeInTheDocument()
  })

  it('shows error on failure', async () => {
    mockGetBoardSummary.mockRejectedValue(new Error('fail'))
    render(<SummaryView boardId={1} columns={['To Do', 'Done']} />)
    expect(await screen.findByText('Failed to load summary.')).toBeInTheDocument()
  })

  it('swimlane color dot carries the neutral ring (#2094)', async () => {
    mockGetBoardSummary.mockResolvedValue({
      swimlanes: [{
        id: 1, name: 'Customer A', color: '#FFFFFF', total_cards: 1,
        stage_distribution: { 'To Do': 1, 'Done': 0 },
        velocity_7d: 0, velocity_30d: 0, active_cards: 1, done_30d: 0, avg_cycle_days: null,
      }],
    } as never)
    const { container } = render(<SummaryView boardId={1} columns={['To Do', 'Done']} />)
    await screen.findByText('Customer A')
    expect(container.querySelector('.color-dot')).not.toBeNull()
  })

  it('renders summary table with swimlane data', async () => {
    mockGetBoardSummary.mockResolvedValue({
      swimlanes: [
        {
          id: 1, name: 'Customer A', color: '#3B82F6', total_cards: 5,
          stage_distribution: { 'To Do': 3, 'Done': 2 },
          velocity_7d: 2, velocity_30d: 8,
          active_cards: 3, done_30d: 2, avg_cycle_days: 4.5,
        },
      ],
    })
    render(<SummaryView boardId={1} columns={['To Do', 'Done']} />)

    expect(await screen.findByText('Customer A')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('8')).toBeInTheDocument()
    // New #342 metrics
    expect(screen.getByText('3')).toBeInTheDocument() // active_cards
    expect(screen.getByText('4.5')).toBeInTheDocument() // avg_cycle_days
  })

  describe('extension panels (#1770)', () => {
    const lane = {
      id: 1, name: 'Customer A', color: '#3B82F6', total_cards: 5,
      stage_distribution: { 'To Do': 3, 'Done': 2 },
      velocity_7d: 2, velocity_30d: 8, active_cards: 3, done_30d: 2, avg_cycle_days: 4.5,
    }
    const statsPanel = {
      id: 's1', title: 'Risk', type: 'stats', description: 'Quarterly',
      data: { items: [{ label: 'Open', value: 7, hint: 'since Monday' }, { label: 'Owner', value: null }] },
    }

    it.each([
      ['an empty list', { swimlanes: [lane], extension_panels: [] }],
      ['no key at all', { swimlanes: [lane] }],
    ])('renders nothing extra for %s', async (_n, payload) => {
      mockGetBoardSummary.mockResolvedValue(payload)
      render(<SummaryView boardId={1} columns={['To Do', 'Done']} />)
      expect(await screen.findByText('Customer A')).toBeInTheDocument()
      expect(screen.queryByTestId('extension-panels')).toBeNull()
      expect(screen.getAllByRole('table')).toHaveLength(1)
    })

    it('renders a valid stats panel', async () => {
      mockGetBoardSummary.mockResolvedValue({ swimlanes: [lane], extension_panels: [statsPanel] })
      render(<SummaryView boardId={1} columns={['To Do', 'Done']} />)
      const group = await screen.findByRole('group', { name: 'Risk' })
      expect(within(group).getByText('Quarterly')).toBeInTheDocument()
      expect(within(group).getByText('Open').tagName).toBe('DT')
      expect(within(group).getByText('7').closest('dd')).not.toBeNull()
      expect(within(group).getByText('since Monday')).toBeInTheDocument()
      expect(within(group).getByText('—')).toBeInTheDocument()
    })

    it('renders a valid table panel, with No data. for zero rows', async () => {
      mockGetBoardSummary.mockResolvedValue({
        swimlanes: [lane],
        extension_panels: [
          { id: 't1', title: 'Owners', type: 'table', data: { columns: [{ key: 'n', label: 'Name' }, { key: 'c', label: 'Count', align: 'right' }], rows: [{ n: 'Ann', c: 3 }, { n: 'Bob' }] } },
          { id: 't2', title: 'Empty', type: 'table', data: { columns: [{ key: 'n', label: 'Name' }], rows: [] } },
        ],
      })
      render(<SummaryView boardId={1} columns={['To Do', 'Done']} />)
      const g = await screen.findByRole('group', { name: 'Owners' })
      expect(within(g).getByRole('columnheader', { name: 'Count' })).toHaveClass('text-right')
      expect(within(g).getByText('Ann')).toBeInTheDocument()
      expect(within(g).getByText('3')).toBeInTheDocument()
      expect(within(g).getByText('—')).toBeInTheDocument()
      expect(within(screen.getByRole('group', { name: 'Empty' })).getByText('No data.')).toBeInTheDocument()
    })

    it('renders only the valid panel when one is malformed', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockGetBoardSummary.mockResolvedValue({
        swimlanes: [lane],
        extension_panels: [null, { id: 'x', title: 'Legacy', data: {} }, statsPanel],
      })
      render(<SummaryView boardId={1} columns={['To Do', 'Done']} />)
      await screen.findByRole('group', { name: 'Risk' })
      expect(screen.getAllByRole('group')).toHaveLength(1)
      expect(screen.queryByText('Legacy')).toBeNull()
      warnSpy.mockRestore()
    })

    it('renders a numeric 0 as 0, right-aligns body cells, and keeps the hint in a dd', async () => {
      mockGetBoardSummary.mockResolvedValue({
        swimlanes: [lane],
        extension_panels: [
          { id: 'z', title: 'Zeros', type: 'stats', data: { items: [{ label: 'Blocked', value: 0, hint: 'none now' }] } },
          { id: 'r', title: 'Right', type: 'table', data: { columns: [{ key: 'c', label: 'Count', align: 'right' }], rows: [{ c: 0 }] } },
        ],
      })
      render(<SummaryView boardId={1} columns={['To Do', 'Done']} />)
      const z = await screen.findByRole('group', { name: 'Zeros' })
      expect(within(z).getByText('0').closest('dd')).not.toBeNull()
      expect(within(z).getByText('none now').tagName).toBe('DD')
      expect(within(z).queryByText('—')).toBeNull()
      const r = screen.getByRole('group', { name: 'Right' })
      expect(within(r).getByText('0').closest('td')).toHaveClass('text-right')
    })

    it('wraps long unbroken titles, descriptions and cells instead of overflowing', async () => {
      const long = 'x'.repeat(100)
      mockGetBoardSummary.mockResolvedValue({
        swimlanes: [lane],
        extension_panels: [
          { id: 'l', title: long, description: long, type: 'table', data: { columns: [{ key: 'c', label: 'C' }], rows: [{ c: long + 'y' }] } },
        ],
      })
      render(<SummaryView boardId={1} columns={['To Do', 'Done']} />)
      const g = await screen.findByRole('group', { name: long })
      expect(within(g).getByRole('heading')).toHaveClass('break-words')
      expect(within(g).getAllByText(long)[0]).toHaveClass('break-words')
      expect(within(g).getByText(long + 'y')).toHaveClass('break-words')
    })

    it('renders hostile strings as literal text', async () => {
      const evil = '<img src=x onerror=alert(1)>'
      mockGetBoardSummary.mockResolvedValue({
        swimlanes: [lane],
        extension_panels: [
          { id: 'e', title: evil, type: 'stats', data: { items: [{ label: 'Link', value: 'javascript:alert(1)' }] } },
        ],
      })
      const { container } = render(<SummaryView boardId={1} columns={['To Do', 'Done']} />)
      expect(await screen.findByText(evil)).toBeInTheDocument()
      expect(container.querySelector('img')).toBeNull()
      expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument()
      expect(screen.queryByRole('link')).toBeNull()
    })
  })

  it('renders column headers', async () => {
    mockGetBoardSummary.mockResolvedValue({ swimlanes: [] })
    render(<SummaryView boardId={1} columns={['To Do', 'Done']} />)

    expect(await screen.findByText('Swimlane')).toBeInTheDocument()
    expect(screen.getByText('Cards')).toBeInTheDocument()
    expect(screen.getByText('7d Velocity')).toBeInTheDocument()
    expect(screen.getByText('30d Velocity')).toBeInTheDocument()
    // New #342 metric headers
    expect(screen.getByText('Metrics (30d)')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText('Done 30d')).toBeInTheDocument()
    expect(screen.getByText('Avg cycle (days)')).toBeInTheDocument()
  })

  it('shows em-dash for null avg_cycle_days', async () => {
    mockGetBoardSummary.mockResolvedValue({
      swimlanes: [
        {
          id: 1, name: 'Customer A', color: '#3B82F6', total_cards: 0,
          stage_distribution: {},
          velocity_7d: 0, velocity_30d: 0,
          active_cards: 0, done_30d: 0, avg_cycle_days: null,
        },
      ],
    })
    render(<SummaryView boardId={1} columns={[]} />)
    await screen.findByText('Customer A')
    const dashes = screen.getAllByText('—')
    // At least the avg_cycle_days, active_cards and done_30d cells show —
    expect(dashes.length).toBeGreaterThanOrEqual(3)
  })

  it('stage-distribution segment initials use the text-xs typography floor, not text-[8px] (#1311)', async () => {
    mockGetBoardSummary.mockResolvedValue({
      swimlanes: [
        {
          id: 1, name: 'Customer A', color: '#3B82F6', total_cards: 100,
          stage_distribution: { 'To Do': 20, 'Done': 80 },
          velocity_7d: 0, velocity_30d: 0,
          active_cards: 0, done_30d: 0, avg_cycle_days: null,
        },
      ],
    })
    const { container } = render(<SummaryView boardId={1} columns={['To Do', 'Done']} />)
    await screen.findByText('Customer A')

    const todoSegment = container.querySelector('[title="To Do: 20"]') as HTMLElement
    const doneSegment = container.querySelector('[title="Done: 80"]') as HTMLElement
    expect(todoSegment).toBeInTheDocument()
    expect(doneSegment).toBeInTheDocument()
    // Both segments are wide enough (>=12%) to show initials at the new size
    expect(todoSegment.textContent).toBe('TO')
    expect(doneSegment.textContent).toBe('DO')
    for (const segment of [todoSegment, doneSegment]) {
      expect(segment.className).toMatch(/\btext-xs\b/)
      expect(segment.className).not.toMatch(/text-\[(8|9|10|11)px\]/)
    }
  })

  it('hides stage-distribution initials on a segment too narrow to fit them, keeping the title intact (#1311)', async () => {
    mockGetBoardSummary.mockResolvedValue({
      swimlanes: [
        {
          id: 1, name: 'Customer A', color: '#3B82F6', total_cards: 100,
          stage_distribution: { 'To Do': 5, 'Done': 95 },
          velocity_7d: 0, velocity_30d: 0,
          active_cards: 0, done_30d: 0, avg_cycle_days: null,
        },
      ],
    })
    const { container } = render(<SummaryView boardId={1} columns={['To Do', 'Done']} />)
    await screen.findByText('Customer A')

    // Too narrow at 5% — no visible initials, but the accessible title survives
    const todoSegment = container.querySelector('[title="To Do: 5"]') as HTMLElement
    expect(todoSegment).toBeInTheDocument()
    expect(todoSegment.textContent).toBe('')

    // Wide enough at 95% — initials still render
    const doneSegment = container.querySelector('[title="Done: 95"]') as HTMLElement
    expect(doneSegment.textContent).toBe('DO')
  })
})

describe('AnalyticsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('shows loading spinner', () => {
    mockGetBoardAnalytics.mockReturnValue(new Promise(() => {}))
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    expect(screen.getByText(/Loading analytics/)).toBeInTheDocument()
    // Canonical spinner element is present
    expect(document.querySelector('.animate-spin')).not.toBeNull()
  })

  it('shows empty state when API returns null (#672)', async () => {
    mockGetBoardAnalytics.mockResolvedValue(null)
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    expect(await screen.findByText('No analytics data')).toBeInTheDocument()
    expect(screen.getByText(/Move cards between columns/)).toBeInTheDocument()
  })

  it('shows empty state when swimlanes is null (#672)', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30, columns: [], swimlanes: null,
      stalled_threshold_days: 7, staleness_threshold_days: 14, stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    expect(await screen.findByText('No analytics data')).toBeInTheDocument()
  })

  it('shows error on failure', async () => {
    mockGetBoardAnalytics.mockRejectedValue(new Error('fail'))
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    expect(await screen.findByText('Failed to load analytics.')).toBeInTheDocument()
  })

  it('renders Age/Throughput mode toggle', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    expect(await screen.findByRole('group', { name: 'Analytics view mode' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Age' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Throughput' })).toBeInTheDocument()
  })

  it('defaults to age mode — period selector hidden', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [
        {
          id: 1, name: 'Customer A',
          avg_days_per_column: { 'To Do': 5 },
          is_outlier: { 'To Do': false },
          age_avg_days_per_column: { 'To Do': 8 },
          age_is_outlier: { 'To Do': false },
          deal_velocity_days: null,
          stalled_cards: [],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    await screen.findByText('Customer A')
    // Period buttons are hidden in age mode
    expect(screen.queryByText('7d')).not.toBeInTheDocument()
    expect(screen.queryByText('30d')).not.toBeInTheDocument()
    expect(screen.queryByText('90d')).not.toBeInTheDocument()
  })

  it('switching to throughput mode shows period selector', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    await screen.findByRole('button', { name: 'Throughput' })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Throughput' }))
    expect(screen.getByRole('button', { name: '7d' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '30d' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '90d' })).toBeInTheDocument()
  })

  it('switching back to age mode hides period selector', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    const user = userEvent.setup()
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    await screen.findByRole('button', { name: 'Throughput' })
    await user.click(screen.getByRole('button', { name: 'Throughput' }))
    expect(screen.getByRole('button', { name: '7d' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Age' }))
    expect(screen.queryByRole('button', { name: '7d' })).not.toBeInTheDocument()
  })

  it('description line appears only in throughput mode', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    const user = userEvent.setup()
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    await screen.findByRole('button', { name: 'Age' })
    expect(screen.queryByText(/exited in the last/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Throughput' }))
    expect(screen.getByText(/exited in the last 30 days/)).toBeInTheDocument()
  })

  it('age mode renders age_avg_days_per_column values', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [
        {
          id: 1, name: 'Customer A',
          avg_days_per_column: { 'To Do': 99 },
          is_outlier: { 'To Do': false },
          age_avg_days_per_column: { 'To Do': 20 },
          age_is_outlier: { 'To Do': false },
          throughput_avg_days_per_column: { 'To Do': 5 },
          throughput_is_outlier: { 'To Do': false },
          throughput_card_count_per_column: { 'To Do': 3 },
          deal_velocity_days: null,
          stalled_cards: [],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    // Default age mode — shows 20d from age_avg_days_per_column
    expect(await screen.findByText('20d')).toBeInTheDocument()
    expect(screen.queryByText('5d')).not.toBeInTheDocument()
    expect(screen.queryByText('99d')).not.toBeInTheDocument()
  })

  it('throughput mode renders throughput_avg_days_per_column values', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [
        {
          id: 1, name: 'Customer A',
          avg_days_per_column: { 'To Do': 99 },
          is_outlier: { 'To Do': false },
          age_avg_days_per_column: { 'To Do': 20 },
          age_is_outlier: { 'To Do': false },
          throughput_avg_days_per_column: { 'To Do': 5 },
          throughput_is_outlier: { 'To Do': false },
          throughput_card_count_per_column: { 'To Do': 3 },
          deal_velocity_days: null,
          stalled_cards: [],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    await screen.findByRole('button', { name: 'Throughput' })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Throughput' }))
    // Throughput mode — shows 5d from throughput_avg_days_per_column
    expect(screen.getByText('5d')).toBeInTheDocument()
    expect(screen.queryByText('20d')).not.toBeInTheDocument()
  })

  it('renders heatmap column headers and cell values when movements exist (#361 regression guard)', async () => {
    // This test prevents the heatmap table being accidentally wrapped in a conditional —
    // the table must always render, even when some cells are null.
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['Backlog', 'In Progress', 'Done'],
      swimlanes: [
        {
          id: 1, name: 'Acme Corp',
          avg_days_per_column: { 'Backlog': 3, 'In Progress': 7, 'Done': null },
          is_outlier: { 'Backlog': false, 'In Progress': false, 'Done': false },
          age_avg_days_per_column: { 'Backlog': 3, 'In Progress': 7, 'Done': null },
          age_is_outlier: { 'Backlog': false, 'In Progress': false, 'Done': false },
          deal_velocity_days: 10,
          stalled_cards: [],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="member" />)

    // Column headers must be visible in the heatmap thead
    expect(await screen.findByText('Backlog')).toBeInTheDocument()
    expect(screen.getByText('In Progress')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    // Swimlane row and cell values
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    expect(screen.getByText('3d')).toBeInTheDocument()
    expect(screen.getByText('7d')).toBeInTheDocument()
    // Null cell renders em-dash
    expect(screen.getByText('—')).toBeInTheDocument()
    // Velocity
    expect(screen.getByText('10d')).toBeInTheDocument()
  })

  it.each([
    // stale_warning_pct is the percent of the threshold used before "Warning" (#1841).
    // threshold 14 at 75% → warning from 10.5d: 10d is OK, 11d is Warning. The old
    // inverted math (1 - pct/100) put the edge at 3.5d and showed 10d as Warning.
    [75, { 'Backlog': 10, 'In Progress': 11, 'Review': 14 }, ['OK', 'Warning', 'High']],
    // 0 turns the warning band off: below the threshold is OK, at it is High.
    [0, { 'Backlog': 1, 'In Progress': 13, 'Review': 14 }, ['OK', 'OK', 'High']],
  ])('heatmap warning band follows stale_warning_pct=%i as percent of the threshold used (#1841)', async (pct, avgs, levels) => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['Backlog', 'In Progress', 'Review'],
      swimlanes: [
        {
          id: 1, name: 'Acme Corp',
          avg_days_per_column: avgs, is_outlier: {},
          age_avg_days_per_column: avgs, age_is_outlier: {},
          deal_velocity_days: null, stalled_cards: [],
        },
      ],
      stalled_threshold_days: 14,
      staleness_threshold_days: 14,
      stale_warning_pct: pct,
    })
    render(<AnalyticsView boardId={1} currentUserRole="member" />)
    await screen.findByText('Acme Corp')
    const cells = within(screen.getByRole('table', { name: 'Dwell time heatmap' })).getAllByRole('cell')
    const values = Object.values(avgs)
    values.forEach((v, i) => {
      const cell = cells.find(c => (c.textContent ?? '').match(/\d+d/)?.[0] === `${v}d`)!
      expect(cell).toHaveTextContent(levels[i])
    })
  })

  it('carries threshold level by icon and text, not color alone (#1591)', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['Backlog', 'In Progress', 'Review', 'Blocked', 'Done'],
      swimlanes: [
        {
          id: 1, name: 'Acme Corp',
          avg_days_per_column: { 'Backlog': 1, 'In Progress': 8, 'Review': 15, 'Blocked': null, 'Done': null },
          is_outlier: {},
          age_avg_days_per_column: { 'Backlog': 1, 'In Progress': 8, 'Review': 15, 'Blocked': null, 'Done': null },
          age_is_outlier: {},
          deal_velocity_days: 10,
          stalled_cards: [],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="member" />)
    await screen.findByText('Acme Corp')

    const table = screen.getByRole('table', { name: 'Dwell time heatmap' })
    const cells = within(table).getAllByRole('cell')
    const byText = (t: string) => cells.find(c => c.textContent?.includes(t))!
    expect(byText('1d')).toHaveTextContent('OK')
    expect(byText('1d')).toHaveTextContent('●')
    expect(byText('8d')).toHaveTextContent('Warning')
    expect(byText('8d')).toHaveTextContent('◆')
    expect(byText('15d')).toHaveTextContent('High')
    expect(byText('15d')).toHaveTextContent('▲')

    // Null cell in an active (non-done) column: dash only, no marker or level text
    const nullCells = cells.filter(c => c.textContent === '—')
    expect(nullCells.length).toBeGreaterThanOrEqual(2)
    nullCells.forEach(c => expect(c.textContent).not.toMatch(/[▲◆●]|High|Warning|OK/))

    const legend = screen.getByRole('list', { name: 'Heatmap legend' })
    expect(within(legend).getByText(/High: At or over threshold/)).toBeInTheDocument()
    expect(within(legend).getByText(/Warning: Approaching threshold/)).toBeInTheDocument()
    expect(within(legend).getByText(/OK: Within threshold/)).toBeInTheDocument()
  })

  it('shows export CSV button for admins', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: [],
      swimlanes: [],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    expect(await screen.findByText('Export CSV')).toBeInTheDocument()
  })

  it('hides export CSV button for non-admins', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: [],
      swimlanes: [],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="member" />)
    await screen.findByRole('button', { name: 'Age' })
    expect(screen.queryByText('Export CSV')).not.toBeInTheDocument()
  })

  it('shows stalled cards section', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [
        {
          id: 1, name: 'Customer A',
          avg_days_per_column: { 'To Do': 5 },
          is_outlier: { 'To Do': false },
          deal_velocity_days: null,
          stalled_cards: [{ id: 100, title: 'Stale Card', days_since_move: 14 }],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    expect(await screen.findByText('Stale Card')).toBeInTheDocument()
    expect(screen.getByText('14d')).toBeInTheDocument()
  })

  it('calls onOpenCard when a stalled card row is clicked', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [
        {
          id: 1, name: 'Customer A',
          avg_days_per_column: { 'To Do': 5 },
          is_outlier: { 'To Do': false },
          deal_velocity_days: null,
          stalled_cards: [{ id: 42, title: 'Stale Card', days_since_move: 14 }],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    const onOpenCard = vi.fn()
    render(<AnalyticsView boardId={1} currentUserRole="admin" onOpenCard={onOpenCard} />)
    await userEvent.setup().click(await screen.findByText('Stale Card'))
    expect(onOpenCard).toHaveBeenCalledWith(42)
  })

  const stalledPayload = {
    days: 30,
    columns: ['To Do'],
    swimlanes: [
      {
        id: 1, name: 'Customer A',
        avg_days_per_column: { 'To Do': 5 },
        is_outlier: { 'To Do': false },
        deal_velocity_days: null,
        stalled_cards: [{ id: 42, title: 'Stale Card', days_since_move: 14 }],
      },
    ],
    stalled_threshold_days: 7,
    staleness_threshold_days: 14,
    stale_warning_pct: 50,
  }

  it('stalled card row is a keyboard tab stop; Enter and Space open the card (#1376)', async () => {
    mockGetBoardAnalytics.mockResolvedValue(stalledPayload)
    const onOpenCard = vi.fn()
    const user = userEvent.setup()
    render(<AnalyticsView boardId={1} currentUserRole="admin" onOpenCard={onOpenCard} />)
    const row = (await screen.findByText('Stale Card')).closest('tr') as HTMLElement
    expect(row).toHaveAttribute('tabindex', '0')
    row.focus()
    expect(row).toHaveFocus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onOpenCard).toHaveBeenCalledTimes(2)
    expect(onOpenCard).toHaveBeenNthCalledWith(1, 42)
    expect(onOpenCard).toHaveBeenNthCalledWith(2, 42)
  })

  it('stalled card row has no tab stop when onOpenCard is absent (#1376)', async () => {
    mockGetBoardAnalytics.mockResolvedValue(stalledPayload)
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    const row = (await screen.findByText('Stale Card')).closest('tr') as HTMLElement
    expect(row).not.toHaveAttribute('tabindex')
  })

  it('changes period on button click in throughput mode', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: [],
      swimlanes: [],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    const user = userEvent.setup()
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    await screen.findByRole('button', { name: 'Throughput' })
    await user.click(screen.getByRole('button', { name: 'Throughput' }))
    await user.click(screen.getByRole('button', { name: '7d' }))
    expect(mockGetBoardAnalytics).toHaveBeenCalledWith(1, 7)
  })

  it('renders heatmap table even when all cells are null (no movements in period)', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do', 'Done'],
      swimlanes: [
        {
          id: 1, name: 'Customer A',
          avg_days_per_column: { 'To Do': null, 'Done': null },
          is_outlier: { 'To Do': false, 'Done': false },
          deal_velocity_days: null,
          stalled_cards: [],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    // Heatmap table always renders — no empty-period message
    expect(await screen.findByText('Customer A')).toBeInTheDocument()
    expect(screen.queryByText(/No card movements/)).not.toBeInTheDocument()
  })

  it('colors cells red when avg meets or exceeds threshold', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [
        {
          id: 1, name: 'Customer A',
          avg_days_per_column: { 'To Do': 14 },
          is_outlier: { 'To Do': false },
          age_avg_days_per_column: { 'To Do': 14 },
          age_is_outlier: { 'To Do': false },
          deal_velocity_days: null,
          stalled_cards: [],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    const cell = await screen.findByText('14d')
    expect(cell.className).toMatch(/danger/)
  })

  it('colors cells yellow when avg is in warning range', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [
        {
          id: 1, name: 'Customer A',
          avg_days_per_column: { 'To Do': 8 },
          is_outlier: { 'To Do': false },
          age_avg_days_per_column: { 'To Do': 8 },
          age_is_outlier: { 'To Do': false },
          deal_velocity_days: null,
          stalled_cards: [],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    // 50% warning of 14d = 7d; avg=8 is >=7 but <14 → yellow
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    const cell = await screen.findByText('8d')
    expect(cell.className).toMatch(/warning/)
  })

  it('colors cells green when avg is well below threshold', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [
        {
          id: 1, name: 'Customer A',
          avg_days_per_column: { 'To Do': 3 },
          is_outlier: { 'To Do': false },
          age_avg_days_per_column: { 'To Do': 3 },
          age_is_outlier: { 'To Do': false },
          deal_velocity_days: null,
          stalled_cards: [],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    // avg=3 is below 7d warning boundary → green
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    const cell = await screen.findByText('3d')
    expect(cell.className).toMatch(/success/)
  })

  it('shows stalled count label when stalled cards are present', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [
        {
          id: 1, name: 'Customer A',
          avg_days_per_column: { 'To Do': 5 },
          is_outlier: { 'To Do': false },
          deal_velocity_days: null,
          stalled_cards: [
            { id: 1, title: 'Card One', days_since_move: 10 },
            { id: 2, title: 'Card Two', days_since_move: 12 },
          ],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    expect(await screen.findByText('2 cards stalled')).toBeInTheDocument()
  })

  it('shows singular count label for exactly one stalled card', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [
        {
          id: 1, name: 'Customer A',
          avg_days_per_column: { 'To Do': 5 },
          is_outlier: { 'To Do': false },
          deal_velocity_days: null,
          stalled_cards: [{ id: 1, title: 'Solo Card', days_since_move: 9 }],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    expect(await screen.findByText('1 card stalled')).toBeInTheDocument()
  })

  it('does not render stalled section when no stalled cards', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [
        {
          id: 1, name: 'Customer A',
          avg_days_per_column: { 'To Do': 5 },
          is_outlier: { 'To Do': false },
          deal_velocity_days: null,
          stalled_cards: [],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    await screen.findByText('Customer A')
    expect(screen.queryByText(/stalled/i)).not.toBeInTheDocument()
  })

  it('hides done columns from heatmap when done_columns is populated', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do', 'Done'],
      done_columns: ['Done'],
      swimlanes: [
        {
          id: 1, name: 'Customer A',
          avg_days_per_column: { 'To Do': 5 },
          is_outlier: { 'To Do': false },
          deal_velocity_days: null,
          stalled_cards: [],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="member" />)
    await screen.findByText('To Do')
    expect(screen.queryByRole('columnheader', { name: 'Done' })).not.toBeInTheDocument()
  })

  it('shows done columns footer note when done_columns is non-empty', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do', 'Done'],
      done_columns: ['Done'],
      swimlanes: [],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="member" />)
    expect(await screen.findByText('1 done column not shown')).toBeInTheDocument()
  })

  it('shows plural footer note for multiple done columns', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do', 'Won', 'Lost'],
      done_columns: ['Won', 'Lost'],
      swimlanes: [],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="member" />)
    expect(await screen.findByText('2 done columns not shown')).toBeInTheDocument()
  })

  it('shows no footer note when done_columns is empty', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do', 'Done'],
      done_columns: [],
      swimlanes: [],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="member" />)
    await screen.findByRole('button', { name: 'Age' })
    expect(screen.queryByText(/done column/i)).not.toBeInTheDocument()
  })

  it('shows no footer note when done_columns is absent (backward compat)', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do', 'Done'],
      swimlanes: [],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="member" />)
    await screen.findByRole('button', { name: 'Age' })
    expect(screen.queryByText(/done column/i)).not.toBeInTheDocument()
  })

  it('shows actual dwell value without ≥ prefix (#575 regression guard)', async () => {
    // Regression guard: the ≥Nd cap introduced by #327 caused all heatmap cells to show
    // "≥30d" even when the actual dwell was shorter. After #575, actual timestamps are used.
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [
        {
          id: 1, name: 'Customer A',
          avg_days_per_column: { 'To Do': 30 },
          is_outlier: { 'To Do': false },
          age_avg_days_per_column: { 'To Do': 30 },
          age_is_outlier: { 'To Do': false },
          deal_velocity_days: null,
          stalled_cards: [],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    await screen.findByText('Customer A')
    expect(screen.getByText('30d')).toBeInTheDocument()
    expect(screen.queryByText('≥30d')).not.toBeInTheDocument()
  })

  it('renders a beta notice strip with "Beta" label and guidance text when analytics loads successfully', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: [],
      swimlanes: [],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="member" />)
    // Wait for the success state — the mode toggle is only rendered after data loads.
    await screen.findByRole('button', { name: 'Age' })
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText(/Analytics data may be incomplete in some configurations/)).toBeInTheDocument()
  })
})
