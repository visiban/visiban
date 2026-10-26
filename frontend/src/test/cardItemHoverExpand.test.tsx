import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import CardItem from '../components/Card/CardItem'
import type { Card } from '../types'

// The in-place hover expansion (the metadata row wrapping so every chip is
// readable) is an overlay, never a layout change: the wrapper freezes at the
// card's at-rest height and the card goes absolute, so neither the cell nor
// the swimlane row grows under the pointer. The overlay is also clamped to
// its cell: shifted up when it would run past the cell's bottom edge and
// capped at the cell's inner height.

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
}))

vi.mock('../components/Common/Avatar', () => ({
  default: ({ user }: { user: { display_name: string } }) => <span data-testid="avatar">{user.display_name}</span>,
}))

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Hover card',
    description: '', priority: 'low', assignee: null,
    labels: [
      { id: 1, uid: 'label00001', name: 'Backend', color: '#3B82F6' },
      { id: 2, uid: 'label00002', name: 'Frontend', color: '#10B981' },
    ],
    due_date: null, weight: 1, position: 0,
    created_by: { id: 1, username: 'u', display_name: 'U', avatar_url: '' },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    last_moved_at: null, attachment_count: 0, checklist_total: 3, checklist_done: 1,
    is_stale: false, custom_field_values: [], blocker_count: 0, external_ref: null,
    archived_at: null, version: 1,
    ...overrides,
  }
}

const REST_HEIGHT = 88
const EXPANDED_HEIGHT = 136

interface Geometry {
  /** The cell's padding box, as getBoundingClientRect reports it. */
  cellTop: number
  cellBottom: number
  /** Where the card's slot (its wrapper) starts. */
  slotTop: number
}

/** Renders a card inside a stand-in BoardCell and stubs the layout numbers
 *  jsdom cannot produce: the wrapper's at-rest height, the card's expanded
 *  height, and the rects the clamp reads. */
