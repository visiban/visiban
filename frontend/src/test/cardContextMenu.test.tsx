import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import CardContextMenu, { CARD_MENU_ESCAPE_PRIORITY } from '../components/Card/CardContextMenu'
import { EscapeLowerHandlers } from './escapeSelectionProbe'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { cardActionEntries, type CardActionContext } from '../utils/cardActions'
import type { BoardFull, Card, Column } from '../types'

// Card context menu (#2059, 1.3 UI spec Part 9 § 2).

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 7, uid: 'carduid00007', column: 10, swimlane: 20, title: 'Fix payout rounding',
    description: '', priority: 'low', assignee: null, labels: [],
    due_date: null, weight: 1, position: 0,
    created_by: { id: 1, username: 'alice', display_name: 'Alice', avatar_url: '' },
    created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
    is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0,
    external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    ...overrides,
  }
}

const columns: Column[] = [
  { id: 10, uid: 'c1', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
  { id: 11, uid: 'c2', name: 'Doing', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
]
const user = (id: number, name: string) => ({ id, username: name.toLowerCase(), display_name: name, avatar_url: '' })
const members = [
  { id: 1, user: user(1, 'Alice'), role: 'member', is_moderator: false, joined_at: '' },
  { id: 2, user: user(2, 'Victor'), role: 'viewer', is_moderator: false, joined_at: '' },
] as unknown as BoardFull['members']

const member: CardActionContext = { role: 'member', currentUserId: 1, isModerator: false, demoMode: false, maintenanceBlocked: false }

function renderMenu(cards: Card[] = [makeCard()], ctx: CardActionContext = member, extra: Partial<React.ComponentProps<typeof CardContextMenu>> = {}) {
  const onAction = vi.fn()
  const onClose = vi.fn()
  const utils = render(
    <CardContextMenu
      anchor={{ top: 100, bottom: 100, left: 50 }}
      label={cards.length === 1 ? `Card actions: ${cards[0].title}` : `Actions for ${cards.length} cards`}
      header={cards.length > 1 ? `${cards.length} cards` : undefined}
      entries={cardActionEntries(cards, ctx)}
      columns={columns}
      members={members}
      onAction={onAction}
      onClose={onClose}
      {...extra}
    />,
  )
  return { ...utils, onAction, onClose }
}

const item = (name: string | RegExp) => screen.getByRole('menuitem', { name })

describe('CardContextMenu', () => {
  it('lists the four groups in order with Delete last, and focuses the first item', () => {
    renderMenu()
    const menu = screen.getByRole('menu', { name: 'Card actions: Fix payout rounding' })
    const labels = within(menu).getAllByRole('menuitem').map((el) => el.getAttribute('data-action'))
    expect(labels).toEqual(['open', 'copy-link', 'move', 'assign', 'priority', 'block', 'archive', 'delete'])
    expect(within(menu).getAllByRole('separator')).toHaveLength(3)
    expect(item(/Delete card…/)).toHaveClass('focus:ring-danger-emphasis')
    expect(item(/Open card/)).toHaveFocus()
    expect(within(item(/Open card/)).getByText('Enter')).toBeInTheDocument()
  })

  it('shows Unblock card for a manually blocked card', () => {
    renderMenu([makeCard({ blocked_at: '2026-10-01T00:00:00Z', is_blocked: true })])
    expect(item('Unblock card')).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /Block card…/ })).not.toBeInTheDocument()
  })

  it('for a viewer, keeps every item with a visible reason line, never hiding one', () => {
    renderMenu([makeCard()], { ...member, role: 'viewer' })
    expect(item(/Open card/)).not.toHaveAttribute('aria-disabled')
    const block = item(/Block card…/)
    expect(block).toHaveAttribute('aria-disabled', 'true')
    expect(block).toHaveAccessibleDescription("Viewers can't block cards")
    expect(screen.getByText("Viewers can't delete cards")).toBeInTheDocument()
  })

  it('Enter on a disabled item does nothing and re-announces the reason', () => {
    const { onAction } = renderMenu([makeCard()], { ...member, role: 'viewer' })
    const block = item(/Block card…/)
    fireEvent.click(block)
    expect(onAction).not.toHaveBeenCalled()
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent("Viewers can't block cards")
    const first = status.textContent
    fireEvent.click(block)
    expect(status.textContent).not.toBe(first)
  })

  it('a multi-card target shows the count header and disables single-card items', () => {
    renderMenu([makeCard(), makeCard({ id: 8, title: 'Other' })])
    expect(screen.getByText('2 cards')).toBeInTheDocument()
    expect(item(/Open card/)).toHaveAccessibleDescription('Select one card')
    expect(item(/Block card…/)).toHaveAccessibleDescription('Select one card')
    expect(item(/Move to…/)).not.toHaveAttribute('aria-disabled')
  })

  it('roving focus: arrows wrap, Home/End jump, typeahead finds by first letter', () => {
    renderMenu()
    fireEvent.keyDown(item(/Open card/), { key: 'ArrowUp' })
    expect(item(/Delete card…/)).toHaveFocus()
    fireEvent.keyDown(item(/Delete card…/), { key: 'ArrowDown' })
    expect(item(/Open card/)).toHaveFocus()
    fireEvent.keyDown(item(/Open card/), { key: 'End' })
    expect(item(/Delete card…/)).toHaveFocus()
    fireEvent.keyDown(item(/Delete card…/), { key: 'Home' })
    expect(item(/Open card/)).toHaveFocus()
    fireEvent.keyDown(item(/Open card/), { key: 'a' })
    expect(item(/Assign to…/)).toHaveFocus()
    fireEvent.keyDown(item(/Assign to…/), { key: 'a' })
    expect(item(/Archive card/)).toHaveFocus()
  })

  it('keeps typeahead letters away from document-level board shortcuts, but not Escape or ⌘K', () => {
    const docKeys: string[] = []
    const onDoc = (e: KeyboardEvent) => { docKeys.push(e.key) }
    document.addEventListener('keydown', onDoc)
    try {
      renderMenu()
      fireEvent.keyDown(item(/Open card/), { key: 's' })
      fireEvent.keyDown(item(/Set priority/), { key: '.' })
      fireEvent.keyDown(item(/Set priority/), { key: 'k', metaKey: true })
      expect(docKeys).toEqual(['k'])
    } finally {
      document.removeEventListener('keydown', onDoc)
    }
  })

  it('runs a plain item through onAction', () => {
    const { onAction } = renderMenu()
    fireEvent.click(item(/Archive card/))
    expect(onAction).toHaveBeenCalledWith('archive')
  })

  it('ArrowRight opens a submenu, ArrowLeft closes only it, and a choice runs with its value', () => {
    const { onAction } = renderMenu()
    fireEvent.keyDown(item(/Move to…/), { key: 'ArrowRight' })
    const sub = screen.getByRole('menu', { name: 'Move to column' })
    expect(item(/Move to…/)).toHaveAttribute('aria-expanded', 'true')
    expect(within(sub).getByRole('menuitem', { name: 'To Do' })).toHaveFocus()
    fireEvent.keyDown(within(sub).getByRole('menuitem', { name: 'To Do' }), { key: 'ArrowLeft' })
    expect(screen.queryByRole('menu', { name: 'Move to column' })).not.toBeInTheDocument()
    expect(item(/Move to…/)).toHaveFocus()
    fireEvent.click(item(/Move to…/))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Doing' }))
    expect(onAction).toHaveBeenCalledWith('move', 11)
  })

  it('Assign lists Unassign and every non-viewer member; Priority lists the four priorities', () => {
    const { onAction } = renderMenu()
    fireEvent.click(item(/Assign to…/))
    const assign = screen.getByRole('menu', { name: 'Assign to' })
    expect(within(assign).getAllByRole('menuitem').map((e) => e.textContent)).toEqual(['Unassign', 'Alice'])
    fireEvent.click(within(assign).getByRole('menuitem', { name: 'Unassign' }))
    expect(onAction).toHaveBeenCalledWith('assign', null)
    fireEvent.mouseEnter(item(/Set priority/))
    expect(screen.queryByRole('menu', { name: 'Assign to' })).not.toBeInTheDocument()
    fireEvent.click(item(/Set priority/))
    const prio = screen.getByRole('menu', { name: 'Set priority' })
    expect(within(prio).getAllByRole('menuitem').map((e) => e.textContent)).toEqual(['Low', 'Medium', 'High', 'Urgent'])
    fireEvent.click(within(prio).getByRole('menuitem', { name: 'Urgent' }))
    expect(onAction).toHaveBeenCalledWith('priority', 'urgent')
  })

  it('ArrowRight on a disabled submenu item re-announces instead of opening', () => {
    renderMenu([makeCard()], { ...member, role: 'viewer' })
    fireEvent.keyDown(item(/Move to…/), { key: 'ArrowRight' })
    expect(screen.queryByRole('menu', { name: 'Move to column' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent("Viewers can't move cards")
  })

  it(`Escape (priority ${CARD_MENU_ESCAPE_PRIORITY}) closes the submenu first, then the menu, and never the selection`, () => {
    const lower = vi.fn()
    render(<EscapeLowerHandlers onLower={lower} />)
    const { onClose } = renderMenu()
    fireEvent.click(item(/Move to…/))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Move to column' })).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledWith('escape')
    expect(lower).not.toHaveBeenCalled()
  })

  it('outranks the block-reason form (42) and the card panel (30)', () => {
    const form = vi.fn(() => undefined)
    function Form() { useEscapeStack(form, 42); return null }
    render(<Form />)
    const { onClose } = renderMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledWith('escape')
    expect(form).not.toHaveBeenCalled()
    expect(CARD_MENU_ESCAPE_PRIORITY).toBeGreaterThan(44)
    expect(CARD_MENU_ESCAPE_PRIORITY).toBeLessThan(60)
  })

  it('Tab closes the menu', () => {
    const { onClose } = renderMenu()
    fireEvent.keyDown(item(/Open card/), { key: 'Tab' })
    expect(onClose).toHaveBeenCalledWith('tab')
  })

  it('an outside press or focus leaving it closes the menu; presses inside do not', () => {
    const { onClose } = renderMenu()
    fireEvent.pointerDown(item(/Open card/))
    expect(onClose).not.toHaveBeenCalled()
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    fireEvent.pointerDown(outside)
    expect(onClose).toHaveBeenCalledWith('outside')
    onClose.mockClear()
    fireEvent.blur(item(/Open card/), { relatedTarget: outside })
    expect(onClose).toHaveBeenCalledWith('outside')
    outside.remove()
  })

  it('closes on window resize (anchored popover rule)', () => {
    const { onClose } = renderMenu()
    fireEvent(window, new Event('resize'))
    expect(onClose).toHaveBeenCalledWith('outside')
  })
})
