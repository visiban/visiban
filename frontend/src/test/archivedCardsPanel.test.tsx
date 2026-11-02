import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OverflowMenu from '../components/Layout/OverflowMenu'
import ArchivedCardsPanel from '../components/Board/ArchivedCardsPanel'
import type { BoardFull, Card } from '../types'
import type { ArchivedCardsPage } from '../api/cards'

vi.mock('../api/cards', () => ({
  getArchivedCards: vi.fn(),
  unarchiveCard: vi.fn(),
}))

import { getArchivedCards, unarchiveCard } from '../api/cards'
import { flagsWrapper } from './instanceFlagsWrapper'
const mockGetArchivedCards = getArchivedCards as ReturnType<typeof vi.fn>
const mockUnarchiveCard = unarchiveCard as ReturnType<typeof vi.fn>

const fakeBoard: BoardFull = {
  id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
  archived_card_count: 0,
  columns: [
    { id: 10, uid: 'coluid000001', name: 'Backlog', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
  ],
  swimlanes: [
    { id: 20, uid: 'laneuid00001', name: 'General', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null },
  ],
  cards: [],
  labels: [],
  members: [],
  staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
  enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false, show_row_chip_field_names: true, export_min_role: 'viewer', card_density: 'comfortable', is_starred: false, created_at: '', updated_at: '', current_user_role: 'admin',
  owner: { id: 1, username: 'jdoe', display_name: 'Jane Doe', avatar_url: '' },
  capabilities: { movement_export: false },
  share_token: null,
  share_token_expires_at: null,
  share_link_active: false,
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
  blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
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
      render(<ArchivedCardsPanel board={memberBoard} onClose={vi.fn()} onUnarchived={vi.fn()} currentUser={visitor} />, { wrapper: flagsWrapper({ demo_mode: true }) })
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
      await screen.findByText('Old feature: WIP limit reached: "Backlog" is at its limit of 3 cards (3 active).'),
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
        'Old feature: Weight limit reached: "Backlog" has 4 weight — adding this card (+2) would reach 6 of 5.',
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
      await screen.findByText('Could not unarchive "Old feature". Please try again.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Old feature')).toBeInTheDocument()
  })

  // A column or swimlane delete cascades to its archived cards, and the server
  // sends only the container's *.deleted event for them (#1615).
  describe('cards of a deleted column or swimlane', () => {
    const otherCard: Card = { ...archivedCard, id: 100, uid: 'carduid00100', column: 11, title: 'Kept card' }
    const twoColumnBoard: BoardFull = {
      ...fakeBoard,
      columns: [
        ...fakeBoard.columns,
        { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
      ],
    }

    it('drops a loaded card once its column leaves the board', async () => {
      mockGetArchivedCards.mockResolvedValue(makePage([archivedCard, otherCard]))
      const { rerender } = render(<ArchivedCardsPanel board={twoColumnBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
      await waitFor(() => screen.getByText('Old feature'))
      expect(screen.getByText('(2)')).toBeInTheDocument()

      rerender(<ArchivedCardsPanel board={{ ...twoColumnBoard, columns: twoColumnBoard.columns.filter((c) => c.id !== 10) }} onClose={vi.fn()} onUnarchived={vi.fn()} />)

      expect(screen.queryByText('Old feature')).not.toBeInTheDocument()
      expect(screen.getByText('Kept card')).toBeInTheDocument()
      expect(screen.getByText('(1)')).toBeInTheDocument()
    })

    it('drops a loaded card once its swimlane leaves the board', async () => {
      mockGetArchivedCards.mockResolvedValue(makePage([archivedCard]))
      const { rerender } = render(<ArchivedCardsPanel board={fakeBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
      await waitFor(() => screen.getByText('Old feature'))

      rerender(<ArchivedCardsPanel board={{ ...fakeBoard, swimlanes: [] }} onClose={vi.fn()} onUnarchived={vi.fn()} />)

      expect(screen.queryByText('Old feature')).not.toBeInTheDocument()
      expect(screen.getByText('No archived cards')).toBeInTheDocument()
    })

    it('asks for the next page at an offset that skips no surviving card', async () => {
      mockGetArchivedCards.mockResolvedValueOnce(makePage([archivedCard, otherCard], 5))
      const { rerender } = render(<ArchivedCardsPanel board={twoColumnBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
      await waitFor(() => screen.getByText('Old feature'))

      // The server's count after the delete: 4 left, 1 of them already shown.
      mockGetArchivedCards.mockResolvedValueOnce(makePage([], 4))
      rerender(<ArchivedCardsPanel board={{ ...twoColumnBoard, columns: twoColumnBoard.columns.filter((c) => c.id !== 10) }} onClose={vi.fn()} onUnarchived={vi.fn()} />)
      expect(await screen.findByText('Load more (3 remaining)')).toBeInTheDocument()

      mockGetArchivedCards.mockResolvedValueOnce(makePage([], 4))
      await userEvent.click(screen.getByText(/Load more/))
      // The server's list lost the deleted card, so the one surviving card
      // already loaded is the whole of the first page now.
      await waitFor(() => expect(mockGetArchivedCards).toHaveBeenLastCalledWith(1, 1))
    })

    // The two `+ pruned` terms keep total server-true while pruned cards are
    // still held in the loaded list; dropping either under-counts the remainder.
    const plusSwimlane = (b: BoardFull): BoardFull => ({
      ...b, swimlanes: [...b.swimlanes, { ...b.swimlanes[0], id: 21, uid: 'laneuid00002' }],
    })

    it('counts pruned cards back in when the server count replaces the total (#1637)', async () => {
      mockGetArchivedCards.mockResolvedValueOnce(makePage([archivedCard, otherCard], 60))
      const { rerender } = render(<ArchivedCardsPanel board={twoColumnBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
      await waitFor(() => screen.getByText('Old feature'))

      mockGetArchivedCards.mockResolvedValueOnce(makePage([], 58))
      rerender(<ArchivedCardsPanel board={{ ...twoColumnBoard, columns: twoColumnBoard.columns.filter((c) => c.id !== 10) }} onClose={vi.fn()} onUnarchived={vi.fn()} />)
      // Server says 58 remain, 1 shown. (Before the count lands it reads 58.)
      expect(await screen.findByText('Load more (57 remaining)')).toBeInTheDocument()
    })

    it('counts pruned cards back in when a Load more page re-syncs the total (#1637)', async () => {
      const extra: Card = { ...archivedCard, id: 101, uid: 'carduid00101', column: 11, title: 'Extra' }
      mockGetArchivedCards.mockResolvedValueOnce(makePage([archivedCard, otherCard], 60))
      const { rerender } = render(<ArchivedCardsPanel board={twoColumnBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
      await waitFor(() => screen.getByText('Old feature'))

      mockGetArchivedCards.mockResolvedValueOnce(makePage([], 58))
      rerender(<ArchivedCardsPanel board={{ ...twoColumnBoard, columns: twoColumnBoard.columns.filter((c) => c.id !== 10) }} onClose={vi.fn()} onUnarchived={vi.fn()} />)
      await screen.findByText('Load more (57 remaining)')

      mockGetArchivedCards.mockResolvedValueOnce(makePage([extra], 58))
      await userEvent.click(screen.getByText(/Load more/))
      // 58 on the server, 2 shown.
      expect(await screen.findByText('Load more (56 remaining)')).toBeInTheDocument()
    })

    it('ignores a count read that began before an unarchive finished (#1637)', async () => {
      mockGetArchivedCards.mockResolvedValueOnce(makePage([archivedCard, otherCard], 5))
      let resolveUnarchive: (c: Card) => void = () => {}
      mockUnarchiveCard.mockReturnValue(new Promise<Card>((r) => { resolveUnarchive = r }))
      const { rerender } = render(<ArchivedCardsPanel board={twoColumnBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
      await waitFor(() => screen.getByText('Old feature'))

      await userEvent.click(screen.getAllByText('Unarchive')[0])
      let resolveCount: (v: unknown) => void = () => {}
      mockGetArchivedCards.mockReturnValueOnce(new Promise((r) => { resolveCount = r }))
      rerender(<ArchivedCardsPanel board={plusSwimlane(twoColumnBoard)} onClose={vi.fn()} onUnarchived={vi.fn()} />)

      resolveUnarchive({ ...archivedCard, archived_at: null })
      await waitFor(() => expect(screen.queryByText('Old feature')).not.toBeInTheDocument())
      // A stale count (taken before the unarchive landed) must not win.
      await act(async () => { resolveCount(makePage([], 99)) })
      expect(screen.getByText('(4)')).toBeInTheDocument()
    })

    it('drops the Load more remainder when a container change shows no unloaded cards remain (#1637)', async () => {
      // 50 loaded would be typical; here 1 shown of 3, the other 2 (never
      // loaded) are in the column that is then deleted.
      mockGetArchivedCards.mockResolvedValueOnce(makePage([otherCard], 3))
      const { rerender } = render(<ArchivedCardsPanel board={twoColumnBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
      await waitFor(() => screen.getByText('Kept card'))
      expect(screen.getByText('Load more (2 remaining)')).toBeInTheDocument()

      mockGetArchivedCards.mockResolvedValueOnce(makePage([otherCard], 1))
      rerender(<ArchivedCardsPanel board={{ ...twoColumnBoard, swimlanes: [...twoColumnBoard.swimlanes, { ...twoColumnBoard.swimlanes[0], id: 21, uid: 'laneuid00002' }] }} onClose={vi.fn()} onUnarchived={vi.fn()} />)
      await waitFor(() => expect(screen.queryByText(/Load more/)).not.toBeInTheDocument())
      expect(screen.getByText('(1)')).toBeInTheDocument()
    })

    it('re-syncs the total from the server when a Load more page comes back empty (#1637)', async () => {
      mockGetArchivedCards.mockResolvedValueOnce(makePage([otherCard], 3))
      render(<ArchivedCardsPanel board={twoColumnBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
      await waitFor(() => screen.getByText('Load more (2 remaining)'))

      // The real API reports count 0 for an empty page.
      mockGetArchivedCards.mockResolvedValueOnce(makePage([], 0))
      await userEvent.click(screen.getByText(/Load more/))
      await waitFor(() => expect(screen.queryByText(/Load more/)).not.toBeInTheDocument())
      // The listed card must keep its header count.
      expect(screen.getByText('Kept card')).toBeInTheDocument()
      expect(screen.getByText('(1)')).toBeInTheDocument()
    })
  })

  it('does not refetch the count for a new board object or a pure reorder (#1637)', async () => {
    mockGetArchivedCards.mockClear()
    mockGetArchivedCards.mockResolvedValue(makePage([{ ...archivedCard, id: 97, uid: 'carduid00097', title: 'Kept' }], 1))
    const b = { ...fakeBoard, columns: [fakeBoard.columns[0], { ...fakeBoard.columns[0], id: 11, uid: 'coluid000002' }] }
    const { rerender } = render(<ArchivedCardsPanel board={b} onClose={vi.fn()} onUnarchived={vi.fn()} />)
    await waitFor(() => screen.getByText('Kept'))
    expect(mockGetArchivedCards).toHaveBeenCalledTimes(1)

    rerender(<ArchivedCardsPanel board={{ ...b }} onClose={vi.fn()} onUnarchived={vi.fn()} />)
    rerender(<ArchivedCardsPanel board={{ ...b, columns: [...b.columns].reverse() }} onClose={vi.fn()} onUnarchived={vi.fn()} />)
    expect(mockGetArchivedCards).toHaveBeenCalledTimes(1)
  })

  it('steps the next-page offset back after an unarchive (#1637)', async () => {
    const second: Card = { ...archivedCard, id: 98, uid: 'carduid00098', title: 'Second' }
    mockGetArchivedCards.mockResolvedValueOnce(makePage([archivedCard, second], 5))
    mockUnarchiveCard.mockResolvedValue({ ...archivedCard, archived_at: null })
    render(<ArchivedCardsPanel board={fakeBoard} onClose={vi.fn()} onUnarchived={vi.fn()} />)
    await waitFor(() => screen.getByText('Load more (3 remaining)'))

    await userEvent.click(screen.getAllByText('Unarchive')[0])
    await waitFor(() => expect(screen.queryByText('Old feature')).not.toBeInTheDocument())

    mockGetArchivedCards.mockResolvedValueOnce(makePage([], 4))
    await userEvent.click(screen.getByText(/Load more/))
    // Two were loaded, one restored: the server's list now starts one shorter.
    await waitFor(() => expect(mockGetArchivedCards).toHaveBeenLastCalledWith(1, 1))
  })
})

describe('ArchivedCardsPanel focus management (#1732)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetArchivedCards.mockResolvedValue(makePage([archivedCard]))
  })

  function Host() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button onClick={() => setOpen(true)}>Open archive</button>
        {open && <ArchivedCardsPanel board={fakeBoard} onClose={() => setOpen(false)} onUnarchived={vi.fn()} />}
      </>
    )
  }

  it('Tab cycles within the panel and never reaches the board behind it', async () => {
    const user = userEvent.setup()
    render(<Host />)
    await user.click(screen.getByText('Open archive'))
    const dialog = await screen.findByRole('dialog', { name: 'Archived cards' })
    await screen.findByText('Old feature')
    for (let i = 0; i < 8; i++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
    for (let i = 0; i < 8; i++) {
      await user.tab({ shift: true })
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('restores focus to the opener on close', async () => {
    const user = userEvent.setup()
    render(<Host />)
    const opener = screen.getByText('Open archive')
    await user.click(opener)
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('opened from an OverflowMenu item: Tab stays trapped and Escape returns focus to the kebab (#1775)', async () => {
    mockGetArchivedCards.mockResolvedValue(makePage([archivedCard]))
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <OverflowMenu items={[{ id: 'a', label: 'Show archived cards', onSelect: () => setOpen(true) }]} />
          {open && (
            <ArchivedCardsPanel board={fakeBoard} onClose={() => setOpen(false)} onUnarchived={vi.fn()} />
          )}
        </>
      )
    }
    const user = userEvent.setup()
    render(<Harness />)
    const kebab = screen.getByRole('button', { name: 'More board actions' })
    await user.click(kebab)
    await user.click(screen.getByRole('menuitem', { name: 'Show archived cards' }))
    const dialog = await screen.findByRole('dialog', { name: 'Archived cards' })
    await waitFor(() => expect(screen.getByText('Old feature')).toBeInTheDocument())
    await user.tab()
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(kebab).toHaveFocus()
  })
})
