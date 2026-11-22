import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import CardItem from '../components/Card/CardItem'
import type { CustomFieldDefinition } from '../types'
import type { Card } from '../types'

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
  // Used by checklistToday (#445) to compare checklist due dates against today.
  todayInTimezone: (_tz: string) => '2026-01-10',
  formatDueDate: (_date: string, _tz: string, _fmt: string) => ({ label: 'Jan 15', overdue: false }),
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
    // Relative to now: a never-moved card ages from created_at (#1841).
    created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    updated_at: '2026-01-01T00:00:00Z',
    last_moved_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    attachment_count: 0,
    checklist_total: 0,
    checklist_done: 0,
    is_stale: false,
    custom_field_values: [],
    blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    archived_at: null,
    version: 1,
    ...overrides,
  }
}

// Helper: get the card's interactive div (the one with data-tour-step="card").
function getCardEl(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-tour-step="card"]') as HTMLElement
}

// #2508 — a hover (expansion, aging tooltip, peek) must never outlive the
// pointer. Only a leave event ends a hover today, and a key press, scroll or
// window blur sends none; the `fixed` peek can also sit under a resting
// pointer and keep itself open through its own mouseenter. These tests drive
// the hover with mouseenter and then send NO mouseleave, the shape of every
// stuck-hover report. They do not claim how a browser fails to send the leave.

// The hovered card carries the lifted shadow; at rest it carries the flat one.
const LIFTED = '0 4px 0'

async function hoverUntilPeek(container: HTMLElement) {
  const cardEl = getCardEl(container)
  fireEvent.mouseEnter(cardEl)
  await act(async () => { vi.advanceTimersByTime(600) })
  expect(screen.getByRole('tooltip')).toBeInTheDocument()
  expect(cardEl.style.boxShadow).toContain(LIFTED)
  return cardEl
}

function expectHoverEnded(cardEl: HTMLElement) {
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  expect(cardEl.style.boxShadow).not.toContain(LIFTED)
}

