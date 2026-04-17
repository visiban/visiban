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
})
