import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardCell from '../components/Board/BoardCell'
import { ADD_CARD_EVENT } from '../utils/addCardEvent'
import { EscapeLowerHandlers } from './escapeSelectionProbe'
import type { Card, Column, Swimlane } from '../types'

// Mutable so a test can simulate an in-flight drag (#1287).
const dnd = vi.hoisted(() => ({ active: null as { id: string } | null }))

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useDndContext: () => ({ active: dnd.active }),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: {},
}))

vi.mock('../api/cards', () => ({ createCard: vi.fn() }))

vi.mock('../components/Card/CardItem', () => ({
  default: ({ card, onClick, compact, inDoneColumn, current, onSelect, peekSuppressed, dimmed, onExpandChange, onOpenMenu, contextTarget }: { card: Card; peekSuppressed?: boolean; onClick?: () => void; compact?: boolean; inDoneColumn?: boolean; current?: boolean; onSelect?: () => void; dimmed?: boolean; onExpandChange?: (id: number, expanded: boolean) => void; onOpenMenu?: unknown; contextTarget?: boolean }) => (
    <div data-testid={`card-${card.id}`} data-card-id={card.id} data-has-menu={String(!!onOpenMenu)} data-context-target={String(!!contextTarget)} data-compact={String(compact ?? false)} data-in-done-column={String(inDoneColumn ?? false)} data-current={String(current ?? false)} data-selectable={String(!!onSelect)} data-peek-suppressed={String(peekSuppressed ?? false)} data-dimmed={String(dimmed ?? false)} onClick={onClick}>{card.title}{onSelect && <button data-testid={`select-${card.id}`} onClick={(e) => { e.stopPropagation(); onSelect() }} />}
      <button data-testid={`expand-${card.id}`} onClick={(e) => { e.stopPropagation(); onExpandChange?.(card.id, true) }} />
      <button data-testid={`collapse-${card.id}`} onClick={(e) => { e.stopPropagation(); onExpandChange?.(card.id, false) }} />
    </div>
  ),
}))

import { createCard } from '../api/cards'
const mockCreateCard = createCard as ReturnType<typeof vi.fn>

