import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import MovementHistoryView from '../components/Board/MovementHistoryView'
import type { BoardFull, CardMovement } from '../types'

vi.mock('../api/boards', () => ({
  getBoardMovements: vi.fn(),
}))

import { getBoardMovements } from '../api/boards'
const mockGetMovements = getBoardMovements as ReturnType<typeof vi.fn>

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeBoard = {
  id: 1,
  uid: 'board1',
  name: 'Test Board',
  columns: [
    { id: 10, uid: 'c1', name: 'Todo', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
    { id: 11, uid: 'c2', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: false, is_done: true },
  ],
  swimlanes: [
    { id: 20, uid: 's1', name: 'Acme', position: 0, color: '#6366F1', is_collapsed: false, created_at: '' },
    { id: 21, uid: 's2', name: 'Globex', position: 1, color: '#EC4899', is_collapsed: false, created_at: '' },
  ],
  members: [
    { id: null, user: { id: 5, username: 'alice', display_name: 'Alice', avatar_url: '' }, role: 'admin' as const, joined_at: '' },
  ],
  cards: [],
  labels: [],
  description: '',
  group: null,
  group_name: null,
  staleness_threshold_days: 7,
  stale_warning_pct: 50,
  allowed_priorities: ['low', 'medium', 'high', 'urgent'] as const,
  enforce_wip_limits: false,
  enforce_wip_hard: false,
  enforce_weight_limits: false,
  is_starred: false,
  created_at: '',
  updated_at: '',
  current_user_role: 'admin' as const,
  share_token: null,
} as unknown as BoardFull

function makeMovement(overrides: Partial<CardMovement> = {}): CardMovement {
  return {
    id: 1,
    card_uid: 'card-uid-1',
    card_title: 'Fix login bug',
    from_column: 10,
    from_column_name: 'Todo',
    from_column_uid: 'c1',
    to_column: 11,
    to_column_name: 'Done',
    to_column_uid: 'c2',
    from_swimlane: 20,
    from_swimlane_name: 'Acme',
    from_swimlane_uid: 's1',
    to_swimlane: 20,
    to_swimlane_name: 'Acme',
    to_swimlane_uid: 's1',
    moved_by: { id: 5, username: 'alice', display_name: 'Alice', avatar_url: '' },
    moved_at: '2026-03-20T10:00:00Z',
    notes: '',
    movement_type: 'move',
    ...overrides,
  }
}

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/boards/1?view=history']}>
      <MovementHistoryView board={fakeBoard} />
    </MemoryRouter>
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MovementHistoryView — empty state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMovements.mockResolvedValue({ results: [], count: 0 })
  })

  it('shows empty state message', async () => {
    renderView()
    await waitFor(() =>
      expect(screen.getByText('No card movements recorded yet.')).toBeInTheDocument()
    )
  })
})

describe('MovementHistoryView — with data', () => {
  const movement = makeMovement()

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMovements.mockResolvedValue({ results: [movement], count: 1 })
  })

  it('renders card title and movement columns', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('Fix login bug')).toBeInTheDocument())
    expect(screen.getAllByText('Done').length).toBeGreaterThan(0)
  })

  it('shows count line with total count', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('1 events found')).toBeInTheDocument())
  })

  it('Prev button is disabled on first page', async () => {
    renderView()
    await waitFor(() => screen.getByText('← Prev'))
    expect(screen.getByText('← Prev').closest('button')).toBeDisabled()
  })

  it('Next button is disabled when only one page', async () => {
    renderView()
    await waitFor(() => screen.getByText('Next →'))
    expect(screen.getByText('Next →').closest('button')).toBeDisabled()
  })
})

