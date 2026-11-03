import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AxiosError, AxiosHeaders } from 'axios'
import {
  DEMO_BLOCK_REASON, MAINTENANCE_REASON, OWNER_ONLY_REASON, PALETTE_COMMAND_LABELS, SELECT_ONE_REASON,
  archiveCards, assignCards, cardActionEntries, cardIdFromElement, cardLink, cardTargetSummary,
  contextMenuTargetIds, moveCardsToColumn, paletteCardActions, resolveCardTarget, setCardsPriority, successMessage,
  type CardActionContext,
} from '../utils/cardActions'
import { DEMO_CARD_FOOTER_NOTE } from '../constants/demoCopy'
import type { Card, Column } from '../types'

vi.mock('../api/cards', () => ({ moveCard: vi.fn(), updateCard: vi.fn(), archiveCard: vi.fn() }))
import { archiveCard, moveCard, updateCard } from '../api/cards'

// Shared card-action rules for the context menu and the ⌘K palette (#2059).

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'u1', column: 10, swimlane: 20, title: 'Fix payout rounding',
    description: '', priority: 'low', assignee: null, labels: [], due_date: null, weight: 1, position: 0,
    created_by: { id: 1, username: 'alice', display_name: 'Alice', avatar_url: '' },
    created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
    is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0,
    external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    ...overrides,
  }
}
const column: Column = { id: 11, uid: 'c', name: 'Doing', position: 1, color: '#000', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null }
const member: CardActionContext = { role: 'member', currentUserId: 1, isModerator: false, demoMode: false, maintenanceBlocked: false }
const byId = (cards: Card[], ctx: CardActionContext) => Object.fromEntries(cardActionEntries(cards, ctx).map((e) => [e.id, e]))

function httpError(status: number, data: unknown = {}) {
  return new AxiosError('x', 'ERR', undefined, undefined, { status, data, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } })
}

describe('target resolution', () => {
  it('prefers the open sheet, then the focused card, then the selection, else none', () => {
    expect(resolveCardTarget({ openCardId: 3, focusedCardId: 4, selectedIds: [5] })).toEqual({ cardIds: [3], source: 'open' })
    expect(resolveCardTarget({ openCardId: null, focusedCardId: 4, selectedIds: [5] })).toEqual({ cardIds: [4], source: 'focused' })
    expect(resolveCardTarget({ openCardId: null, focusedCardId: null, selectedIds: new Set([5, 6]) })).toEqual({ cardIds: [5, 6], source: 'selection' })
    expect(resolveCardTarget({ openCardId: undefined, focusedCardId: undefined, selectedIds: [] })).toBeNull()
  })

  it('a card inside the selection targets the selection; outside, only itself', () => {
    expect(contextMenuTargetIds(2, new Set([1, 2, 3]))).toEqual([1, 2, 3])
    expect(contextMenuTargetIds(9, new Set([1, 2]))).toEqual([9])
  })

  it('reads the card id off any element inside a card face', () => {
    const face = document.createElement('div')
    face.setAttribute('data-card-id', '42')
    const inner = document.createElement('span')
    face.appendChild(inner)
    expect(cardIdFromElement(inner)).toBe(42)
    expect(cardIdFromElement(document.body)).toBeNull()
    expect(cardIdFromElement(null)).toBeNull()
  })
})

describe('cardActionEntries', () => {
  it('a member on their own card may do everything', () => {
    const e = byId([makeCard()], member)
    expect(Object.values(e).every((x) => x.enabled)).toBe(true)
    expect(e.block.label).toBe('Block card…')
  })

  it('is state-aware: a manually blocked card offers Unblock card', () => {
    const e = byId([makeCard({ blocked_at: '2026-10-01T00:00:00Z' })], member)
    expect(e.unblock).toMatchObject({ label: 'Unblock card', enabled: true })
    expect(e.block).toBeUndefined()
  })

  it('viewers and collaborators read the reason, Open and Copy link stay enabled', () => {
    const v = byId([makeCard()], { ...member, role: 'viewer' })
    expect(v.open.enabled && v['copy-link'].enabled).toBe(true)
    expect(v.block).toMatchObject({ enabled: false, reason: "Viewers can't block cards" })
    expect(v.priority.reason).toBe("Viewers can't change the priority of cards")
    const c = byId([makeCard()], { ...member, role: 'collaborator' })
    expect(c.move.reason).toBe("Collaborators can't move cards")
  })

  it('maintenance mode disables every write with its own reason', () => {
    const e = byId([makeCard()], { ...member, role: 'admin', maintenanceBlocked: true })
    for (const id of ['move', 'assign', 'priority', 'block', 'archive', 'delete']) expect(e[id].reason).toBe(MAINTENANCE_REASON)
    expect(e.open.enabled).toBe(true)
  })

  it('the hosted demo withholds block, archive and delete with the demo lead', () => {
    const e = byId([makeCard()], { ...member, demoMode: true })
    expect(e.block.reason).toBe(DEMO_BLOCK_REASON)
    expect(e.archive.reason).toBe(DEMO_CARD_FOOTER_NOTE)
    expect(e.delete.reason).toBe(DEMO_CARD_FOOTER_NOTE)
    expect(e.move.enabled && e.priority.enabled).toBe(true)
    // The demo widens reassigning cards others created (CardDetail's carve-out).
    expect(byId([makeCard({ created_by: { id: 9, username: 'z', display_name: 'Z', avatar_url: '' } })], { ...member, demoMode: true }).assign.enabled).toBe(true)
  })

  it('ownership: disabled only when every creator is known and none is the user', () => {
    const other = makeCard({ created_by: { id: 9, username: 'z', display_name: 'Z', avatar_url: '' } })
    const e = byId([other], member)
    expect(e.archive.reason).toBe(OWNER_ONLY_REASON)
    expect(e.delete.reason).toBe(OWNER_ONLY_REASON)
    expect(e.block.reason).toBe(OWNER_ONLY_REASON)
    expect(e.assign.reason).toBe(OWNER_ONLY_REASON)
    // Unknown creator: leave enabled, the server decides.
    expect(byId([makeCard({ created_by: null })], member).archive.enabled).toBe(true)
    // A moderator or admin may act on others' cards.
    expect(byId([other], { ...member, isModerator: true }).delete.enabled).toBe(true)
    expect(byId([other], { ...member, role: 'admin' }).archive.enabled).toBe(true)
    // Mixed set: one own card is enough; the rest report as partial failure.
    expect(byId([other, makeCard({ id: 2 })], member).archive.enabled).toBe(true)
  })

  it('several cards: single-card items say "Select one card"', () => {
    const e = byId([makeCard(), makeCard({ id: 2 })], member)
    expect(e.open.reason).toBe(SELECT_ONE_REASON)
    expect(e['copy-link'].reason).toBe(SELECT_ONE_REASON)
    expect(e.block.reason).toBe(SELECT_ONE_REASON)
    expect(e.move.enabled).toBe(true)
  })
})

