import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import CardItem from '../components/Card/CardItem'
import type { Card } from '../types'

// Card context menu entry points on the card face (#2059).

const dnd = vi.hoisted(() => ({ isDragging: false }))
vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({ attributes: { role: 'button', tabIndex: 0 }, listeners: {}, setNodeRef: () => {}, isDragging: dnd.isDragging }),
}))

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 7, uid: 'carduid00007', column: 10, swimlane: 20, title: 'Fix payout rounding',
    description: '', priority: 'low', assignee: null, labels: [],
    due_date: null, weight: 1, position: 0,
    created_by: { id: 1, username: 'alice', display_name: 'Alice', avatar_url: '' },
    created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:00Z',
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
    is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0,
    external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    ...overrides,
  }
}

const face = (container: HTMLElement) => container.querySelector('[data-card-id="7"]') as HTMLElement

describe('CardItem — context menu entry points (#2059)', () => {
  it('right-click opens the menu at the pointer and never reaches the cell', () => {
    const onOpenMenu = vi.fn()
    const cellHandler = vi.fn()
    const { container } = render(
      <div onContextMenu={cellHandler}>
        <CardItem card={makeCard()} onOpenMenu={onOpenMenu} />
      </div>,
    )
    const notCanceled = fireEvent.contextMenu(face(container), { clientX: 120, clientY: 80 })
    expect(notCanceled).toBe(false)
    expect(onOpenMenu).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), { top: 80, bottom: 80, left: 120 })
    expect(cellHandler).not.toHaveBeenCalled()
  })

  it('a touch long-press does not open the menu (#1287: it is the drag start)', () => {
    const onOpenMenu = vi.fn()
    const { container } = render(<CardItem card={makeCard()} onOpenMenu={onOpenMenu} />)
    fireEvent.pointerDown(face(container), { pointerType: 'touch' })
    fireEvent.contextMenu(face(container), { clientX: 120, clientY: 80 })
    expect(onOpenMenu).not.toHaveBeenCalled()
  })

  it('does not open while the card is being dragged', () => {
    dnd.isDragging = true
    try {
      const onOpenMenu = vi.fn()
      const { container } = render(<CardItem card={makeCard()} onOpenMenu={onOpenMenu} />)
      fireEvent.contextMenu(face(container), { clientX: 120, clientY: 80 })
      expect(onOpenMenu).not.toHaveBeenCalled()
    } finally {
      dnd.isDragging = false
    }
  })

  it.each([
    ['Menu', { key: 'ContextMenu' }],
    ['Shift+F10', { key: 'F10', shiftKey: true }],
  ])('%s on the focused card opens the menu anchored to the card', (_name, keyInit) => {
    const onOpenMenu = vi.fn()
    const { container } = render(<CardItem card={makeCard()} onOpenMenu={onOpenMenu} />)
    const el = face(container)
    el.getBoundingClientRect = () => ({ top: 40, bottom: 90, left: 15, right: 215, width: 200, height: 50, x: 15, y: 40, toJSON: () => ({}) })
    fireEvent.keyDown(el, keyInit)
    expect(onOpenMenu).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), { top: 40, bottom: 90, left: 15 })
    // The native contextmenu the same key fires does not open it twice.
    fireEvent.contextMenu(el, { clientX: 0, clientY: 0 })
    expect(onOpenMenu).toHaveBeenCalledTimes(1)
  })

  it('a keyboard-generated contextmenu (no pointer position) anchors to the card', () => {
    const onOpenMenu = vi.fn()
    const { container } = render(<CardItem card={makeCard()} onOpenMenu={onOpenMenu} />)
    const el = face(container)
    el.getBoundingClientRect = () => ({ top: 40, bottom: 90, left: 15, right: 215, width: 200, height: 50, x: 15, y: 40, toJSON: () => ({}) })
    fireEvent.contextMenu(el, { clientX: 0, clientY: 0 })
    expect(onOpenMenu).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), { top: 40, bottom: 90, left: 15 })
  })

  it('other keys still reach the drag listeners, and F10 alone does nothing', () => {
    const onOpenMenu = vi.fn()
    const { container } = render(<CardItem card={makeCard()} onOpenMenu={onOpenMenu} />)
    fireEvent.keyDown(face(container), { key: 'F10' })
    fireEvent.keyDown(face(container), { key: 'Enter' })
    expect(onOpenMenu).not.toHaveBeenCalled()
  })

  it('renders the ⋯ More actions button, coarse-pointer only, which opens the menu without opening the card', () => {
    const onOpenMenu = vi.fn()
    const onClick = vi.fn()
    render(<CardItem card={makeCard()} onOpenMenu={onOpenMenu} onClick={onClick} />)
    const button = screen.getByRole('button', { name: 'More actions' })
    expect(button).toHaveAttribute('aria-haspopup', 'menu')
    // Hidden by default; shown only under (pointer: coarse) on a focused card.
    expect(button).toHaveClass('hidden', 'w-11', 'h-11', '[@media(pointer:coarse)]:group-focus-within:flex')
    fireEvent.click(button)
    expect(onOpenMenu).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('on a selected card the ⋯ button shows at coarse pointer without focus', () => {
    render(<CardItem card={makeCard()} onOpenMenu={vi.fn()} selected />)
    expect(screen.getByRole('button', { name: 'More actions' })).toHaveClass('[@media(pointer:coarse)]:flex')
  })

  it('outlines the card while the menu targets it alone', () => {
    // Created just now: no aging tint, so the fill shows.
    const { container } = render(<CardItem card={makeCard({ created_at: new Date().toISOString() })} onOpenMenu={vi.fn()} contextTarget />)
    expect(face(container)).toHaveClass('ring-1', 'ring-info', 'bg-info/10')
  })

  it('drops the info fill under an aging tint, like the selection (#1841)', () => {
    const idle = makeCard({ created_at: '2020-01-01T00:00:00Z', last_moved_at: null })
    const { container } = render(<CardItem card={idle} onOpenMenu={vi.fn()} contextTarget staleness_threshold_days={7} />)
    expect(face(container)).toHaveClass('ring-1', 'ring-info')
    expect(face(container)).not.toHaveClass('bg-info/10')
  })

  it('keeps the title clear of the ⋯ button where it can show', () => {
    render(<CardItem card={makeCard()} onOpenMenu={vi.fn()} />)
    expect(screen.getByText('Fix payout rounding')).toHaveClass('[@media(pointer:coarse)]:group-focus-within:pr-14')
  })

  it('offers no menu path without onOpenMenu or on a read-only card', () => {
    const { container, rerender } = render(<CardItem card={makeCard()} />)
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument()
    // Not canceled: the native menu (or a host's handler) still gets the event.
    expect(fireEvent.contextMenu(face(container))).toBe(true)
    rerender(<CardItem card={makeCard()} onOpenMenu={vi.fn()} readOnly />)
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument()
  })
})
