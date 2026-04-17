import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ShareBoardPage from '../pages/ShareBoardPage'
import type { BoardPublic } from '../types'

vi.mock('../api/boards', () => ({
  getPublicBoard: vi.fn(),
}))

import { getPublicBoard } from '../api/boards'
const mockGetPublicBoard = getPublicBoard as ReturnType<typeof vi.fn>

const fakeBoard: BoardPublic = {
  uid: 'shareuid01',
  name: 'My Shared Board',
  columns: [
    { id: 1, uid: 'col1', name: 'Todo', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: false, is_done: false },
    { id: 2, uid: 'col2', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: false, is_done: false },
  ],
  swimlanes: [
    { id: 10, uid: 'lane1', name: 'Customer A', position: 0, color: '#3B82F6', is_collapsed: false, created_at: '' },
  ],
  labels: [
    { id: 100, uid: 'lbl1', name: 'Bug', color: '#EF4444' },
  ],
  cards: [
    {
      uid: 'card1',
      column: 1,
      swimlane: 10,
      title: 'Fix login bug',
      priority: 'high',
      assignee: { display_name: 'Alice' },
      labels: [{ id: 100, uid: 'lbl1', name: 'Bug', color: '#EF4444' }],
      due_date: null,
      weight: 1,
      position: 0,
      last_moved_at: null,
      checklist_total: 0,
      checklist_done: 0,
      is_stale: false,
    },
  ],
}

function renderSharePage(token = 'valid-token-abc') {
  return render(
    <MemoryRouter initialEntries={[`/share/${token}`]}>
      <Routes>
        <Route path="/share/:token" element={<ShareBoardPage />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('ShareBoardPage — valid token', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPublicBoard.mockResolvedValue(fakeBoard)
  })

  it('renders the share board page with the board name', async () => {
    renderSharePage()
    await waitFor(() => expect(screen.getByTestId('share-board-page')).toBeInTheDocument())
    expect(screen.getByText('My Shared Board')).toBeInTheDocument()
  })

  it('renders the "View only" badge', async () => {
    renderSharePage()
    await waitFor(() => expect(screen.getByText('View only')).toBeInTheDocument())
  })

  it('renders a card from the board', async () => {
    renderSharePage()
    await waitFor(() => expect(screen.getByText('Fix login bug')).toBeInTheDocument())
  })

  it('renders column headers', async () => {
    renderSharePage()
    await waitFor(() => {
      expect(screen.getByText('Todo')).toBeInTheDocument()
      expect(screen.getByText('Done')).toBeInTheDocument()
    })
  })

  it('calls getPublicBoard with the token from the URL', async () => {
    renderSharePage('abc123tok')
    await waitFor(() => expect(mockGetPublicBoard).toHaveBeenCalledWith('abc123tok'))
  })

  it('renders card with readOnly (no drag handles — data-testid present)', async () => {
    renderSharePage()
    await waitFor(() => {
      const cards = screen.getAllByTestId('share-card')
      expect(cards.length).toBeGreaterThan(0)
    })
  })

  it('does not show stale indicator when is_stale is false', async () => {
    renderSharePage()
    await waitFor(() => expect(screen.getByText('Fix login bug')).toBeInTheDocument())
    expect(screen.queryByLabelText('Stale')).not.toBeInTheDocument()
  })

  it('does not show stale indicator even when is_stale is true (removed from share page)', async () => {
    // The amber dot was removed from the share page per spec — aging tint is board-view-only.
    mockGetPublicBoard.mockResolvedValue({
      ...fakeBoard,
      cards: [{ ...fakeBoard.cards[0], is_stale: true }],
    })
    renderSharePage()
    await waitFor(() => expect(screen.getByText('Fix login bug')).toBeInTheDocument())
    expect(screen.queryByLabelText('Stale')).not.toBeInTheDocument()
  })
})

describe('ShareBoardPage — expired/invalid token', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPublicBoard.mockRejectedValue(new Error('404'))
  })

  it('renders the expired page on 404', async () => {
    renderSharePage('revoked-token')
    await waitFor(() => expect(screen.getByTestId('share-expired-page')).toBeInTheDocument())
  })

  it('shows the correct heading on the expired page', async () => {
    renderSharePage('revoked-token')
    await waitFor(() =>
      expect(screen.getByText('This board is no longer shared')).toBeInTheDocument()
    )
  })

  it('shows sign in link on expired page', async () => {
    renderSharePage('revoked-token')
    await waitFor(() =>
      expect(screen.getByText('Sign in to Visiban')).toBeInTheDocument()
    )
  })
})
