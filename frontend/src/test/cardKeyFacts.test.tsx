import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CardDetail from '../components/Card/CardDetail'
import CardKeyFacts from '../components/Card/CardKeyFacts'
import { buildKeyFacts } from '../utils/cardKeyFacts'
import { rememberCardDetailTab } from '../components/Card/cardDetailTabMemory'
import type { Card, BoardFull, User, CustomFieldDefinition } from '../types'

vi.mock('../api/cards', () => ({
  blockCard: vi.fn(),
  unblockCard: vi.fn(),
  getCardBlocks: vi.fn().mockResolvedValue([]),
  deleteCard: vi.fn(),
  archiveCard: vi.fn(),
  getCardComments: vi.fn().mockResolvedValue([]),
  getCardTimeline: vi.fn().mockResolvedValue({ count: 0, next: null, previous: null, results: [] }),
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
vi.mock('../components/Card/ActivityTabPanel', () => ({ default: () => <div>Activity</div> }))
vi.mock('../components/Card/MentionTextarea', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="mention-textarea" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))
vi.mock('../components/Card/RichTextEditor', () => ({
  default: ({ value }: { value: string }) => <textarea data-testid="rich-text-editor" defaultValue={value} />,
}))

import { getCardAttachments, deleteCardAttachment, getCardComments } from '../api/cards'

const alex: User = {
  id: 7, username: 'alex', email: 'a@example.com', first_name: 'Alex', last_name: 'Brown', avatar_url: '',
  display_name: 'Alex Brown', is_site_admin: false, must_change_password: false, must_change_username: false,
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Test Card', description: 'A test card',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1, position: 0,
    created_by: { id: 1, username: 'user1', display_name: 'User 1', avatar_url: '' },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', last_moved_at: null,
    attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1,
    custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    ...overrides,
  }
}

const dealField: CustomFieldDefinition = {
  id: 55, uid: 'cfuid000055', name: 'Deal value', field_type: 'text', choices: [], position: 0, show_on_card: true,
  is_required: false, help_text: '', number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
  threshold_direction: '', threshold_warn: null, threshold_alert: null, threshold_warn_days: null, threshold_alert_days: null, created_at: '2026-01-01T00:00:00Z',
}

function makeBoard(overrides: Partial<BoardFull> = {}): BoardFull {
  return {
    health_status: null, effective_health_status: null, health_status_source: null, health_status_changed_at: null, health_status_changed_by: null, health_status_note: null, default_preset: null,
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0,
    columns: [
      { id: 10, uid: 'coluid000001', name: 'Review', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
      { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: true, policy: null },
    ],
    swimlanes: [{ id: 20, uid: 'laneuid00001', name: 'Platform', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null }],
    cards: [], labels: [],
    members: [{ id: 1, user: alex, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false,
    show_row_chip_field_names: true, export_min_role: 'viewer', card_density: 'comfortable', is_starred: false,
    created_at: '', updated_at: '', current_user_role: 'admin',
    owner: { id: 1, username: 'jdoe', display_name: 'Jane Doe', avatar_url: '' },
    capabilities: { movement_export: false }, share_token: null, share_token_expires_at: null, share_link_active: false,
    custom_field_definitions: [], swimlane_custom_field_definitions: [],
    ...overrides,
  }
}

const baseProps = () => ({
  card: makeCard(), board: makeBoard(), onClose: vi.fn(), onDeleted: vi.fn(), onUpdated: vi.fn(), onArchived: vi.fn(),
})

describe('buildKeyFacts (#1916)', () => {
  const input = (card: Card, board: BoardFull) => ({ card, board, userTimezone: 'UTC', userDateFormat: 'MM/DD/YYYY' })

  it('always has the column, and nothing else when the card has no assignee, due date or pinned value', () => {
    const facts = buildKeyFacts(input(makeCard(), makeBoard()))
    expect(facts.map((f) => f.key)).toEqual(['column'])
    expect(facts[0].label).toBe('Review, column. Go to Move')
  })

  it('appends the swimlane only when the board has more than one', () => {
    const board = makeBoard()
    board.swimlanes = [...board.swimlanes, { ...board.swimlanes[0], id: 21, uid: 'laneuid00002', name: 'Growth' }]
    const [column] = buildKeyFacts(input(makeCard(), board))
    expect(column.text).toBe('Review · Platform')
    expect(column.label).toBe('Review · Platform, column and swimlane. Go to Move')
  })

  it('orders assignee, due date, then pinned fields, and uses the first name', () => {
    const card = makeCard({
      assignee: alex,
      due_date: '2020-11-20',
      custom_field_values: [{ field_definition: 55, value: '$40k' }],
    })
    const facts = buildKeyFacts(input(card, makeBoard({ custom_field_definitions: [dealField] })))
    expect(facts.map((f) => f.key)).toEqual(['column', 'assignee', 'due', 'field-55'])
    expect(facts[1].text).toBe('Alex')
    expect(facts[1].label).toBe('Assignee: Alex Brown. Go to Assignee')
    expect(facts[2].label).toBe('Due 11/20/2020, overdue, November 20, 2020. Go to Due date')
    expect(facts[2].tone).toBe('danger')
    expect(facts[3].label).toBe('Deal value $40k. Go to Deal value')
  })

  it('omits a pinned field with no value and an unpinned field with one', () => {
    const unpinned = { ...dealField, id: 56, name: 'Stage', show_on_card: false }
    const card = makeCard({ custom_field_values: [{ field_definition: 56, value: 'Won' }] })
    const facts = buildKeyFacts(input(card, makeBoard({ custom_field_definitions: [dealField, unpinned] })))
    expect(facts.map((f) => f.key)).toEqual(['column'])
  })

  it('carries a crossed threshold as the chip does: mark data plus the words in name and title (#1122)', () => {
    const spend = {
      ...dealField, name: 'Spend', field_type: 'number' as const, number_prefix: '$', number_decimals: 0,
      threshold_direction: 'above' as const, threshold_warn: 5000, threshold_alert: 6000,
    }
    const card = makeCard({ custom_field_values: [{ field_definition: 55, value: '6100' }] })
    const [, fact] = buildKeyFacts(input(card, makeBoard({ custom_field_definitions: [spend] })))
    expect(fact.threshold).toEqual({ level: 'alert', direction: 'above' })
    expect(fact.label).toBe('Spend $6,100, Alert: at or above $6,000. Go to Spend')
    expect(fact.staticLabel).toBe('Spend: $6,100, Alert: at or above $6,000')
    expect(fact.title).toBe('Spend: $6,100 (Alert: at or above $6,000)')

    render(<CardKeyFacts facts={[fact]} onJump={vi.fn()} />)
    const button = screen.getByRole('button', { name: /Alert: at or above \$6,000/ })
    expect(button.querySelector('svg[data-threshold-mark="alert"]')).toHaveAttribute('aria-hidden', 'true')
  })

  it('leaves a pinned value short of its threshold unmarked (#1122)', () => {
    const spend = { ...dealField, field_type: 'number' as const, threshold_direction: 'above' as const, threshold_warn: 50 }
    const card = makeCard({ custom_field_values: [{ field_definition: 55, value: '10' }] })
    const [, fact] = buildKeyFacts(input(card, makeBoard({ custom_field_definitions: [spend] })))
    expect(fact.threshold).toBeUndefined()
    expect(fact.label).toBe('Deal value 10. Go to Deal value')
    render(<CardKeyFacts facts={[fact]} onJump={vi.fn()} />)
    expect(document.querySelector('svg[data-threshold-mark]')).toBeNull()
  })
})

describe('CardKeyFacts overflow (#1916)', () => {
  const facts = Array.from({ length: 5 }, (_, i) => ({
    key: `f${i}`, target: 'assignee' as const, text: `Fact ${i}`, label: `Fact ${i}. Go to X`, staticLabel: `Fact ${i}`,
  }))
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')

  beforeEach(() => {
    // Two facts per line: the 5 facts span three lines.
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        // +N follows the last visible chip, so it sits on the line after it.
        if (this.dataset.factMore !== undefined) {
          const visible = [...(this.parentElement?.querySelectorAll<HTMLElement>('[data-fact-index]') ?? [])].filter((el) => !el.hidden).length
          return 20 * Math.floor(visible / 2)
        }
        return 20 * Math.floor(Number(this.dataset.factIndex ?? 0) / 2)
      },
    })
  })
  afterEach(() => {
    if (original) Object.defineProperty(HTMLElement.prototype, 'offsetTop', original)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetTop
  })

  it('collapses what does not fit on two lines into a +N button and expands in place', async () => {
    render(<CardKeyFacts facts={facts} onJump={vi.fn()} />)
    const more = await screen.findByRole('button', { name: '+2 more facts' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Fact 3. Go to X' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fact 2. Go to X' })).toBeInTheDocument()

    await userEvent.click(more)
    const less = screen.getByRole('button', { name: 'Show fewer' })
    expect(less).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Fact 4. Go to X' })).toBeInTheDocument()
  })

  it('collapses again when the fact list changes (a card swap)', async () => {
    const { rerender } = render(<CardKeyFacts facts={facts} onJump={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: '+2 more facts' }))
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeInTheDocument()
    rerender(<CardKeyFacts facts={facts.map((f) => ({ ...f, text: `${f.text}!` }))} onJump={vi.fn()} />)
    expect(await screen.findByRole('button', { name: '+2 more facts' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows no +N when everything fits', () => {
    render(<CardKeyFacts facts={facts.slice(0, 4)} onJump={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /more fact/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
  })

  it('does not count a 1px-taller assignee chip as its own line (offsets 9,8,9,41,41 are two lines)', () => {
    const tops = [9, 8, 9, 41, 41]
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) { return tops[Number(this.dataset.factIndex ?? 0)] },
    })
    render(<CardKeyFacts facts={facts} onJump={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /more fact/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
    expect(document.querySelectorAll('li[hidden]')).toHaveLength(0)
  })

  it('shrinks the visible count until +N sits on line two or earlier', async () => {
    const tops = [0, 0, 20, 20, 40]
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.factMore !== undefined) {
          // +N follows the last visible chip: with 3 visible it wraps to line 3.
          const visible = [...(this.parentElement?.querySelectorAll<HTMLElement>('[data-fact-index]') ?? [])].filter((el) => !el.hidden).length
          return visible >= 3 ? 40 : 20
        }
        return tops[Number(this.dataset.factIndex ?? 0)]
      },
    })
    render(<CardKeyFacts facts={facts} onJump={vi.fn()} />)
    expect(await screen.findByRole('button', { name: '+3 more facts' })).toBeInTheDocument()
    expect(document.querySelectorAll('li[hidden]')).toHaveLength(3)
  })

  it('hides only as many facts as needed: one more fits when +N still lands on line two', async () => {
    // Fact 0-2 on line 0-1, 3 and 4 on line 2; +N sits right after the last visible fact.
    const tops = [0, 0, 0, 20, 40]
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.factMore !== undefined) {
          const visible = [...(this.parentElement?.querySelectorAll<HTMLElement>('[data-fact-index]') ?? [])].filter((el) => !el.hidden).length
          return visible >= 5 ? 40 : 20
        }
        return tops[Number(this.dataset.factIndex ?? 0)]
      },
    })
    render(<CardKeyFacts facts={facts} onJump={vi.fn()} />)
    // Four facts fit on two lines and +N shares line two with fact 3: only one hidden.
    expect(await screen.findByRole('button', { name: '+1 more fact' })).toBeInTheDocument()
    expect(document.querySelectorAll('li[hidden]')).toHaveLength(1)
  })

  it('collapses to one line plus +N when maxLines is 1', async () => {
    render(<CardKeyFacts facts={facts} maxLines={1} onJump={vi.fn()} />)
    expect(await screen.findByRole('button', { name: '+4 more facts' })).toBeInTheDocument()
    expect(document.querySelectorAll('li[hidden]')).toHaveLength(4)
  })

  it('renders nothing for an empty list', () => {
    const { container } = render(<CardKeyFacts facts={[]} onJump={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('CardDetail key facts (#1916)', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.clearAllMocks()
    rememberCardDetailTab('details')
    scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView
  })

  const richCard = () => makeCard({
    assignee: alex,
    due_date: '2999-01-01',
    custom_field_values: [{ field_definition: 55, value: '$40k' }],
  })
  const richBoard = (overrides: Partial<BoardFull> = {}) => makeBoard({ custom_field_definitions: [dealField], ...overrides })
  const facts = () => screen.getByRole('list', { name: 'Key facts' })

  it('renders only the column fact for a bare card', () => {
    render(<CardDetail {...baseProps()} onMoveCard={vi.fn()} />)
    expect(within(facts()).getAllByRole('listitem')).toHaveLength(1)
    expect(within(facts()).getByRole('button', { name: 'Review, column. Go to Move' })).toBeInTheDocument()
  })

  it('jumps to Assignee: scrolls to the top of the section and focuses its first control', async () => {
    render(<CardDetail {...{ ...baseProps(), card: richCard(), board: richBoard() }} />)
    await userEvent.click(within(facts()).getByRole('button', { name: 'Assignee: Alex Brown. Go to Assignee' }))
    const section = document.querySelector('[data-fact-section="assignee"]') as HTMLElement
    await waitFor(() => expect(section.contains(document.activeElement)).toBe(true))
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
  })

  it('scrolls instantly under prefers-reduced-motion', async () => {
    const mm = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })
    vi.stubGlobal('matchMedia', mm)
    window.matchMedia = mm as unknown as typeof window.matchMedia
    try {
      render(<CardDetail {...{ ...baseProps(), card: richCard(), board: richBoard() }} />)
      await userEvent.click(within(facts()).getByRole('button', { name: /Go to Due date/ }))
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' }))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('jumps to Due date and focuses the date input', async () => {
    render(<CardDetail {...{ ...baseProps(), card: richCard(), board: richBoard() }} />)
    await userEvent.click(within(facts()).getByRole('button', { name: /Go to Due date/ }))
    await waitFor(() => expect(screen.getByLabelText('Due date', { selector: 'input' })).toHaveFocus())
  })

  it('switches back to Details from another tab, then focuses the field', async () => {
    render(<CardDetail {...{ ...baseProps(), card: richCard(), board: richBoard() }} />)
    await userEvent.click(screen.getByRole('tab', { name: /^Comments/ }))
    expect(screen.getByRole('tab', { name: /^Comments/ })).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(within(facts()).getByRole('button', { name: /Go to Assignee/ }))
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true')
    const section = document.querySelector('[data-fact-section="assignee"]') as HTMLElement
    await waitFor(() => expect(section.contains(document.activeElement)).toBe(true))
  })

  it('opens a collapsed Custom fields section for a pinned fact and focuses that field', async () => {
    render(<CardDetail {...{ ...baseProps(), card: richCard(), board: richBoard() }} />)
    await userEvent.click(screen.getByRole('button', { name: /Custom fields/ }))
    expect(document.querySelector('[data-fact-section="field:55"]')).toBeNull()
    await userEvent.click(within(facts()).getByRole('button', { name: 'Deal value $40k. Go to Deal value' }))
    const section = await waitFor(() => {
      const el = document.querySelector('[data-fact-section="field:55"]') as HTMLElement
      expect(el).not.toBeNull()
      return el
    })
    await waitFor(() => expect(section.contains(document.activeElement)).toBe(true))
  })

  it('opens the Move popover from the Column fact, with focus inside it', async () => {
    const onMoveCard = vi.fn()
    render(<CardDetail {...{ ...baseProps(), card: richCard(), board: richBoard() }} onMoveCard={onMoveCard} />)
    await userEvent.click(within(facts()).getByRole('button', { name: 'Review, column. Go to Move' }))
    const popover = document.querySelector('[data-move-popover]') as HTMLElement
    expect(popover).not.toBeNull()
    await waitFor(() => expect(popover.contains(document.activeElement)).toBe(true))
  })

  it('returns focus to the Column fact when Move, opened from it, closes with Escape', async () => {
    render(<CardDetail {...{ ...baseProps(), card: richCard(), board: richBoard() }} onMoveCard={vi.fn()} />)
    const fact = within(facts()).getByRole('button', { name: 'Review, column. Go to Move' })
    await userEvent.click(fact)
    await waitFor(() => expect(document.querySelector('[data-move-popover]')).not.toBeNull())
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(document.querySelector('[data-move-popover]')).toBeNull())
    expect(fact).toHaveFocus()
  })

  it('keeps navigating for a read-only viewer; the Column fact is plain text with nothing to open', async () => {
    render(<CardDetail {...{ ...baseProps(), card: richCard(), board: richBoard({ current_user_role: 'viewer' }) }} onMoveCard={vi.fn()} />)
    expect(within(facts()).queryByRole('button', { name: /Column/ })).not.toBeInTheDocument()
    expect(within(facts()).getByLabelText('Review, column')).toBeInTheDocument()
    await userEvent.click(within(facts()).getByRole('button', { name: /Go to Due date/ }))
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    const section = document.querySelector('[data-fact-section="due"]') as HTMLElement
    expect(section.contains(document.activeElement)).toBe(true)
  })

  describe('as a viewer (read-only sections)', () => {
    const viewerBoard = () => richBoard({ current_user_role: 'viewer' })

    it('jumping via Assignee leaves focus inside the section even though its control is disabled', async () => {
      render(<CardDetail {...baseProps()} card={richCard()} board={viewerBoard()} />)
      await userEvent.click(within(facts()).getByRole('button', { name: 'Assignee: Alex Brown. Go to Assignee' }))
      const section = document.querySelector<HTMLElement>('[data-fact-section="assignee"]')!
      await waitFor(() => expect(section.contains(document.activeElement)).toBe(true))
      expect(document.activeElement).not.toBe(document.body)
    })

    it('jumping via a pinned field (no control for a viewer) focuses the section', async () => {
      render(<CardDetail {...baseProps()} card={richCard()} board={viewerBoard()} />)
      await userEvent.click(within(facts()).getByRole('button', { name: /Go to Deal value/ }))
      const section = document.querySelector<HTMLElement>('[data-fact-section="field:55"]')!
      await waitFor(() => expect(section.contains(document.activeElement)).toBe(true))
    })
  })
})

