import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import BoardCell from '../components/Board/BoardCell'
import type { Card, Column, Swimlane } from '../types'

// #1918 chain-level test: real BoardCell -> real CardItem. Only dnd-kit and
// network are mocked, so the `currentCardId` -> `peekSuppressed` wiring is real.
vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useDndContext: () => ({ active: null }),
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
}))
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: {},
}))
vi.mock('../api/cards', () => ({ createCard: vi.fn() }))

const column: Column = { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false }
const swimlane: Swimlane = { id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01' }

function makeCard(id: number): Card {
  return {
    id, uid: `carduid0000${id}`, column: 10, swimlane: 20, title: `Card ${id}`, description: `Description ${id}`,
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: id, created_by: { id: 1, username: 'user1', display_name: 'User 1', avatar_url: '' },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1,
    custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
  }
}

const baseProps = () => ({
  column, swimlane, cards: [makeCard(1), makeCard(2)], boardId: 1, canEdit: false,
  closeEditorOnEnter: false, filteredCardIds: null as Set<number> | null,
  selectedCardIds: new Set<number>(), onToggleCardSelection: vi.fn(),
  onCardClick: vi.fn(), onCardAdded: vi.fn(),
})

describe('card hover peek with the detail sheet open (#1918)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Element.prototype.getBoundingClientRect = vi.fn(() => ({
      top: 100, left: 50, bottom: 160, right: 250, width: 200, height: 60, x: 50, y: 100, toJSON: () => {},
    }))
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  const hoverCard = async (title: string) => {
    const el = screen.getByText(title).closest('[data-tour-step="card"]') as HTMLElement
    fireEvent.mouseEnter(el)
    await act(async () => { vi.advanceTimersByTime(700) })
    return el
  }

  it('shows no peek on another card while a card is selected, and a peek works again after close', async () => {
    const props = baseProps()
    const { rerender } = render(<BoardCell {...props} currentCardId={1} />)
    const other = await hoverCard('Card 2')
    expect(screen.queryByText(/Click to open/)).not.toBeInTheDocument()

    // Closing the sheet does not re-show the peek for the card still under the pointer.
    rerender(<BoardCell {...props} currentCardId={null} />)
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(screen.queryByText(/Click to open/)).not.toBeInTheDocument()

    fireEvent.mouseLeave(other)
    await hoverCard('Card 2')
    expect(screen.getByText(/Click to open/)).toBeInTheDocument()
  })

  it('unmounts a visible peek when a card becomes selected', async () => {
    const props = baseProps()
    const { rerender } = render(<BoardCell {...props} currentCardId={null} />)
    await hoverCard('Card 2')
    expect(screen.getByText(/Click to open/)).toBeInTheDocument()
    rerender(<BoardCell {...props} currentCardId={1} />)
    expect(screen.queryByText(/Click to open/)).not.toBeInTheDocument()
  })
})

