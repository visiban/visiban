import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import CardItem from '../components/Card/CardItem'
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
// pointer. React's mouseleave needs a native mouseout on the card, which the
// browser does not send when a hovered card node is moved or re-inserted, or
// while a layout shift slides the board out from under a still pointer (the
// filter row opening). These tests drive the hover with mouseenter and then
// send NO mouseleave, the shape of every stuck-hover report.

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
    // A fast move straight from the card onto the peek: React dispatches the
    // card's leave and the peek's enter from one native event, so it stays.
    act(() => {
      fireEvent.mouseLeave(cardEl)
      fireEvent.mouseEnter(screen.getByRole('tooltip'))
    })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
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
})
