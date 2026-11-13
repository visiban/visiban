import { StrictMode } from 'react'
import { createPortal } from 'react-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CardDetail from '../components/Card/CardDetail'
import type { Card, BoardFull, User } from '../types'
import { markBoardTreePointerEvent } from '../hooks/useCardSheetPlacement'
import { DEMO_CARD_DETAIL_NOTE, DEMO_CARD_FOOTER_NOTE, DEMO_EXTERNAL_REF_REASON } from '../constants/demoCopy'

// #1914 — the card detail sheet anchored to the selected card's column.

vi.mock('../api/cards', () => ({
  // Manual block (#1149): CardBlockSection fetches the block history on mount.
  blockCard: vi.fn(),
  unblockCard: vi.fn(),
  getCardBlocks: vi.fn().mockResolvedValue([]),
  deleteCard: vi.fn(),
  archiveCard: vi.fn(),
  getCardComments: vi.fn().mockResolvedValue([]),
  addCardComment: vi.fn(),
  deleteComment: vi.fn(),
  updateCard: vi.fn(),
  getCardAttachments: vi.fn().mockResolvedValue([]),
  uploadCardAttachment: vi.fn(),
  deleteCardAttachment: vi.fn(),
  getChecklist: vi.fn().mockResolvedValue([]),
  addChecklistItem: vi.fn(),
  updateChecklistItem: vi.fn(),
  deleteChecklistItem: vi.fn(),
  getCardRelations: vi.fn().mockResolvedValue([]),
  addCardRelation: vi.fn(),
  deleteCardRelation: vi.fn(),
  searchCards: vi.fn().mockResolvedValue([]),
}))
vi.mock('../api/boards', () => ({ createLabel: vi.fn() }))
vi.mock('../components/Card/ActivityTabPanel', () => ({
  default: () => <div data-testid="activity-tab-panel">Activity</div>,
}))
vi.mock('../components/Card/RichTextEditor', () => ({
  default: ({ value }: { value: string }) => <div data-testid="rich-text-editor">{value}</div>,
}))

import { getCardComments, getCardAttachments, getChecklist } from '../api/cards'
import { flagsWrapper } from './instanceFlagsWrapper'

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false,
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Test Card', description: 'A test card',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: 0, created_by: { id: 1, username: 'jdoe', display_name: 'Jane Doe', avatar_url: '' }, created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z', last_moved_at: null,
    attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
    version: 1, custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    ...overrides,
  }
}

function makeBoard(): BoardFull {
  return {
    health_status: null, effective_health_status: null, health_status_source: null, default_preset: null,
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0,
    columns: [
      { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
      { id: 11, uid: 'coluid000002', name: 'Doing', position: 1, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
    ],
    swimlanes: [{ id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null }],
    cards: [], labels: [],
    members: [{ id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false, show_row_chip_field_names: true, export_min_role: 'viewer', card_density: 'comfortable', is_starred: false, created_at: '', updated_at: '', current_user_role: 'admin',
    owner: { id: 1, username: 'jdoe', display_name: 'Jane Doe', avatar_url: '' },
    capabilities: { movement_export: false },
    share_token: null, share_token_expires_at: null, share_link_active: false,
    custom_field_definitions: [], swimlane_custom_field_definitions: [],
  }
}

const defaultProps = () => ({
  card: makeCard(),
  board: makeBoard(),
  onClose: vi.fn(),
  onDeleted: vi.fn(),
  onUpdated: vi.fn(),
  onArchived: vi.fn(),
  currentUser: fakeUser,
})

// ── A fake board DOM with measurable geometry ──────────────────────────────
interface Box { left: number; top: number; width: number; height: number }
function stubRect(el: Element, box: () => Box) {
  el.getBoundingClientRect = () => {
    const b = box()
    return { x: b.left, y: b.top, left: b.left, top: b.top, width: b.width, height: b.height, right: b.left + b.width, bottom: b.top + b.height, toJSON: () => b } as DOMRect
  }
}

function setViewport(width: number, height = 900) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })
}

/** Toolbar bottom 96, lane labels 0..220, the card's cell `cell`, the card 60px tall at `cardTop`. */
function mountBoard({ withCard = true } = {}) {
  const geo = { cell: { left: 240, top: 120, width: 220, height: 400 }, cardTop: 280 }
  const nav = document.createElement('nav')
  nav.setAttribute('aria-label', 'Board toolbar')
  stubRect(nav, () => ({ left: 0, top: 56, width: 1600, height: 40 }))
  const scroll = document.createElement('div')
  scroll.setAttribute('data-board-scroll', '')
  scroll.tabIndex = -1
  const content = document.createElement('div')
  scroll.appendChild(content)
  const lane = document.createElement('div')
  lane.setAttribute('data-lane-label', '')
  stubRect(lane, () => ({ left: 0, top: 120, width: 220, height: 400 }))
  const cell = document.createElement('div')
  cell.setAttribute('data-board-cell', '')
  stubRect(cell, () => geo.cell)
  const cardEl = document.createElement('div')
  cardEl.setAttribute('data-card-id', '1')
  cardEl.tabIndex = 0
  cardEl.textContent = 'Card face'
  stubRect(cardEl, () => ({ left: geo.cell.left + 8, top: geo.cardTop, width: 204, height: 60 }))
  content.append(lane, cell)
  if (withCard) cell.appendChild(cardEl)
  document.body.append(nav, scroll)
  return { geo, nav, scroll, content, cell, cardEl }
}

const dialog = () => screen.getByRole('dialog', { name: /./ })

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  setViewport(1600)
})

