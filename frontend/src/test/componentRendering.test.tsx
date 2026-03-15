import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Avatar from '../components/Common/Avatar'

// ---------------------------------------------------------------------------
// Mocks — keep components isolated from heavy dependencies
// ---------------------------------------------------------------------------

// Mock @dnd-kit so components that call useDraggable / useSortable don't crash
vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
}))

vi.mock('../api/boards', () => ({
  updateColumn: vi.fn(),
  updateSwimlane: vi.fn().mockResolvedValue({
    id: 20, name: 'Renamed', contact_email: '', notes: '', position: 0,
    color: '#6B7280', is_collapsed: false, created_at: '',
  }),
}))

vi.mock('../components/Board/BoardCell', () => ({ default: () => <div /> }))
vi.mock('../components/Board/EditSwimlaneModal', () => ({ default: () => <div data-testid="edit-modal" /> }))

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

  it('shows due date string when due_date is set to tomorrow', () => {
    // Use a fixed date well in the future (more than 1 day, less than 7) to avoid timezone edge cases
    // The card renders "Nd" format for 2-6 days out
    const futureDate = new Date()
    futureDate.setDate(futureDate.getDate() + 3)
    // Format as local YYYY-MM-DD to match how the component interprets dates
    const iso = `${futureDate.getFullYear()}-${String(futureDate.getMonth() + 1).padStart(2, '0')}-${String(futureDate.getDate()).padStart(2, '0')}`
    render(<CardItem card={makeCard({ due_date: iso })} />)
    // Should show "3d" label — test that the due date indicator renders
    expect(screen.getByTitle(`Due ${iso}`)).toBeInTheDocument()
  })

  it('shows overdue styling with red text when due_date is in the past', () => {
    // Use a date 5 days in the past — safely overdue in any timezone
    const pastDate = new Date()
    pastDate.setDate(pastDate.getDate() - 5)
    const iso = `${pastDate.getFullYear()}-${String(pastDate.getMonth() + 1).padStart(2, '0')}-${String(pastDate.getDate()).padStart(2, '0')}`
    render(<CardItem card={makeCard({ due_date: iso })} />)
    // The overdue span has text-red-500 class
    const dueBadge = screen.getByTitle(`Due ${iso}`)
    expect(dueBadge.className).toContain('text-red-500')
  })

  it('shows attachment count when attachment_count > 0', () => {
    render(<CardItem card={makeCard({ attachment_count: 3 })} />)
    expect(screen.getByTitle('3 attachment(s)')).toBeInTheDocument()
  })

  it('shows weight value when weight > 1', () => {
    render(<CardItem card={makeCard({ weight: 5 })} />)
    expect(screen.getByTitle('Weight: 5')).toBeInTheDocument()
  })

  it('shows stale indicator when is_stale is true', () => {
    const { container } = render(<CardItem card={makeCard({ is_stale: true })} />)
    expect(screen.getByTitle('Stale — no movement recently')).toBeInTheDocument()
    // Stale card gets amber ring
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain('ring-amber-400')
  })

  it('shows recently moved dot when last_moved_at is within 24 hours', () => {
    const recentlyMoved = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    render(<CardItem card={makeCard({ last_moved_at: recentlyMoved })} />)
    expect(screen.getByTitle('Recently moved')).toBeInTheDocument()
  })

  it('does not show recently moved dot for stale card even if last_moved_at is recent', () => {
    const recentlyMoved = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    render(<CardItem card={makeCard({ last_moved_at: recentlyMoved, is_stale: true })} />)
    // Stale indicator should be present, recently moved dot should not
    expect(screen.getByTitle('Stale — no movement recently')).toBeInTheDocument()
    expect(screen.queryByTitle('Recently moved')).not.toBeInTheDocument()
  })

  it('renders cleanly with no metadata (all null/zero values)', () => {
    const card = makeCard({
      labels: [], checklist_total: 0, attachment_count: 0, due_date: null,
      assignee: null, weight: 1, is_stale: false, last_moved_at: null,
    })
    const { container } = render(<CardItem card={card} />)
    // Should render title without crashing
    expect(screen.getByText('Test Card')).toBeInTheDocument()
    // No metadata section should render (no labels, checklist, etc.)
    expect(container.firstChild).toBeInTheDocument()
  })

  it('renders selection checkbox when onSelect is provided and selected', () => {
    render(<CardItem card={makeCard()} onSelect={vi.fn()} selected={true} />)
    // selected card should have blue ring
    const { container } = render(<CardItem card={makeCard()} onSelect={vi.fn()} selected={true} />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain('ring-blue-400')
  })

  it('shows a due date indicator when due_date is set to today (local date)', () => {
    const now = new Date()
    // Format as local YYYY-MM-DD (same interpretation as formatDueDate)
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    render(<CardItem card={makeCard({ due_date: today })} />)
    // Component shows "Today" for local today — verify the due date element renders
    expect(screen.getByTitle(`Due ${today}`)).toBeInTheDocument()
  })

  it('shows label overflow count when more than 3 labels', () => {
    const card = makeCard({
      labels: [
        { id: 1, name: 'Bug', color: '#EF4444' },
        { id: 2, name: 'Feature', color: '#3B82F6' },
        { id: 3, name: 'Docs', color: '#10B981' },
        { id: 4, name: 'Test', color: '#F59E0B' },
      ],
    })
    render(<CardItem card={card} />)
    expect(screen.getByText('+1')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

describe('Avatar', () => {
  const baseUser = {
    username: 'jdoe', avatar_url: '', display_name: 'Jane Doe',
    first_name: 'Jane', last_name: 'Doe',
  }

  it('renders ? when user is null', () => {
    render(<Avatar user={null} />)
    expect(screen.getByText('?')).toBeInTheDocument()
  })

  it('renders ? when user is undefined', () => {
    render(<Avatar user={undefined} />)
    expect(screen.getByText('?')).toBeInTheDocument()
  })

  it('renders an img when avatar_url is set', () => {
    render(<Avatar user={{ ...baseUser, avatar_url: 'https://example.com/avatar.png' }} />)
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('src', 'https://example.com/avatar.png')
    expect(img).toHaveAttribute('alt', 'Jane Doe')
  })

  it('renders initials from display_name when no avatar', () => {
    render(<Avatar user={baseUser} />)
    expect(screen.getByText('JD')).toBeInTheDocument()
  })

  it('falls back to username initials when no name fields', () => {
    render(<Avatar user={{ username: 'xray', avatar_url: '', display_name: '' }} />)
    expect(screen.getByText('XR')).toBeInTheDocument()
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
    expect(screen.getByTitle('Cards in column / WIP limit')).toHaveTextContent('2')
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

  it('hides WIP row when wip_limit is null', () => {
    render(
      <ColumnHeader
        column={makeColumn({ wip_limit: null })}
        cards={[makeCard()]}
        boardId={1}
        isAdmin={false}
        onColumnUpdated={noop}
        onColumnDeleted={noop}
        collapsed={false}
        onToggleCollapse={noop}
      />,
    )
    expect(screen.queryByTitle('Cards in column / WIP limit')).not.toBeInTheDocument()
  })

  it('hides Weight row when total card weight is zero', () => {
    render(
      <ColumnHeader
        column={makeColumn()}
        cards={[makeCard({ weight: 0 })]}
        boardId={1}
        isAdmin={false}
        onColumnUpdated={noop}
        onColumnDeleted={noop}
        collapsed={false}
        onToggleCollapse={noop}
      />,
    )
    expect(screen.queryByTitle('Total card weight / weight budget')).not.toBeInTheDocument()
  })

  it('shows Weight row when total card weight is non-zero', () => {
    render(
      <ColumnHeader
        column={makeColumn({ weight_limit: 10 })}
        cards={[makeCard({ weight: 3 }), makeCard({ id: 2, weight: 2 })]}
        boardId={1}
        isAdmin={false}
        onColumnUpdated={noop}
        onColumnDeleted={noop}
        collapsed={false}
        onToggleCollapse={noop}
      />,
    )
    expect(screen.getByTitle('Total card weight / weight budget')).toBeInTheDocument()
    expect(screen.getByText('5/10')).toBeInTheDocument()
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
    expect(screen.getByText('DON')).toBeInTheDocument()
    expect(screen.getByTitle('Expand "Done"')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// SwimlaneRow — inline rename
// ---------------------------------------------------------------------------

import SwimlaneRow from '../components/Board/SwimlaneRow'
import type { Swimlane } from '../types'

function makeSwimlane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 20, name: 'Customer A', contact_email: 'a@example.com', notes: '',
    position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01',
    ...overrides,
  }
}

const swimlaneRowBaseProps = {
  columns: [],
  cards: [],
  boardId: 1,
  canEdit: true,
  closeEditorOnEnter: false,
  collapsedColumnIds: new Set<number>(),
  filteredCardIds: null,
  selectedCardIds: new Set<number>(),
  onToggleCardSelection: () => {},
  onCardClick: () => {},
  onCardAdded: () => {},
  onSwimlaneUpdated: () => {},
  onSwimlaneDeleted: () => {},
}

describe('SwimlaneRow', () => {
  it('renders the swimlane name', () => {
    render(<SwimlaneRow swimlane={makeSwimlane()} isAdmin={false} {...swimlaneRowBaseProps} />)
    expect(screen.getByText('Customer A')).toBeInTheDocument()
  })

  it('clicking the swimlane name shows a rename input when isAdmin', async () => {
    render(<SwimlaneRow swimlane={makeSwimlane()} isAdmin={true} {...swimlaneRowBaseProps} />)
    await userEvent.setup().click(screen.getByText('Customer A'))
    const input = screen.getByRole('textbox')
    expect(input).toBeInTheDocument()
    expect((input as HTMLInputElement).value).toBe('Customer A')
  })

  it('does not enter rename mode when isAdmin is false', async () => {
    render(<SwimlaneRow swimlane={makeSwimlane()} isAdmin={false} {...swimlaneRowBaseProps} />)
    await userEvent.setup().click(screen.getByText('Customer A'))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('pressing Escape cancels the rename', async () => {
    render(<SwimlaneRow swimlane={makeSwimlane()} isAdmin={true} {...swimlaneRowBaseProps} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('Customer A'))
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('Customer A')).toBeInTheDocument()
  })

  it('edit button (✎) opens the EditSwimlaneModal when isAdmin', async () => {
    render(<SwimlaneRow swimlane={makeSwimlane()} isAdmin={true} {...swimlaneRowBaseProps} />)
    await userEvent.setup().click(screen.getByTitle('Edit swimlane'))
    expect(screen.getByTestId('edit-modal')).toBeInTheDocument()
  })

  it('collapsed cell shows total count when no filter is active', () => {
    const col = makeColumn({ id: 5 })
    const card = makeCard({ id: 99, column: 5, swimlane: 20 })
    const { container } = render(
      <SwimlaneRow
        swimlane={makeSwimlane()}
        isAdmin={false}
        {...swimlaneRowBaseProps}
        columns={[col]}
        cards={[card]}
        collapsedColumnIds={new Set([5])}
        filteredCardIds={null}
      />
    )
    expect(screen.getByText('1')).toBeInTheDocument()
    // no pulse class when filter is inactive
    const cell = container.querySelector('.animate-pulse')
    expect(cell).toBeNull()
  })

  it('collapsed cell pulses and shows match count when filter has matches', () => {
    const col = makeColumn({ id: 5 })
    const matchCard = makeCard({ id: 99, column: 5, swimlane: 20 })
    const otherCard = makeCard({ id: 100, column: 5, swimlane: 20 })
    const { container } = render(
      <SwimlaneRow
        swimlane={makeSwimlane()}
        isAdmin={false}
        {...swimlaneRowBaseProps}
        columns={[col]}
        cards={[matchCard, otherCard]}
        collapsedColumnIds={new Set([5])}
        filteredCardIds={new Set([99])}
      />
    )
    // shows match count (1), not total (2)
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.queryByText('2')).not.toBeInTheDocument()
    // pulse highlight applied
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
  })

  it('collapsed cell shows total count (no pulse) when filter is active but no matches in this cell', () => {
    const col = makeColumn({ id: 5 })
    const card = makeCard({ id: 99, column: 5, swimlane: 20 })
    const { container } = render(
      <SwimlaneRow
        swimlane={makeSwimlane()}
        isAdmin={false}
        {...swimlaneRowBaseProps}
        columns={[col]}
        cards={[card]}
        collapsedColumnIds={new Set([5])}
        filteredCardIds={new Set([999])}
      />
    )
    // total count still shown
    expect(screen.getByText('1')).toBeInTheDocument()
    // no pulse when no matches
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })
})
