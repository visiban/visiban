import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import CardBlockSection, { type BlockFormMode } from '../components/Card/CardBlockSection'
import { useEscapeStack } from '../hooks/useEscapeStack'
import type { Card, CardBlock } from '../types'

vi.mock('../api/cards', () => ({
  blockCard: vi.fn(),
  unblockCard: vi.fn(),
  getCardBlocks: vi.fn(),
}))

import { blockCard, getCardBlocks, unblockCard } from '../api/cards'

const mockBlock = blockCard as ReturnType<typeof vi.fn>
const mockUnblock = unblockCard as ReturnType<typeof vi.fn>
const mockBlocks = getCardBlocks as ReturnType<typeof vi.fn>

const NOW = new Date('2026-10-04T05:00:00Z')
const USER = { id: 1, username: 'jdoe', display_name: 'Jane Doe', avatar_url: '' }

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 7, uid: 'carduid00007', column: 10, swimlane: 20, title: 'Payment flow',
    description: '', priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: 0, created_by: USER, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false,
    archived_at: null, version: 3, custom_field_values: [], blocker_count: 0, external_ref: null,
    is_blocked: false, blocked_at: null, blocked_reason: '',
    ...overrides,
  }
}

function makeBlock(overrides: Partial<CardBlock> = {}): CardBlock {
  return {
    id: 1, blocked_at: '2026-10-01T00:00:00Z', blocked_by: USER, reason: 'Waiting on customer',
    unblocked_at: null, unblocked_by: null, resolution: '', column_name: 'Doing', column_uid: 'col1',
    duration_seconds: 0, imported_from_username: null,
    ...overrides,
  }
}

const blockedCard = makeCard({ is_blocked: true, blocked_at: '2026-10-01T00:00:00Z', blocked_reason: 'Waiting on customer', version: 4 })

/** Panel stand-in: registers the sheet's Escape at 30 and owns formMode, like CardDetail. */
function Harness({ card, canBlock = true, initialMode = null, onUpdated = vi.fn(), onPanelEscape = vi.fn() }: {
  card: Card; canBlock?: boolean; initialMode?: BlockFormMode; onUpdated?: (c: Card) => void; onPanelEscape?: () => void
}) {
  const [mode, setMode] = useState<BlockFormMode>(initialMode)
  const [current, setCurrent] = useState(card)
  useEscapeStack(() => { onPanelEscape() }, 30)
  return (
    <div>
      <button type="button" onClick={() => setMode('block')}>Block…</button>
      <CardBlockSection
        boardId={1}
        card={current}
        canBlock={canBlock}
        formMode={mode}
        onFormModeChange={setMode}
        unblockTriggerRef={() => {}}
        onCardUpdated={(c) => { setCurrent(c); onUpdated(c) }}
      />
    </div>
  )
}

