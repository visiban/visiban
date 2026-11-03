import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AxiosError, AxiosHeaders } from 'axios'
import CardDeleteConfirm from '../components/Card/CardDeleteConfirm'
import type { Card } from '../types'

vi.mock('../api/cards', () => ({ deleteCard: vi.fn() }))
import { deleteCard } from '../api/cards'

// The card context menu's Delete card… confirm (#2059).

function makeCard(id: number, creatorId: number | null = 1): Card {
  return {
    id, uid: `u${id}`, column: 10, swimlane: 20, title: `Card ${id}`,
    description: '', priority: 'low', assignee: null, labels: [], due_date: null, weight: 1, position: 0,
    created_by: creatorId === null ? null : { id: creatorId, username: 'u', display_name: 'U', avatar_url: '' },
    created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
    is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0,
    external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
  }
}
const forbidden = () => new AxiosError('x', 'ERR', undefined, undefined, { status: 403, data: {}, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } })

describe('CardDeleteConfirm', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('names one card, deletes on confirm, and closes with no failure', async () => {
    vi.mocked(deleteCard).mockResolvedValue(undefined as never)
    const onDeleted = vi.fn()
    const onClose = vi.fn()
    render(<CardDeleteConfirm boardId={3} cards={[makeCard(1)]} canModifyAll={false} currentUserId={1} onDeleted={onDeleted} onClose={onClose} />)
    expect(screen.getByRole('dialog', { name: 'Delete this card?' })).toHaveTextContent('This will permanently delete “Card 1”. This cannot be undone.')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('button', { name: 'Deleting…' })).toHaveAttribute('aria-disabled', 'true')
    // Escape is swallowed while the request is in flight (#1437).
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(null))
    expect(deleteCard).toHaveBeenCalledWith(3, 1)
    expect(onDeleted).toHaveBeenCalledWith([1])
  })

  it("warns that others' cards will be skipped, and reports the partial failure", async () => {
    vi.mocked(deleteCard).mockResolvedValueOnce(undefined as never).mockRejectedValueOnce(forbidden())
    const onClose = vi.fn()
    render(<CardDeleteConfirm boardId={3} cards={[makeCard(1), makeCard(2, 9)]} canModifyAll={false} currentUserId={1} onDeleted={vi.fn()} onClose={onClose} />)
    expect(screen.getByText('1 card created by others will be skipped.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledWith('1 of 2 cards could not be deleted — you can only delete cards you created.'))
  })

  it("says none will be deleted when every card is someone else's; Cancel closes", () => {
    const onClose = vi.fn()
    render(<CardDeleteConfirm boardId={3} cards={[makeCard(2, 9)]} canModifyAll={false} currentUserId={1} onDeleted={vi.fn()} onClose={onClose} />)
    expect(screen.getByText('You can only delete cards you created. This card will not be deleted.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledWith(null)
  })

  it('says none will be deleted when every one of several cards is someone else\u2019s', () => {
    render(<CardDeleteConfirm boardId={3} cards={[makeCard(2, 9), makeCard(3, 8)]} canModifyAll={false} currentUserId={1} onDeleted={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('You can only delete cards you created. None of these cards will be deleted.')).toBeInTheDocument()
  })

  it('an admin sees no ownership note', () => {
    render(<CardDeleteConfirm boardId={3} cards={[makeCard(2, 9), makeCard(3, 9)]} canModifyAll currentUserId={1} onDeleted={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Delete 2 cards?' })).toHaveTextContent('all 2 cards')
    expect(screen.queryByText(/created by others/)).not.toBeInTheDocument()
  })
})
