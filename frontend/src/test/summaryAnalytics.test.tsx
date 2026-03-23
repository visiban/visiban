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
        },
      ],
    })
    render(<SummaryView boardId={1} columns={['To Do', 'Done']} />)

    expect(await screen.findByText('Customer A')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('8')).toBeInTheDocument()
  })

  it('renders column headers', async () => {
    mockGetBoardSummary.mockResolvedValue({ swimlanes: [] })
    render(<SummaryView boardId={1} columns={['To Do', 'Done']} />)

    expect(await screen.findByText('Swimlane')).toBeInTheDocument()
    expect(screen.getByText('Cards')).toBeInTheDocument()
    expect(screen.getByText('7d Velocity')).toBeInTheDocument()
    expect(screen.getByText('30d Velocity')).toBeInTheDocument()
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
      board_medians: { 'To Do': 3, 'Done': 1 },
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
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)

    expect(await screen.findByText('Customer A')).toBeInTheDocument()
    expect(screen.getByText('7d')).toBeInTheDocument()
    expect(screen.getByText('30d')).toBeInTheDocument()
    expect(screen.getByText('90d')).toBeInTheDocument()
  })

  it('shows export CSV button for admins', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: [],
      board_medians: {},
      swimlanes: [],
      stalled_threshold_days: 7,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    expect(await screen.findByText('Export CSV')).toBeInTheDocument()
  })

  it('hides export CSV button for non-admins', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: [],
      board_medians: {},
      swimlanes: [],
      stalled_threshold_days: 7,
    })
    render(<AnalyticsView boardId={1} currentUserRole="member" />)
    await screen.findByText('Period:')
    expect(screen.queryByText('Export CSV')).not.toBeInTheDocument()
  })

  it('shows stalled cards section', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      board_medians: { 'To Do': 3 },
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
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    expect(await screen.findByText('Stale Card')).toBeInTheDocument()
    expect(screen.getByText('14d stalled')).toBeInTheDocument()
  })

  it('calls onOpenCard when a stalled card row is clicked', async () => {
    mockGetBoardAnalytics.mockResolvedValue({
      days: 30,
      columns: ['To Do'],
      board_medians: { 'To Do': 3 },
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
      board_medians: {},
      swimlanes: [],
      stalled_threshold_days: 7,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    await screen.findByText('Period:')
    await userEvent.setup().click(screen.getByText('7d'))
    expect(mockGetBoardAnalytics).toHaveBeenCalledWith(1, 7)
  })
})