afterEach(() => {
  document.querySelectorAll('nav[aria-label="Board toolbar"], [data-board-scroll], [data-keeps-card-sheet-open]').forEach((el) => el.remove())
  setViewport(1024, 768)
  vi.unstubAllGlobals()
})

describe('CardDetail sheet — Dock to edge toggle (#1915)', () => {
  const toggle = () => screen.getByTestId('card-sheet-dock-toggle')

  it('renders before Close in DOM order, unpressed, with the Dock label; focus still opens on Close', () => {
    mountBoard()
    render(<CardDetail {...defaultProps()} />)
    const t = toggle()
    expect(t).toHaveAttribute('type', 'button')
    expect(t).toHaveAttribute('aria-pressed', 'false')
    expect(t).toHaveAttribute('aria-label', 'Dock to edge')
    expect(t).toHaveAttribute('title', 'Dock to edge')
    const close = screen.getByRole('button', { name: 'Close' })
    expect(t.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(close).toHaveFocus()
    expect(dialog()).toHaveAttribute('data-sheet-mode', 'anchored')
  })

  it('docks on click, persists, relabels, and does not rely on tint alone (border plus icon swap)', async () => {
    mountBoard()
    render(<CardDetail {...defaultProps()} />)
    const before = toggle().innerHTML
    await userEvent.click(toggle())
    await waitFor(() => expect(dialog()).toHaveAttribute('data-sheet-mode', 'docked'))
    expect(localStorage.getItem('user:prefs:card-sheet-docked')).toBe('true')
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(toggle()).toHaveAttribute('aria-label', 'Open next to card')
    expect(toggle()).toHaveAttribute('title', 'Open next to card')
    expect(toggle().className).toContain('bg-surface-hover')
    expect(toggle().className).toContain('border-line-strong')
    expect(toggle().innerHTML).not.toBe(before)
    expect(screen.getByTestId('card-detail-backdrop')).toBeInTheDocument()
    expect(screen.queryByTestId('card-sheet-notch')).not.toBeInTheDocument()
  })

  it('toggles back to anchored and clears the stored preference', async () => {
    localStorage.setItem('user:prefs:card-sheet-docked', 'true')
    mountBoard()
    render(<CardDetail {...defaultProps()} />)
    expect(dialog()).toHaveAttribute('data-sheet-mode', 'docked')
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(toggle())
    await waitFor(() => expect(dialog()).toHaveAttribute('data-sheet-mode', 'anchored'))
    expect(localStorage.getItem('user:prefs:card-sheet-docked')).toBe('false')
  })

  it('activates with Enter and Space', async () => {
    mountBoard()
    render(<CardDetail {...defaultProps()} />)
    toggle().focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-pressed', 'true'))
    await userEvent.keyboard(' ')
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-pressed', 'false'))
  })

  it('Shift+Tab from Close reaches the toggle', async () => {
    mountBoard()
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(toggle()).toHaveFocus()
  })

  it('a fresh mount (a card swap, a reload) keeps the chosen mode at >= 1280px', async () => {
    mountBoard()
    const first = render(<CardDetail {...defaultProps()} />)
    await userEvent.click(toggle())
    first.unmount()
    render(<CardDetail {...defaultProps()} />)
    expect(dialog()).toHaveAttribute('data-sheet-mode', 'docked')
  })

  it('is hidden at <= 640px (full-screen), even when docked is stored', () => {
    localStorage.setItem('user:prefs:card-sheet-docked', 'true')
    setViewport(640)
    mountBoard()
    render(<CardDetail {...defaultProps()} />)
    expect(dialog()).toHaveAttribute('data-sheet-mode', 'fullscreen')
    expect(screen.queryByTestId('card-sheet-dock-toggle')).not.toBeInTheDocument()
  })

  it('is shown at 641px', () => {
    setViewport(641)
    mountBoard()
    render(<CardDetail {...defaultProps()} />)
    expect(toggle()).toBeInTheDocument()
  })
})

describe('CardDetail sheet — anchor rule (#1914)', () => {
  it('anchors right of the column, below the toolbar, with a notch at the card and no backdrop', () => {
    mountBoard()
    render(<CardDetail {...defaultProps()} />)
    const d = dialog()
    expect(d).toHaveAttribute('data-sheet-mode', 'anchored')
    expect(d).toHaveAttribute('data-sheet-side', 'right')
    // Column right 460 + 6px gap; toolbar bottom 96 + 8px; 12px above the bottom.
    expect(d.style.left).toBe('466px')
    expect(d.style.top).toBe('104px')
    expect(d.style.bottom).toBe('12px')
    expect(d.style.width).toBe('540px')
    expect(d.className).toContain('rounded-lg')
    expect(d.className).toContain('shadow-2xl')
    const notch = screen.getByTestId('card-sheet-notch')
    expect(notch).toHaveAttribute('aria-hidden', 'true')
    expect(notch).toHaveAttribute('data-clamped', 'false')
    // #1946: a tail (isosceles triangle) in the brand blue, on a 1px brand-blue border.
    expect(notch.tagName.toLowerCase()).toBe('svg')
    expect(notch.getAttribute('class')).toContain('fill-primary-emphasis')
    // Sheet right of the column: the tail sits on the sheet's LEFT edge, facing the card, unflipped.
    expect(notch.getAttribute('class')).toContain('-left-[7px]')
    expect(notch.getAttribute('class')).not.toContain('-scale-x-100')
    expect(notch).not.toHaveAttribute('data-direction')
    expect(notch.querySelector('path')).toHaveAttribute('d', 'M7 6L1 12L7 18Z')
    expect(d.className).toContain('border-primary-emphasis')
    expect(d.className).not.toContain('border-line')
    // Card center 310, sheet top 104: tail center 206, top = center - 13.
    expect(notch.style.top).toBe('193px')
    // The tail is a direct child of the root, before the clip wrapper.
    expect(notch.parentElement).toBe(d)
    const wrapper = notch.nextElementSibling as HTMLElement
    expect(wrapper.className).toContain('overflow-hidden')
    expect(wrapper.className).toContain('rounded-[7px]')
    expect(d.className).not.toContain('overflow-hidden')
    expect(screen.queryByTestId('card-detail-backdrop')).not.toBeInTheDocument()
  })

  it('starts below the filter row when it is shown, not just below the toolbar', () => {
    const { scroll } = mountBoard()
    // Toolbar bottom 96; the filter row ends, and the board grid starts, at 150.
    stubRect(scroll, () => ({ left: 0, top: 150, width: 1600, height: 750 }))
    render(<CardDetail {...defaultProps()} />)
    expect(dialog().style.top).toBe('158px')
  })

  it('flips left of the column when the right side has no room', () => {
    const { geo } = mountBoard()
    geo.cell = { ...geo.cell, left: 1000 }
    render(<CardDetail {...defaultProps()} />)
    expect(dialog()).toHaveAttribute('data-sheet-side', 'left')
    expect(dialog().style.left).toBe(`${1000 - 6 - 540}px`)
    const tail = screen.getByTestId('card-sheet-notch')
    // Sheet left of the column: the tail sits on the sheet's RIGHT edge, mirrored.
    expect(tail.getAttribute('class')).toContain('-right-[7px]')
    expect(tail.getAttribute('class')).toContain('-scale-x-100')
  })

  it('docks at the right edge with the light backdrop when neither side fits', () => {
    setViewport(1300)
    const { geo } = mountBoard()
    geo.cell = { ...geo.cell, left: 600 }
    render(<CardDetail {...defaultProps()} />)
    expect(dialog()).toHaveAttribute('data-sheet-mode', 'docked')
    expect(dialog().className).toContain('right-0')
    expect(dialog().className).toContain('border-l')
    expect(dialog().className).not.toContain('rounded-lg')
    expect(dialog().className).toContain('border-line')
    expect(dialog().className).not.toContain('border-primary-emphasis')
    // A flush panel's clip wrapper has no radius (#1946).
    expect((dialog().firstElementChild as HTMLElement).className).toContain('overflow-hidden')
    expect((dialog().firstElementChild as HTMLElement).className).not.toContain('rounded-')
    expect(screen.getByTestId('card-detail-backdrop').className).toContain('bg-backdrop/20')
    expect(screen.queryByTestId('card-sheet-notch')).not.toBeInTheDocument()
  })

  it('docks between 641px and 1279px even when the column has room', () => {
    setViewport(1279)
    mountBoard()
    render(<CardDetail {...defaultProps()} />)
    expect(dialog()).toHaveAttribute('data-sheet-mode', 'docked')
  })

  it('is full-screen at <= 640px with 44px Board and Close controls', async () => {
    setViewport(640)
    mountBoard()
    const props = defaultProps()
    render(<CardDetail {...props} />)
    expect(dialog()).toHaveAttribute('data-sheet-mode', 'fullscreen')
    expect(dialog().className).toContain('inset-0')
    expect(dialog().className).not.toContain('border-primary-emphasis')
    expect((dialog().firstElementChild as HTMLElement).className).not.toContain('rounded-')
    expect(screen.queryByTestId('card-detail-backdrop')).not.toBeInTheDocument()
    const back = screen.getByRole('button', { name: 'Back to board' })
    expect(back.className).toContain('h-11')
    expect(screen.getByRole('button', { name: 'Close' }).className).toContain('h-11')
    await userEvent.setup().click(back)
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('has no Board back control outside full-screen', () => {
    mountBoard()
    render(<CardDetail {...defaultProps()} />)
    expect(screen.queryByRole('button', { name: 'Back to board' })).not.toBeInTheDocument()
  })

  it('draws a wedge pointing up when the card is scrolled above the sheet', () => {
    const { geo } = mountBoard()
    geo.cardTop = -400
    render(<CardDetail {...defaultProps()} />)
    const notch = screen.getByTestId('card-sheet-notch')
    expect(notch).toHaveAttribute('data-clamped', 'true')
    expect(notch).toHaveAttribute('data-direction', 'up')
    expect(notch.getAttribute('class')).toContain('fill-primary-emphasis')
    expect(notch.querySelector('path')).toHaveAttribute('d', 'M7 6H1L7 18Z')
    // Pinned 28px below the sheet's top corner.
    expect(notch.style.top).toBe(`${28 - 13}px`)
  })

  it('draws a wedge pointing down when the card is scrolled below the sheet', () => {
    const { geo } = mountBoard()
    geo.cardTop = 5000
    render(<CardDetail {...defaultProps()} />)
    const notch = screen.getByTestId('card-sheet-notch')
    expect(notch).toHaveAttribute('data-clamped', 'true')
    expect(notch).toHaveAttribute('data-direction', 'down')
    expect(notch.querySelector('path')).toHaveAttribute('d', 'M7 6L1 18H7Z')
  })

  it('docks with no notch when the card has no board element (deep link, palette, filtered out)', () => {
    mountBoard({ withCard: false })
    render(<CardDetail {...defaultProps()} />)
    expect(dialog()).toHaveAttribute('data-sheet-mode', 'docked')
    expect(screen.queryByTestId('card-sheet-notch')).not.toBeInTheDocument()
  })

  it('switches to anchored when the card element appears later (board content resized)', async () => {
    const observers: Array<() => void> = []
    vi.stubGlobal('ResizeObserver', class {
      cb: () => void
      constructor(cb: () => void) { this.cb = cb; observers.push(() => cb()) }
      observe() {}
      disconnect() {}
    })
    const { cell, cardEl } = mountBoard({ withCard: false })
    render(<CardDetail {...defaultProps()} />)
    expect(dialog()).toHaveAttribute('data-sheet-mode', 'docked')
    // The board finishes rendering (a lane expands): the card is now there.
    cell.appendChild(cardEl)
    act(() => { observers.forEach((fire) => { fire(); fire() }) })
    await waitFor(() => expect(dialog()).toHaveAttribute('data-sheet-mode', 'anchored'))
    expect(screen.getByTestId('card-sheet-notch')).toBeInTheDocument()
  })

  it('switches to anchored when the card renders within a few frames of opening', async () => {
    const { cell, cardEl } = mountBoard({ withCard: false })
    render(<CardDetail {...defaultProps()} />)
    expect(dialog()).toHaveAttribute('data-sheet-mode', 'docked')
    cell.appendChild(cardEl)
    await waitFor(() => expect(dialog()).toHaveAttribute('data-sheet-mode', 'anchored'))
  })

  it('re-anchors to the new column after an in-sheet Move, and docks if the card element is lost', () => {
    const { content, cardEl } = mountBoard()
    const props = defaultProps()
    const { rerender } = render(<CardDetail {...props} />)
    expect(dialog().style.left).toBe('466px')

    // The card re-mounts in the Doing cell, which is further right.
    const doing = document.createElement('div')
    doing.setAttribute('data-board-cell', '')
    stubRect(doing, () => ({ left: 700, top: 120, width: 220, height: 400 }))
    content.appendChild(doing)
    doing.appendChild(cardEl)
    stubRect(cardEl, () => ({ left: 708, top: 280, width: 204, height: 60 }))
    rerender(<CardDetail {...props} card={makeCard({ column: 11, version: 2 })} />)
    expect(dialog()).toHaveAttribute('data-sheet-mode', 'anchored')
    expect(dialog().style.left).toBe(`${920 + 6}px`)

    // Moved into a collapsed column: no element to anchor to.
    cardEl.remove()
    rerender(<CardDetail {...props} card={makeCard({ column: 10, swimlane: 20, version: 3, position: 5 })} />)
    expect(dialog()).toHaveAttribute('data-sheet-mode', 'docked')
  })

  it('re-places on window resize after the 150ms debounce', async () => {
    mountBoard()
    render(<CardDetail {...defaultProps()} />)
    expect(dialog()).toHaveAttribute('data-sheet-mode', 'anchored')
    setViewport(1000)
    fireEvent(window, new Event('resize'))
    // Not yet: the re-place waits for the resize to settle.
    expect(dialog()).toHaveAttribute('data-sheet-mode', 'anchored')
    await waitFor(() => expect(dialog()).toHaveAttribute('data-sheet-mode', 'docked'))
  })

  it('moves the notch with a vertical board scroll and re-places at scroll-end; ignores scrolls inside the sheet', async () => {
    const { geo, scroll } = mountBoard()
    render(<CardDetail {...defaultProps()} />)
    const notchTop = () => screen.getByTestId('card-sheet-notch').style.top
    expect(notchTop()).toBe('193px')

    // A scroll inside the sheet's own body is not a board scroll.
    geo.cardTop = 380
    const body = dialog().querySelector('[aria-busy]') as HTMLElement
    fireEvent.scroll(body)
    await new Promise((r) => setTimeout(r, 200))
    expect(notchTop()).toBe('193px')

    // The board scrolls: the notch follows the card (it does not move the sheet).
    fireEvent.scroll(scroll)
    await waitFor(() => expect(notchTop()).toBe('293px'))
    expect(dialog().style.top).toBe('104px')

    // Scroll-end: the board was scrolled sideways, the column moved right.
    geo.cell = { ...geo.cell, left: 300 }
    fireEvent.scroll(scroll)
    await waitFor(() => expect(dialog().style.left).toBe(`${520 + 6}px`))
  })
})

describe('CardDetail sheet — click-catcher (#1914)', () => {
  const press = (el: Element, init: { x?: number; y?: number; button?: number } = {}) => {
    const { x = 10, y = 10, button = 0 } = init
    fireEvent.pointerDown(el, { button, clientX: x, clientY: y })
  }
  const click = (el: Element, x = 10, y = 10) => fireEvent.click(el, { clientX: x, clientY: y })

  it('closes on a click on empty board space and consumes that click', () => {
    const { scroll } = mountBoard()
    const behind = vi.fn()
    scroll.addEventListener('click', behind)
    const props = defaultProps()
    render(<CardDetail {...props} />)
    press(scroll)
    // The dismissing press does not move focus, so focus can return to the card.
    expect(fireEvent.mouseDown(scroll)).toBe(false)
    click(scroll)
    expect(props.onClose).toHaveBeenCalledOnce()
    // The dismissing click never reaches what was under it (no surprise "add card").
    expect(behind).not.toHaveBeenCalled()
  })

  it('lets a control outside the board work in the same click that closes the sheet', () => {
    mountBoard()
    const filters = document.createElement('button')
    const opened = vi.fn()
    filters.addEventListener('click', opened)
    const toolbar = document.querySelector('nav[aria-label="Board toolbar"]')!
    toolbar.appendChild(filters)
    const props = defaultProps()
    render(<CardDetail {...props} />)
    press(filters)
    // Not consumed: the press moves focus as usual and the click goes through.
    expect(fireEvent.mouseDown(filters)).toBe(true)
    click(filters)
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(opened).toHaveBeenCalledOnce()
  })

  describe('with the custom color picker open (#2095)', () => {
    const openPicker = () => {
      fireEvent.click(screen.getByRole('button', { name: '+ New label' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'New label name' }), { target: { value: 'Half typed' } })
      fireEvent.click(screen.getByRole('button', { name: 'Choose custom color' }))
      expect(screen.getByRole('dialog', { name: 'Custom color' })).toBeInTheDocument()
    }

    it('the first press on board space closes only the picker, still consumed; the second closes the sheet', () => {
      const { scroll } = mountBoard()
      const behind = vi.fn()
      scroll.addEventListener('click', behind)
      const props = defaultProps()
      render(<CardDetail {...props} />)
      openPicker()

      press(scroll)
      fireEvent.mouseDown(scroll)
      click(scroll)
      expect(screen.queryByRole('dialog', { name: 'Custom color' })).toBeNull()
      expect(props.onClose).not.toHaveBeenCalled()
      expect(behind).not.toHaveBeenCalled()
      expect(screen.getByRole('textbox', { name: 'New label name' })).toHaveValue('Half typed')

      press(scroll)
      fireEvent.mouseDown(scroll)
      click(scroll)
      expect(props.onClose).toHaveBeenCalledOnce()
    })

    it('a press on another card still swaps the sheet, and the typed label name goes with it', () => {
      const { cell } = mountBoard()
      const other = document.createElement('div')
      other.setAttribute('data-card-id', '2')
      cell.appendChild(other)
      const cardClick = vi.fn()
      other.addEventListener('click', cardClick)
      const props = defaultProps()
      const { rerender } = render(<CardDetail key={props.card.id} {...props} />)
      openPicker()

      press(other)
      fireEvent.mouseDown(other)
      click(other)
      expect(screen.queryByRole('dialog', { name: 'Custom color' })).toBeNull()
      expect(cardClick).toHaveBeenCalledOnce()
      expect(props.onClose).not.toHaveBeenCalled()

      // BoardView keys the sheet by card, so the swap is a new instance (panels replace, never stack).
      rerender(<CardDetail key={2} {...props} card={{ ...props.card, id: 2 }} />)
      expect(screen.queryByRole('textbox', { name: 'New label name' })).toBeNull()
      expect(screen.getByRole('button', { name: '+ New label' })).toBeInTheDocument()
    })

    it('a control outside the sheet still works, and the sheet survives that press', () => {
      mountBoard()
      const filters = document.createElement('button')
      const opened = vi.fn()
      filters.addEventListener('click', opened)
      document.querySelector('nav[aria-label="Board toolbar"]')!.appendChild(filters)
      const props = defaultProps()
      render(<CardDetail {...props} />)
      openPicker()

      press(filters)
      fireEvent.mouseDown(filters)
      click(filters)
      expect(screen.queryByRole('dialog', { name: 'Custom color' })).toBeNull()
      expect(opened).toHaveBeenCalledOnce()
      expect(props.onClose).not.toHaveBeenCalled()
    })
  })

  it('consumes the click on a control inside the board, such as an empty cell', () => {
    const { content } = mountBoard()
    const emptyCell = document.createElement('div')
    emptyCell.setAttribute('role', 'button')
    const add = vi.fn()
    emptyCell.addEventListener('click', add)
    content.appendChild(emptyCell)
    const props = defaultProps()
    render(<CardDetail {...props} />)
    press(emptyCell)
    expect(fireEvent.mouseDown(emptyCell)).toBe(false)
    click(emptyCell)
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(add).not.toHaveBeenCalled()
  })

  it('saves an unsaved title edit before an outside click closes the sheet', async () => {
    const { scroll } = mountBoard()
    const { updateCard } = await import('../api/cards')
    ;(updateCard as ReturnType<typeof vi.fn>).mockResolvedValue(makeCard({ title: 'Renamed', version: 2 }))
    const props = defaultProps()
    render(<CardDetail {...props} />)
    const title = screen.getByDisplayValue('Test Card')
    title.focus()
    fireEvent.change(title, { target: { value: 'Renamed' } })
    press(scroll)
    click(scroll)
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(updateCard).toHaveBeenCalledWith(1, 1, expect.objectContaining({ title: 'Renamed' }))
  })

  it('leaves a click on another board card to that card (it swaps the open card)', () => {
    const { cell } = mountBoard()
    const other = document.createElement('div')
    other.setAttribute('data-card-id', '2')
    cell.appendChild(other)
    const cardClick = vi.fn()
    other.addEventListener('click', cardClick)
    const props = defaultProps()
    render(<CardDetail {...props} />)
    press(other)
    // The press focuses the new card, which becomes the opener for the swap.
    expect(fireEvent.mouseDown(other)).toBe(true)
    click(other)
    expect(props.onClose).not.toHaveBeenCalled()
    expect(cardClick).toHaveBeenCalledOnce()
  })

  it('keeps focus in the sheet when the open card itself is clicked', () => {
    const { cardEl } = mountBoard()
    const cardClick = vi.fn()
    cardEl.addEventListener('click', cardClick)
    const props = defaultProps()
    render(<CardDetail {...props} />)
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
    press(cardEl)
    // Default-prevented: the press does not move focus onto the card face.
    expect(fireEvent.mouseDown(cardEl)).toBe(false)
    click(cardEl)
    expect(props.onClose).not.toHaveBeenCalled()
    expect(cardClick).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
  })

  it('leaves a popover a board card portaled to document.body alone (custom-field quick edit)', () => {
    const { scroll } = mountBoard()
    function PortaledFromCard() {
      return (
        <div data-testid="board-tree" onPointerDownCapture={markBoardTreePointerEvent}>
          {createPortal(<div data-testid="quick-edit"><button data-testid="choice">Won</button></div>, document.body)}
        </div>
      )
    }
    const picked = vi.fn()
    const props = defaultProps()
    render(<><PortaledFromCard /><CardDetail {...props} /></>)
    const choice = screen.getByTestId('choice')
    choice.addEventListener('click', picked)
    // Portaled: outside the board's DOM and the sheet's.
    expect(scroll.contains(choice)).toBe(false)
    expect(dialog().contains(choice)).toBe(false)
    press(choice)
    expect(fireEvent.mouseDown(choice)).toBe(true)
    click(choice)
    expect(props.onClose).not.toHaveBeenCalled()
    expect(picked).toHaveBeenCalledOnce()
    // The popover's padding (not a control) is not consumed either.
    press(screen.getByTestId('quick-edit'))
    click(screen.getByTestId('quick-edit'))
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('never closes from a click on a toast marked data-keeps-card-sheet-open', () => {
    mountBoard()
    const toast = document.createElement('div')
    toast.setAttribute('data-keeps-card-sheet-open', '')
    const btn = document.createElement('button')
    toast.appendChild(btn)
    document.body.appendChild(toast)
    const props = defaultProps()
    render(<CardDetail {...props} />)
    press(btn)
    click(btn)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('leaves clicks inside another dialog opened over the sheet (the command palette) alone', () => {
    mountBoard()
    const palette = document.createElement('div')
    palette.setAttribute('role', 'dialog')
    palette.setAttribute('aria-modal', 'true')
    const result = document.createElement('button')
    const picked = vi.fn()
    result.addEventListener('click', picked)
    palette.appendChild(result)
    document.body.appendChild(palette)
    const props = defaultProps()
    render(<CardDetail {...props} />)
    press(result)
    expect(fireEvent.mouseDown(result)).toBe(true)
    click(result)
    expect(props.onClose).not.toHaveBeenCalled()
    expect(picked).toHaveBeenCalledOnce()
    palette.remove()
  })

  it('does not close on a drag, a non-primary button, or a canceled pointer', () => {
    const { scroll } = mountBoard()
    const props = defaultProps()
    render(<CardDetail {...props} />)
    press(scroll, { x: 10 })
    click(scroll, 40)
    press(scroll, { button: 2 })
    click(scroll)
    press(scroll)
    fireEvent.pointerCancel(scroll)
    click(scroll)
    // A click with no pointerdown (keyboard activation) is never a dismissal.
    click(scroll)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('treats a portaled dropdown opened from the sheet as inside', async () => {
    mountBoard()
    const user = userEvent.setup()
    const props = defaultProps()
    render(<CardDetail {...props} />)
    await user.click(screen.getAllByRole('combobox')[0])
    const option = await screen.findByRole('option', { name: 'Jane Doe' })
    // The menu is portaled to document.body, outside the dialog's DOM.
    expect(dialog().contains(option)).toBe(false)
    await user.click(option)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('does not close on a click inside the sheet', async () => {
    mountBoard()
    const props = defaultProps()
    render(<CardDetail {...props} />)
    await userEvent.setup().click(screen.getByText('Comments'))
    expect(props.onClose).not.toHaveBeenCalled()
  })
})

describe('CardDetail sheet — focus (#1914)', () => {
  it('moves focus to the close button on open', () => {
    mountBoard()
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
  })

  it('returns focus to the card when the opener is gone (opened from the command palette)', () => {
    const { cardEl } = mountBoard()
    const palette = document.createElement('input')
    document.body.appendChild(palette)
    palette.focus()
    const { unmount } = render(<CardDetail {...defaultProps()} />)
    palette.remove()
    unmount()
    expect(cardEl).toHaveFocus()
  })

  it('returns focus to the board region when the card was on the board at open but is gone at close (archive, delete)', () => {
    const { scroll, cardEl } = mountBoard()
    // Opened by clicking the card, so the card is the opener too.
    cardEl.focus()
    const { unmount } = render(<CardDetail {...defaultProps()} />)
    expect(dialog()).toHaveAttribute('data-sheet-mode', 'anchored')
    // The card leaves the board in the same commit that closes the sheet.
    cardEl.remove()
    unmount()
    expect(scroll).toHaveFocus()
  })

  it('returns focus to the board region when the card is no longer on the board', () => {
    const { scroll } = mountBoard({ withCard: false })
    const palette = document.createElement('input')
    document.body.appendChild(palette)
    palette.focus()
    const { unmount } = render(<CardDetail {...defaultProps()} />)
    palette.remove()
    unmount()
    expect(scroll).toHaveFocus()
  })
})

describe('CardDetail sheet — loading (#1914, frame 6)', () => {
  it('opens at once from the board card, shows skeletons, is aria-busy and holds Archive until loaded', async () => {
    let resolveComments: (v: unknown[]) => void = () => {}
    ;(getCardComments as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((r) => { resolveComments = r }))
    ;(getCardAttachments as ReturnType<typeof vi.fn>).mockResolvedValueOnce([])
    ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValueOnce([])
    render(<CardDetail {...defaultProps()} />)
    // Title, breadcrumb and tabs come from the board card.
    expect(screen.getByDisplayValue('Test Card')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'details' })).toBeInTheDocument()
    const body = dialog().querySelector('[aria-busy]') as HTMLElement
    expect(body).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByTestId('comments-skeleton')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('checklist-skeleton')).toBeInTheDocument()
    expect(await screen.findByText('Loading card details')).toBeInTheDocument()

    const archive = screen.getByRole('button', { name: 'Archive card' })
    expect(archive).toHaveAttribute('aria-disabled', 'true')
    expect(archive).toHaveAttribute('title', 'Available once the card has loaded')
    fireEvent.click(archive)
    expect(screen.queryByText('Archive this card?')).not.toBeInTheDocument()

    await act(async () => { resolveComments([]) })
    await waitFor(() => expect(body).toHaveAttribute('aria-busy', 'false'))
    expect(screen.queryByTestId('comments-skeleton')).not.toBeInTheDocument()
    expect(screen.queryByText('Loading card details')).not.toBeInTheDocument()
    expect(archive).not.toHaveAttribute('aria-disabled')
    fireEvent.click(archive)
    expect(screen.getByText('Archive this card?')).toBeInTheDocument()
  })

  it('stops loading when a section fetch fails, so Archive is never held forever', async () => {
    ;(getChecklist as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    render(<CardDetail {...defaultProps()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Archive card' })).not.toHaveAttribute('aria-disabled'))
    expect(screen.getByText(/failed to load/)).toBeInTheDocument()
  })
})

describe('CardDetail sheet — shared demo and long content (#1914, frames 5 and 7)', () => {
  it('shows the demo note at the top of the body and makes the PR/MR link read-only with its own reason', () => {
    render(<CardDetail {...defaultProps()} currentUser={fakeUser} />, { wrapper: flagsWrapper({ demo_mode: true }) })
    expect(screen.getByText(DEMO_CARD_DETAIL_NOTE)).toBeInTheDocument()
    const add = screen.getByRole('button', { name: '+ Link a pull or merge request' })
    expect(add).toHaveAttribute('aria-disabled', 'true')
    expect(add).toHaveAttribute('aria-describedby', 'ext-ref-demo-reason')
    expect(screen.getByText(DEMO_EXTERNAL_REF_REASON)).toBeInTheDocument()
    // A determined click still opens no editor.
    fireEvent.click(add)
    expect(screen.queryByLabelText('URL')).not.toBeInTheDocument()
    // No destructive action in the demo: the footer note replaces Archive and Delete.
    expect(screen.queryByText('Delete card')).not.toBeInTheDocument()
    expect(screen.queryByText('Archive card')).not.toBeInTheDocument()
    expect(screen.getByTestId('card-demo-footer')).toHaveTextContent(DEMO_CARD_FOOTER_NOTE)
  })

  it('hides Edit and Remove on an existing PR/MR link in the demo', () => {
    const card = makeCard({ external_ref: { url: 'https://github.com/o/r/pull/1', provider: 'github', ref: 'o/r#1' } })
    render(<CardDetail {...defaultProps()} card={card} currentUser={fakeUser} />, { wrapper: flagsWrapper({ demo_mode: true }) })
    expect(screen.getByText('o/r#1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit pull or merge request link' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove pull or merge request link' })).not.toBeInTheDocument()
  })

  it('shows no demo note outside the demo', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.queryByText(DEMO_CARD_DETAIL_NOTE)).not.toBeInTheDocument()
  })

  it('shows the top and bottom scroll shadows only while there is more content on that side', () => {
    render(<CardDetail {...defaultProps()} />)
    const body = dialog().querySelector('[aria-busy]') as HTMLElement
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 1200 })
    body.scrollTop = 0
    fireEvent.scroll(body)
    expect(screen.queryByTestId('card-body-shadow-top')).not.toBeInTheDocument()
    expect(screen.getByTestId('card-body-shadow-bottom')).toBeInTheDocument()
    // The fades cover h-6 (top) and h-10 (bottom), so a focused control scrolls clear of both (#2180).
    expect(body).toHaveClass('scroll-pt-6', 'scroll-pb-10')
    body.scrollTop = 400
    fireEvent.scroll(body)
    expect(screen.getByTestId('card-body-shadow-top')).toBeInTheDocument()
    expect(screen.getByTestId('card-body-shadow-bottom')).toBeInTheDocument()
    body.scrollTop = 900
    fireEvent.scroll(body)
    expect(screen.getByTestId('card-body-shadow-top')).toBeInTheDocument()
    expect(screen.queryByTestId('card-body-shadow-bottom')).not.toBeInTheDocument()
  })
})

describe('CardDetail sheet — transitions (#1914)', () => {
  const animated: Element[] = []
  beforeEach(() => {
    animated.length = 0
    ;(HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element) {
      animated.push(this)
      return { onfinish: null, oncancel: null }
    }
  })
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate
    document.querySelectorAll('[data-card-sheet-ghost]').forEach((g) => g.remove())
  })

  it('a swap hands the departing sheet to the new card: the old content fades out over the new one', () => {
    mountBoard()
    const props = defaultProps()
    const { rerender } = render(<CardDetail key={1} {...props} />)
    expect(animated).toContain(dialog())
    animated.length = 0
    rerender(<CardDetail key={2} {...props} card={makeCard({ id: 2, title: 'Second' })} />)
    const ghost = document.querySelector('[data-card-sheet-ghost]')
    expect(ghost).not.toBeNull()
    expect(animated).toContain(ghost)
    expect(animated).toContain(dialog())
    // Exactly one dialog: the ghost is not one.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByDisplayValue('Second')).toBeInTheDocument()
  })

  it('a close leaves a ghost that plays the close transition, and the dialog is gone at once', async () => {
    mountBoard()
    const { unmount } = render(<CardDetail {...defaultProps()} />)
    unmount()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const ghost = document.querySelector('[data-card-sheet-ghost]')
    expect(ghost).toHaveAttribute('aria-hidden', 'true')
    animated.length = 0
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect(animated).toContain(ghost)
  })

  it("StrictMode's simulated remount leaves no ghost behind", async () => {
    mountBoard()
    render(<StrictMode><CardDetail {...defaultProps()} /></StrictMode>)
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect(document.querySelector('[data-card-sheet-ghost]')).toBeNull()
  })
})