const column: Column = { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null }
const swimlane: Swimlane = { id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null }

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Test Card', description: '',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '', updated_at: '',
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1,
    custom_field_values: [],
    blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
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
  // While one card is expanded over the cell (hover / focus in its metadata
  // row), the cell dims every other card so the expanded one reads as the
  // cell's only content.
  it('dims the other cards while one reports itself expanded, and clears when it ends', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1, title: 'A' }), makeCard({ id: 2, title: 'B' }), makeCard({ id: 3, title: 'C' })]
    render(<BoardCell {...props} />)
    expect(screen.getByTestId('card-1')).toHaveAttribute('data-dimmed', 'false')

    fireEvent.click(screen.getByTestId('expand-2'))
    expect(screen.getByTestId('card-1')).toHaveAttribute('data-dimmed', 'true')
    expect(screen.getByTestId('card-2')).toHaveAttribute('data-dimmed', 'false')
    expect(screen.getByTestId('card-3')).toHaveAttribute('data-dimmed', 'true')

    fireEvent.click(screen.getByTestId('collapse-2'))
    expect(screen.getByTestId('card-1')).toHaveAttribute('data-dimmed', 'false')
    expect(screen.getByTestId('card-3')).toHaveAttribute('data-dimmed', 'false')
  })

  it('a stale "ended" report from the previous card does not clear the neighbor that took over', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1, title: 'A' }), makeCard({ id: 2, title: 'B' })]
    render(<BoardCell {...props} />)
    fireEvent.click(screen.getByTestId('expand-1'))
    // The pointer slides onto card 2: it starts before card 1's end lands.
    fireEvent.click(screen.getByTestId('expand-2'))
    fireEvent.click(screen.getByTestId('collapse-1'))
    expect(screen.getByTestId('card-1')).toHaveAttribute('data-dimmed', 'true')
    expect(screen.getByTestId('card-2')).toHaveAttribute('data-dimmed', 'false')
  })

  // #1841: a done column's cards never age; BoardCell forwards column.is_done
  // to CardItem, which then skips the tint, aging tooltip and Stale badge
  // (CardItem's own behavior is covered in componentRendering.test.tsx).
  it.each([
    [true, 'true'],
    [false, 'false'],
  ])('passes column.is_done=%s to CardItem as inDoneColumn', (isDone, expected) => {
    const props = defaultProps()
    props.column = { ...column, is_done: isDone }
    props.cards = [makeCard({ last_moved_at: '2026-01-01T00:00:00Z', is_stale: true })]
    render(<BoardCell {...props} />)
    expect(screen.getByTestId('card-1')).toHaveAttribute('data-in-done-column', expected)
  })

  // #1914: the cell is what the card detail sheet anchors to, and it marks
  // only the open card as current.
  it('marks itself as a board cell and forwards currentCardId to the matching card only', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 }), makeCard({ id: 2, position: 1 })]
    const { container } = render(<BoardCell {...props} currentCardId={2} />)
    expect(container.querySelector('[data-board-cell]')).not.toBeNull()
    expect(screen.getByTestId('card-1')).toHaveAttribute('data-current', 'false')
    expect(screen.getByTestId('card-2')).toHaveAttribute('data-current', 'true')
  })

  it('offers no selection checkbox while a card detail sheet is open, so focus stays in the sheet', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 })]
    const { rerender } = render(<BoardCell {...props} currentCardId={null} />)
    expect(screen.getByTestId('card-1')).toHaveAttribute('data-selectable', 'true')
    fireEvent.click(screen.getByTestId('select-1'))
    expect(props.onToggleCardSelection).toHaveBeenCalledWith(1)
    rerender(<BoardCell {...props} currentCardId={7} />)
    expect(screen.getByTestId('card-1')).toHaveAttribute('data-selectable', 'false')
  })

  it('suppresses hover peeks on every card exactly while a card detail sheet is open (#1918)', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 }), makeCard({ id: 2 })]
    const { rerender } = render(<BoardCell {...props} currentCardId={null} />)
    expect(screen.getByTestId('card-1')).toHaveAttribute('data-peek-suppressed', 'false')
    rerender(<BoardCell {...props} currentCardId={2} />)
    expect(screen.getByTestId('card-1')).toHaveAttribute('data-peek-suppressed', 'true')
    expect(screen.getByTestId('card-2')).toHaveAttribute('data-peek-suppressed', 'true')
    rerender(<BoardCell {...props} currentCardId={null} />)
    expect(screen.getByTestId('card-1')).toHaveAttribute('data-peek-suppressed', 'false')
  })

  it('renders + Add card button when canEdit and allow_card_creation', () => {
    render(<BoardCell {...defaultProps()} />)
    expect(screen.getByRole('button', { name: 'Add card to To Do in Customer A' })).toBeInTheDocument()
  })

  it('keeps the card stack content-sized so a tall neighbor cell cannot stretch its cards (#2270)', () => {
    const { container } = render(<BoardCell {...defaultProps()} />)
    const cell = container.querySelector('[data-board-cell]') as HTMLElement
    expect(cell).not.toHaveClass('h-full')
    const stacks = cell.querySelectorAll('.flex-col, .grid-cols-2')
    expect(stacks.length).toBeGreaterThan(0)
    stacks.forEach((el) => {
      // One assertion per class: a negated multi-class toHaveClass only fails when the element has ALL of them.
      for (const cls of ['h-full', 'flex-1', 'grow']) expect(el).not.toHaveClass(cls)
    })
  })

  it('hides + Add card when canEdit is false', () => {
    const props = defaultProps()
    props.canEdit = false
    render(<BoardCell {...props} />)
    expect(screen.queryByRole('button', { name: /^Add card to/ })).not.toBeInTheDocument()
  })

  it('hides + Add card when column disallows card creation', () => {
    const props = defaultProps()
    props.column = { ...column, allow_card_creation: false }
    render(<BoardCell {...props} />)
    expect(screen.queryByRole('button', { name: /^Add card to/ })).not.toBeInTheDocument()
  })

  it('clicking + Add card shows input', async () => {
    render(<BoardCell {...defaultProps()} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add card to To Do in Customer A' }))
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
    expect(props.onCardClick).toHaveBeenCalledTimes(1)
    expect(props.onCardClick.mock.calls[0][0]).toBe(card)
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
    await user.click(screen.getByRole('button', { name: 'Add card to To Do in Customer A' }))
    await user.type(screen.getByPlaceholderText('Card title…'), 'New Card')
    await user.click(screen.getByText('Add'))
    expect(mockCreateCard).toHaveBeenCalledWith(1, { column: 10, swimlane: 20, title: 'New Card' })
  })

  // #1373 — handleAdd's createCard() call used to be a floating promise when
  // invoked from the Enter-key path: a rejection left the input showing the
  // typed title with no error (the existing addError UI never rendered).
  it('shows an error and keeps the input open when createCard fails (Enter key, closeEditorOnEnter)', async () => {
    mockCreateCard.mockRejectedValueOnce(new Error('network error'))
    const props = { ...defaultProps(), closeEditorOnEnter: true }
    render(<BoardCell {...props} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add card to To Do in Customer A' }))
    const input = screen.getByPlaceholderText('Card title…')
    await user.type(input, 'New Card{Enter}')

    expect(await screen.findByText('Failed to add card.')).toBeInTheDocument()
    expect(props.onCardAdded).not.toHaveBeenCalled()
    // The input stays open with the typed title so the user can retry.
    expect(screen.getByDisplayValue('New Card')).toBeInTheDocument()
  })

  it('shows card count badge when 2 or more cards are present', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 }), makeCard({ id: 2, title: 'Card B' })]
    render(<BoardCell {...props} />)
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('lifts the built-in count badge above the cards but below the sticky label and header (#1162)', () => {
    // CardItem's root is `relative z-0`; a z-auto badge paints underneath the first card.
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 }), makeCard({ id: 2, title: 'Card B' })]
    render(<BoardCell {...props} />)
    const badge = screen.getByTestId('cell-card-count')
    expect(badge.className).toContain('z-[5]')
    expect(badge.className).not.toMatch(/\bz-(10|20|30)\b/)
  })

  it('does not show count badge for a single card', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 })]
    render(<BoardCell {...props} />)
    expect(screen.queryByText('1')).not.toBeInTheDocument()
  })

  it('empty cell shows its dashed edge on hover and focus only', () => {
    const { container } = render(<BoardCell {...defaultProps()} />)
    // Quiet at rest (#2270): the dashed edge appears on hover and focus only.
    expect(container.firstChild as HTMLElement).toHaveClass('hover:border-dashed', 'focus:border-dashed')
    expect(container.firstChild as HTMLElement).not.toHaveClass('border-dashed')
  })

  it('non-empty cell does not have dashed border', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 })]
    const { container } = render(<BoardCell {...props} />)
    expect(container.firstChild as HTMLElement).not.toHaveClass('border-dashed')
  })

  it('empty addable cell renders the dashed boundary, min height and centered hover-aware Add card affordance (#200)', () => {
    const { container } = render(<BoardCell {...defaultProps()} />)
    const cell = container.firstChild as HTMLElement
    expect(cell).toHaveClass('hover:border-dashed', 'min-h-14', 'rounded-lg', 'p-[5px]', 'bg-canvas')
    const affordance = screen.getByTestId('empty-cell-add-affordance')
    expect(affordance).toHaveAttribute('aria-hidden', 'true')
    expect(affordance).toHaveClass('items-center', 'justify-center', 'group-hover/cell:text-fg')
    // Quiet plus at rest; the label appears on hover and focus only.
    expect(affordance).toHaveTextContent('+Add card')
    expect(screen.getByText('Add card', { selector: 'span' })).toHaveClass('hidden', 'group-hover/cell:inline', 'group-focus/cell:inline')
  })

  it('the column header asks a cell to open its new-card input (#2270)', async () => {
    const { container } = render(<BoardCell {...defaultProps()} />)
    const cell = container.firstChild as HTMLElement
    expect(cell).toHaveAttribute('data-column-id', '10')
    expect(cell).toHaveAttribute('data-swimlane-id')
    expect(screen.queryByPlaceholderText('Card title…')).not.toBeInTheDocument()
    act(() => { cell.dispatchEvent(new CustomEvent(ADD_CARD_EVENT)) })
    expect(screen.getByPlaceholderText('Card title…')).toBeInTheDocument()
  })

  it('a cell that cannot create cards ignores the header request (#2270)', () => {
    const { container } = render(<BoardCell {...defaultProps()} canEdit={false} />)
    act(() => { (container.firstChild as HTMLElement).dispatchEvent(new CustomEvent(ADD_CARD_EVENT)) })
    expect(screen.queryByPlaceholderText('Card title…')).not.toBeInTheDocument()
  })

  it('populated cell gets no empty treatment (#200)', () => {
    const { container } = render(<BoardCell {...defaultProps()} cards={[makeCard()]} />)
    expect(container.firstChild as HTMLElement).not.toHaveClass('border-dashed')
    expect(screen.queryByTestId('empty-cell-add-affordance')).not.toBeInTheDocument()
  })

  it('viewer sees no Add card affordance on an empty cell (#200)', () => {
    render(<BoardCell {...defaultProps()} canEdit={false} />)
    expect(screen.queryByTestId('empty-cell-add-affordance')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Add card to/ })).not.toBeInTheDocument()
  })

  it('empty cell exposes the cell itself as the add-card button with a column+swimlane accessible name (#962)', () => {
    render(<BoardCell {...defaultProps()} />)
    // Empty cells are the keyboard-reachable creation surface — the cell wrapper
    // carries role="button" with a column-and-swimlane-scoped accessible name so
    // screen readers know which slot the action targets.
    const cellAsButton = screen.getByRole('button', { name: 'Add card to To Do in Customer A' })
    expect(cellAsButton).toBeInTheDocument()
    expect(cellAsButton).toHaveAttribute('tabindex', '0')
  })

  it('empty cell does not render a separate inner + Add card button (avoids double tab-stop)', () => {
    render(<BoardCell {...defaultProps()} />)
    // The visible "+ Add card" overlay is decorative (aria-hidden) — the cell
    // itself is the only Tab stop for the create action.
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
  })

  it('Enter on a focused empty cell opens the new-card input (#962)', async () => {
    render(<BoardCell {...defaultProps()} />)
    const cell = screen.getByRole('button', { name: 'Add card to To Do in Customer A' })
    cell.focus()
    await userEvent.setup().keyboard('{Enter}')
    expect(screen.getByPlaceholderText('Card title…')).toBeInTheDocument()
  })

  it('Space on a focused empty cell opens the new-card input (#962)', async () => {
    render(<BoardCell {...defaultProps()} />)
    const cell = screen.getByRole('button', { name: 'Add card to To Do in Customer A' })
    cell.focus()
    await userEvent.setup().keyboard(' ')
    expect(screen.getByPlaceholderText('Card title…')).toBeInTheDocument()
  })

  it('clicking anywhere on an empty addable cell opens the new-card input (#962)', async () => {
    render(<BoardCell {...defaultProps()} />)
    const cell = screen.getByRole('button', { name: 'Add card to To Do in Customer A' })
    await userEvent.setup().click(cell)
    expect(screen.getByPlaceholderText('Card title…')).toBeInTheDocument()
  })

  it('non-addable empty cell is not a focusable button (canEdit false)', () => {
    const props = defaultProps()
    props.canEdit = false
    render(<BoardCell {...props} />)
    expect(screen.queryByRole('button', { name: /Add card to/i })).not.toBeInTheDocument()
  })

  it('non-addable empty cell is not a focusable button (allow_card_creation false)', () => {
    const props = defaultProps()
    props.column = { ...column, allow_card_creation: false }
    render(<BoardCell {...props} />)
    expect(screen.queryByRole('button', { name: /Add card to/i })).not.toBeInTheDocument()
  })

  it('populated cell still uses the bottom + Add card button as the affordance', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 })]
    render(<BoardCell {...props} />)
    // Populated cells keep the dense info-rich layout — the cell wrapper is no
    // longer a button, the fill-height button is the only create affordance,
    // and it is named like the empty cell (#2320).
    const buttons = screen.getAllByRole('button', { name: /Add card to/i })
    expect(buttons).toHaveLength(1)
    expect(buttons[0].tagName).toBe('BUTTON')
    expect(buttons[0]).toHaveAccessibleName('Add card to To Do in Customer A')
  })

  it('populated addable cell: the add button fills the cell with the empty-cell hover look (#2319)', () => {
    dnd.active = null
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 })]
    const { container } = render(<BoardCell {...props} />)
    const btn = screen.getByRole('button', { name: 'Add card to To Do in Customer A' })
    expect(btn).toHaveClass('flex-1', 'focus:ring-2', 'hover:border-dashed', 'hover:border-line-strong')
    // #2320: a 44px touch target, and a wash that differs from canvas in light mode
    // (surface-hover equals canvas there, so surface-hover/30 was invisible).
    expect(btn).toHaveClass('min-h-11', 'hover:bg-surface-active/50', 'focus:bg-surface-active/50')
    expect(btn).not.toHaveClass('min-h-8')
    expect(btn).not.toHaveClass('hover:bg-surface-hover/30')
    expect(btn).not.toHaveClass('opacity-0')
    expect(screen.getByText('Add card', { selector: 'span' })).toHaveClass('hidden', 'group-hover/addbtn:inline')
    expect(container.firstElementChild).toHaveClass('flex', 'flex-col')
  })

  it('populated cell: a focused add button keeps focus through a drag and after it (#2320)', () => {
    dnd.active = null
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 })]
    const { rerender } = render(<BoardCell {...props} />)
    const btn = screen.getByRole('button', { name: 'Add card to To Do in Customer A' })
    btn.focus()
    dnd.active = { id: '1' }
    rerender(<BoardCell {...props} />)
    expect(btn).toHaveFocus()
    dnd.active = null
    rerender(<BoardCell {...props} />)
    expect(btn).toHaveFocus()
    expect(btn).not.toHaveClass('opacity-0')
  })

  it('populated cell: add button is neutralized during a drag (#2319)', () => {
    dnd.active = { id: '1' }
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 })]
    render(<BoardCell {...props} />)
    // Transparent, not `invisible`: a hidden button would drop keyboard focus (#2320).
    const btn = screen.getByText('+', { selector: 'span' }).closest('button')
    expect(btn).toHaveClass('opacity-0', 'pointer-events-none')
    expect(btn).not.toHaveClass('invisible')
    dnd.active = null
  })

  it('populated cell: add button is absent when the column disallows creation (#2319)', () => {
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 })]
    props.column = { ...props.column, allow_card_creation: false }
    const { container } = render(<BoardCell {...props} />)
    expect(screen.queryByRole('button', { name: 'Add card to To Do in Customer A' })).not.toBeInTheDocument()
    expect(container.firstElementChild).not.toHaveClass('flex-col')
  })

  it('populated cell: clicking the add button opens the input and Cancel returns focus to it (#2319)', async () => {
    const user = userEvent.setup()
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 })]
    render(<BoardCell {...props} />)
    await user.click(screen.getByRole('button', { name: 'Add card to To Do in Customer A' }))
    expect(screen.getByPlaceholderText('Card title…')).toBeInTheDocument()
    await user.click(screen.getByText('Cancel'))
    expect(screen.getByRole('button', { name: 'Add card to To Do in Customer A' })).toHaveFocus()
  })

  it('right-click (or touch long-press) opens the new-card input when no drag is active', () => {
    dnd.active = null
    render(<BoardCell {...defaultProps()} />)
    const cell = screen.getByRole('button', { name: 'Add card to To Do in Customer A' })
    const notCanceled = fireEvent.contextMenu(cell)
    expect(notCanceled).toBe(false)
    expect(screen.getByPlaceholderText('Card title…')).toBeInTheDocument()
  })

  // #2059 — a right-click on a card belongs to the card's context menu; only
  // empty cell space keeps the add-card shortcut, in a populated cell too.
  it('right-click on a card face does not open the new-card input', () => {
    dnd.active = null
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 })]
    render(<BoardCell {...props} />)
    const notCanceled = fireEvent.contextMenu(screen.getByText('Test Card'))
    expect(notCanceled).toBe(true)
    expect(screen.queryByPlaceholderText('Card title…')).not.toBeInTheDocument()
  })

  it('right-click on empty space in a populated cell still opens the new-card input', () => {
    dnd.active = null
    const props = defaultProps()
    props.cards = [makeCard({ id: 1 })]
    const { container } = render(<BoardCell {...props} />)
    const cell = container.querySelector('[data-board-cell]') as HTMLElement
    expect(fireEvent.contextMenu(cell)).toBe(false)
    expect(screen.getByPlaceholderText('Card title…')).toBeInTheDocument()
  })

  it('hands every card the menu opener and outlines only the menu target', () => {
    const props = { ...defaultProps(), onOpenCardMenu: vi.fn(), contextTargetCardId: 2 }
    props.cards = [makeCard({ id: 1 }), makeCard({ id: 2, title: 'Other' })]
    render(<BoardCell {...props} />)
    expect(screen.getByTestId('card-1')).toHaveAttribute('data-has-menu', 'true')
    expect(screen.getByTestId('card-1')).toHaveAttribute('data-context-target', 'false')
    expect(screen.getByTestId('card-2')).toHaveAttribute('data-context-target', 'true')
  })

  it('a contextmenu during an active drag neither opens the input nor the native menu (#1287)', () => {
    // On Android a long-press fires `contextmenu`, and a long-press is also what
    // starts a touch drag — so this fires mid-drag in practice.
    dnd.active = { id: '1' }
    try {
      render(<BoardCell {...defaultProps()} />)
      const cell = screen.getByRole('button', { name: 'Add card to To Do in Customer A' })
      const notCanceled = fireEvent.contextMenu(cell)
      expect(notCanceled).toBe(false)
      expect(screen.queryByPlaceholderText('Card title…')).not.toBeInTheDocument()
    } finally {
      dnd.active = null
    }
  })

  // #1428 — create into a full column returns the move path's 409 body; the
  // reason replaces the generic text only for the three limit codes.
  it('shows the hard-WIP reason when create is refused at the limit', async () => {
    mockCreateCard.mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          detail: 'WIP limit enforced — move blocked.', code: 'wip_hard_blocked',
          column_name: 'To Do', current_count: 1, wip_limit: 1,
        },
      },
    })
    const props = defaultProps()
    render(<BoardCell {...props} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add card to To Do in Customer A' }))
    await user.type(screen.getByPlaceholderText('Card title…'), 'New Card')
    await user.click(screen.getByText('Add'))

    expect(
      await screen.findByText('Column at capacity — no exceptions: "To Do" is at its limit of 1 card (1 active).'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Failed to add card.')).not.toBeInTheDocument()
    expect(props.onCardAdded).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('New Card')).toBeInTheDocument()
  })

  it('keeps the generic text for a 409 that is not a limit refusal', async () => {
    mockCreateCard.mockRejectedValueOnce({
      response: { status: 409, data: { code: 'something_else', detail: 'nope' } },
    })
    const props = defaultProps()
    render(<BoardCell {...props} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add card to To Do in Customer A' }))
    await user.type(screen.getByPlaceholderText('Card title…'), 'New Card')
    await user.click(screen.getByText('Add'))
    expect(await screen.findByText('Failed to add card.')).toBeInTheDocument()
  })
})

