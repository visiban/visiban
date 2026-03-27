import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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
})

describe('AnalyticsView', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows loading state', () => {
    mockGetBoardAnalytics.mockReturnValue(new Promise(() => {}))
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    expect(screen.getByText(/Loading analytics/)).toBeInTheDocument()
  })

  it('shows error on failure', async () => {
    mockGetBoardAnalytics.mockRejectedValue(new Error('fail'))
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    expect(await screen.findByText('Failed to load analytics.')).toBeInTheDocument()
  })

  it('renders analytics with period buttons', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do', 'Done'],
      swimlanes: [
        {
          id: 1, name: 'Customer A',
          avg_days_per_column: { 'To Do': 5, 'Done': 1 },
          is_outlier: { 'To Do': true, 'Done': false },
          deal_velocity_days: 6,
          stalled_cards: [],
        },
      ],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)

    expect(await screen.findByText('Customer A')).toBeInTheDocument()
    expect(screen.getByText('7d')).toBeInTheDocument()
    expect(screen.getByText('30d')).toBeInTheDocument()
    expect(screen.getByText('90d')).toBeInTheDocument()
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
    // '7d' also appears as a period button — assert at least one instance exists
    expect(screen.getAllByText('7d').length).toBeGreaterThanOrEqual(1)
    // Null cell renders em-dash
    expect(screen.getByText('—')).toBeInTheDocument()
    // Velocity
    expect(screen.getByText('10d')).toBeInTheDocument()
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
    await screen.findByText('Period:')
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
    expect(screen.getByText('14d stalled')).toBeInTheDocument()
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

  it('changes period on button click', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: [],
      swimlanes: [],
      stalled_threshold_days: 7,
      staleness_threshold_days: 14,
      stale_warning_pct: 50,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    await screen.findByText('Period:')
    await userEvent.setup().click(screen.getByText('7d'))
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
    expect(cell.className).toMatch(/red/)
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
    expect(cell.className).toMatch(/yellow/)
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
    expect(cell.className).toMatch(/green/)
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
    await screen.findByText('Period:')
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
    await screen.findByText('Period:')
    expect(screen.queryByText(/done column/i)).not.toBeInTheDocument()
  })

  it('shows capped value with ≥ prefix when avg equals period length', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      swimlanes: [
        {
          id: 1, name: 'Customer A',
          avg_days_per_column: { 'To Do': 30 },
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
    expect(await screen.findByText('≥30d')).toBeInTheDocument()
  })
})
