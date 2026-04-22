import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import MovementHistoryView from '../components/Board/MovementHistoryView'
import type { BoardFull, CardMovement } from '../types'

vi.mock('../api/boards', () => ({
  getBoardMovements: vi.fn(),
}))

import { getBoardMovements } from '../api/boards'

const mockGetBoardMovements = getBoardMovements as ReturnType<typeof vi.fn>

const mockBoard: BoardFull = {
  id: 1,
  uid: 'abc123',
  name: 'Test Board',
  description: '',
  group: null,
  group_name: null,
  columns: [
    { id: 1, uid: 'c1', name: 'To Do', position: 0, color: '#6B7280', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
    { id: 2, uid: 'c2', name: 'Done', position: 1, color: '#22C55E', wip_limit: null, weight_limit: null, allow_card_creation: false, is_done: true },
  ],
  swimlanes: [
    { id: 1, uid: 's1', name: 'Customer A', position: 0, color: '#3B82F6', is_collapsed: false, created_at: '2024-01-01T00:00:00Z' },
  ],
  cards: [],
  labels: [],
  members: [
    {
      id: 1,
      role: 'admin',
      is_moderator: false,
      joined_at: '2024-01-01T00:00:00Z',
      user: { id: 10, username: 'admin', avatar_url: '', display_name: 'Admin User' },
    },
  ],
  staleness_threshold_days: 7,
  stale_warning_pct: 50,
  allowed_priorities: [],
  enforce_wip_limits: true,
  enforce_wip_hard: false,
  enforce_weight_limits: true, export_min_role: 'viewer',
  is_starred: false,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  current_user_role: 'admin',
  owner: { id: 10, username: 'admin', display_name: 'Admin User', avatar_url: '' },
  capabilities: { movement_export: false },
  share_token: null,
}

function makeMv(overrides: Partial<CardMovement> = {}): CardMovement {
  return {
    id: 1,
    card_title: 'Test Card',
    card_uid: 'card-uid-1',
    from_column: 1,
    from_column_name: 'To Do',
    from_column_uid: 'c1',
    to_column: 2,
    to_column_name: 'Done',
    to_column_uid: 'c2',
    from_swimlane: 1,
    from_swimlane_name: 'Customer A',
    from_swimlane_uid: 's1',
    to_swimlane: 1,
    to_swimlane_name: 'Customer A',
    to_swimlane_uid: 's1',
    moved_by: { id: 10, username: 'admin', avatar_url: '', display_name: 'Admin User' },
    moved_at: '2024-03-01T12:00:00Z',
    notes: '',
    movement_type: 'move',
    ...overrides,
  }
}

function renderHistory(board = mockBoard) {
  return render(
    <MemoryRouter initialEntries={['/boards/1?view=history']}>
      <MovementHistoryView board={board} />
    </MemoryRouter>
  )
}

describe('MovementHistoryView', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows loading state while fetching', () => {
    mockGetBoardMovements.mockReturnValue(new Promise(() => {}))
    renderHistory()
    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
  })

  it('shows error on fetch failure', async () => {
    mockGetBoardMovements.mockRejectedValue(new Error('fail'))
    renderHistory()
    expect(await screen.findByText('Failed to load movement history.')).toBeInTheDocument()
  })

  it('renders movement events', async () => {
    mockGetBoardMovements.mockResolvedValue({
      count: 1, offset: 0, page_size: 50,
      results: [makeMv()],
    })
    renderHistory()
    expect(await screen.findByText('Test Card')).toBeInTheDocument()
    expect(screen.getByText(/To Do →/)).toBeInTheDocument()
  })

  it('shows empty state when no results', async () => {
    mockGetBoardMovements.mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] })
    renderHistory()
    expect(await screen.findByText(/No card movements recorded yet/)).toBeInTheDocument()
  })

  it('renders archived event with italic label', async () => {
    mockGetBoardMovements.mockResolvedValue({
      count: 1, offset: 0, page_size: 50,
      results: [makeMv({ movement_type: 'archived', id: 2 })],
    })
    renderHistory()
    expect(await screen.findByText('Archived')).toBeInTheDocument()
  })

  it('renders unarchived event with Reactivated label', async () => {
    mockGetBoardMovements.mockResolvedValue({
      count: 1, offset: 0, page_size: 50,
      results: [makeMv({ movement_type: 'unarchived', id: 3 })],
    })
    renderHistory()
    expect(await screen.findByText('Reactivated')).toBeInTheDocument()
  })

  it('clicking a row opens the slide-in panel', async () => {
    mockGetBoardMovements.mockResolvedValue({
      count: 1, offset: 0, page_size: 50,
      results: [makeMv()],
    })
    renderHistory()
    const row = await screen.findByText('Test Card')
    await userEvent.setup().click(row)
    // Panel heading matches card title
    expect(screen.getAllByText('Test Card').length).toBeGreaterThan(1)
    expect(screen.getByRole('complementary', { name: 'Movement detail' })).toBeInTheDocument()
  })

  it('closes the slide-in panel on close button click', async () => {
    mockGetBoardMovements.mockResolvedValue({
      count: 1, offset: 0, page_size: 50,
      results: [makeMv()],
    })
    renderHistory()
    const row = await screen.findByText('Test Card')
    const user = userEvent.setup()
    await user.click(row)
    const closeBtn = screen.getByRole('button', { name: 'Close panel' })
    await user.click(closeBtn)
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })

  it('does not show Export button when capabilities.movement_export is false', async () => {
    mockGetBoardMovements.mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] })
    renderHistory()
    await screen.findByText(/No card movements recorded yet/)
    expect(screen.queryByText('Export')).not.toBeInTheDocument()
  })

  it('shows Export button when capabilities.movement_export is true', async () => {
    const boardWithExport = { ...mockBoard, capabilities: { movement_export: true } }
    mockGetBoardMovements.mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] })
    renderHistory(boardWithExport)
    await screen.findByText(/No card movements recorded yet/)
    expect(screen.getByText('Export')).toBeInTheDocument()
  })

  it('shows pagination when there are more results than page size', async () => {
    mockGetBoardMovements.mockResolvedValue({
      count: 60, offset: 0, page_size: 50,
      results: Array.from({ length: 50 }, (_, i) => makeMv({ id: i + 1, card_title: `Card ${i + 1}` })),
    })
    renderHistory()
    await screen.findByText('Card 1')
    expect(screen.getByText(/Next/)).toBeInTheDocument()
  })

  it('shows count line with total count', async () => {
    mockGetBoardMovements.mockResolvedValue({
      count: 3, offset: 0, page_size: 50,
      results: [makeMv()],
    })
    renderHistory()
    expect(await screen.findByText('3 events found')).toBeInTheDocument()
  })

  it('filter bar renders swimlane, column, and assignee dropdowns', async () => {
    mockGetBoardMovements.mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] })
    renderHistory()
    await screen.findByText(/No card movements recorded yet/)
    expect(screen.getByText('Swimlane')).toBeInTheDocument()
    expect(screen.getByText('Column')).toBeInTheDocument()
    expect(screen.getByText('User')).toBeInTheDocument()
  })

  it('Clear filters button appears when a filter is active', async () => {
    mockGetBoardMovements.mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] })
    render(
      <MemoryRouter initialEntries={['/boards/1?view=history&column_id=2']}>
        <MovementHistoryView board={mockBoard} />
      </MemoryRouter>
    )
    await screen.findByText(/No movements match the current filters/)
    expect(screen.getByText('Clear filters')).toBeInTheDocument()
  })
})
