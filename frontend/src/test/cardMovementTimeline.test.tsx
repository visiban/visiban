import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CardMovementTimeline from '../components/Card/CardMovementTimeline'

vi.mock('../api/cards', () => ({
  getCardMovements: vi.fn(),
  getCardActivities: vi.fn(),
}))

import { getCardMovements, getCardActivities } from '../api/cards'

const mockGetMovements = getCardMovements as ReturnType<typeof vi.fn>
const mockGetActivities = getCardActivities as ReturnType<typeof vi.fn>

const fakeUser = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false,
}

describe('CardMovementTimeline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Clear the show-full-history preference so each test starts from the default
    // off state regardless of what a previous test toggled.
    localStorage.removeItem('user:prefs:show-full-history')
  })

  it('shows loading state', () => {
    mockGetMovements.mockReturnValue(new Promise(() => {}))
    mockGetActivities.mockReturnValue(new Promise(() => {}))
    render(<CardMovementTimeline boardId={1} cardId={1} />)
    expect(screen.getByText('Loading history…')).toBeInTheDocument()
  })

  it('shows empty state', async () => {
    mockGetMovements.mockResolvedValue([])
    mockGetActivities.mockResolvedValue([])
    render(<CardMovementTimeline boardId={1} cardId={1} />)
    await waitFor(() => {
      expect(screen.getByText('No activity yet.')).toBeInTheDocument()
    })
  })

  it('renders "Created in" for initial move', async () => {
    mockGetMovements.mockResolvedValue([
      { id: 1, from_column: null, from_column_name: null, from_column_uid: '', to_column: 10, to_column_name: 'To Do', to_column_uid: 'c1', from_swimlane: null, from_swimlane_name: null, from_swimlane_uid: '', to_swimlane: 20, to_swimlane_name: 'Customer A', to_swimlane_uid: 's1', moved_by: fakeUser, moved_at: '2026-01-01T00:00:00Z', notes: '', movement_type: 'move' as const },
    ])
    mockGetActivities.mockResolvedValue([])
    render(<CardMovementTimeline boardId={1} cardId={1} />)
    await waitFor(() => {
      expect(screen.getByText('Created in To Do')).toBeInTheDocument()
      expect(screen.getByText('by Jane Doe')).toBeInTheDocument()
    })
  })

  it('renders column transitions', async () => {
    mockGetMovements.mockResolvedValue([
      { id: 1, from_column: null, from_column_name: null, from_column_uid: '', to_column: 10, to_column_name: 'To Do', to_column_uid: 'c1', from_swimlane: null, from_swimlane_name: null, from_swimlane_uid: '', to_swimlane: 20, to_swimlane_name: 'A', to_swimlane_uid: 's1', moved_by: fakeUser, moved_at: '2026-01-01T00:00:00Z', notes: '', movement_type: 'move' as const },
      { id: 2, from_column: 10, from_column_name: 'To Do', from_column_uid: 'c1', to_column: 11, to_column_name: 'In Progress', to_column_uid: 'c2', from_swimlane: 20, from_swimlane_name: 'A', from_swimlane_uid: 's1', to_swimlane: 20, to_swimlane_name: 'A', to_swimlane_uid: 's1', moved_by: fakeUser, moved_at: '2026-01-02T00:00:00Z', notes: '', movement_type: 'move' as const },
    ])
    mockGetActivities.mockResolvedValue([])
    render(<CardMovementTimeline boardId={1} cardId={1} />)
    await waitFor(() => {
      expect(screen.getByText('To Do → In Progress')).toBeInTheDocument()
    })
  })

  it('shows time spent between moves', async () => {
    mockGetMovements.mockResolvedValue([
      { id: 1, from_column: null, from_column_name: null, from_column_uid: '', to_column: 10, to_column_name: 'To Do', to_column_uid: 'c1', from_swimlane: null, from_swimlane_name: null, from_swimlane_uid: '', to_swimlane: 20, to_swimlane_name: 'A', to_swimlane_uid: 's1', moved_by: null, moved_at: '2026-01-01T00:00:00Z', notes: '', movement_type: 'move' as const },
      { id: 2, from_column: 10, from_column_name: 'To Do', from_column_uid: 'c1', to_column: 11, to_column_name: 'In Progress', to_column_uid: 'c2', from_swimlane: 20, from_swimlane_name: 'A', from_swimlane_uid: 's1', to_swimlane: 20, to_swimlane_name: 'A', to_swimlane_uid: 's1', moved_by: null, moved_at: '2026-01-03T00:00:00Z', notes: '', movement_type: 'move' as const },
      { id: 3, from_column: 11, from_column_name: 'In Progress', from_column_uid: 'c2', to_column: 12, to_column_name: 'Done', to_column_uid: 'c3', from_swimlane: 20, from_swimlane_name: 'A', from_swimlane_uid: 's1', to_swimlane: 20, to_swimlane_name: 'A', to_swimlane_uid: 's1', moved_by: null, moved_at: '2026-01-05T00:00:00Z', notes: '', movement_type: 'move' as const },
    ])
    mockGetActivities.mockResolvedValue([])
    render(<CardMovementTimeline boardId={1} cardId={1} />)
    await waitFor(() => {
      expect(screen.getByText('Spent 2d here')).toBeInTheDocument()
    })
  })

  it('shows swimlane change', async () => {
    mockGetMovements.mockResolvedValue([
      { id: 1, from_column: 10, from_column_name: 'To Do', from_column_uid: 'c1', to_column: 10, to_column_name: 'To Do', to_column_uid: 'c1', from_swimlane: 20, from_swimlane_name: 'Customer A', from_swimlane_uid: 's1', to_swimlane: 21, to_swimlane_name: 'Customer B', to_swimlane_uid: 's2', moved_by: null, moved_at: '2026-01-01T00:00:00Z', notes: '', movement_type: 'move' as const },
    ])
    mockGetActivities.mockResolvedValue([])
    render(<CardMovementTimeline boardId={1} cardId={1} />)
    await waitFor(() => {
      expect(screen.getByText('(Customer A → Customer B)')).toBeInTheDocument()
    })
  })

  it('hides activities by default but shows them when Show full history is checked', async () => {
    mockGetMovements.mockResolvedValue([])
    mockGetActivities.mockResolvedValue([
      { id: 1, event_type: 'priority_change', from_value: 'low', to_value: 'high', actor: fakeUser, created_at: '2026-01-01T00:00:00Z' },
    ])
    render(<CardMovementTimeline boardId={1} cardId={1} />)
    // With activities but no moves, the timeline renders but visible list is empty
    await waitFor(() => {
      expect(screen.getByText('Show full history')).toBeInTheDocument()
    })
    // Activity not shown by default
    expect(screen.queryByText(/Priority/)).not.toBeInTheDocument()
    // Toggle show all
    await userEvent.setup().click(screen.getByText('Show full history'))
    expect(screen.getByText('Priority: low → high')).toBeInTheDocument()
  })

  it('shows deleted column name in italic red when column id is not in columnIds', async () => {
    mockGetMovements.mockResolvedValue([
      { id: 1, from_column: 10, from_column_name: 'Old Column', from_column_uid: 'c1', to_column: 11, to_column_name: 'In Progress', to_column_uid: 'c2', from_swimlane: 20, from_swimlane_name: 'A', from_swimlane_uid: 's1', to_swimlane: 20, to_swimlane_name: 'A', to_swimlane_uid: 's1', moved_by: null, moved_at: '2026-01-01T00:00:00Z', notes: '', movement_type: 'move' as const },
    ])
    mockGetActivities.mockResolvedValue([])
    // columnIds only contains 11 (In Progress) — column 10 (Old Column) is deleted
    render(<CardMovementTimeline boardId={1} cardId={1} columnIds={new Set([11])} />)
    await waitFor(() => {
      const deleted = screen.getByTitle('This column has been deleted')
      expect(deleted).toBeInTheDocument()
      expect(deleted.textContent).toBe('Deleted — Old Column')
      expect(deleted.className).toContain('italic')
      expect(deleted.className).toContain('text-red-400')
    })
  })

  it('shows deleted column name in italic red when column id is null but name is preserved (FK nulled by backend)', async () => {
    // This covers the real-world case: column deleted → FK set to null by DB,
    // but to_column_name is preserved as a model field.
    mockGetMovements.mockResolvedValue([
      { id: 1, from_column: 10, from_column_name: 'To Do', to_column: null, to_column_name: 'Deleted Col', from_swimlane: 20, from_swimlane_name: 'A', to_swimlane: 20, to_swimlane_name: 'A', moved_by: null, moved_at: '2026-01-01T00:00:00Z', notes: '' },
    ])
    mockGetActivities.mockResolvedValue([])
    render(<CardMovementTimeline boardId={1} cardId={1} columnIds={new Set([10])} />)
    await waitFor(() => {
      const deleted = screen.getByTitle('This column has been deleted')
      expect(deleted.textContent).toBe('Deleted — Deleted Col')
    })
  })

  it('shows column name normally when column still exists', async () => {
    mockGetMovements.mockResolvedValue([
      { id: 1, from_column: 10, from_column_name: 'To Do', to_column: 11, to_column_name: 'In Progress', from_swimlane: 20, from_swimlane_name: 'A', to_swimlane: 20, to_swimlane_name: 'A', moved_by: null, moved_at: '2026-01-01T00:00:00Z', notes: '' },
    ])
    mockGetActivities.mockResolvedValue([])
    render(<CardMovementTimeline boardId={1} cardId={1} columnIds={new Set([10, 11])} />)
    await waitFor(() => {
      expect(screen.queryByTitle('This column has been deleted')).not.toBeInTheDocument()
    })
  })

  it('renders activity entries after toggling show all', async () => {
    mockGetMovements.mockResolvedValue([
      { id: 1, from_column: null, from_column_name: null, to_column: 10, to_column_name: 'To Do', from_swimlane: null, from_swimlane_name: null, to_swimlane: 20, to_swimlane_name: 'A', moved_by: null, moved_at: '2026-01-01T00:00:00Z', notes: '' },
    ])
    mockGetActivities.mockResolvedValue([
      { id: 1, event_type: 'priority_change', from_value: 'low', to_value: 'high', actor: fakeUser, created_at: '2026-01-02T00:00:00Z' },
    ])
    render(<CardMovementTimeline boardId={1} cardId={1} />)
    await waitFor(() => {
      expect(screen.getByText('Created in To Do')).toBeInTheDocument()
    })
    // Activity not shown by default
    expect(screen.queryByText(/Priority: low → high/)).not.toBeInTheDocument()
    // Toggle show all
    await userEvent.setup().click(screen.getByText('Show full history'))
    expect(screen.getByText('Priority: low → high')).toBeInTheDocument()
  })
})
