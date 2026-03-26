import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardCell from '../components/Board/BoardCell'
import type { Card, Column, Swimlane } from '../types'

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useDndContext: () => ({ active: null }),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: {},
}))

vi.mock('../api/cards', () => ({ createCard: vi.fn() }))

vi.mock('../components/Card/CardItem', () => ({
  default: ({ card, onClick }: { card: Card; onClick?: () => void }) => (
    <div data-testid={`card-${card.id}`} onClick={onClick}>{card.title}</div>
  ),
}))

import { createCard } from '../api/cards'
const mockCreateCard = createCard as ReturnType<typeof vi.fn>

const column: Column = { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false }
const swimlane: Swimlane = { id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01' }

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Test Card', description: '',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: 0, created_by: 1, created_at: '', updated_at: '',
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
    ...overrides,
  }
}

const defaultProps = () => ({
  column,
  swimlane,
  cards: [] as Card[],
  boardId: 1,
  canEdit: true,
  closeEditorOnEnter: false,
  filteredCardIds: null as Set<number> | null,
  selectedCardIds: new Set<number>(),
  onToggleCardSelection: vi.fn(),
  onCardClick: vi.fn(),
  onCardAdded: vi.fn(),
})

describe('BoardCell', () => {
  it('renders + Add card button when canEdit and allow_card_creation', () => {
    render(<BoardCell {...defaultProps()} />)
    expect(screen.getByText('+ Add card')).toBeInTheDocument()
  })

  it('hides + Add card when canEdit is false', () => {
    const props = defaultProps()
    props.canEdit = false
    render(<BoardCell {...props} />)
    expect(screen.queryByText('+ Add card')).not.toBeInTheDocument()
  })

  it('hides + Add card when column disallows card creation', () => {
    const props = defaultProps()
    props.column = { ...column, allow_card_creation: false }
    render(<BoardCell {...props} />)
    expect(screen.queryByText('+ Add card')).not.toBeInTheDocument()
  })

  it('clicking + Add card shows input', async () => {
    render(<BoardCell {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('+ Add card'))
    expect(screen.getByPlaceholderText('Card title…')).toBeInTheDocument()
    expect(screen.getByText('Add')).toBeInTheDocument()
    expect(screen.getByText('Cancel')).toBeInTheDocument()
  })

  it('renders cards', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1, title: 'Card A' }), makeCard({ id: 2, title: 'Card B' })]
    render(<BoardCell {...props} />)
    expect(screen.getByTestId('card-1')).toBeInTheDocument()
    expect(screen.getByTestId('card-2')).toBeInTheDocument()
  })

  it('clicking card calls onCardClick', async () => {
    const props = defaultProps()
    const card = makeCard({ id: 1, title: 'Card A' })
    props.cards = [card]
    render(<BoardCell {...props} />)
    await userEvent.setup().click(screen.getByTestId('card-1'))
    expect(props.onCardClick).toHaveBeenCalledWith(card)
  })

  it('filters cards when filteredCardIds is set', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1, title: 'Card A' }), makeCard({ id: 2, title: 'Card B' })]
    props.filteredCardIds = new Set([1])
    render(<BoardCell {...props} />)
    expect(screen.getByTestId('card-1')).toBeInTheDocument()
    expect(screen.queryByTestId('card-2')).not.toBeInTheDocument()
  })

  it('creates card when Add is clicked', async () => {
    const newCard = makeCard({ id: 99, title: 'New Card' })
    mockCreateCard.mockResolvedValue(newCard)
    const props = defaultProps()
    render(<BoardCell {...props} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Add card'))
    await user.type(screen.getByPlaceholderText('Card title…'), 'New Card')
    await user.click(screen.getByText('Add'))
    expect(mockCreateCard).toHaveBeenCalledWith(1, { column: 10, swimlane: 20, title: 'New Card' })
  })

  it('shows card count badge when 2 or more cards are present', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 }), makeCard({ id: 2, title: 'Card B' })]
    render(<BoardCell {...props} />)
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('does not show count badge for a single card', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 })]
    render(<BoardCell {...props} />)
    expect(screen.queryByText('1')).not.toBeInTheDocument()
  })

  it('empty cell has dashed border', () => {
    const { container } = render(<BoardCell {...defaultProps()} />)
    expect(container.firstChild as HTMLElement).toHaveClass('border-dashed')
  })

  it('non-empty cell does not have dashed border', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 })]
    const { container } = render(<BoardCell {...props} />)
    expect(container.firstChild as HTMLElement).not.toHaveClass('border-dashed')
  })
})
