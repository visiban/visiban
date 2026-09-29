import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import CardItem from '../components/Card/CardItem'
import type { Card, CardExternalRef } from '../types'

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
}))

vi.mock('../components/Common/Avatar', () => ({
  default: ({ user }: { user: { display_name: string } }) => <span data-testid="avatar">{user.display_name}</span>,
}))

const GH: CardExternalRef = {
  provider: 'github',
  ref: 'acme/web#12',
  url: 'https://github.com/acme/web/pull/12',
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Linked card',
    description: '', priority: 'low', assignee: null, labels: [],
    due_date: null, weight: 1, position: 0,
    created_by: { id: 1, username: 'alice', display_name: 'Alice', avatar_url: '' },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
    is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0,
    external_ref: GH,
    ...overrides,
  }
}

describe('CardItem — MR/PR badge (#352)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders a new-tab link with a safe rel', () => {
    render(<CardItem card={makeCard()} density="standard" />)
    const link = screen.getByRole('link', { name: 'acme/web#12, GitHub, opens in new tab' })
    expect(link).toHaveAttribute('href', GH.url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    // The real host is shown, since provider/ref are editor-chosen free text.
    expect(link).toHaveAttribute('title', 'GitHub acme/web#12 — github.com (opens in new tab)')
  })

  it.each(['standard', 'dense'] as const)('shows the ref text at %s density', (density) => {
    render(<CardItem card={makeCard()} density={density} />)
    expect(screen.getByText('acme/web#12')).toBeInTheDocument()
  })

  it('shows the glyph only at comfortable density, keeping the accessible name', () => {
    render(<CardItem card={makeCard()} density="comfortable" />)
    expect(screen.queryByText('acme/web#12')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'acme/web#12, GitHub, opens in new tab' })).toBeInTheDocument()
  })

  it('is hidden in compact layout', () => {
    render(<CardItem card={makeCard()} density="standard" compact />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('renders nothing when the card has no link (null or undefined)', () => {
    const { rerender } = render(<CardItem card={makeCard({ external_ref: null })} density="dense" />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    rerender(<CardItem card={makeCard({ external_ref: undefined })} density="dense" />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('clicking the badge does not open the card', () => {
    const onClick = vi.fn()
    render(<CardItem card={makeCard()} density="standard" onClick={onClick} />)
    fireEvent.click(screen.getByRole('link'))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('keydown on the badge does not bubble to the card', () => {
    const onKeyDown = vi.fn()
    render(
      <div onKeyDown={onKeyDown}>
        <CardItem card={makeCard()} density="standard" />
      </div>,
    )
    fireEvent.keyDown(screen.getByRole('link'), { key: 'Enter' })
    expect(onKeyDown).not.toHaveBeenCalled()
  })

  // The card's drag sensors start on mousedown (MouseSensor) and touchstart
  // (TouchSensor), not pointerdown (#1287) — all three must be stopped.
  it.each([
    ['pointer-down', 'onPointerDown', fireEvent.pointerDown],
    ['mouse-down', 'onMouseDown', fireEvent.mouseDown],
    ['touch-start', 'onTouchStart', fireEvent.touchStart],
  ] as const)('%s on the badge does not bubble (never starts a drag)', (_name, prop, fire) => {
    const handler = vi.fn()
    render(
      <div {...{ [prop]: handler }}>
        <CardItem card={makeCard()} density="standard" />
      </div>,
    )
    fire(screen.getByRole('link'))
    expect(handler).not.toHaveBeenCalled()
  })

  it('never renders an href for a non-http URL', () => {
    render(<CardItem card={makeCard({ external_ref: { ...GH, url: 'javascript:alert(1)' } })} density="standard" />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'acme/web#12, GitHub' })).toBeInTheDocument()
  })

  it('re-renders when only the link changes (memo comparator)', () => {
    const card = makeCard({ external_ref: null })
    const { rerender } = render(<CardItem card={card} density="standard" />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    rerender(<CardItem card={{ ...card, external_ref: GH }} density="standard" />)
    expect(screen.getByRole('link')).toBeInTheDocument()
    rerender(<CardItem card={{ ...card, external_ref: { ...GH, ref: 'acme/web#13' } }} density="standard" />)
    expect(screen.getByText('acme/web#13')).toBeInTheDocument()
  })

  it('lists the ref as plain text in the peek popover', async () => {
    vi.useFakeTimers()
    const { container } = render(<CardItem card={makeCard()} density="comfortable" />)
    const cardEl = container.querySelector('[data-tour-step="card"]') as HTMLElement
    fireEvent.mouseEnter(cardEl)
    await act(async () => { vi.advanceTimersByTime(600) })
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('GitHub acme/web#12')
  })
})

describe('CardItem — selection checkbox never starts a drag (#1287)', () => {
  it.each([
    ['pointer-down', 'onPointerDown', fireEvent.pointerDown],
    ['mouse-down', 'onMouseDown', fireEvent.mouseDown],
    ['touch-start', 'onTouchStart', fireEvent.touchStart],
  ] as const)('%s on the checkbox does not bubble', (_name, prop, fire) => {
    const handler = vi.fn()
    render(
      <div {...{ [prop]: handler }}>
        <CardItem card={makeCard({ external_ref: null })} density="standard" onSelect={vi.fn()} />
      </div>,
    )
    fire(screen.getByRole('checkbox'))
    expect(handler).not.toHaveBeenCalled()
  })
})