function renderInCell(geometry: Geometry, external?: boolean) {
  const utils = render(
    <div data-board-cell style={{ padding: 8 }}>
      <div data-testid="other-card">Other card</div>
      <CardItem card={makeCard(external ? { external_ref: { provider: 'github', ref: '#12', url: 'https://github.com/x/y/pull/12' } } : {})} density="dense" />
    </div>,
  )
  const cell = utils.container.querySelector('[data-board-cell]') as HTMLElement
  const card = utils.container.querySelector('[data-card-id]') as HTMLElement
  const wrapper = card.parentElement as HTMLElement

  vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({
    top: geometry.cellTop, bottom: geometry.cellBottom, left: 0, right: 220, width: 220,
    height: geometry.cellBottom - geometry.cellTop, x: 0, y: geometry.cellTop, toJSON: () => ({}),
  } as DOMRect)
  vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
    top: geometry.slotTop, bottom: geometry.slotTop + REST_HEIGHT, left: 8, right: 212, width: 204,
    height: REST_HEIGHT, x: 8, y: geometry.slotTop, toJSON: () => ({}),
  } as DOMRect)
  // The wrapper's rect above is the at-rest footprint while the card is in
  // flow; the card itself reports its full wrapped height once it is an overlay.
  Object.defineProperty(card, 'offsetHeight', { configurable: true, get: () => EXPANDED_HEIGHT })
  const style = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
    const cs = style(el)
    if (el === cell) {
      return { ...cs, paddingTop: '8px', paddingBottom: '8px' } as CSSStyleDeclaration
    }
    return cs
  })
  return { ...utils, cell, card, wrapper }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('card hover expansion stays an overlay inside its cell', () => {
  it('at rest the row clips and the card is in flow', () => {
    const { card, wrapper } = renderInCell({ cellTop: 100, cellBottom: 400, slotTop: 108 })
    const row = screen.getByTestId('card-metadata-row')
    expect(row).toHaveClass('overflow-hidden')
    expect(row).not.toHaveClass('flex-wrap')
    expect(card).toHaveClass('relative')
    expect(card).not.toHaveClass('absolute')
    expect(wrapper.style.height).toBe('')
  })

  it('on hover the wrapper keeps the at-rest height and the card becomes an absolute overlay', () => {
    const { card, wrapper } = renderInCell({ cellTop: 100, cellBottom: 400, slotTop: 108 })
    act(() => { fireEvent.mouseEnter(card) })

    const row = screen.getByTestId('card-metadata-row')
    expect(row).toHaveClass('flex-wrap')
    expect(row).toHaveClass('overflow-visible')
    expect(row).not.toHaveClass('overflow-hidden')
    // The wrapper is what the cell lays out; it must not change size.
    expect(wrapper.style.height).toBe(`${REST_HEIGHT}px`)
    expect(card).toHaveClass('absolute')
    expect(card).toHaveClass('left-0')
    expect(card).toHaveClass('right-0')
    expect(card).toHaveClass('overflow-hidden')
    expect(card).not.toHaveClass('relative')
    // Enough room below: no upward shift, capped at the cell's content height.
    expect(card.style.top).toBe('0px')
    expect(card.style.maxHeight).toBe('284px')
  })

  it('shifts the overlay up when the expansion would run past the cell bottom', () => {
    // Cell content box 108..292 (184px). Slot starts at 200, so only 92px of
    // room below for a 136px expansion: shift up by 44px.
    const { card } = renderInCell({ cellTop: 100, cellBottom: 300, slotTop: 200 })
    act(() => { fireEvent.mouseEnter(card) })
    expect(card.style.top).toBe('-44px')
    expect(card.style.maxHeight).toBe('184px')
  })

  it('never shifts above the cell top, and caps the height at the cell instead', () => {
    // Content box 108..208 (100px): smaller than the expansion. The slot is
    // 12px below the content top, so the shift stops at 12px and max-height
    // (100px) clips the rest.
    const { card } = renderInCell({ cellTop: 100, cellBottom: 216, slotTop: 120 })
    act(() => { fireEvent.mouseEnter(card) })
    expect(card.style.top).toBe('-12px')
    expect(card.style.maxHeight).toBe('100px')
    // The overflow is clipped, not spilled: the card stays inside the cell
    // even when its content is taller than the cell's content box.
    expect(card).toHaveClass('overflow-hidden')
    expect(card).not.toHaveClass('overflow-visible')
  })

  it('mouse leave restores the in-flow card and clipped row', () => {
    const { card, wrapper } = renderInCell({ cellTop: 100, cellBottom: 400, slotTop: 108 })
    act(() => { fireEvent.mouseEnter(card) })
    act(() => { fireEvent.mouseLeave(card) })

    const row = screen.getByTestId('card-metadata-row')
    expect(row).toHaveClass('overflow-hidden')
    expect(row).not.toHaveClass('flex-wrap')
    expect(card).toHaveClass('relative')
    expect(card).not.toHaveClass('absolute')
    expect(wrapper.style.height).toBe('')
    expect(card.style.top).toBe('')
    expect(card.style.maxHeight).toBe('')
  })

  it('keyboard focus inside the metadata row expands the same way, and leaving the row collapses it', () => {
    const { card, wrapper } = renderInCell({ cellTop: 100, cellBottom: 400, slotTop: 108 }, true)
    const link = screen.getByRole('link', { name: /#12/ })
    act(() => { fireEvent.focus(link) })
    expect(screen.getByTestId('card-metadata-row')).toHaveClass('flex-wrap')
    expect(card).toHaveClass('absolute')
    expect(wrapper.style.height).toBe(`${REST_HEIGHT}px`)

    act(() => { fireEvent.blur(link, { relatedTarget: screen.getByTestId('other-card') }) })
    expect(screen.getByTestId('card-metadata-row')).toHaveClass('overflow-hidden')
    expect(card).toHaveClass('relative')
    expect(wrapper.style.height).toBe('')
  })

  it('moving focus to another element inside the row keeps the expansion open', () => {
    const { card } = renderInCell({ cellTop: 100, cellBottom: 400, slotTop: 108 }, true)
    const row = screen.getByTestId('card-metadata-row')
    const link = screen.getByRole('link', { name: /#12/ })
    act(() => { fireEvent.focus(link) })
    act(() => { fireEvent.blur(link, { relatedTarget: row }) })
    expect(row).toHaveClass('flex-wrap')
    expect(card).toHaveClass('absolute')
  })

  it('a blur with no relatedTarget (the focused chip unmounted) collapses the expansion', () => {
    const { card, wrapper } = renderInCell({ cellTop: 100, cellBottom: 400, slotTop: 108 }, true)
    const link = screen.getByRole('link', { name: /#12/ })
    act(() => { fireEvent.focus(link) })
    expect(card).toHaveClass('absolute')
    act(() => { fireEvent.blur(link, { relatedTarget: null }) })
    expect(screen.getByTestId('card-metadata-row')).toHaveClass('overflow-hidden')
    expect(card).toHaveClass('relative')
    expect(wrapper.style.height).toBe('')
  })

  it('reports the expansion to the cell on hover and its end on leave', () => {
    const onExpandChange = vi.fn()
    const { container } = render(
      <div data-board-cell>
        <CardItem card={makeCard()} density="dense" onExpandChange={onExpandChange} />
      </div>,
    )
    const card = container.querySelector('[data-card-id]') as HTMLElement
    const wrapper = card.parentElement as HTMLElement
    vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 188, height: REST_HEIGHT } as DOMRect)
    act(() => { fireEvent.mouseEnter(card) })
    expect(onExpandChange).toHaveBeenLastCalledWith(1, true)
    act(() => { fireEvent.mouseLeave(card) })
    expect(onExpandChange).toHaveBeenLastCalledWith(1, false)
  })

  it('a dimmed card is blurred and faded to near-invisible, on the wrapper the cell lays out', () => {
    const { container, rerender } = render(<CardItem card={makeCard()} density="dense" dimmed />)
    const wrapper = (container.querySelector('[data-card-id]') as HTMLElement).parentElement as HTMLElement
    expect(wrapper).toHaveAttribute('data-dimmed', 'true')
    expect(wrapper).toHaveClass('opacity-[0.08]')
    expect(wrapper).toHaveClass('blur-[2px]')
    rerender(<CardItem card={makeCard()} density="dense" dimmed={false} />)
    expect(wrapper).not.toHaveAttribute('data-dimmed')
    expect(wrapper).not.toHaveClass('opacity-[0.08]')
    expect(wrapper).not.toHaveClass('blur-[2px]')
  })

  it('the drag-overlay copy never expands', () => {
    const { container } = render(
      <div data-board-cell>
        <CardItem card={makeCard()} density="dense" overlay />
      </div>,
    )
    const card = container.querySelector('.group') as HTMLElement
    act(() => { fireEvent.mouseEnter(card) })
    expect(card).toHaveClass('relative')
    expect(card).not.toHaveClass('absolute')
    expect(screen.getByTestId('card-metadata-row')).toHaveClass('overflow-hidden')
  })
})