describe('CardDetail section counts (#1916)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rememberCardDetailTab('details')
  })
  const attachment = (id: number) => ({ id, filename: `f${id}.png`, size: 1024, url: `/f/${id}`, uploaded_by: alex, uploaded_at: '2026-01-01T00:00:00Z' })

  it('hides the Attachments count while loading, then shows it, zero included', async () => {
    let resolve!: (v: unknown[]) => void
    ;(getCardAttachments as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    render(<CardDetail {...baseProps()} />)
    expect(screen.queryByTestId('card-section-count-attachments')).not.toBeInTheDocument()
    await act(async () => { resolve([]) })
    expect(await screen.findByTestId('card-section-count-attachments')).toHaveTextContent('0')
  })

  it('updates the Attachments count live after a delete', async () => {
    ;(getCardAttachments as ReturnType<typeof vi.fn>).mockResolvedValueOnce([attachment(1), attachment(2)])
    ;(deleteCardAttachment as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    render(<CardDetail {...baseProps()} />)
    expect(await screen.findByText('f1.png')).toBeInTheDocument()
    expect(screen.getByTestId('card-section-count-attachments')).toHaveTextContent('2')
    fireEvent.click(screen.getByRole('button', { name: 'Delete attachment f1.png' }))
    await waitFor(() => expect(screen.getByTestId('card-section-count-attachments')).toHaveTextContent('1'))
  })

  it('shows "Relations 0" for an editor once loaded, and leaves the Checklist header alone', async () => {
    render(<CardDetail {...baseProps()} />)
    expect(await screen.findByTestId('card-section-count-relations')).toHaveTextContent('0')
    // #445 owns the Checklist header: no count when there are no items.
    expect(screen.getByText('Checklist').textContent).toBe('Checklist')
  })

  it('keeps the Comments tab count unknown while loading', async () => {
    let resolve!: (v: unknown[]) => void
    ;(getCardComments as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    render(<CardDetail {...baseProps()} />)
    expect(screen.queryByTestId('card-tab-count-comments')).not.toBeInTheDocument()
    await act(async () => { resolve([]) })
    expect(await screen.findByTestId('card-tab-count-comments')).toHaveTextContent('0')
  })
})