describe('palette commands', () => {
  it('has no Open and no Delete, names the card, and puts block first', () => {
    const info = { cardIds: [1], source: 'focused' as const, summary: 'x', actions: cardActionEntries([makeCard()], member) }
    const labels = paletteCardActions(info).map((a) => a.label)
    expect(labels).toEqual(['Block card…', 'Move card to…', 'Assign card to…', 'Set priority…', 'Copy link to card', 'Archive card'])
    expect(labels.every((l) => PALETTE_COMMAND_LABELS.includes(l))).toBe(true)
  })

  it('summarizes the target, with block state', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-04T05:00:00Z'))
    try {
      expect(cardTargetSummary([makeCard({ blocked_at: '2026-10-01T00:00:00Z' })], 'open')).toBe('Fix payout rounding · Blocked 3d')
    } finally {
      vi.useRealTimers()
    }
    expect(cardTargetSummary([makeCard()], 'focused')).toBe('Fix payout rounding')
    expect(cardTargetSummary([makeCard(), makeCard({ id: 2 })], 'selection')).toBe('2 selected cards')
    expect(cardTargetSummary([makeCard(), makeCard({ id: 2 })], 'result')).toBe('2 cards')
  })

  it('links to the board with ?card=', () => {
    expect(cardLink(5, 9, 'https://kanban.example')).toBe('https://kanban.example/boards/5?card=9')
  })
})

describe('writes over a target set (§ Bulk operations wording)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.clearAllMocks() })

  it('moves serially and names a single cause', async () => {
    vi.mocked(moveCard)
      .mockResolvedValueOnce({ card: makeCard({ column: 11 }) } as never)
      .mockRejectedValueOnce(httpError(409, { code: 'wip_limit_exceeded' }))
    const r = await moveCardsToColumn(1, [makeCard(), makeCard({ id: 2 })], column)
    expect(moveCard).toHaveBeenNthCalledWith(1, 1, 1, { column_id: 11, swimlane_id: 20, position: 9999 })
    expect(r.done).toHaveLength(1)
    expect(r.failureMessage).toBe('1 of 2 cards could not be moved — a column limit was reached.')
  })

  it('assigns and sets priority with Promise.allSettled', async () => {
    vi.mocked(updateCard).mockResolvedValue(makeCard() as never)
    expect((await assignCards(1, [makeCard()], null)).failureMessage).toBeNull()
    expect(updateCard).toHaveBeenCalledWith(1, 1, { assignee_id: null })
    vi.mocked(updateCard).mockRejectedValueOnce(httpError(403)).mockRejectedValueOnce(httpError(404))
    expect((await setCardsPriority(1, [makeCard(), makeCard({ id: 2 })], 'high')).failureMessage)
      .toBe('2 of 2 cards could not be updated — for more than one reason.')
  })

  it('archive uses the creator-only 403 wording', async () => {
    vi.mocked(archiveCard).mockRejectedValue(httpError(403))
    expect((await archiveCards(1, [makeCard()])).failureMessage)
      .toBe('1 of 1 card could not be archived — you can only archive cards you created.')
  })

  it('success lines', () => {
    const one = [makeCard()]
    const two = [makeCard(), makeCard({ id: 2 })]
    expect(successMessage('move', one, 'Doing')).toBe('Moved “Fix payout rounding” to Doing.')
    expect(successMessage('assign', two, 'Alice')).toBe('Assigned 2 cards to Alice.')
    expect(successMessage('assign', one)).toBe('Unassigned “Fix payout rounding”.')
    expect(successMessage('priority', one, 'high')).toBe('Set “Fix payout rounding” to high priority.')
    expect(successMessage('archive', two)).toBe('Archived 2 cards.')
    expect(successMessage('copy-link', one)).toBe('Link copied to the clipboard.')
    expect(successMessage('open', one)).toBe('')
  })
})
