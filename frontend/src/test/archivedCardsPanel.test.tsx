import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ArchivedCardsPanel from '../components/Board/ArchivedCardsPanel'
import type { BoardFull, Card } from '../types'
import type { ArchivedCardsPage } from '../api/cards'

vi.mock('../api/cards', () => ({
  getArchivedCards: vi.fn(),
  unarchiveCard: vi.fn(),
}))

import { getArchivedCards, unarchiveCard } from '../api/cards'
const mockGetArchivedCards = getArchivedCards as ReturnType<typeof vi.fn>
const mockUnarchiveCard = unarchiveCard as ReturnType<typeof vi.fn>

const fakeBoard: BoardFull = {
  id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
  columns: [
    { id: 10, uid: 'coluid000001', name: 'Backlog', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
  ],
  swimlanes: [
    { id: 20, uid: 'laneuid00001', name: 'General', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '' },
  ],
  cards: [],
  labels: [],
  members: [],
  staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
  enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, is_starred: false, created_at: '', updated_at: '', current_user_role: 'admin',
  owner: { id: 1, username: 'jdoe', display_name: 'Jane Doe', avatar_url: '' },
  capabilities: { movement_export: false },
}

const archivedCard: Card = {
  id: 99, uid: 'carduid00099', column: 10, swimlane: 20,
  title: 'Old feature', description: '', priority: 'medium',
  assignee: null, labels: [], due_date: null, weight: 1, position: 0,
  created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
  last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
  is_stale: false, archived_at: '2024-02-01T00:00:00Z', version: 1,
}

const makePage = (cards: Card[], total?: number): ArchivedCardsPage => ({
  count: total ?? cards.length,
  offset: 0,
  page_size: 50,
  results: cards,
})

describe('ArchivedCardsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows loading state while fetching', async () => {
    // Never resolve so we stay in loading
    mockGetArchivedCards.mockReturnValue(new Promise(() => {}))
    render(<ArchivedCardsPanel board={fakeBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
    expect(screen.getByText(/Loading/)).toBeInTheDocument()
  })

  it('shows archived cards after fetch', async () => {
    mockGetArchivedCards.mockResolvedValue(makePage([archivedCard]))
    render(<ArchivedCardsPanel board={fakeBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Old feature')).toBeInTheDocument())
  })

  it('shows column and swimlane name for each card', async () => {
    mockGetArchivedCards.mockResolvedValue(makePage([archivedCard]))
    render(<ArchivedCardsPanel board={fakeBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/Backlog/)).toBeInTheDocument())
    expect(screen.getByText(/General/)).toBeInTheDocument()
  })

  it('shows empty state when no archived cards', async () => {
    mockGetArchivedCards.mockResolvedValue(makePage([]))
    render(<ArchivedCardsPanel board={fakeBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/No archived cards/)).toBeInTheDocument())
  })

  it('fetches using the board id', async () => {
    mockGetArchivedCards.mockResolvedValue(makePage([]))
    render(<ArchivedCardsPanel board={fakeBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
    await waitFor(() => expect(mockGetArchivedCards).toHaveBeenCalledWith(1, 0))
  })

  it('shows load-more button when total exceeds page', async () => {
    mockGetArchivedCards.mockResolvedValue(makePage([archivedCard], 75))
    render(<ArchivedCardsPanel board={fakeBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/Load more/)).toBeInTheDocument())
  })

  it('does not show load-more button when all results fit in one page', async () => {
    mockGetArchivedCards.mockResolvedValue(makePage([archivedCard]))
    render(<ArchivedCardsPanel board={fakeBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
    await waitFor(() => screen.getByText('Old feature'))
    expect(screen.queryByText(/Load more/)).not.toBeInTheDocument()
  })

  it('calls onUnarchived and removes card from list after restore', async () => {
    mockGetArchivedCards.mockResolvedValue(makePage([archivedCard]))
    const restoredCard: Card = { ...archivedCard, archived_at: null }
    mockUnarchiveCard.mockResolvedValue(restoredCard)
    const onUnarchived = vi.fn()

    render(<ArchivedCardsPanel board={fakeBoard} onClose={vi.fn()} onUnarchived={onUnarchived} />)
    await waitFor(() => screen.getByText('Old feature'))

    await userEvent.click(screen.getByText('Unarchive'))

    await waitFor(() => expect(onUnarchived).toHaveBeenCalledWith(restoredCard))
    expect(screen.queryByText('Old feature')).not.toBeInTheDocument()
  })

  it('calls onClose when the close button is clicked', async () => {
    mockGetArchivedCards.mockResolvedValue(makePage([]))
    const onClose = vi.fn()
    render(<ArchivedCardsPanel board={fakeBoard} onClose={onClose} onUnarchived={vi.fn()} />)
    await waitFor(() => screen.getByLabelText('Close'))
    await userEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when backdrop is clicked', async () => {
    mockGetArchivedCards.mockResolvedValue(makePage([]))
    const onClose = vi.fn()
    const { container } = render(
      <ArchivedCardsPanel board={fakeBoard} onClose={onClose} onUnarchived={vi.fn()} />
    )
    await waitFor(() => screen.getByText(/No archived cards/))
    // The backdrop is the absolute div behind the panel
    const backdrop = container.querySelector('.absolute.inset-0') as HTMLElement
    await userEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
