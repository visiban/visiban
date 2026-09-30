import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import CardItem from '../components/Card/CardItem'
import type { Card, CustomFieldDefinition } from '../types'

// Mock dnd-kit — CardItem calls useDraggable unconditionally (hook rules).
// We expose a mutable `isDraggingRef` so individual tests can simulate dragging.
const isDraggingRef = { current: false }

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    get isDragging() { return isDraggingRef.current },
  }),
}))

vi.mock('../components/Common/Avatar', () => ({
  default: ({ user }: { user: { display_name: string } }) => (
    <span data-testid="avatar">{user.display_name}</span>
  ),
}))

vi.mock('../utils/date', () => ({
  formatDueDate: (_date: string, _tz: string, _fmt: string) => ({ label: 'Jan 15', overdue: false }),
  formatRelativeMovedAt: (date: string | null, _fmt: string) => date === null ? null : 'moved 3 days ago',
  // Used by CardPeekPopover to render the footer timestamp.
  formatRelativeTime: (iso: string) => iso ? '2d ago' : '',
}))

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1,
    uid: 'carduid00001',
    column: 10,
    swimlane: 20,
    title: 'Peek Test Card',
    description: 'A description for the card peek popover.',
    priority: 'medium',
    assignee: null,
    labels: [],
    due_date: null,
    weight: 1,
    position: 0,
    created_by: { id: 1, username: 'user1', display_name: 'User One', avatar_url: '' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_moved_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    attachment_count: 0,
    checklist_total: 0,
    checklist_done: 0,
    is_stale: false,
    custom_field_values: [],
    blocker_count: 0, external_ref: null,
    archived_at: null,
    version: 1,
    ...overrides,
  }
}

// Helper: get the card's interactive div (the one with data-tour-step="card").
function getCardEl(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-tour-step="card"]') as HTMLElement
}