describe('CardBlockSection (#1149)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    mockBlocks.mockResolvedValue([])
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing visible for an unblocked card with no history', async () => {
    render(<Harness card={makeCard()} />)
    await waitFor(() => expect(mockBlocks).toHaveBeenCalledWith(1, 7))
    expect(screen.queryByTestId('card-blocked-banner')).not.toBeInTheDocument()
    expect(screen.queryByTestId('card-block-form')).not.toBeInTheDocument()
    expect(screen.queryByTestId('card-blocked-total')).not.toBeInTheDocument()
  })

  it('opens the form with focus in Reason and the helper text', async () => {
    render(<Harness card={makeCard()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Block…' }))
    const reason = screen.getByLabelText(/Reason/)
    expect(reason).toHaveFocus()
    expect(reason).toHaveAttribute('aria-required', 'true')
    expect(reason).toHaveAttribute('maxLength', '500')
    expect(screen.getByText(/Say what the card is waiting on/)).toBeInTheDocument()
  })

  it('requires a reason before calling the API', async () => {
    render(<Harness card={makeCard()} initialMode="block" />)
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Block card' }))
    expect(screen.getByText('Enter a reason to block this card.')).toHaveClass('text-danger')
    expect(screen.getByLabelText(/Reason/)).toHaveAttribute('aria-invalid', 'true')
    expect(mockBlock).not.toHaveBeenCalled()
  })

  it('blocks with the trimmed reason, closes the form and shows the banner', async () => {
    const onUpdated = vi.fn()
    mockBlock.mockResolvedValue(blockedCard)
    mockBlocks.mockResolvedValue([makeBlock()])
    render(<Harness card={makeCard()} initialMode="block" onUpdated={onUpdated} />)
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: '  Waiting on customer ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Block card' })) })
    expect(mockBlock).toHaveBeenCalledWith(1, 7, 'Waiting on customer')
    expect(onUpdated).toHaveBeenCalledWith(blockedCard)
    expect(screen.queryByTestId('card-block-form')).not.toBeInTheDocument()
    const banner = await screen.findByTestId('card-blocked-banner')
    expect(banner).toHaveAttribute('role', 'note')
    expect(banner).toHaveTextContent('Blocked for 3d 5h')
    expect(banner).toHaveTextContent('Waiting on customer')
    await waitFor(() => expect(banner).toHaveTextContent('By Jane Doe'))
    expect(banner).toHaveFocus()
    expect(screen.getByTestId('card-block-status')).toHaveTextContent('Blocked "Payment flow"')
  })

  it('shows the server error in the reserved slot and keeps the form open', async () => {
    mockBlock.mockRejectedValue({ response: { status: 409, data: { code: 'card_already_blocked', detail: 'x' } } })
    render(<Harness card={makeCard()} initialMode="block" />)
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Vendor' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Block card' })) })
    expect(screen.getByText(/already blocked/)).toHaveClass('text-danger')
    expect(screen.getByTestId('card-block-form')).toBeInTheDocument()
  })

  it('surfaces a field validation message from the server', async () => {
    mockBlock.mockRejectedValue({ response: { status: 400, data: { reason: ['Ensure this field has no more than 500 characters.'] } } })
    render(<Harness card={makeCard()} initialMode="block" />)
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Vendor' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Block card' })) })
    expect(screen.getByText('Ensure this field has no more than 500 characters.')).toBeInTheDocument()
  })

  it('falls back to a generic message when the error has no body', async () => {
    mockBlock.mockRejectedValue(new Error('network'))
    render(<Harness card={makeCard()} initialMode="block" />)
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Vendor' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Block card' })) })
    expect(screen.getByText('Could not block this card. Try again.')).toBeInTheDocument()
  })

  it('Escape with focus on a footer button closes the form, not the panel', () => {
    const onPanelEscape = vi.fn()
    render(<Harness card={makeCard()} initialMode="block" onPanelEscape={onPanelEscape} />)
    screen.getByRole('button', { name: 'Cancel' }).focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('card-block-form')).not.toBeInTheDocument()
    expect(onPanelEscape).not.toHaveBeenCalled()
    // With no form open, Escape falls through to the panel.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onPanelEscape).toHaveBeenCalledTimes(1)
  })

  it('Cancel closes the form without calling the API', () => {
    render(<Harness card={makeCard()} initialMode="block" />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('card-block-form')).not.toBeInTheDocument()
    expect(mockBlock).not.toHaveBeenCalled()
  })

  it('banner totals every block of the card', async () => {
    mockBlocks.mockResolvedValue([
      makeBlock({ id: 2 }),
      makeBlock({
        id: 1, blocked_at: '2026-09-01T00:00:00Z', unblocked_at: '2026-09-03T05:00:00Z',
        duration_seconds: 2 * 86400 + 5 * 3600,
      }),
    ])
    render(<Harness card={blockedCard} />)
    expect(await screen.findByText('Total blocked time: 5d 10h across 2 blocks')).toBeInTheDocument()
  })

  it('names an imported or deleted blocker', async () => {
    mockBlocks.mockResolvedValue([makeBlock({ blocked_by: null, imported_from_username: 'old-sam' })])
    const { unmount } = render(<Harness card={blockedCard} />)
    expect(await screen.findByText(/By old-sam/)).toBeInTheDocument()
    unmount()
    mockBlocks.mockResolvedValue([makeBlock({ blocked_by: null })])
    render(<Harness card={blockedCard} />)
    expect(await screen.findByText(/By a deleted user/)).toBeInTheDocument()
  })

  it('unblocks with an optional resolution and announces the duration', async () => {
    const onUpdated = vi.fn()
    const cleared = makeCard({ version: 5 })
    mockUnblock.mockResolvedValue(cleared)
    render(<Harness card={blockedCard} onUpdated={onUpdated} />)
    fireEvent.click(screen.getByRole('button', { name: 'Unblock' }))
    const resolution = screen.getByLabelText('Resolution')
    expect(resolution).toHaveFocus()
    expect(resolution).not.toHaveAttribute('aria-required', 'true')
    fireEvent.change(resolution, { target: { value: 'Customer replied' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unblock card' })) })
    expect(mockUnblock).toHaveBeenCalledWith(1, 7, 'Customer replied')
    expect(onUpdated).toHaveBeenCalledWith(cleared)
    expect(screen.queryByTestId('card-blocked-banner')).not.toBeInTheDocument()
    expect(screen.getByTestId('card-block-status')).toHaveTextContent('Unblocked "Payment flow" after 3d 5h')
  })

  it('unblock without a resolution sends an empty one', async () => {
    mockUnblock.mockResolvedValue(makeCard({ version: 5 }))
    render(<Harness card={blockedCard} initialMode="unblock" />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unblock card' })) })
    expect(mockUnblock).toHaveBeenCalledWith(1, 7, '')
  })

  it('shows the generic unblock error', async () => {
    mockUnblock.mockRejectedValue({ response: { data: { code: 'card_not_blocked' } } })
    render(<Harness card={blockedCard} initialMode="unblock" />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unblock card' })) })
    expect(screen.getByText('This card is no longer blocked.')).toBeInTheDocument()
  })

  it('a reader without edit rights sees the banner but no Unblock', async () => {
    render(<Harness card={blockedCard} canBlock={false} />)
    expect(screen.getByTestId('card-blocked-banner')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unblock' })).not.toBeInTheDocument()
  })

  it('shows past blocked time on an unblocked card', async () => {
    mockBlocks.mockResolvedValue([
      makeBlock({ unblocked_at: '2026-10-02T00:00:00Z', duration_seconds: 86400 }),
    ])
    render(<Harness card={makeCard()} />)
    expect(await screen.findByText('Previously blocked. Total blocked time: 1d across 1 block.')).toBeInTheDocument()
  })

  it('tolerates a failed history fetch', async () => {
    mockBlocks.mockRejectedValue(new Error('down'))
    render(<Harness card={blockedCard} />)
    await waitFor(() => expect(mockBlocks).toHaveBeenCalled())
    expect(screen.getByTestId('card-blocked-banner')).toHaveTextContent('Blocked for 3d 5h')
    expect(screen.queryByTestId('card-blocked-total')).not.toBeInTheDocument()
  })
})
