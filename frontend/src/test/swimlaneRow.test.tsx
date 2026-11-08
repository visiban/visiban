import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SwimlaneRow from '../components/Board/SwimlaneRow'
import { EscapeLowerHandlers } from './escapeSelectionProbe'
import type { Card, Column, Swimlane } from '../types'
import { cellKey } from '../gridOverlays/types'
import { encodeOverlayLevel } from '../gridOverlays/scale'

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
  default: ({ column, swimlane, overlayCell, overlayLabel, currentCardId }: { column: Column; swimlane: Swimlane; overlayCell?: { value: number } | null; overlayLabel?: string; currentCardId?: number | null }) => (
    <div
      data-testid={`cell-${column.id}-${swimlane.id}`}
      data-current-card-id={String(currentCardId ?? '')}
      data-overlay-value={overlayCell ? String(overlayCell.value) : ''}
      data-overlay-label={overlayLabel ?? ''}
    >
      Cell
    </div>
  ),
}))

vi.mock('../components/Board/EditSwimlaneModal', () => ({
  default: ({ userDateFormat }: { userDateFormat?: string }) => <div data-testid="edit-swimlane-modal" data-date-format={userDateFormat}>Edit Swimlane</div>,
}))

vi.mock('../api/cards', () => ({ createCard: vi.fn() }))