describe('BoardCell — Escape in the add-card input (#1860)', () => {
  it('cancels the input without reaching the selection-clear handler', async () => {
    const user = userEvent.setup()
    const onLower = vi.fn()
    render(<><EscapeLowerHandlers onLower={onLower} /><BoardCell {...defaultProps()} selectedCardIds={new Set([1])} /></>)
    await user.click(screen.getByRole('button', { name: 'Add card to To Do in Customer A' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByPlaceholderText('Card title…')).not.toBeInTheDocument()
    expect(onLower).not.toHaveBeenCalled()
  })

  it('closes only the focused cell when two add-card inputs are open', async () => {
    const user = userEvent.setup()
    render(<><BoardCell {...defaultProps()} /><BoardCell {...defaultProps()} /></>)
    const adds = screen.getAllByRole('button', { name: 'Add card to To Do in Customer A' })
    await user.click(adds[0])
    await user.click(screen.getAllByRole('button', { name: 'Add card to To Do in Customer A' })[0])
    expect(screen.getAllByPlaceholderText('Card title…')).toHaveLength(2)
    await user.keyboard('{Escape}')
    expect(screen.getAllByPlaceholderText('Card title…')).toHaveLength(1)
  })

  it('lets Escape fall through when no input is open', async () => {
    const user = userEvent.setup()
    const onLower = vi.fn()
    render(<><EscapeLowerHandlers onLower={onLower} /><BoardCell {...defaultProps()} /></>)
    await user.keyboard('{Escape}')
    expect(onLower).toHaveBeenCalled()
  })
})

describe('BoardCell — focus returns to the add-card opener (#2087)', () => {
  it('empty cell: Escape returns focus to the cell', async () => {
    const user = userEvent.setup()
    render(<BoardCell {...defaultProps()} />)
    await user.click(screen.getByRole('button', { name: 'Add card to To Do in Customer A' }))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: /^Add card to/ })).toHaveFocus()
  })
  it('empty cell: Cancel returns focus to the cell', async () => {
    const user = userEvent.setup()
    render(<BoardCell {...defaultProps()} />)
    await user.click(screen.getByRole('button', { name: 'Add card to To Do in Customer A' }))
    await user.click(screen.getByText('Cancel'))
    expect(screen.getByRole('button', { name: /^Add card to/ })).toHaveFocus()
  })
  it('empty cell: a committed add returns focus to the cell', async () => {
    const user = userEvent.setup()
    mockCreateCard.mockResolvedValue(makeCard({ id: 99, title: 'N' }))
    render(<BoardCell {...defaultProps()} />)
    await user.click(screen.getByRole('button', { name: 'Add card to To Do in Customer A' }))
    await user.type(screen.getByPlaceholderText('Card title…'), 'N')
    await user.click(screen.getByText('Add'))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Add card to/ })).toHaveFocus())
  })
  describe('populated cell', () => {
    const populated = () => ({ ...defaultProps(), cards: [makeCard({ id: 1, title: 'A' })] })
    it('Escape returns focus to the + Add card button', async () => {
      const user = userEvent.setup()
      render(<BoardCell {...populated()} />)
      await user.click(screen.getByRole('button', { name: 'Add card to To Do in Customer A' }))
      await user.keyboard('{Escape}')
      expect(screen.getByRole('button', { name: 'Add card to To Do in Customer A' })).toHaveFocus()
    })
    it('Cancel returns focus to the + Add card button', async () => {
      const user = userEvent.setup()
      render(<BoardCell {...populated()} />)
      await user.click(screen.getByRole('button', { name: 'Add card to To Do in Customer A' }))
      await user.click(screen.getByText('Cancel'))
      expect(screen.getByRole('button', { name: 'Add card to To Do in Customer A' })).toHaveFocus()
    })
    it('a committed add returns focus to the + Add card button', async () => {
      const user = userEvent.setup()
      mockCreateCard.mockResolvedValue(makeCard({ id: 99, title: 'N' }))
      render(<BoardCell {...populated()} />)
      await user.click(screen.getByRole('button', { name: 'Add card to To Do in Customer A' }))
      await user.type(screen.getByPlaceholderText('Card title…'), 'N')
      await user.click(screen.getByText('Add'))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Add card to To Do in Customer A' })).toHaveFocus())
    })
  })
})