describe('Card hover guard (#2508)', () => {
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

  it('a pointer move outside the card ends the hover even when no mouseleave arrives', async () => {
    const { container } = render(<><CardItem card={makeCard()} /><div data-testid="elsewhere" /></>)
    const cardEl = await hoverUntilPeek(container)
    act(() => { fireEvent.pointerMove(screen.getByTestId('elsewhere')) })
    expectHoverEnded(cardEl)
  })

  it('a pointer move inside the card or over the peek keeps the hover', async () => {
    const { container } = render(<CardItem card={makeCard()} />)
    const cardEl = await hoverUntilPeek(container)
    act(() => { fireEvent.pointerMove(cardEl.firstElementChild ?? cardEl) })
    act(() => { fireEvent.pointerMove(screen.getByRole('tooltip').firstElementChild!) })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    expect(cardEl.style.boxShadow).toContain(LIFTED)
  })

  it('a shortcut key (F opens the filter row) ends a visible peek and the hover', async () => {
    const { container } = render(<CardItem card={makeCard()} />)
    const cardEl = await hoverUntilPeek(container)
    act(() => { fireEvent.keyDown(document.body, { key: 'f' }) })
    expectHoverEnded(cardEl)
  })

  it('a key cancels a pending peek timer, so no peek appears later', async () => {
    const { container } = render(<CardItem card={makeCard()} />)
    const cardEl = getCardEl(container)
    fireEvent.mouseEnter(cardEl)
    await act(async () => { vi.advanceTimersByTime(300) })
    act(() => { fireEvent.keyDown(document.body, { key: 'f' }) })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expectHoverEnded(cardEl)
  })

  it('a modifier key alone keeps the hover, so Shift+click lands on the card it was aimed at (#2358)', async () => {
    const { container } = render(<CardItem card={makeCard()} />)
    const cardEl = await hoverUntilPeek(container)
    act(() => { fireEvent.keyDown(document.body, { key: 'Shift' }) })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    expect(cardEl.style.boxShadow).toContain(LIFTED)
  })

  it('a page scroll ends the hover (the fixed peek would float at a stale position)', async () => {
    const { container } = render(<CardItem card={makeCard()} />)
    const cardEl = await hoverUntilPeek(container)
    act(() => { fireEvent.scroll(window) })
    expectHoverEnded(cardEl)
  })

  it('a scroll of a board container outside the card ends the hover', async () => {
    const { container } = render(<div data-testid="cell"><CardItem card={makeCard()} /></div>)
    const cardEl = await hoverUntilPeek(container)
    act(() => { fireEvent.scroll(screen.getByTestId('cell')) })
    expectHoverEnded(cardEl)
  })

  it('the window losing focus ends the hover', async () => {
    const { container } = render(<CardItem card={makeCard()} />)
    const cardEl = await hoverUntilPeek(container)
    act(() => { fireEvent.blur(window) })
    expectHoverEnded(cardEl)
  })

  it('a press on the peek dismisses it, so it never blocks the filter row or toolbar under it', async () => {
    const { container } = render(<CardItem card={makeCard()} />)
    const cardEl = await hoverUntilPeek(container)
    act(() => { fireEvent.pointerDown(screen.getByRole('tooltip')) })
    expectHoverEnded(cardEl)
  })

  it('a press on the card itself keeps the hover (click, drag and the menu start there)', async () => {
    const { container } = render(<CardItem card={makeCard()} />)
    const cardEl = await hoverUntilPeek(container)
    act(() => { fireEvent.pointerDown(cardEl) })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })

  it('leaving the peek ends the whole hover, not just the peek', async () => {
    const { container } = render(<CardItem card={makeCard()} />)
    const cardEl = await hoverUntilPeek(container)
    // The pointer is on the peek while the card still counts as hovered (no
    // card mouseleave ran): only the peek's own leave can end the hover, so a
    // bare setPeekVisible(false) there would leave the card expanded.
    act(() => { fireEvent.mouseEnter(screen.getByRole('tooltip')) })
    expect(cardEl.style.boxShadow).toContain(LIFTED)
    act(() => { fireEvent.mouseLeave(screen.getByRole('tooltip')) })
    expectHoverEnded(cardEl)
    // A fresh hover still works afterwards.
    await hoverUntilPeek(container)
  })

  it('stops listening once the hover has ended', async () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { container } = render(<CardItem card={makeCard()} />)
    const cardEl = await hoverUntilPeek(container)
    act(() => { fireEvent.mouseLeave(cardEl) })
    const removed = remove.mock.calls.map(([type]) => type)
    expect(removed).toEqual(expect.arrayContaining(['pointermove', 'pointerdown', 'scroll', 'keydown', 'blur']))
  })

  it('Escape, the WCAG 1.4.13 dismiss key, ends the hover', async () => {
    const { container } = render(<CardItem card={makeCard()} />)
    const cardEl = await hoverUntilPeek(container)
    act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }) })
    expectHoverEnded(cardEl)
  })

  it('a scroll inside the peek keeps it', async () => {
    const { container } = render(<CardItem card={makeCard()} />)
    await hoverUntilPeek(container)
    act(() => { fireEvent.scroll(screen.getByRole('tooltip')) })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })

  it('never places the peek above the board region, so it cannot cover the filter row or toolbar', async () => {
    // Card at the bottom of a short viewport: the #1457 slide-up would lift the
    // peek to the viewport margin, over the toolbar above the board region.
    const rects: Record<string, Partial<DOMRect>> = {
      board: { top: 180, bottom: 700, left: 0, right: 1000, width: 1000, height: 520 },
      card: { top: 640, bottom: 690, left: 50, right: 250, width: 200, height: 50 },
    }
    Element.prototype.getBoundingClientRect = vi.fn(function (this: Element) {
      const r = this.hasAttribute('data-board-scroll') ? rects.board : rects.card
      return { x: r.left, y: r.top, toJSON: () => {}, ...r } as DOMRect
    })
    // Taller than the room below the card, so placement pins it near the top.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 700 })
    try {
      const { container } = render(<div data-board-scroll><CardItem card={makeCard()} /></div>)
      fireEvent.mouseEnter(getCardEl(container))
      await act(async () => { vi.advanceTimersByTime(600) })
      const top = parseFloat(screen.getByRole('tooltip').style.top)
      expect(top).toBeGreaterThanOrEqual(180)
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original)
    }
  })

  it('an arrow key in the card\'s open quick-edit list keeps the hover (the exemption)', async () => {
    const def = {
      id: 5, uid: 'cfuid005', name: 'Stage', field_type: 'dropdown', choices: ['Beta', 'GA'],
      position: 0, show_on_card: true, is_required: false, help_text: '',
      number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
      threshold_direction: '', threshold_warn: null, threshold_alert: null,
      threshold_warn_days: null, threshold_alert_days: null, created_at: '2026-01-01T00:00:00Z',
    } as CustomFieldDefinition
    const { container } = render(
      <CardItem
        card={makeCard({ custom_field_values: [{ field_definition: 5, value: 'Beta' }] })}
        customFieldDefinitions={[def]}
        boardId={7}
        onCardUpdated={vi.fn()}
      />,
    )
    const cardEl = await hoverUntilPeek(container)
    act(() => { fireEvent.click(screen.getByRole('button', { name: /Stage: Beta/ })) })
    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowDown' }) })
    expect(cardEl.style.boxShadow).toContain(LIFTED)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })
})
