import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import CardPeekSheet from '../components/Card/CardPeekSheet'
import CardDetail from '../components/Card/CardDetail'
import type { BoardFull, Card, User } from '../types'

// #2507: the card peek follows the card detail sheet's placement rule and shares its Dock to edge preference.
// Every other card endpoint (the detail sheet loads many) resolves empty.
vi.mock('../api/cards', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const stubbed = Object.fromEntries(Object.keys(real).map((k) => [k, vi.fn().mockResolvedValue([])]))
  return { ...stubbed, getCardTimeline: vi.fn().mockResolvedValue({ count: 0, next: null, previous: null, results: [] }) }
})

const DOCK_KEY = 'user:prefs:card-sheet-docked'

const board = {
  id: 1,
  columns: [{ id: 1, name: 'Prospect', position: 0 }, { id: 2, name: 'Qualified', position: 1 }],
  swimlanes: [{ id: 5, name: 'North America' }],
  custom_field_definitions: [],
  cards: [],
  members: [], labels: [], tracks: [], track_definitions: [],
} as unknown as BoardFull

const card = {
  id: 9, column: 2, swimlane: 5, title: 'Sakura', description: '', due_date: null, assignee: null,
  is_stale: false, last_moved_at: new Date().toISOString(), version: 1, created_at: new Date().toISOString(),
  custom_field_values: [], labels: [], tracks: [],
} as unknown as Card

interface Box { left: number; top: number; width: number; height: number }
function stubRect(el: Element, box: Box) {
  el.getBoundingClientRect = () => ({ x: box.left, y: box.top, left: box.left, top: box.top, width: box.width, height: box.height, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box } as DOMRect)
}
function setViewport(width: number, height = 900) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })
}

/** A board whose card 9 sits in a column at `cellLeft`..+220, toolbar bottom 96. */
function mountBoard(cellLeft = 240) {
  const nav = document.createElement('nav')
  nav.setAttribute('aria-label', 'Board toolbar')
  stubRect(nav, { left: 0, top: 56, width: 1600, height: 40 })
  const scroll = document.createElement('div')
  scroll.setAttribute('data-board-scroll', '')
  stubRect(scroll, { left: 0, top: 96, width: 1600, height: 800 })
  const content = document.createElement('div')
  scroll.appendChild(content)
  const cell = document.createElement('div')
  cell.setAttribute('data-board-cell', '')
  stubRect(cell, { left: cellLeft, top: 120, width: 220, height: 400 })
  const cardEl = document.createElement('div')
  cardEl.setAttribute('data-card-id', '9')
  cardEl.tabIndex = 0
  stubRect(cardEl, { left: cellLeft + 8, top: 280, width: 204, height: 60 })
  cell.appendChild(cardEl)
  content.append(cell)
  document.body.append(nav, scroll)
  return { cell }
}

const setup = () => render(<CardPeekSheet card={card} board={board} canEdit onClose={vi.fn()} onOpenCard={vi.fn()} onMoveCard={vi.fn().mockResolvedValue({ ok: true })} />)
const sheet = () => screen.getByTestId('card-peek-sheet')

beforeEach(() => {
  localStorage.clear()
  setViewport(1600)
})
afterEach(() => {
  document.querySelectorAll('nav[aria-label="Board toolbar"], [data-board-scroll]').forEach((el) => el.remove())
  setViewport(1024, 768)
})

describe('CardPeekSheet placement (#2507)', () => {
  it('anchors beside the card column at 400px wide with a notch, not at the far right', () => {
    mountBoard()
    setup()
    const d = sheet()
    expect(d).toHaveAttribute('data-sheet-mode', 'anchored')
    expect(d).toHaveAttribute('data-sheet-side', 'right')
    expect(d.style.left).toBe('466px')
    expect(d.style.top).toBe('104px')
    expect(d.style.bottom).toBe('12px')
    expect(d.style.width).toBe('400px')
    expect(d.className).not.toContain('right-4')
    const notch = screen.getByTestId('card-sheet-notch')
    expect(notch.parentElement).toBe(d)
    expect((notch.nextElementSibling as HTMLElement).className).toContain('overflow-hidden')
    expect(screen.queryByTestId('card-peek-backdrop')).not.toBeInTheDocument()
  })

  it('flips to the left of the column when the right side has no room for 400px', () => {
    mountBoard(1250)
    setup()
    expect(sheet()).toHaveAttribute('data-sheet-side', 'left')
    expect(sheet().style.left).toBe(`${1250 - 6 - 400}px`)
    expect(screen.getByTestId('card-sheet-notch').getAttribute('class')).toContain('-scale-x-100')
  })

  it('docks below 1280px with the light backdrop and no notch', () => {
    setViewport(1100)
    mountBoard()
    setup()
    expect(sheet()).toHaveAttribute('data-sheet-mode', 'docked')
    expect(sheet().className).toContain('right-0')
    expect(sheet().className).toContain('border-l')
    expect(screen.getByTestId('card-peek-backdrop').className).toContain('bg-backdrop/20')
    expect(screen.queryByTestId('card-sheet-notch')).not.toBeInTheDocument()
  })

  it('is full-screen at 640px and hides the dock toggle', () => {
    setViewport(640)
    mountBoard()
    setup()
    expect(sheet()).toHaveAttribute('data-sheet-mode', 'fullscreen')
    expect(sheet().className).toContain('inset-0')
    expect(screen.queryByTestId('card-sheet-dock-toggle')).not.toBeInTheDocument()
  })

  it('docks when the card has no measurable element', () => {
    setup()
    expect(sheet()).toHaveAttribute('data-sheet-mode', 'docked')
  })

  it('re-places after a debounced window resize', async () => {
    mountBoard()
    setup()
    expect(sheet()).toHaveAttribute('data-sheet-mode', 'anchored')
    setViewport(1100)
    fireEvent(window, new Event('resize'))
    expect(sheet()).toHaveAttribute('data-sheet-mode', 'anchored')
    await waitFor(() => expect(sheet()).toHaveAttribute('data-sheet-mode', 'docked'))
  })
})