const columns: Column[] = [
  { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
  { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
]

const swimlane: Swimlane = {
  id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: 'a@test.com', notes: '', position: 0,
  color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null,
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Test Card', description: '',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '', updated_at: '',
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
    version: 1,
    custom_field_values: [],
    blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
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

  it('keeps the sticky label panel opaque on hover so scrolled cards never show through', () => {
    const { container } = render(<SwimlaneRow {...defaultProps()} />)
    const panel = container.querySelector('[data-tour-step="swimlane"]') as HTMLElement
    expect(panel.className).toContain('bg-surface')
    // A hover:bg-* here would swap the opaque background for a translucent one.
    expect(panel.className).not.toMatch(/(^|\s)hover:bg-/)
  })

  // #1914: the card detail sheet never covers the lane labels; it finds
  // their right edge by this marker on the sticky label panel.
  it('marks the sticky label panel for the card detail sheet and forwards currentCardId to cells', () => {
    const { container } = render(<SwimlaneRow {...defaultProps()} currentCardId={7} />)
    const panel = container.querySelector('[data-tour-step="swimlane"]') as HTMLElement
    expect(panel).toHaveAttribute('data-lane-label')
    expect(container.querySelector('[data-current-card-id="7"]')).not.toBeNull()
  })

  it('hides the hover "+" in the column separator from assistive tech (#2012)', () => {
    render(<SwimlaneRow {...defaultProps()} onInsertColumn={vi.fn()} hoveredSepIndex={1} />)
    const glyph = screen.getByText('+')
    expect(glyph).toHaveAttribute('aria-hidden', 'true')
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

  it('passes userDateFormat through to EditSwimlaneModal (#1993)', async () => {
    render(<SwimlaneRow {...defaultProps()} userDateFormat="DD/MM/YYYY" />)
    await userEvent.setup().click(screen.getByTitle('Edit swimlane'))
    expect(screen.getByTestId('edit-swimlane-modal')).toHaveAttribute('data-date-format', 'DD/MM/YYYY')
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
    expect(badge.className).toContain('text-info')
  })

  it('collapsed=true match cell pulses with a reduced-motion opt-out (#199)', () => {
    const props = defaultProps()
    const card = makeCard({ id: 1, column: 10 })
    props.cards = [card]
    props.filteredCardIds = new Set([card.id])
    props.collapsed = true
    render(<SwimlaneRow {...props} />)
    expect(screen.getByText('1').parentElement).toHaveClass('animate-pulse', 'motion-reduce:animate-none')
  })

  it('renders focus icon button with tooltip when not focused', () => {
    render(<SwimlaneRow {...defaultProps()} />)
    expect(screen.getByTitle('Focus on Customer A')).toBeInTheDocument()
  })

  it('focus button has an accessible name that does not depend on title alone', () => {
    render(<SwimlaneRow {...defaultProps()} />)
    // title alone is not a reliable accessible name (Firefox/VoiceOver skip it); assert the
    // attribute directly since aria-label and title share the same text here, so getByRole's
    // computed-name resolution would pass via the title fallback even without aria-label
    expect(screen.getByTitle('Focus on Customer A')).toHaveAttribute('aria-label', 'Focus on Customer A')
  })

  it('isFocused=true gives the focus button an "Exit focus" accessible name', () => {
    const props = defaultProps()
    props.isFocused = true
    render(<SwimlaneRow {...props} />)
    // assert the attribute directly — aria-label and title share the same text here, so
    // getByRole's computed-name resolution would pass via the title fallback regardless
    expect(screen.getByTitle('Exit focus')).toHaveAttribute('aria-label', 'Exit focus')
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
    expect(btn.className).toContain('text-info')
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

  it('calls onHoverEnter on mouseenter', () => {
    const props = defaultProps()
    const onHoverEnter = vi.fn()
    const onHoverLeave = vi.fn()
    const { container } = render(<SwimlaneRow {...props} onHoverEnter={onHoverEnter} onHoverLeave={onHoverLeave} />)
    const row = container.querySelector('.relative.flex.border-b') as HTMLElement
    fireEvent.mouseEnter(row)
    expect(onHoverEnter).toHaveBeenCalled()
  })

  it('calls onHoverLeave on mouseleave', () => {
    const props = defaultProps()
    const onHoverEnter = vi.fn()
    const onHoverLeave = vi.fn()
    const { container } = render(<SwimlaneRow {...props} onHoverEnter={onHoverEnter} onHoverLeave={onHoverLeave} />)
    const row = container.querySelector('.relative.flex.border-b') as HTMLElement
    fireEvent.mouseEnter(row)
    fireEvent.mouseLeave(row)
    expect(onHoverLeave).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Grid overlay plumbing (#1147)
// ---------------------------------------------------------------------------

describe('SwimlaneRow — grid overlay lookup (#1147)', () => {
  const overlayCells = () =>
    new Map([
      [cellKey(10, 20), { value: 3, label: '3 cards', display: '3', encoding: encodeOverlayLevel(4) }],
    ])

  it('hands each cell its own value and nothing to the cells with none', () => {
    render(<SwimlaneRow {...defaultProps()} overlayCells={overlayCells()} overlayLabel="Card count" />)
    expect(screen.getByTestId('cell-10-20')).toHaveAttribute('data-overlay-value', '3')
    expect(screen.getByTestId('cell-10-20')).toHaveAttribute('data-overlay-label', 'Card count')
    // Column 11 has no entry in the map — the cell renders untouched.
    expect(screen.getByTestId('cell-11-20')).toHaveAttribute('data-overlay-value', '')
  })

  it('passes nothing at all when no overlay is active', () => {
    render(<SwimlaneRow {...defaultProps()} />)
    expect(screen.getByTestId('cell-10-20')).toHaveAttribute('data-overlay-value', '')
    expect(screen.getByTestId('cell-10-20')).toHaveAttribute('data-overlay-label', '')
  })

  it('leaves a collapsed column as its count stub, with no BoardCell to shade', () => {
    render(
      <SwimlaneRow
        {...defaultProps()}
        cards={[makeCard({ id: 1, column: 10 })]}
        collapsedColumnIds={new Set([10])}
        overlayCells={overlayCells()}
        overlayLabel="Card count"
      />,
    )
    expect(screen.queryByTestId('cell-10-20')).not.toBeInTheDocument()
  })
})

describe('SwimlaneRow — keyboard rename (#1376)', () => {
  it('admin name is a button; Enter starts inline rename', async () => {
    const user = userEvent.setup()
    render(<SwimlaneRow {...defaultProps()} />)
    const nameBtn = screen.getByRole('button', { name: 'Customer A' })
    nameBtn.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByDisplayValue('Customer A')).toBeInTheDocument()
  })

  it('non-admin name is plain text, not a button', () => {
    render(<SwimlaneRow {...defaultProps()} isAdmin={false} />)
    expect(screen.queryByRole('button', { name: 'Customer A' })).not.toBeInTheDocument()
    expect(screen.getByText('Customer A')).toBeInTheDocument()
  })
})

describe('SwimlaneRow — row limit state (#1150)', () => {
  const cardsIn = (n: number, weight = 1, column = 10) =>
    Array.from({ length: n }, (_, i) => makeCard({ id: 100 + i, uid: `c${i}`, column, weight }))
  const stat = () => screen.queryByTestId('swimlane-limit-stat')
  const limited = (overrides: Partial<Swimlane>) => ({ ...swimlane, ...overrides })

  it('shows nothing for a row without limits', () => {
    render(<SwimlaneRow {...defaultProps()} cards={cardsIn(3)} />)
    expect(stat()).toBeNull()
  })

  it('under: calm WIP n/limit in a tertiary tone, no accent', () => {
    const { container } = render(<SwimlaneRow {...defaultProps()} swimlane={limited({ wip_limit: 6 })} cards={cardsIn(4)} />)
    expect(stat()).toHaveTextContent('WIP 4/6')
    expect(stat()!.className).toContain('text-fg-tertiary')
    expect(container.querySelector('.bg-danger-emphasis.h-0\\.5')).toBeNull()
  })

  it('at: says "at limit" in text, not color alone, when the board opts in', () => {
    render(<SwimlaneRow {...defaultProps()} showWipAtLimit swimlane={limited({ wip_limit: 5 })} cards={cardsIn(5)} />)
    expect(stat()).toHaveTextContent('WIP 5/5 · at limit')
    expect(stat()!.className).toContain('text-fg-secondary')
  })

  it('at, with the board opt-in off (the default): reads like under, as the column header does', () => {
    render(<SwimlaneRow {...defaultProps()} swimlane={limited({ wip_limit: 5 })} cards={cardsIn(5)} />)
    expect(stat()).toHaveTextContent('WIP 5/5')
    expect(stat()).not.toHaveTextContent('at limit')
    expect(stat()!.className).toContain('text-fg-tertiary')
  })

  it('over WIP: danger text, the ⚠ glyph and the top accent strip; ⛔ when hard', () => {
    const { container, rerender } = render(
      <SwimlaneRow {...defaultProps()} swimlane={limited({ wip_limit: 4 })} cards={cardsIn(5)} />,
    )
    expect(stat()).toHaveTextContent('⚠ Over WIP · 5/4')
    expect(stat()!.className).toContain('text-danger')
    expect(container.querySelector('.bg-danger-emphasis.h-0\\.5')).not.toBeNull()
    rerender(<SwimlaneRow {...defaultProps()} swimlane={limited({ wip_limit: 4, limit_enforcement: 'hard' })} cards={cardsIn(5)} />)
    expect(stat()).toHaveTextContent('⛔ Over WIP · 5/4')
  })

  it('a null mode takes the hard glyph from the board flags', () => {
    render(
      <SwimlaneRow
        {...defaultProps()} swimlane={limited({ wip_limit: 1 })} cards={cardsIn(2)}
        limitFlags={{ enforce_wip_limits: false, enforce_wip_hard: true, enforce_weight_limits: false }}
      />,
    )
    expect(stat()).toHaveTextContent('⛔ Over WIP · 2/1')
  })

  it('over weight: danger text naming the weight', () => {
    render(<SwimlaneRow {...defaultProps()} swimlane={limited({ wip_limit: 9, weight_limit: 12 })} cards={cardsIn(3, 6)} />)
    expect(stat()).toHaveTextContent('Over weight · 18/12')
    // § System signals: "Lane over limit" uses fixed danger tokens.
    expect(stat()!.className).toContain('text-danger')
  })

  it('names the metric that is at its limit, not the other one', () => {
    render(<SwimlaneRow {...defaultProps()} showWipAtLimit swimlane={limited({ wip_limit: 5, weight_limit: 6 })} cards={cardsIn(3, 2)} />)
    expect(stat()).toHaveTextContent('Weight 6/6 · at limit')
  })

  it('keeps the numbers whole and lets the meter shrink', () => {
    render(<SwimlaneRow {...defaultProps()} swimlane={limited({ wip_limit: 4 })} cards={cardsIn(5)} />)
    const [text, meter] = Array.from(stat()!.children) as HTMLElement[]
    expect(text.className).toContain('shrink-0')
    expect(text.className).not.toContain('truncate')
    expect(meter.className).toContain('min-w-0')
  })

  it('counts only the counted columns and active cards', () => {
    const cards = [...cardsIn(2), makeCard({ id: 200, uid: 'x1', column: 11 }), makeCard({ id: 201, uid: 'x2', archived_at: '2026-01-01' })]
    render(<SwimlaneRow {...defaultProps()} swimlane={limited({ wip_limit: 5, limit_column_ids: [10] })} cards={cards} />)
    expect(stat()).toHaveTextContent('WIP 2/5')
  })

  it('a collapsed row keeps an over-limit state and folds the calm ones', () => {
    const { rerender } = render(
      <SwimlaneRow {...defaultProps()} collapsed swimlane={limited({ wip_limit: 4 })} cards={cardsIn(5)} />,
    )
    expect(stat()).toHaveTextContent('Over WIP')
    rerender(<SwimlaneRow {...defaultProps()} collapsed swimlane={limited({ wip_limit: 6 })} cards={cardsIn(5)} />)
    expect(stat()).toBeNull()
  })

  it('the meter is decorative', () => {
    render(<SwimlaneRow {...defaultProps()} swimlane={limited({ wip_limit: 6 })} cards={cardsIn(3)} />)
    expect(stat()!.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })
})

describe('SwimlaneRow — Escape in the rename input (#1860)', () => {
  it('cancels the rename without reaching the selection-clear handler', async () => {
    const user = userEvent.setup()
    const onLower = vi.fn()
    render(<><EscapeLowerHandlers onLower={onLower} /><SwimlaneRow {...defaultProps()} /></>)
    await user.click(screen.getByRole('button', { name: 'Customer A' }))
    await user.type(screen.getByDisplayValue('Customer A'), 'x{Escape}')
    expect(screen.queryByDisplayValue('Customer Ax')).not.toBeInTheDocument()
    expect(onLower).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onLower).toHaveBeenCalled()
  })
})