describe('Card peek popover', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    isDraggingRef.current = false
    // jsdom returns zeroed DOMRect by default; provide a realistic rect so the
    // popover positioning logic in CardPeekPopover has valid coordinates to use.
    Element.prototype.getBoundingClientRect = vi.fn(() => ({
      top: 100, left: 50, bottom: 160, right: 250, width: 200, height: 60,
      x: 50, y: 100, toJSON: () => {},
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not show the popover on initial render', () => {
    const { container } = render(<CardItem card={makeCard()} />)
    expect(getCardEl(container)).toBeTruthy()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('shows the popover after 600 ms hover', async () => {
    const { container } = render(<CardItem card={makeCard()} />)
    const cardEl = getCardEl(container)

    fireEvent.mouseEnter(cardEl)
    // Advance past the 600 ms delay.
    await act(async () => { vi.advanceTimersByTime(600) })

    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    // The popover should contain the card's title and description.
    expect(screen.getByRole('tooltip')).toHaveTextContent('Peek Test Card')
    expect(screen.getByRole('tooltip')).toHaveTextContent('A description for the card peek popover.')
  })

  // Regression guard (#1305): mouseleave/drag-start already clear peekTimer,
  // but a card can also unmount directly while the timer is still pending
  // (e.g. a WebSocket move/delete broadcast removes it from the board while
  // the pointer rests on it). Unmounting must clear the timer too, not fire
  // setPeekVisible/setAnchorRect against a torn-down component.
  it('clears the pending peek timer on unmount, without throwing', async () => {
    const { container, unmount } = render(<CardItem card={makeCard()} />)
    const cardEl = getCardEl(container)

    fireEvent.mouseEnter(cardEl)

    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => unmount()).not.toThrow()
    expect(clearSpy).toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    // Advancing past the original 600ms delay after unmount must not throw.
    expect(() => act(() => { vi.advanceTimersByTime(600) })).not.toThrow()
    expect(errorSpy).not.toHaveBeenCalled()

    clearSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('does not show the popover when mouseleave fires before 600 ms', async () => {
    const { container } = render(<CardItem card={makeCard()} />)
    const cardEl = getCardEl(container)

    fireEvent.mouseEnter(cardEl)
    await act(async () => { vi.advanceTimersByTime(300) }) // half-way
    fireEvent.mouseLeave(cardEl)
    await act(async () => { vi.advanceTimersByTime(400) }) // past 600 ms total

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('hides the popover when mouse leaves the card after it appeared', async () => {
    const { container } = render(<CardItem card={makeCard()} />)
    const cardEl = getCardEl(container)

    fireEvent.mouseEnter(cardEl)
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.mouseLeave(cardEl)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('does not show the popover when readOnly={true}', async () => {
    const { container } = render(<CardItem card={makeCard()} readOnly />)
    const cardEl = getCardEl(container)

    fireEvent.mouseEnter(cardEl)
    await act(async () => { vi.advanceTimersByTime(600) })

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('does not show the popover when overlay={true}', async () => {
    const { container } = render(<CardItem card={makeCard()} overlay />)
    const cardEl = getCardEl(container)

    fireEvent.mouseEnter(cardEl)
    await act(async () => { vi.advanceTimersByTime(600) })

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('shows checklist progress in the popover when checklist is present', async () => {
    const card = makeCard({ checklist_total: 4, checklist_done: 2 })
    const { container } = render(<CardItem card={card} />)
    const cardEl = getCardEl(container)

    fireEvent.mouseEnter(cardEl)
    await act(async () => { vi.advanceTimersByTime(600) })

    expect(screen.getByRole('tooltip')).toHaveTextContent('2/4')
  })

  it('shows "Click to open ↗" in the footer', async () => {
    const { container } = render(<CardItem card={makeCard()} />)
    const cardEl = getCardEl(container)

    fireEvent.mouseEnter(cardEl)
    await act(async () => { vi.advanceTimersByTime(600) })

    expect(screen.getByRole('tooltip')).toHaveTextContent('Click to open ↗')
  })

  // ---- #961: peek surfaces metrics hidden from card face at lower densities ----

  it('peek shows weight + attachments on a single muted line when present (last-moved is in the footer, not duplicated here)', async () => {
    // last_moved_at must be relative-to-now: a hardcoded ISO drifts past the
    // staleness warning threshold over time and triggers the aging-tint tooltip,
    // producing two role="tooltip" elements and breaking getByRole('tooltip').
    const card = makeCard({ weight: 5, attachment_count: 3, last_moved_at: new Date(Date.now() - 2 * 86_400_000).toISOString() })
    const { container } = render(<CardItem card={card} density="comfortable" />)
    fireEvent.mouseEnter(getCardEl(container))
    await act(async () => { vi.advanceTimersByTime(600) })
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('Weight 5')
    expect(tooltip).toHaveTextContent('3 attachments')
    // Single line — verify "·" separator is used (discipline check)
    expect(tooltip.textContent).toMatch(/Weight 5 · 3 attachments/)
    // last_moved_at is intentionally NOT in the metrics line — the footer already
    // shows "Last activity 2d ago" so listing it twice is noise.
    expect(tooltip.textContent).not.toMatch(/Moved 2d ago/)
  })

  it('peek metrics line uses singular "1 attachment" for a single attachment', async () => {
    const card = makeCard({ weight: 1, attachment_count: 1, last_moved_at: null })
    const { container } = render(<CardItem card={card} density="comfortable" />)
    fireEvent.mouseEnter(getCardEl(container))
    await act(async () => { vi.advanceTimersByTime(600) })
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('1 attachment')
    expect(tooltip).not.toHaveTextContent('1 attachments')
  })

  it('peek omits the metrics line entirely when no metric applies', async () => {
    const card = makeCard({ weight: 1, attachment_count: 0, last_moved_at: null })
    const { container } = render(<CardItem card={card} />)
    fireEvent.mouseEnter(getCardEl(container))
    await act(async () => { vi.advanceTimersByTime(600) })
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).not.toHaveTextContent(/Weight \d|attachment/)
  })
})

// ---- #1308: peek custom fields must not read as the card-face chip disagreeing with itself ----

function makeDef(overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id: 1, uid: 'cfuid001', name: 'Field', field_type: 'text', choices: [],
    position: 0, show_on_card: false, is_required: false, help_text: '',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

async function openPeek(card: Card, defs: CustomFieldDefinition[]) {
  const { container } = render(<CardItem card={card} customFieldDefinitions={defs} />)
  fireEvent.mouseEnter(getCardEl(container))
  await act(async () => { vi.advanceTimersByTime(600) })
  return screen.getByRole('tooltip')
}

describe('Card peek popover — custom fields (#1308)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    isDraggingRef.current = false
    Element.prototype.getBoundingClientRect = vi.fn(() => ({
      top: 100, left: 50, bottom: 160, right: 250, width: 200, height: 60,
      x: 50, y: 100, toJSON: () => {},
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // The reported case: SA pinned on the card face, AE non-pinned in the peek.
  const SA = makeDef({ id: 1, name: 'SA', show_on_card: true, position: 0, help_text: 'Solutions Architect' })
  const AE = makeDef({ id: 2, name: 'AE', show_on_card: false, position: 1, help_text: 'Account Executive' })
  const reportedCard = () => makeCard({
    custom_field_values: [
      { field_definition: 1, value: 'Glenda' },
      { field_definition: 2, value: 'Bob' },
    ],
  })

  it('labels the non-pinned group "Other fields" when the board pins a field, and does not repeat the pinned one', async () => {
    const tooltip = await openPeek(reportedCard(), [SA, AE])
    const line = within(tooltip).getByTestId('card-peek-custom-fields')
    expect(line).toHaveTextContent(/^Other fields — AE: Bob$/)
    expect(tooltip).not.toHaveTextContent('SA: Glenda')
  })

  it('omits the label when no field is pinned (no card-face chip to confuse it with)', async () => {
    const tooltip = await openPeek(reportedCard(), [{ ...SA, show_on_card: false }, AE])
    const line = within(tooltip).getByTestId('card-peek-custom-fields')
    expect(line).not.toHaveTextContent('Other fields')
    expect(line).toHaveTextContent(/^SA: Glenda · AE: Bob$/)
  })

  it('keys the label off show_on_card, not a pin count (#1146 presets may pin more)', async () => {
    const pinnedA = makeDef({ id: 3, name: 'P1', show_on_card: true, position: 2 })
    const pinnedB = makeDef({ id: 4, name: 'P2', show_on_card: true, position: 3 })
    const pinnedC = makeDef({ id: 5, name: 'P3', show_on_card: true, position: 4 })
    const tooltip = await openPeek(reportedCard(), [SA, AE, pinnedA, pinnedB, pinnedC])
    expect(within(tooltip).getByTestId('card-peek-custom-fields')).toHaveTextContent(/^Other fields — AE: Bob$/)
  })

  it('gives each entry a title with the full field help text as a name fallback', async () => {
    const tooltip = await openPeek(reportedCard(), [SA, AE])
    expect(within(tooltip).getByText('AE: Bob')).toHaveAttribute('title', 'AE: Bob — Account Executive')
  })

  it('truncates a long unbroken value inside the 288px panel, keeping the full text in the title', async () => {
    const long = 'https://example.com/' + 'x'.repeat(200)
    const card = makeCard({ custom_field_values: [{ field_definition: 2, value: long }] })
    const tooltip = await openPeek(card, [SA, AE])
    const entry = within(tooltip).getByText(`AE: ${long}`)
    // jsdom has no layout, so assert the clipping classes rather than a width.
    expect(entry).toHaveClass('inline-block', 'max-w-full', 'truncate')
    expect(entry).toHaveAttribute('title', `AE: ${long} — Account Executive`)
  })

  it('falls back to name: value in the title when the field has no help text', async () => {
    const tooltip = await openPeek(reportedCard(), [SA, { ...AE, help_text: '' }])
    expect(within(tooltip).getByText('AE: Bob')).toHaveAttribute('title', 'AE: Bob')
  })

  it('renders custom fields on their own line, separate from the metrics line', async () => {
    const card = { ...reportedCard(), weight: 5 }
    const tooltip = await openPeek(card, [SA, AE])
    const line = within(tooltip).getByTestId('card-peek-custom-fields')
    expect(line).not.toHaveTextContent('Weight 5')
    expect(tooltip).toHaveTextContent('Weight 5')
  })

  it('renders no custom-field line when no non-pinned field is populated', async () => {
    const card = makeCard({ custom_field_values: [{ field_definition: 1, value: 'Glenda' }] })
    const tooltip = await openPeek(card, [SA, AE])
    expect(within(tooltip).queryByTestId('card-peek-custom-fields')).not.toBeInTheDocument()
    expect(tooltip).not.toHaveTextContent('Other fields')
  })

  it('shows exactly 6 entries without a "+N more" marker', async () => {
    const defs = Array.from({ length: 6 }, (_, i) => makeDef({ id: 10 + i, name: `F${i}`, position: i }))
    const card = makeCard({ custom_field_values: defs.map((d) => ({ field_definition: d.id, value: `v${d.id}` })) })
    const tooltip = await openPeek(card, defs)
    const line = within(tooltip).getByTestId('card-peek-custom-fields')
    expect(line).toHaveTextContent('F5: v15')
    expect(line).not.toHaveTextContent(/more/)
  })

  it('caps at 5 entries + "+N more" beyond 6, in position order, with hidden names in the title', async () => {
    // Defined out of position order to prove the sort.
    const defs = Array.from({ length: 8 }, (_, i) => makeDef({ id: 20 + i, name: `F${i}`, position: 7 - i }))
    const card = makeCard({ custom_field_values: defs.map((d) => ({ field_definition: d.id, value: `v${d.id}` })) })
    const tooltip = await openPeek(card, [SA, ...defs])
    const line = within(tooltip).getByTestId('card-peek-custom-fields')
    expect(line).toHaveTextContent(/^Other fields — F7: v27 · F6: v26 · F5: v25 · F4: v24 · F3: v23 · \+3 more$/)
    expect(within(line).getByText('+3 more')).toHaveAttribute('title', 'F2, F1, F0')
  })
})