describe('CardPeekSheet Dock to edge (#2507)', () => {
  it('docks on click, persists under the detail sheet\'s key, and relabels', () => {
    mountBoard()
    setup()
    const t = screen.getByTestId('card-sheet-dock-toggle')
    expect(t).toHaveAttribute('aria-pressed', 'false')
    expect(t).toHaveAttribute('aria-label', 'Dock to edge')
    fireEvent.click(t)
    expect(sheet()).toHaveAttribute('data-sheet-mode', 'docked')
    expect(localStorage.getItem(DOCK_KEY)).toBe('true')
    expect(screen.getByTestId('card-sheet-dock-toggle')).toHaveAttribute('aria-label', 'Open next to card')
    fireEvent.click(screen.getByTestId('card-sheet-dock-toggle'))
    expect(sheet()).toHaveAttribute('data-sheet-mode', 'anchored')
    expect(localStorage.getItem(DOCK_KEY)).toBe('false')
  })

  it('opens docked when the preference is stored, even with room beside the card', () => {
    localStorage.setItem(DOCK_KEY, 'true')
    mountBoard()
    setup()
    expect(sheet()).toHaveAttribute('data-sheet-mode', 'docked')
    expect(screen.getByTestId('card-sheet-dock-toggle')).toHaveAttribute('aria-pressed', 'true')
  })

  it('shares the preference with the card detail sheet in both directions', () => {
    mountBoard()
    const peek = setup()
    fireEvent.click(screen.getByTestId('card-sheet-dock-toggle'))
    peek.unmount()
    const user = { id: 1, username: 'j', email: 'j@x.com', first_name: '', last_name: '', display_name: 'J', avatar_url: '', is_site_admin: false, must_change_password: false, must_change_username: false } as User
    const detail = render(<CardDetail card={card} board={board} onClose={vi.fn()} onDeleted={vi.fn()} onUpdated={vi.fn()} onArchived={vi.fn()} currentUser={user} />)
    expect(screen.getByRole('dialog', { name: /./ })).toHaveAttribute('data-sheet-mode', 'docked')
    fireEvent.click(screen.getByTestId('card-sheet-dock-toggle'))
    detail.unmount()
    setup()
    expect(sheet()).toHaveAttribute('data-sheet-mode', 'anchored')
  })
})

describe('CardPeekSheet card-to-card swap (#2507)', () => {
  afterEach(() => { delete (Element.prototype as { animate?: unknown }).animate })

  it('slides on a same-side swap', () => {
    const animate = vi.fn((..._args: unknown[]) => ({ onfinish: null, oncancel: null }))
    ;(Element.prototype as { animate?: unknown }).animate = animate
    const { cell } = mountBoard()
    const second = document.createElement('div')
    second.setAttribute('data-card-id', '10')
    stubRect(second, { left: 1250 + 8, top: 400, width: 204, height: 60 })
    const cell2 = document.createElement('div')
    cell2.setAttribute('data-board-cell', '')
    stubRect(cell2, { left: 700, top: 120, width: 220, height: 400 })
    cell2.appendChild(second)
    cell.parentElement!.appendChild(cell2)
    const card2 = { ...card, id: 10, column: 1 } as Card
    const props = { board, canEdit: true, onClose: vi.fn(), onOpenCard: vi.fn(), onMoveCard: vi.fn().mockResolvedValue({ ok: true }) }
    const { rerender } = render(<CardPeekSheet key={9} card={card} {...props} />)
    animate.mockClear()
    rerender(<CardPeekSheet key={10} card={card2} {...props} />)
    // Both cards place on the right of their column: same side, so the panel slides (a translateX keyframe).
    expect(sheet()).toHaveAttribute('data-sheet-side', 'right')
    const slid = animate.mock.calls.some((c) => JSON.stringify(c[0]).includes('translateX'))
    expect(slid).toBe(true)
  })
})
