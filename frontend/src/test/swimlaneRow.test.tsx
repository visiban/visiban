import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SwimlaneRow from '../components/Board/SwimlaneRow'
import { EscapeLowerHandlers } from './escapeSelectionProbe'
import type { Card, Column, CustomFieldDefinition, Swimlane } from '../types'
import { cellKey } from '../gridOverlays/types'
import { encodeOverlayLevel } from '../gridOverlays/scale'

vi.mock('../api/boards', () => ({ updateSwimlane: vi.fn(), patchSwimlane: vi.fn() }))
import { updateSwimlane } from '../api/boards'
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
  color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null, computed_health_status: null, health_computed_at: null, health_computed_counts: null,
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

  // #2271: the left label panel is gone. The band spans the grid, is tinted with the lane
  // color, and forwards currentCardId to the cells.
  it('renders a full-width band tinted with the lane color and no left label panel', () => {
    const { container } = render(<SwimlaneRow {...defaultProps()} currentCardId={7} />)
    const band = screen.getByTestId('swimlane-band')
    expect(band.className).toContain('mx-4')
    expect(band.style.backgroundColor).not.toBe('')
    expect(screen.getByTestId('swimlane-color-square')).toHaveStyle({ backgroundColor: '#6B7280' })
    expect(container.querySelector('[data-lane-label]')).toBeNull()
    expect(container.querySelector('.border-l-4')).toBeNull()
    expect(container.querySelector('[data-current-card-id="7"]')).not.toBeNull()
  })

  it('shows the name at 17px semibold and the card count as text', () => {
    render(<SwimlaneRow {...defaultProps()} cards={[makeCard({ id: 1 }), makeCard({ id: 2 })]} />)
    expect(screen.getByTestId('swimlane-name').className).toContain('text-[17px]')
    expect(screen.getByTestId('swimlane-name').className).toContain('font-semibold')
    expect(screen.getByTestId('swimlane-card-count')).toHaveTextContent('2 cards')
  })

  it('shows overdue and stale counts as text and omits them at zero', () => {
    const past = '2020-01-01'
    const props = defaultProps()
    props.cards = [makeCard({ id: 1, due_date: past }), makeCard({ id: 2, due_date: past }), makeCard({ id: 3, is_stale: true }), makeCard({ id: 4 })]
    const { rerender } = render(<SwimlaneRow {...props} />)
    expect(screen.getByTestId('swimlane-overdue-count')).toHaveTextContent('2 overdue')
    expect(screen.getByTestId('swimlane-stale-count')).toHaveTextContent('1 stale')
    rerender(<SwimlaneRow {...props} cards={[makeCard({ id: 4 })]} />)
    expect(screen.queryByTestId('swimlane-overdue-count')).toBeNull()
    expect(screen.queryByTestId('swimlane-stale-count')).toBeNull()
  })

  it('does not count a stale card in a done column as stale', () => {
    const props = defaultProps()
    props.columns = [columns[0], { ...columns[1], is_done: true }]
    props.cards = [makeCard({ id: 1, column: 11, is_stale: true })]
    render(<SwimlaneRow {...props} />)
    expect(screen.queryByTestId('swimlane-stale-count')).toBeNull()
  })

  // #2300: the cells row uses the board's shared template; #2305: the band is pinned left
  // and capped to the visible width so its stats stay on screen while the grid scrolls.
  it('lays the cells out on the shared grid template it is given', () => {
    const tpl = '16px minmax(0, 1fr) 8px 40px 16px'
    render(<SwimlaneRow {...defaultProps()} gridTemplate={tpl} collapsed />)
    const strip = screen.getByTestId('swimlane-collapsed-strip')
    expect(strip.className).toContain('grid')
    expect(strip.style.gridTemplateColumns).toBe(tpl)
  })

  it('builds a template from its columns when none is passed', () => {
    render(<SwimlaneRow {...defaultProps()} collapsed />)
    const strip = screen.getByTestId('swimlane-collapsed-strip')
    expect(strip.style.gridTemplateColumns).toBe(`16px ${columns.map(() => 'minmax(0, 1fr)').join(' 8px ')} 16px`)
    // A strip cell fills its track rather than carrying a pixel width.
    expect(screen.getByTestId(`swimlane-strip-cell-${columns[0].id}`).style.width).toBe('')
  })

  it('pins the band to the left edge and caps it to the visible board width (#2305)', () => {
    render(<SwimlaneRow {...defaultProps()} />)
    const band = screen.getByTestId('swimlane-band')
    expect(band.className).toContain('sticky')
    expect(band.className).toContain('left-4')
    expect(band.getAttribute('style')).toContain('max-width: calc(var(--board-view-w, 100%) - 32px)')
    // The stats live inside the pinned band, so they move with it.
    expect(within(band).getByTestId('swimlane-band-stats')).toBeInTheDocument()
  })

  it('inserts a column from a cell separator on release, and not for a non-admin (#2300)', () => {
    const onInsertColumn = vi.fn()
    const { container, unmount } = render(<SwimlaneRow {...defaultProps()} onInsertColumn={onInsertColumn} />)
    const sep = container.querySelector('.cursor-pointer.select-none') as HTMLElement
    expect(container.querySelector('.cursor-col-resize')).toBeNull()
    fireEvent.mouseDown(sep, { clientX: 10 })
    expect(onInsertColumn).not.toHaveBeenCalled()
    fireEvent.mouseUp(window)
    expect(onInsertColumn).toHaveBeenCalledWith(columns[0].id)
    fireEvent.mouseUp(window)
    expect(onInsertColumn).toHaveBeenCalledTimes(1)
    // A drag past 4px is not a click (same gesture as the header separator).
    fireEvent.mouseDown(sep, { clientX: 10 })
    fireEvent.mouseMove(window, { clientX: 40 })
    fireEvent.mouseUp(window)
    expect(onInsertColumn).toHaveBeenCalledTimes(1)
    unmount()
    const { container: c2 } = render(<SwimlaneRow {...defaultProps()} isAdmin={false} onInsertColumn={onInsertColumn} />)
    expect(c2.querySelector('.cursor-pointer.select-none')).toBeNull()
  })

  // #1990 kept under #2300: a lane separator drag resizes the column to its left,
  // the same gesture (and the same saved width) as the header separator.
  it('resizes the column left of a cell separator on drag, and inserts on a tiny drag (#1990, #2300)', () => {
    const onInsertColumn = vi.fn()
    const setColumnWidth = vi.fn()
    const colWidths = new Map([[columns[0].id, 300]])
    const { container } = render(
      <SwimlaneRow {...defaultProps()} onInsertColumn={onInsertColumn} colWidths={colWidths} setColumnWidth={setColumnWidth} />,
    )
    // The first separator has nothing to its left: insert only.
    expect(container.querySelectorAll('.cursor-pointer.select-none')).toHaveLength(1)
    const sep = container.querySelector('.cursor-col-resize') as HTMLElement
    expect(sep).not.toBeNull()
    fireEvent.mouseDown(sep, { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 140 })
    fireEvent.mouseUp(window)
    // Unmeasured track (jsdom): the drag adds to the saved width.
    expect(setColumnWidth).toHaveBeenLastCalledWith(columns[0].id, 340)
    expect(onInsertColumn).not.toHaveBeenCalled()
    setColumnWidth.mockClear()
    fireEvent.mouseDown(sep, { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 102 })
    fireEvent.mouseUp(window)
    expect(setColumnWidth).not.toHaveBeenCalled()
    expect(onInsertColumn).toHaveBeenCalledWith(columns[1].id)
  })

  it('does not resize a collapsed column from a lane separator: it is a 40px stub (#2300)', () => {
    const { container } = render(
      <SwimlaneRow {...defaultProps()} collapsedColumnIds={new Set([columns[0].id])} colWidths={new Map()} setColumnWidth={vi.fn()} />,
    )
    expect(container.querySelector('.cursor-col-resize')).toBeNull()
  })

  it('has no tint styles when the lane has no color', () => {
    render(<SwimlaneRow {...defaultProps()} swimlane={{ ...swimlane, color: '' }} />)
    expect(screen.getByTestId('swimlane-band').className).toContain('bg-surface')
    expect(screen.queryByTestId('swimlane-color-square')).toBeNull()
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

  it('collapsed=true keeps the edit button (#2271)', () => {
    const props = defaultProps()
    props.collapsed = true
    render(<SwimlaneRow {...props} />)
    expect(screen.getByTitle('Edit swimlane')).toBeInTheDocument()
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

  it('keeps the edit button on a collapsed lane, and a double-click on a control does not open the modal', async () => {
    const props = defaultProps()
    props.collapsed = true
    render(<SwimlaneRow {...props} />)
    expect(screen.getByTitle('Edit swimlane')).toBeInTheDocument()
    await userEvent.setup().dblClick(screen.getByTitle('Expand Customer A'))
    expect(screen.queryByTestId('edit-swimlane-modal')).not.toBeInTheDocument()
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

  it('collapsed=true counts only filter matches in the strip cell', () => {
    const props = defaultProps()
    const [a, b] = [makeCard({ id: 1, column: 10 }), makeCard({ id: 2, column: 10 })]
    props.cards = [a, b]
    props.filteredCardIds = new Set([a.id])
    props.collapsed = true
    render(<SwimlaneRow {...props} />)
    const cell = screen.getByTestId('swimlane-strip-cell-10')
    expect(within(cell).getByText('1', { selector: '[aria-hidden="true"]' })).toBeInTheDocument()
    expect(cell.querySelectorAll('[data-status]')).toHaveLength(1)
  })

  it('collapsed=true match cell pulses with a reduced-motion opt-out (#199)', () => {
    const props = defaultProps()
    const card = makeCard({ id: 1, column: 10 })
    props.cards = [card]
    props.filteredCardIds = new Set([card.id])
    props.collapsed = true
    render(<SwimlaneRow {...props} />)
    expect(screen.getByTestId('swimlane-strip-cell-10')).toHaveClass('animate-pulse', 'motion-reduce:animate-none')
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
    // Non-color active cue (#2188): the underline bar, not the text-info tint alone.
    expect(within(btn).getByTestId('active-underline')).toBeInTheDocument()
  })

  it('aria-pressed=false when not focused', () => {
    render(<SwimlaneRow {...defaultProps()} />)
    const btn = screen.getByTitle('Focus on Customer A')
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    expect(within(btn).queryByTestId('active-underline')).not.toBeInTheDocument()
  })

  it('clicking focused crosshair calls onExitFocus, not onFocus', async () => {
    const props = defaultProps()
    props.isFocused = true
    render(<SwimlaneRow {...props} />)
    await userEvent.setup().click(screen.getByTitle('Exit focus'))
    expect(props.onExitFocus).toHaveBeenCalled()
    expect(props.onFocus).not.toHaveBeenCalled()
  })

  it('collapse button has aria-expanded=true when not collapsed', () => {
    render(<SwimlaneRow {...defaultProps()} />)
    const btn = screen.getByTitle('Collapse Customer A')
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    expect(btn.querySelector('svg')).not.toHaveClass('-rotate-90')
    expect(within(btn).queryByTestId('active-underline')).not.toBeInTheDocument()
  })

  it('collapse button has aria-expanded=false and a turned chevron when collapsed', () => {
    const props = defaultProps()
    props.collapsed = true
    render(<SwimlaneRow {...props} />)
    const btn = screen.getByTitle('Expand Customer A')
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    expect(btn.querySelector('svg')).toHaveClass('-rotate-90')
    expect(within(btn).getByTestId('active-underline')).toBeInTheDocument()
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
    const row = container.querySelector('[data-swimlane-id]') as HTMLElement
    fireEvent.mouseEnter(row)
    expect(onHoverEnter).toHaveBeenCalled()
  })

  it('calls onHoverLeave on mouseleave', () => {
    const props = defaultProps()
    const onHoverEnter = vi.fn()
    const onHoverLeave = vi.fn()
    const { container } = render(<SwimlaneRow {...props} onHoverEnter={onHoverEnter} onHoverLeave={onHoverLeave} />)
    const row = container.querySelector('[data-swimlane-id]') as HTMLElement
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

  it('under: calm WIP n / limit in the foreground tone, no accent (#2275)', () => {
    const { container } = render(<SwimlaneRow {...defaultProps()} swimlane={limited({ wip_limit: 6 })} cards={cardsIn(4)} />)
    expect(stat()).toHaveTextContent(/^WIP 4 \/ 6$/)
    expect(stat()!.className).toContain('text-fg')
    expect(stat()!.className).not.toContain('text-warning')
    expect(container.querySelector('.bg-danger-emphasis.h-0\\.5')).toBeNull()
  })

  it('at: says "at limit" in text, not color alone, when the board opts in', () => {
    render(<SwimlaneRow {...defaultProps()} showWipAtLimit swimlane={limited({ wip_limit: 5 })} cards={cardsIn(5)} />)
    expect(stat()).toHaveTextContent('WIP 5 / 5 · at limit')
    expect(stat()!.className).toContain('text-fg')
  })

  it('at, with the board opt-in off (the default): reads like under, as the column header does', () => {
    render(<SwimlaneRow {...defaultProps()} swimlane={limited({ wip_limit: 5 })} cards={cardsIn(5)} />)
    expect(stat()).toHaveTextContent(/^WIP 5 \/ 5$/)
    expect(stat()).not.toHaveTextContent('at limit')
  })

  it('over WIP: "WIP n / limit over" in warning text, no accent strip; ⛔ when hard (#2275)', () => {
    const { container, rerender } = render(
      <SwimlaneRow {...defaultProps()} swimlane={limited({ wip_limit: 4 })} cards={cardsIn(5)} />,
    )
    expect(stat()).toHaveTextContent(/^WIP 5 \/ 4 over$/)
    expect(stat()!.className).toContain('text-warning-on-tint')
    expect(stat()!.className).not.toContain('text-danger')
    expect(stat()).toHaveAttribute('title', "Over the swimlane's WIP limit")
    expect(container.querySelector('.bg-danger-emphasis.h-0\\.5')).toBeNull()
    rerender(<SwimlaneRow {...defaultProps()} swimlane={limited({ wip_limit: 4, limit_enforcement: 'hard' })} cards={cardsIn(5)} />)
    expect(stat()).toHaveTextContent('⛔ WIP 5 / 4 over')
    expect(stat()).toHaveAttribute('title', "Over the swimlane's hard WIP limit — no override possible")
  })

  it('a null mode takes the hard glyph from the board flags', () => {
    render(
      <SwimlaneRow
        {...defaultProps()} swimlane={limited({ wip_limit: 1 })} cards={cardsIn(2)}
        limitFlags={{ enforce_wip_limits: false, enforce_wip_hard: true, enforce_weight_limits: false }}
      />,
    )
    expect(stat()).toHaveTextContent('⛔ WIP 2 / 1 over')
  })

  it('over weight: warning text naming the weight (#2275)', () => {
    render(<SwimlaneRow {...defaultProps()} swimlane={limited({ wip_limit: 9, weight_limit: 12 })} cards={cardsIn(3, 6)} />)
    expect(stat()).toHaveTextContent(/^Weight 18 \/ 12 over$/)
    expect(stat()!.className).toContain('text-warning-on-tint')
    expect(stat()).toHaveAttribute('title', "Over the swimlane's weight limit")
  })

  it('names the metric that is at its limit, not the other one', () => {
    render(<SwimlaneRow {...defaultProps()} showWipAtLimit swimlane={limited({ wip_limit: 5, weight_limit: 6 })} cards={cardsIn(3, 2)} />)
    expect(stat()).toHaveTextContent('Weight 6 / 6 · at limit')
  })

  it('keeps the numbers on one line in the band stats', () => {
    render(<SwimlaneRow {...defaultProps()} swimlane={limited({ wip_limit: 4 })} cards={cardsIn(5)} />)
    expect(stat()!.className).toContain('whitespace-nowrap')
    expect(stat()!.closest('[data-testid="swimlane-band-stats"]')).not.toBeNull()
  })

  it('counts only the counted columns and active cards', () => {
    const cards = [...cardsIn(2), makeCard({ id: 200, uid: 'x1', column: 11 }), makeCard({ id: 201, uid: 'x2', archived_at: '2026-01-01' })]
    render(<SwimlaneRow {...defaultProps()} swimlane={limited({ wip_limit: 5, limit_column_ids: [10] })} cards={cards} />)
    expect(stat()).toHaveTextContent('WIP 2 / 5')
  })

  it('a collapsed row keeps an over-limit state and folds the calm ones', () => {
    const { rerender } = render(
      <SwimlaneRow {...defaultProps()} collapsed swimlane={limited({ wip_limit: 4 })} cards={cardsIn(5)} />,
    )
    expect(stat()).toHaveTextContent('WIP 5 / 4 over')
    rerender(<SwimlaneRow {...defaultProps()} collapsed swimlane={limited({ wip_limit: 6 })} cards={cardsIn(5)} />)
    expect(stat()).toBeNull()
  })

  it('puts the limit line before the card count, after overdue and stale', () => {
    render(<SwimlaneRow {...defaultProps()} swimlane={limited({ wip_limit: 4 })} cards={[...cardsIn(5), makeCard({ id: 300, uid: 'od', due_date: '2020-01-01' })]} />)
    const kids = Array.from(screen.getByTestId('swimlane-band-stats').children)
    const idx = (id: string) => kids.findIndex((k) => k.getAttribute('data-testid') === id)
    expect(idx('swimlane-overdue-count')).toBeLessThan(idx('swimlane-limit-stat'))
    expect(idx('swimlane-limit-stat')).toBeLessThan(idx('swimlane-card-count'))
  })
})

describe('SwimlaneRow — number rollup (#2275)', () => {
  const amount: CustomFieldDefinition = {
    id: 7, uid: 'cfuid007', name: 'Amount', field_type: 'number', choices: [],
    position: 0, show_on_card: false, is_required: false, help_text: '',
    number_prefix: '$', number_suffix: 'k', number_decimals: null, choice_colors: {},
    threshold_direction: '', threshold_warn: null, threshold_alert: null, threshold_warn_days: null, threshold_alert_days: null, created_at: '2026-01-01T00:00:00Z',
  }
  const doneColumns: Column[] = [columns[0], { ...columns[1], is_done: true }]
  const valued = (id: number, value: string, column = 10) =>
    makeCard({ id, uid: `v${id}`, column, custom_field_values: [{ field_definition: 7, value }] })
  const rollup = () => screen.queryByTestId('swimlane-rollup')

  it('is hidden when the board chose no rollup field', () => {
    render(<SwimlaneRow {...defaultProps()} cards={[valued(1, '33')]} />)
    expect(rollup()).toBeNull()
  })

  it('shows "{total} open" over the lane\'s cards not in a done column', () => {
    render(
      <SwimlaneRow
        {...defaultProps()} columns={doneColumns} rollupField={amount}
        cards={[valued(1, '33'), valued(2, '380'), valued(3, '500', 11), makeCard({ id: 4, uid: 'nv' })]}
      />,
    )
    // Visible "$413k open"; the sr-only prefix names the field for screen readers.
    expect(rollup()).toHaveTextContent(/^Amount: \$413k open$/)
    expect(rollup()!.querySelector('.sr-only')).toHaveTextContent('Amount:')
    expect(rollup()).toHaveAttribute('title', 'Amount: total of the cards not in a done column')
    expect(rollup()!.className).toContain('text-fg')
  })

  it('updates when a card moves into a done column (live, from the card list)', () => {
    const { rerender } = render(
      <SwimlaneRow {...defaultProps()} columns={doneColumns} rollupField={amount} cards={[valued(1, '33'), valued(2, '380')]} />,
    )
    expect(rollup()).toHaveTextContent('$413k open')
    rerender(
      <SwimlaneRow {...defaultProps()} columns={doneColumns} rollupField={amount} cards={[valued(1, '33'), valued(2, '380', 11)]} />,
    )
    expect(rollup()).toHaveTextContent('$33k open')
  })

  it('sits after the limit line and before the card count', () => {
    render(
      <SwimlaneRow {...defaultProps()} swimlane={{ ...swimlane, wip_limit: 9 }} rollupField={amount} cards={[valued(1, '33')]} />,
    )
    const kids = Array.from(screen.getByTestId('swimlane-band-stats').children)
    const idx = (id: string) => kids.findIndex((k) => k.getAttribute('data-testid') === id)
    expect(idx('swimlane-limit-stat')).toBeLessThan(idx('swimlane-rollup'))
    expect(idx('swimlane-rollup')).toBeLessThan(idx('swimlane-card-count'))
  })
})

describe('SwimlaneRow — collapsed strip (#2271)', () => {
  it('shows a text count and one status square per card, an en dash when empty', () => {
    const props = defaultProps()
    props.collapsed = true
    props.cards = [
      makeCard({ id: 1, column: 10, due_date: '2020-01-01' }),
      makeCard({ id: 2, column: 10, is_stale: true }),
      makeCard({ id: 3, column: 10 }),
    ]
    render(<SwimlaneRow {...props} />)
    const cell = screen.getByTestId('swimlane-strip-cell-10')
    expect(cell).toHaveTextContent('To Do: 3 cards, 1 overdue, 1 stale')
    const squares = Array.from(cell.querySelectorAll('[data-status]'))
    expect(squares.map((q) => q.getAttribute('data-status'))).toEqual(['overdue', 'stale', 'ok'])
    expect(squares[0]).toHaveClass('bg-danger-emphasis')
    expect(squares[1]).toHaveClass('bg-warning-emphasis')
    expect(squares[2]).toHaveClass('bg-primary-emphasis/60')
    const empty = screen.getByTestId('swimlane-strip-cell-11')
    expect(empty).toHaveTextContent('–')
    expect(empty).toHaveTextContent('Done: no cards')
    expect(empty.querySelector('[data-status]')).toBeNull()
  })

  it('does not render the cells while collapsed, and keeps them when expanded', () => {
    const props = defaultProps()
    const { rerender } = render(<SwimlaneRow {...props} collapsed />)
    expect(screen.queryByTestId('cell-10-20')).toBeNull()
    expect(screen.getByTestId('swimlane-collapsed-strip')).toBeInTheDocument()
    rerender(<SwimlaneRow {...props} />)
    expect(screen.getByTestId('cell-10-20')).toBeInTheDocument()
    expect(screen.queryByTestId('swimlane-collapsed-strip')).toBeNull()
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

describe('SwimlaneRow — focus returns to the rename opener (#2087)', () => {
  it('Escape returns focus to the name button', async () => {
    const user = userEvent.setup()
    render(<SwimlaneRow {...defaultProps()} />)
    await user.click(screen.getByRole('button', { name: 'Customer A' }))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Customer A' })).toHaveFocus()
  })
  it('Enter commit returns focus to the name button', async () => {
    const user = userEvent.setup()
    render(<SwimlaneRow {...defaultProps()} />)
    await user.click(screen.getByRole('button', { name: 'Customer A' }))
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Customer A' })).toHaveFocus()
  })
  it('a changed-name Enter commit saves via updateSwimlane and returns focus', async () => {
    const user = userEvent.setup()
    const props = defaultProps()
    const updated = { ...props.swimlane, name: 'Customer A2' }
    vi.mocked(updateSwimlane).mockResolvedValue(updated)
    render(<SwimlaneRow {...props} />)
    await user.click(screen.getByRole('button', { name: 'Customer A' }))
    await user.type(screen.getByDisplayValue('Customer A'), '2{Enter}')
    await waitFor(() => expect(props.onSwimlaneUpdated).toHaveBeenCalledWith(updated))
    expect(updateSwimlane).toHaveBeenCalledWith(props.boardId, props.swimlane.id, expect.objectContaining({ name: 'Customer A2' }))
    expect(screen.getByRole('button', { name: 'Customer A' })).toHaveFocus()
  })
  it('a blur commit does not pull focus back', async () => {
    const user = userEvent.setup()
    render(<SwimlaneRow {...defaultProps()} />)
    await user.click(screen.getByRole('button', { name: 'Customer A' }))
    await user.click(document.body)
    expect(screen.getByRole('button', { name: 'Customer A' })).not.toHaveFocus()
  })
})