describe('BoardCell gated stage (#2278)', () => {
  const stage: Column = {
    ...column,
    sub_columns: [{ id: 1, uid: 's1', position: 0, name: 'Doing' }, { id: 2, uid: 's2', position: 1, name: 'Ready' }],
    tracks: [{ id: 1, field_id: 41, field_uid: 'f41', name: 'Technical', position: 0 }],
  }

  it('renders one named drop group per sub-column, cards by gates_passed in position order', () => {
    const props = defaultProps()
    props.column = stage
    props.cards = [makeCard({ id: 1, gates_passed: 1, position: 1 }), makeCard({ id: 2, gates_passed: 0, position: 0 }), makeCard({ id: 3, gates_passed: 1, position: 0 })]
    render(<BoardCell {...props} />)
    const doing = screen.getByRole('group', { name: 'To Do: Doing' })
    const ready = screen.getByRole('group', { name: 'To Do: Ready' })
    expect(doing).toHaveAttribute('data-sub-column-drop', 'cell:10:20:0')
    expect(Array.from(doing.querySelectorAll('[data-card-id]')).map((e) => e.getAttribute('data-card-id'))).toEqual(['2'])
    expect(Array.from(ready.querySelectorAll('[data-card-id]')).map((e) => e.getAttribute('data-card-id'))).toEqual(['3', '1'])
  })

  it('renders a single well with "Show sub-columns" off', () => {
    const props = defaultProps()
    props.column = stage
    props.cards = [makeCard({ id: 1, gates_passed: 1 })]
    render(<BoardCell {...props} showSubColumns={false} />)
    expect(screen.queryByTestId('cell-sub-columns')).not.toBeInTheDocument()
    expect(screen.getByTestId('card-1')).toBeInTheDocument()
  })
})

