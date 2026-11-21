import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
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
      blocker_count: 0,
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

  it('renders the "Shared view, read-only" pill', async () => {
    renderSharePage()
    await waitFor(() => expect(screen.getByText('Shared view, read-only')).toBeInTheDocument())
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

  it('renders full swimlane name without truncation', async () => {
    const longName = 'Mobile Application Relaunch - Phase Two'
    mockGetPublicBoard.mockResolvedValue({
      ...fakeBoard,
      swimlanes: [{ ...fakeBoard.swimlanes[0], name: longName }],
    })
    renderSharePage()
    await waitFor(() => expect(screen.getByText(longName)).toBeInTheDocument())
    const nameEl = screen.getByText(longName)
    expect(nameEl.className).not.toContain('truncate')
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
    mockGetPublicBoard.mockRejectedValue(Object.assign(new Error('404'), { response: { status: 404 } }))
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

// #2366 — a split stage renders its sub-columns and track names read-only.
describe('ShareBoardPage — gated stage and tracks (#2366)', () => {
  const card = (uid: string, gates: number | undefined, position: number, column = 1) => ({
    ...fakeBoard.cards[0], uid, title: uid, column, position, labels: [], assignee: null, gates_passed: gates,
  })
  const split: BoardPublic = {
    ...fakeBoard,
    columns: [
      {
        ...fakeBoard.columns[0],
        sub_columns: [
          { id: 201, uid: 's1', position: 1, name: 'Ready' },
          { id: 200, uid: 's0', position: 0, name: 'Doing' },
        ],
        tracks: [
          { id: 2, field_id: 8, field_uid: 'f8', name: 'Business', position: 1 },
          { id: 1, field_id: 7, field_uid: 'f7', name: 'Technical', position: 0 },
        ],
      },
      fakeBoard.columns[1],
    ],
    cards: [card('b-ready', 1, 0), card('a-doing-2', 0, 1), card('a-doing-1', 0, 0), card('plain', undefined, 0, 2)],
  } as BoardPublic

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPublicBoard.mockResolvedValue(split)
  })

  it('shows sub-column headers in position order with per-sub-column counts', async () => {
    renderSharePage()
    const headers = await screen.findAllByTestId('share-sub-column-header')
    expect(headers.map((h) => h.textContent)).toEqual(['Doing2, 2 cards', 'Ready1, 1 card'])
  })

  it('splits the cell by gates_passed, each list in position order', async () => {
    renderSharePage()
    const cells = await screen.findAllByTestId('share-sub-column-cell')
    expect(cells).toHaveLength(2)
    expect(Array.from(cells[0].querySelectorAll('[data-testid="share-card"]')).map((c) => c.querySelector('p')?.textContent)).toEqual(['a-doing-1', 'a-doing-2'])
    expect(cells[1]).toHaveTextContent('b-ready')
  })

  it('lists the stage tracks by name in order, with no state claimed', async () => {
    renderSharePage()
    const chips = await screen.findByTestId('share-track-chips')
    expect(Array.from(chips.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['Technical', 'Business'])
    expect(chips.querySelector('[data-track-state]')).toBeNull()
  })

  it('renders a plain column with no sub-column or track chrome', async () => {
    mockGetPublicBoard.mockResolvedValue(fakeBoard)
    renderSharePage()
    await screen.findByText('Fix login bug')
    expect(screen.queryByTestId('share-sub-columns')).toBeNull()
    expect(screen.queryByTestId('share-track-chips')).toBeNull()
    expect(screen.queryByTestId('share-split-cell')).toBeNull()
  })

  it('is read-only: no buttons, inputs or links in the split stage', async () => {
    renderSharePage()
    const list = await screen.findByTestId('share-sub-columns')
    expect(list.querySelectorAll('button, input, a')).toHaveLength(0)
  })
})

describe('ShareBoardPage on the shared look (#2480)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('says what the snapshot is, with lane and card counts', async () => {
    mockGetPublicBoard.mockResolvedValue(fakeBoard)
    renderSharePage()
    expect(await screen.findByTestId('share-board-summary')).toHaveTextContent(
      "1 lane · 1 card. A read-only snapshot of this board. Cards can't be opened or moved here. Reload to see the latest.",
    )
  })

  it('names the priority for screen readers on the card face', async () => {
    mockGetPublicBoard.mockResolvedValue(fakeBoard)
    renderSharePage()
    const card = await screen.findByTestId('share-card')
    expect(card).toHaveTextContent('Priority: high.')
    expect(card.className).toContain('border-l-4')
  })

  it('shows a grid skeleton, not a spinner, while loading', () => {
    mockGetPublicBoard.mockReturnValue(new Promise(() => {}))
    renderSharePage()
    const skeleton = screen.getByTestId('share-board-skeleton')
    expect(skeleton).toHaveAttribute('role', 'status')
    expect(skeleton).toHaveAttribute('aria-busy', 'true')
    expect(skeleton).toHaveTextContent('Loading board')
  })

  it('the revoked state is the empty-state part with an h1 and Sign in to Visiban', async () => {
    mockGetPublicBoard.mockRejectedValue(Object.assign(new Error('404'), { response: { status: 404 } }))
    renderSharePage()
    expect(await screen.findByRole('heading', { level: 1, name: 'This board is no longer shared' })).toBeInTheDocument()
    expect(screen.getByText('The share link has been revoked or the board has been deleted.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in to Visiban' })).toHaveAttribute('href', '/')
  })

  it('on phones shows one column at a time, chosen with a select, lanes stacked with counts', async () => {
    const original = window.matchMedia
    window.matchMedia = ((q: string) => ({
      matches: true, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      mockGetPublicBoard.mockResolvedValue(fakeBoard)
      renderSharePage()
      const select = await screen.findByLabelText('Column')
      expect(screen.getByTestId('share-phone-board')).toBeInTheDocument()
      expect(screen.getByRole('option', { name: 'Todo (1)' })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: 'Done (0)' })).toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Customer A' })).toHaveTextContent('Fix login bug')
      fireEvent.change(select, { target: { value: '2' } })
      expect(screen.getByRole('region', { name: 'Customer A' })).toHaveTextContent('No cards here')
    } finally {
      window.matchMedia = original
    }
  })
  it('a transient failure is retryable, not the revoked message', async () => {
    mockGetPublicBoard.mockRejectedValueOnce(Object.assign(new Error('500'), { response: { status: 500 } })).mockResolvedValueOnce(fakeBoard)
    renderSharePage()
    expect(await screen.findByRole('heading', { level: 1, name: "The board didn't load" })).toBeInTheDocument()
    expect(screen.queryByText('This board is no longer shared')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('share-board-page')).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
  })

  it('a 404 is the revoked state', async () => {
    mockGetPublicBoard.mockRejectedValue(Object.assign(new Error('404'), { response: { status: 404 } }))
    renderSharePage()
    expect(await screen.findByTestId('share-expired-page')).toBeInTheDocument()
  })
})
