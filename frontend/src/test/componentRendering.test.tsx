import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mocks — keep components isolated from heavy dependencies
// ---------------------------------------------------------------------------

// Mock @dnd-kit so components that call useDraggable / useSortable don't crash
vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
}))

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, transform: null, transition: null, isDragging: false }),
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => undefined } },
}))

import CardItem from '../components/Card/CardItem'
import ColumnHeader from '../components/Board/ColumnHeader'
import type { Card, Column } from '../types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1,
    column: 10,
    swimlane: 20,
    title: 'Test Card',
    description: '',
    priority: 'medium',
    assignee: null,
    labels: [],
    due_date: null,
    weight: 1,
    position: 0,
    created_by: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_moved_at: null,
    attachment_count: 0,
    checklist_total: 0,
    checklist_done: 0,
    is_stale: false,
    ...overrides,
  }
}

function makeColumn(overrides: Partial<Column> = {}): Column {
  return {
    id: 10,
    name: 'To Do',
    position: 0,
    color: '#3B82F6',
    wip_limit: null,
    weight_limit: null,
    allow_card_creation: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// CardItem
// ---------------------------------------------------------------------------

describe('CardItem', () => {
  it('renders the card title', () => {
    render(<CardItem card={makeCard({ title: 'Fix login bug' })} />)
    expect(screen.getByText('Fix login bug')).toBeInTheDocument()
  })

  it('applies a full border color matching the priority', () => {
    const { container } = render(<CardItem card={makeCard({ priority: 'urgent' })} />)
    const root = container.firstChild as HTMLElement
    // urgent = #EF4444
    expect(root.style.borderColor.toLowerCase()).toContain('#ef4444')
  })

  it('renders label pills when labels are provided', () => {
    const card = makeCard({
      labels: [{ id: 1, name: 'Bug', color: '#EF4444' }],
    })
    render(<CardItem card={card} />)
    expect(screen.getByText('Bug')).toBeInTheDocument()
  })

  it('shows assignee initials when an assignee exists', () => {
    const card = makeCard({
      assignee: {
        id: 2,
        username: 'jdoe',
        email: 'j@example.com',
        first_name: 'Jane',
        last_name: 'Doe',
        avatar_url: '',
        display_name: 'Jane Doe',
        is_site_admin: false,
        must_change_password: false,
      },
    })
    render(<CardItem card={card} />)
    expect(screen.getByTitle('Jane Doe')).toBeInTheDocument()
    expect(screen.getByText('JD')).toBeInTheDocument()
  })

  it('shows checklist progress when checklist items exist', () => {
    const card = makeCard({ checklist_total: 5, checklist_done: 3 })
    render(<CardItem card={card} />)
    expect(screen.getByTitle('3/5 checklist items')).toBeInTheDocument()
  })

  it('applies highlight ring classes when highlighted prop is true', () => {
    const { container } = render(<CardItem card={makeCard()} highlighted />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain('ring-2')
    expect(root.className).toContain('ring-blue-400')
    expect(root.className).toContain('animate-pulse')
  })

  it('does not apply highlight ring classes when highlighted is false', () => {
    const { container } = render(<CardItem card={makeCard()} highlighted={false} />)
    const root = container.firstChild as HTMLElement
    expect(root.className).not.toContain('animate-pulse')
  })
})

// ---------------------------------------------------------------------------
// ColumnHeader
// ---------------------------------------------------------------------------

describe('ColumnHeader', () => {
  const noop = () => {}

  it('renders the column name', () => {
    render(
      <ColumnHeader
        column={makeColumn({ name: 'In Progress' })}
        cards={[]}
        boardId={1}
        isAdmin={false}
        onColumnUpdated={noop}
        onColumnDeleted={noop}
        collapsed={false}
        onToggleCollapse={noop}
      />,
    )
    expect(screen.getByText('In Progress')).toBeInTheDocument()
  })

  it('shows the card count', () => {
    const cards = [makeCard({ id: 1 }), makeCard({ id: 2 })]
    render(
      <ColumnHeader
        column={makeColumn()}
        cards={cards}
        boardId={1}
        isAdmin={false}
        onColumnUpdated={noop}
        onColumnDeleted={noop}
        collapsed={false}
        onToggleCollapse={noop}
      />,
    )
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('shows card count / WIP limit when wip_limit is set', () => {
    const cards = [makeCard()]
    render(
      <ColumnHeader
        column={makeColumn({ wip_limit: 5 })}
        cards={cards}
        boardId={1}
        isAdmin={false}
        onColumnUpdated={noop}
        onColumnDeleted={noop}
        collapsed={false}
        onToggleCollapse={noop}
      />,
    )
    expect(screen.getByText('1/5')).toBeInTheDocument()
  })

  it('renders collapsed state with vertical column name', () => {
    render(
      <ColumnHeader
        column={makeColumn({ name: 'Done' })}
        cards={[]}
        boardId={1}
        isAdmin={false}
        onColumnUpdated={noop}
        onColumnDeleted={noop}
        collapsed={true}
        onToggleCollapse={noop}
      />,
    )
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByTitle('Expand "Done"')).toBeInTheDocument()
  })
})
