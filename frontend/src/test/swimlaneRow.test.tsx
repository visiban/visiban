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
  { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
  { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
]

const swimlane: Swimlane = {
  id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: 'a@test.com', notes: '', position: 0,
  color: '#6B7280', is_collapsed: false, created_at: '2026-01-01',
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Test Card', description: '',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '', updated_at: '',
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
    version: 1,
    ...overrides,
  }
}

// collapsed/onToggleCollapse/onFocus/isFocused are now controlled props (Step 2 of #340).
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
  collapsed: false,
  onToggleCollapse: vi.fn(),
  onFocus: vi.fn(),
  onExitFocus: vi.fn(),
  isFocused: false,
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
    expect(screen.getByTitle('Collapse Customer A')).toBeInTheDocument()
  })

  it('collapse button calls onToggleCollapse (controlled — no internal state)', async () => {
    const props = defaultProps()
    render(<SwimlaneRow {...props} />)
    await userEvent.setup().click(screen.getByTitle('Collapse Customer A'))
    expect(props.onToggleCollapse).toHaveBeenCalledTimes(1)
  })

  it('collapsed=true shows compact count (controlled prop)', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1, column: 10 }), makeCard({ id: 2, column: 10 })]
    props.collapsed = true
    render(<SwimlaneRow {...props} />)
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('collapsed=true hides contact email', () => {
    const props = defaultProps()
    props.collapsed = true
    render(<SwimlaneRow {...props} />)
    expect(screen.queryByText('a@test.com')).not.toBeInTheDocument()
  })

  it('collapsed=true hides edit button', () => {
    const props = defaultProps()
    props.collapsed = true
    render(<SwimlaneRow {...props} />)
    expect(screen.queryByTitle('Edit swimlane')).not.toBeInTheDocument()
  })

  it('collapsed=true shows nothing for empty cells', () => {
    const props = defaultProps()
    props.cards = []
    props.collapsed = true
    render(<SwimlaneRow {...props} />)
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

  it('collapsed=true shows card count pill for non-empty cells', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1, column: 10 }), makeCard({ id: 2, column: 10 })]
    props.collapsed = true
    render(<SwimlaneRow {...props} />)
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('collapsed=true highlights filter matches in blue', () => {
    const props = defaultProps()
    const card = makeCard({ id: 1, column: 10 })
    props.cards = [card]
    props.filteredCardIds = new Set([card.id])
    props.collapsed = true
    render(<SwimlaneRow {...props} />)
    const badge = screen.getByText('1')
    expect(badge.className).toContain('text-blue-400')
  })

  it('renders focus icon button with tooltip when not focused', () => {
    render(<SwimlaneRow {...defaultProps()} />)
    expect(screen.getByTitle('Focus on Customer A')).toBeInTheDocument()
  })

  it('clicking focus button calls onFocus with swimlane id when not focused', async () => {
    const props = defaultProps()
    render(<SwimlaneRow {...props} />)
    await userEvent.setup().click(screen.getByTitle('Focus on Customer A'))
    expect(props.onFocus).toHaveBeenCalledWith(20)
    expect(props.onExitFocus).not.toHaveBeenCalled()
  })

  it('isFocused=true renders focus icon with blue color class and updated title', () => {
    const props = defaultProps()
    props.isFocused = true
    render(<SwimlaneRow {...props} />)
    const btn = screen.getByTitle('Exit focus')
    expect(btn.className).toContain('text-blue-400')
  })

  it('isFocused=true sets aria-pressed=true on focus button', () => {
    const props = defaultProps()
    props.isFocused = true
    render(<SwimlaneRow {...props} />)
    const btn = screen.getByTitle('Exit focus')
    expect(btn).toHaveAttribute('aria-pressed', 'true')
  })

  it('aria-pressed=false when not focused', () => {
    render(<SwimlaneRow {...defaultProps()} />)
    const btn = screen.getByTitle('Focus on Customer A')
    expect(btn).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking focused crosshair calls onExitFocus, not onFocus', async () => {
    const props = defaultProps()
    props.isFocused = true
    render(<SwimlaneRow {...props} />)
    await userEvent.setup().click(screen.getByTitle('Exit focus'))
    expect(props.onExitFocus).toHaveBeenCalled()
    expect(props.onFocus).not.toHaveBeenCalled()
  })

  it('collapse button has aria-pressed=false when not collapsed', () => {
    render(<SwimlaneRow {...defaultProps()} />)
    const btn = screen.getByTitle('Collapse Customer A')
    expect(btn).toHaveAttribute('aria-pressed', 'false')
  })

  it('collapse button has aria-pressed=true when collapsed', () => {
    const props = defaultProps()
    props.collapsed = true
    render(<SwimlaneRow {...props} />)
    const btn = screen.getByTitle('Expand Customer A')
    expect(btn).toHaveAttribute('aria-pressed', 'true')
  })

  it('collapse button title reflects collapsed state', () => {
    render(<SwimlaneRow {...defaultProps()} />)
    expect(screen.getByTitle('Collapse Customer A')).toBeInTheDocument()
  })

  it('collapse button title reflects expanded state when collapsed=true', () => {
    const props = defaultProps()
    props.collapsed = true
    render(<SwimlaneRow {...props} />)
    expect(screen.getByTitle('Expand Customer A')).toBeInTheDocument()
  })

  it('calls onHoverEnter on mouseenter', async () => {
    const props = defaultProps()
    const onHoverEnter = vi.fn()
    const onHoverLeave = vi.fn()
    const { container } = render(<SwimlaneRow {...props} onHoverEnter={onHoverEnter} onHoverLeave={onHoverLeave} />)
    const row = container.querySelector('.relative.flex.border-b') as HTMLElement
    await userEvent.setup().pointer({ target: row, type: 'mouseenter' })
    expect(onHoverEnter).toHaveBeenCalled()
  })

  it('calls onHoverLeave on mouseleave', async () => {
    const props = defaultProps()
    const onHoverEnter = vi.fn()
    const onHoverLeave = vi.fn()
    const { container } = render(<SwimlaneRow {...props} onHoverEnter={onHoverEnter} onHoverLeave={onHoverLeave} />)
    const row = container.querySelector('.relative.flex.border-b') as HTMLElement
    await userEvent.setup().pointer([
      { target: row, type: 'mouseenter' },
      { target: document.body, type: 'mouseleave' },
    ])
    expect(onHoverLeave).toHaveBeenCalled()
  })
})