describe('BoardCell lane default team (#2211)', () => {
  const mia = { id: 10, username: 'mia', display_name: 'Mia Reyes', avatar_url: '' }
  const laneDefault = { assignee: mia, others: ['Dan Kovacs'] }

  it('shows the pre-assigned member with the caption and sends them as the assignee', async () => {
    mockCreateCard.mockResolvedValue(makeCard({ id: 98 }))
    render(<BoardCell {...defaultProps()} laneDefault={laneDefault} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add card to To Do in Customer A' }))
    const group = screen.getByRole('group', { name: 'Assignees' })
    expect(group).toHaveTextContent('Mia Reyes')
    expect(group).toHaveTextContent("From the Customer A default team. Remove anyone this card shouldn't have. Also on the team, not assigned: Dan Kovacs.")
    await user.type(screen.getByPlaceholderText('Card title…'), 'Renewal')
    await user.click(screen.getByText('Add'))
    await waitFor(() => expect(mockCreateCard).toHaveBeenCalledWith(1, { column: 10, swimlane: 20, title: 'Renewal', assignee_id: 10 }))
  })

  it('Unassign creates the card with no assignee', async () => {
    mockCreateCard.mockClear()
    mockCreateCard.mockResolvedValue(makeCard({ id: 97 }))
    render(<BoardCell {...defaultProps()} laneDefault={laneDefault} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add card to To Do in Customer A' }))
    await user.click(screen.getByRole('button', { name: 'Unassign Mia Reyes' }))
    expect(screen.getByRole('group', { name: 'Assignees' })).toHaveTextContent('No one.')
    await user.type(screen.getByPlaceholderText('Card title…'), 'Renewal')
    await user.click(screen.getByText('Add'))
    await waitFor(() => expect(mockCreateCard).toHaveBeenCalledWith(1, { column: 10, swimlane: 20, title: 'Renewal' }))
  })

  it('renders no Assignees group for a lane without a team', async () => {
    render(<BoardCell {...defaultProps()} laneDefault={null} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add card to To Do in Customer A' }))
    expect(screen.queryByRole('group', { name: 'Assignees' })).toBeNull()
  })
})
