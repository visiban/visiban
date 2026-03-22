import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SwimlaneRow from '../components/Board/SwimlaneRow'
import type { Card, Column, Swimlane } from '../types'

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useDndContext: () => ({ active: null }),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: {},
  useSortable: () => ({ setNodeRef: () => {}, attributes: {}, listeners: {}, transform: null, transition: undefined, isDragging: false }),
}))

vi.mock('../components/Board/BoardCell', () => ({
  default: ({ column, swimlane }: { column: Column; swimlane: Swimlane }) => (
    <div data-testid={`cell-${column.id}-${swimlane.id}`}>Cell</div>
  ),
}))

vi.mock('../components/Board/EditSwimlaneModal', () => ({
  default: () => <div data-testid="edit-swimlane-modal">Edit Swimlane</div>,
}))

vi.mock('../api/cards', () => ({ createCard: vi.fn() }))

const columns: Column[] = [
  { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true },
  { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true },
]

const swimlane: Swimlane = {
  id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: 'a@test.com', notes: '', position: 0,
  color: '#6B7280', is_collapsed: false, created_at: '2026-01-01',
}

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
  swimlane,
  columns,
  cards: [] as Card[],
  boardId: 1,
  isAdmin: true,
  canEdit: true,
  closeEditorOnEnter: false,
  collapsedColumnIds: new Set<number>(),
  filteredCardIds: null as Set<number> | null,
  selectedCardIds: new Set<number>(),
  onToggleCardSelection: vi.fn(),
  onCardClick: vi.fn(),
  onCardAdded: vi.fn(),
  onSwimlaneUpdated: vi.fn(),
  onSwimlaneDeleted: vi.fn(),
})

describe('SwimlaneRow', () => {
  it('renders swimlane name', () => {
    render(<SwimlaneRow {...defaultProps()} />)
    expect(screen.getByText('Customer A')).toBeInTheDocument()
  })

  it('renders swimlane contact email', () => {
    render(<SwimlaneRow {...defaultProps()} />)
    expect(screen.getByText('a@test.com')).toBeInTheDocument()
  })

  it('renders BoardCell for each column', () => {
    render(<SwimlaneRow {...defaultProps()} />)
    expect(screen.getByTestId('cell-10-20')).toBeInTheDocument()
    expect(screen.getByTestId('cell-11-20')).toBeInTheDocument()
  })

  it('renders collapse toggle button', () => {
    render(<SwimlaneRow {...defaultProps()} />)
    expect(screen.getByTitle('Collapse')).toBeInTheDocument()
  })

  it('collapsing swimlane shows compact count', async () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1, column: 10 }), makeCard({ id: 2, column: 10 })]
    render(<SwimlaneRow {...props} />)
    await userEvent.setup().click(screen.getByTitle('Collapse'))
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('collapsing swimlane hides contact email', async () => {
    render(<SwimlaneRow {...defaultProps()} />)
    expect(screen.getByText('a@test.com')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByTitle('Collapse'))
    expect(screen.queryByText('a@test.com')).not.toBeInTheDocument()
  })

  it('collapsing swimlane hides edit button', async () => {
    render(<SwimlaneRow {...defaultProps()} />)
    await userEvent.setup().click(screen.getByTitle('Collapse'))
    expect(screen.queryByTitle('Edit swimlane')).not.toBeInTheDocument()
  })

  it('collapsed swimlane shows nothing for empty cells', async () => {
    const props = defaultProps()
    props.cards = []
    render(<SwimlaneRow {...props} />)
    await userEvent.setup().click(screen.getByTitle('Collapse'))
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('shows edit button for admin', () => {
    render(<SwimlaneRow {...defaultProps()} />)
    expect(screen.getByTitle('Edit swimlane')).toBeInTheDocument()
  })

  it('hides edit button for non-admin', () => {
    const props = defaultProps()
    props.isAdmin = false
    render(<SwimlaneRow {...props} />)
    expect(screen.queryByTitle('Edit swimlane')).not.toBeInTheDocument()
  })

  it('shows card count for collapsed columns', () => {
    const props = defaultProps()
    props.collapsedColumnIds = new Set([10])
    props.cards = [makeCard({ id: 1, column: 10 })]
    render(<SwimlaneRow {...props} />)
    // Collapsed column should show count instead of BoardCell
    expect(screen.queryByTestId('cell-10-20')).not.toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('clicking edit shows EditSwimlaneModal', async () => {
    render(<SwimlaneRow {...defaultProps()} />)
    await userEvent.setup().click(screen.getByTitle('Edit swimlane'))
    expect(screen.getByTestId('edit-swimlane-modal')).toBeInTheDocument()
  })

  it('collapsed swimlane shows card count pill for non-empty cells', async () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1, column: 10 }), makeCard({ id: 2, column: 10 })]
    render(<SwimlaneRow {...props} />)
    await userEvent.setup().click(screen.getByTitle('Collapse'))
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('collapsed swimlane highlights filter matches in blue', async () => {
    const props = defaultProps()
    const card = makeCard({ id: 1, column: 10 })
    props.cards = [card]
    props.filteredCardIds = new Set([card.id])
    render(<SwimlaneRow {...props} />)
    await userEvent.setup().click(screen.getByTitle('Collapse'))
    const badge = screen.getByText('1')
    expect(badge.className).toContain('text-blue-400')
  })
})