describe('MovementHistoryView — filters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMovements.mockResolvedValue({ results: [makeMovement()], count: 1 })
  })

  it('passes swimlane_id param when swimlane filter is selected', async () => {
    renderView()
    await waitFor(() => screen.getAllByTestId('history-row'))

    // Open the Swimlane dropdown and pick "Acme"
    fireEvent.click(screen.getByText('Swimlane'))
    fireEvent.click(screen.getByText('Acme'))

    await waitFor(() =>
      expect(mockGetMovements).toHaveBeenCalledWith(
        fakeBoard.id,
        expect.objectContaining({ swimlane_id: '20' })
      )
    )
  })

  it('passes column_id param when column filter is selected', async () => {
    renderView()
    await waitFor(() => screen.getAllByTestId('history-row'))

    fireEvent.click(screen.getByRole('button', { name: /^Column/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Done' }))

    await waitFor(() =>
      expect(mockGetMovements).toHaveBeenCalledWith(
        fakeBoard.id,
        expect.objectContaining({ to_column_id: '11' })
      )
    )
  })

  it('passes user_id param when user filter is selected', async () => {
    renderView()
    await waitFor(() => screen.getAllByTestId('history-row'))

    fireEvent.click(screen.getByRole('button', { name: /^User/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alice' }))

    await waitFor(() =>
      expect(mockGetMovements).toHaveBeenCalledWith(
        fakeBoard.id,
        expect.objectContaining({ moved_by_id: '5' })
      )
    )
  })

  it('passes since param from date input', async () => {
    renderView()
    await waitFor(() => screen.getAllByTestId('history-row'))

    fireEvent.change(screen.getByLabelText('Since date'), { target: { value: '2026-01-01' } })

    await waitFor(() =>
      expect(mockGetMovements).toHaveBeenCalledWith(
        fakeBoard.id,
        expect.objectContaining({ moved_after: '2026-01-01' })
      )
    )
  })

  it('shows "Clear filters" button when filter is active and clears on click', async () => {
    renderView()
    await waitFor(() => screen.getAllByTestId('history-row'))

    fireEvent.click(screen.getByRole('button', { name: /^Column/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Done' }))

    await waitFor(() => expect(screen.getByText('Clear filters')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Clear filters'))

    await waitFor(() =>
      expect(mockGetMovements).toHaveBeenLastCalledWith(
        fakeBoard.id,
        expect.not.objectContaining({ to_column_id: '11' })
      )
    )
  })

  it('shows "No movements match the current filters." when filtered results are empty', async () => {
    mockGetMovements.mockResolvedValue({ results: [], count: 0 })
    renderView()
    // Apply a filter first so it shows filter-specific empty text
    await waitFor(() => screen.getByText('No card movements recorded yet.'))

    // Simulate filtered empty state by having data then filter returning 0
    mockGetMovements.mockResolvedValue({ results: [], count: 0 })
    fireEvent.click(screen.getByRole('button', { name: /^Column/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Done' }))

    await waitFor(() =>
      expect(screen.getByText('No movements match the current filters.')).toBeInTheDocument()
    )
  })
})

describe('MovementHistoryView — slide-in panel', () => {
  const movement = makeMovement()

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMovements.mockResolvedValue({ results: [movement], count: 1 })
  })

  it('opens slide-in panel on row click', async () => {
    renderView()
    const row = await waitFor(() => screen.getByTestId('history-row'))
    fireEvent.click(row)

    await waitFor(() =>
      expect(screen.getByRole('complementary', { name: 'Movement detail' })).toBeInTheDocument()
    )
    expect(screen.getByRole('heading', { name: 'Fix login bug' })).toBeInTheDocument()
  })

  it('closes slide-in panel when close button is clicked', async () => {
    renderView()
    const row = await waitFor(() => screen.getByTestId('history-row'))
    fireEvent.click(row)

    await waitFor(() => screen.getByRole('complementary', { name: 'Movement detail' }))
    fireEvent.click(screen.getByLabelText('Close panel'))

    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Movement detail' })).not.toBeInTheDocument()
    )
  })

  it('closes slide-in panel on Escape key', async () => {
    renderView()
    const row = await waitFor(() => screen.getByTestId('history-row'))
    fireEvent.click(row)
    await waitFor(() => screen.getByRole('complementary', { name: 'Movement detail' }))

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Movement detail' })).not.toBeInTheDocument()
    )
  })

  it('panel shows from/to column names', async () => {
    renderView()
    const row = await waitFor(() => screen.getByTestId('history-row'))
    fireEvent.click(row)

    await waitFor(() => screen.getByRole('complementary', { name: 'Movement detail' }))
    expect(screen.getAllByText('Todo').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Done').length).toBeGreaterThan(0)
  })
})

describe('MovementHistoryView — pagination', () => {
  // 51 items triggers page 2 being available.
  const movements = Array.from({ length: 50 }, (_, i) =>
    makeMovement({ id: i + 1, card_uid: `uid-${i}`, card_title: `Card ${i + 1}` })
  )

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMovements.mockResolvedValue({ results: movements, count: 110 })
  })

  it('shows correct item range and total', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('110 events found')).toBeInTheDocument())
  })

  it('Next button is enabled when more pages exist', async () => {
    renderView()
    await waitFor(() => screen.getByText('Next →'))
    expect(screen.getByText('Next →').closest('button')).not.toBeDisabled()
  })

  it('clicking Next requests page 2', async () => {
    renderView()
    await waitFor(() => screen.getByText('Next →'))
    fireEvent.click(screen.getByText('Next →'))

    await waitFor(() =>
      expect(mockGetMovements).toHaveBeenCalledWith(
        fakeBoard.id,
        expect.objectContaining({ offset: '50' })
      )
    )
  })
})
