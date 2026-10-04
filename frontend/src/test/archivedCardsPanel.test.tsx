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
  archived_card_count: 0,
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
  enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false, export_min_role: 'viewer', card_density: 'comfortable', is_starred: false, created_at: '', updated_at: '', current_user_role: 'admin',
  owner: { id: 1, username: 'jdoe', display_name: 'Jane Doe', avatar_url: '' },
  capabilities: { movement_export: false },
  share_token: null,
  share_token_expires_at: null,
  custom_field_definitions: [],
  swimlane_custom_field_definitions: [],
}

const archivedCard: Card = {
  id: 99, uid: 'carduid00099', column: 10, swimlane: 20,
  title: 'Old feature', description: '', priority: 'medium',
  assignee: null, labels: [], due_date: null, weight: 1, position: 0,
  created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
  last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
  is_stale: false, archived_at: '2024-02-01T00:00:00Z', version: 1,
  custom_field_values: [],
  blocker_count: 0, external_ref: null,
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

  // #1373 — the initial getArchivedCards() call used to be a floating promise:
  // a rejection left `loading` false and `cards` empty, rendering the same
  // "No archived cards" message as a genuinely empty board.
  it('shows a load error distinct from the empty state when the initial fetch fails', async () => {
    mockGetArchivedCards.mockRejectedValue(new Error('network error'))
    render(<ArchivedCardsPanel board={fakeBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
    expect(await screen.findByText('Could not load archived cards. Please try again.')).toBeInTheDocument()
    expect(screen.queryByText('No archived cards')).not.toBeInTheDocument()
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

  // #1373 — the handleLoadMore() getArchivedCards() call used to be a floating
  // promise: a rejection left the existing cards in place with no indication
  // the "Load more" click had failed.
  it('shows an error without losing existing cards when load-more fails', async () => {
    mockGetArchivedCards.mockResolvedValueOnce(makePage([archivedCard], 75))
    render(<ArchivedCardsPanel board={fakeBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
    await waitFor(() => screen.getByText(/Load more/))

    mockGetArchivedCards.mockRejectedValueOnce(new Error('network error'))
    await userEvent.click(screen.getByText(/Load more/))

    expect(await screen.findByText('Could not load more archived cards. Please try again.')).toBeInTheDocument()
    expect(screen.getByText('Old feature')).toBeInTheDocument()
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

  describe('hosted demo visitor (#1179)', () => {
    const visitor = {
      id: 99, username: 'visitor', email: '', first_name: '', last_name: '', avatar_url: '',
      display_name: 'Visitor', is_site_admin: false, must_change_password: false, must_change_username: false,
    }
    const memberBoard: BoardFull = {
      ...fakeBoard,
      current_user_role: 'member',
      members: [{ id: 2, user: visitor, role: 'member', is_moderator: false, joined_at: '' }],
    }

    it('a demo member can restore a card someone else archived', async () => {
      mockGetArchivedCards.mockResolvedValue(makePage([archivedCard]))
      render(<ArchivedCardsPanel board={memberBoard} onClose={vi.fn()} onUnarchived={vi.fn()} currentUser={{ ...visitor, demo_mode: true }} />)
      await waitFor(() => screen.getByText('Old feature'))
      expect(screen.getByText('Unarchive')).toBeInTheDocument()
    })

    it('outside demo mode the same plain member cannot', async () => {
      mockGetArchivedCards.mockResolvedValue(makePage([archivedCard]))
      render(<ArchivedCardsPanel board={memberBoard} onClose={vi.fn()} onUnarchived={vi.fn()} currentUser={visitor} />)
      await waitFor(() => screen.getByText('Old feature'))
      expect(screen.queryByText('Unarchive')).not.toBeInTheDocument()
    })
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

// #1376 — the pointer-only backdrop is decorative: keyboard parity is the Close button + Escape
describe('ArchivedCardsPanel — keyboard (#1376)', () => {
  it('hides the click-only backdrop from assistive tech and offers a keyboard-operable Close', async () => {
    mockGetArchivedCards.mockResolvedValue(makePage([]))
    const onClose = vi.fn()
    const { container } = render(<ArchivedCardsPanel board={fakeBoard} onClose={onClose} onUnarchived={vi.fn()} />)
    expect(container.querySelector('.bg-backdrop\\/50')).toHaveAttribute('aria-hidden', 'true')
    const user = userEvent.setup()
    const close = screen.getAllByRole('button').find((b) => /close/i.test(b.getAttribute('aria-label') ?? ''))!
    close.focus()
    await user.keyboard('{Enter}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ArchivedCardsPanel — backdrop keyboard operation (#1376)', () => {
  it('backdrop has no focusable descendant and Escape closes the panel', async () => {
    mockGetArchivedCards.mockResolvedValue(makePage([]))
    const onClose = vi.fn()
    const { container } = render(<ArchivedCardsPanel board={fakeBoard} onClose={onClose} onUnarchived={vi.fn()} />)
    const backdrop = container.querySelector('[aria-hidden="true"].absolute.inset-0') as HTMLElement
    expect(backdrop).not.toBeNull()
    expect(backdrop.querySelector('button, a, input, [tabindex]')).toBeNull()
    await userEvent.setup().keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // #1428 — restore into a full column now returns the move path's 409 body.
  // Before, the rejection was unhandled and the click silently did nothing.
  it('shows the WIP-limit reason and keeps the card when restore is refused', async () => {
    mockGetArchivedCards.mockResolvedValue(makePage([archivedCard]))
    mockUnarchiveCard.mockRejectedValueOnce({
      response: {
        status: 409,
        data: { code: 'wip_limit_exceeded', column_name: 'Backlog', current_count: 3, wip_limit: 3 },
      },
    })
    const onUnarchived = vi.fn()
    render(<ArchivedCardsPanel board={fakeBoard} onClose={vi.fn()} onUnarchived={onUnarchived} />)
    await waitFor(() => screen.getByText('Old feature'))

    await userEvent.click(screen.getByText('Unarchive'))

    expect(
      await screen.findByText('WIP limit reached — "Backlog" is at its limit of 3 cards (3 active).'),
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('WIP limit reached')
    expect(screen.getByText('Old feature')).toBeInTheDocument()
    expect(screen.getByText('Unarchive')).toBeEnabled()
    expect(onUnarchived).not.toHaveBeenCalled()
  })

  it('shows the weight-limit reason when restore is refused on weight', async () => {
    mockGetArchivedCards.mockResolvedValue(makePage([archivedCard]))
    mockUnarchiveCard.mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          code: 'weight_limit_exceeded', column_name: 'Backlog',
          current_weight: 4, weight_limit: 5, card_weight: 2,
        },
      },
    })
    render(<ArchivedCardsPanel board={fakeBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
    await waitFor(() => screen.getByText('Old feature'))
    await userEvent.click(screen.getByText('Unarchive'))
    expect(
      await screen.findByText(
        'Weight limit reached — "Backlog" has 4 weight — adding this card (+2) would reach 6 of 5.',
      ),
    ).toBeInTheDocument()
  })

  it('shows a generic message for any other restore failure', async () => {
    mockGetArchivedCards.mockResolvedValue(makePage([archivedCard]))
    mockUnarchiveCard.mockRejectedValueOnce(new Error('network error'))
    render(<ArchivedCardsPanel board={fakeBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
    await waitFor(() => screen.getByText('Old feature'))
    await userEvent.click(screen.getByText('Unarchive'))
    expect(
      await screen.findByText('Could not unarchive this card. Please try again.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Old feature')).toBeInTheDocument()
  })
})
