import type { MoveOutcome } from '../hooks/useBoard'
import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CardDetail from '../components/Card/CardDetail'
import type { Card, BoardFull, User } from '../types'

vi.mock('../api/cards', () => ({
  // Manual block (#1149): CardBlockSection fetches the block history on mount.
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

vi.mock('../api/boards', () => ({
  createLabel: vi.fn(),
}))

vi.mock('../components/Card/ActivityTabPanel', () => ({
  default: ({ focusFirstEntry }: { focusFirstEntry?: boolean }) => (
    <div data-testid="activity-tab-panel" data-focus-first={String(!!focusFirstEntry)}>Activity</div>
  ),
}))

vi.mock('../components/Card/MentionTextarea', () => ({
  default: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
    <textarea
      data-testid="mention-textarea"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  ),
}))

vi.mock('../components/Card/RichTextEditor', () => ({
  default: ({ value, onSave, placeholder, readOnly, showActions }: { value: string; onSave: (v: string) => void; placeholder?: string; readOnly?: boolean; showActions?: boolean }) => (
    <div>
      <textarea
        data-testid="rich-text-editor"
        defaultValue={value}
        placeholder={placeholder}
        readOnly={readOnly}
        onBlur={(e) => { if (!showActions) onSave(e.target.value); }}
      />
      {showActions && !readOnly && (
        <button
          data-testid="description-save"
          onClick={() => {
            const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="rich-text-editor"]')
            onSave(ta?.value ?? value)
          }}
        >
          Save
        </button>
      )}
    </div>
  ),
}))

import { updateCard, getCardComments, getCardAttachments, getChecklist, updateChecklistItem, deleteChecklistItem, getCardRelations, addCardComment, addChecklistItem, getCardTimeline } from '../api/cards'
import { flagsWrapper } from './instanceFlagsWrapper'
import { rememberCardDetailTab } from '../components/Card/cardDetailTabMemory'
// #967: the card tab is session memory at module level; start every test on Details.
beforeEach(() => rememberCardDetailTab('details'))

const mockUpdateCard = updateCard as ReturnType<typeof vi.fn>
const mockGetCardRelations = getCardRelations as ReturnType<typeof vi.fn>
const mockUpdateChecklistItem = updateChecklistItem as ReturnType<typeof vi.fn>
const mockDeleteChecklistItem = deleteChecklistItem as ReturnType<typeof vi.fn>
const mockAddChecklistItem = addChecklistItem as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false,
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Test Card', description: 'A test card',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z', last_moved_at: null,
    attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
    version: 1,
    custom_field_values: [],
    blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    ...overrides,
  }
}

function makeBoard(overrides: Partial<BoardFull> = {}): BoardFull {
  return {
    health_status: null, effective_health_status: null, health_status_source: null, default_preset: null,
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0,
    columns: [{ id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null }],
    swimlanes: [{ id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null }],
    cards: [], labels: [{ id: 100, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }],
    members: [{ id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false, show_row_chip_field_names: true, export_min_role: 'viewer', card_density: 'comfortable', is_starred: false, created_at: '', updated_at: '', current_user_role: 'admin',
    owner: { id: 1, username: 'jdoe', display_name: 'Jane Doe', avatar_url: '' },
    capabilities: { movement_export: false },
    share_token: null,
    share_token_expires_at: null,
    share_link_active: false,
    custom_field_definitions: [],
    swimlane_custom_field_definitions: [],
    ...overrides,
  }
}

// #1914 (frame 6): Archive is aria-disabled until the three section fetches
// settle; a test that archives waits for that first.
const waitForSheetLoaded = () =>
  waitFor(() => expect(screen.getByRole('button', { name: 'Archive card' })).not.toHaveAttribute('aria-disabled'))

const defaultProps = () => ({
  card: makeCard(),
  board: makeBoard(),
  onClose: vi.fn(),
  onDeleted: vi.fn(),
  onUpdated: vi.fn(),
  onArchived: vi.fn(),
})

describe('CardDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateCard.mockImplementation((_boardId: number, _cardId: number, patch: Record<string, unknown>) =>
      Promise.resolve({ ...makeCard(), ...patch })
    )
  })

  it('renders card title in header', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByDisplayValue('Test Card')).toBeInTheDocument()
  })

  it('uses role="dialog" with proper ARIA attributes', () => {
    render(<CardDetail {...defaultProps()} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby', 'card-detail-title')
    expect(dialog).toHaveAttribute('tabindex', '-1')
  })

  it('labels the dialog with the card title input', () => {
    render(<CardDetail {...defaultProps()} />)
    const titleInput = screen.getByDisplayValue('Test Card')
    expect(titleInput).toHaveAttribute('id', 'card-detail-title')
  })

  it('hides the decorative "›" between swimlane and column from assistive tech (#2012)', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByText('›')).toHaveAttribute('aria-hidden', 'true')
  })

  it('renders swimlane and column names', () => {
    render(<CardDetail {...defaultProps()} />)
    // Swimlane and column names are in the same <p> split by a span
    // The column also appears in the key-facts row (#1916), so scope to the breadcrumb buttons.
    expect(screen.getByTitle('Customer A')).toBeInTheDocument()
    expect(screen.getByTitle('To Do')).toBeInTheDocument()
  })

  it('renders close button', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByTitle('Close')).toBeInTheDocument()
  })

  it('calls onClose when close button clicked', async () => {
    const props = defaultProps()
    render(<CardDetail {...props} />)
    await userEvent.setup().click(screen.getByTitle('Close'))
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('Escape key calls onClose', () => {
    const props = defaultProps()
    render(<CardDetail {...props} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  // #1914: there is no click-target backdrop any more. A click outside the
  // sheet closes it through the document-level click-catcher.
  it('clicking outside the sheet calls onClose', async () => {
    const props = defaultProps()
    render(<CardDetail {...props} />)
    await userEvent.setup().click(document.body)
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('renders Details, Comments and History tabs (#967)', () => {
    render(<CardDetail {...defaultProps()} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Details', 'Comments', 'History'])
    expect(screen.getByRole('tablist', { name: 'Card sections' })).toBeInTheDocument()
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', tabs[0].id)
  })

  it('switches to the History tab and shows the activity panel', async () => {
    render(<CardDetail {...defaultProps()} />)
    await userEvent.setup().click(screen.getByRole('tab', { name: /^History/ }))
    expect(screen.getByTestId('activity-tab-panel')).toBeInTheDocument()
  })

  describe('tabs (#967)', () => {
    const timeline = () => getCardTimeline as ReturnType<typeof vi.fn>
    const COUNTS = { move: 2, comment: 1, field: 1, checklist: 0, attachment: 0, system: 0 }
    const movedEntry = {
      id: 7, kind: 'move', ts: new Date(Date.now() - 2 * 3600_000).toISOString(),
      actor: { id: 2, username: 'jordan', display_name: 'Jordan', avatar_url: '' },
      event_type: 'move', imported_from_username: null,
      data: { id: 7, from_column: 10, from_column_name: 'Doing', to_column: 11, to_column_name: 'Review' },
    }

    it('switches tab when a new tabRequest arrives for the open card (#967)', () => {
      const props = defaultProps()
      const { rerender } = render(<CardDetail {...props} />)
      expect(screen.getByRole('tab', { name: /^Details/ })).toHaveAttribute('aria-selected', 'true')
      rerender(<CardDetail {...props} tabRequest={{ tab: 'comments', n: 1 }} />)
      expect(screen.getByRole('tab', { name: /^Comments/ })).toHaveAttribute('aria-selected', 'true')
      fireEvent.click(screen.getByRole('tab', { name: /^Details/ }))
      rerender(<CardDetail {...props} tabRequest={{ tab: 'history', n: 2 }} />)
      expect(screen.getByRole('tab', { name: /^History/ })).toHaveAttribute('aria-selected', 'true')
    })

    it('pins the comment composer clear of the home indicator on narrow screens (#967)', () => {
      render(<CardDetail {...defaultProps()} />)
      fireEvent.click(screen.getByRole('tab', { name: /^Comments/ }))
      const composer = document.querySelector('.sticky.border-t') as HTMLElement
      expect(composer.className).toContain('max-[640px]:pb-[calc(1rem+env(safe-area-inset-bottom))]')
    })

    it('roves focus and selection with Left/Right/Home/End, wrapping at the ends', async () => {
      render(<CardDetail {...defaultProps()} />)
      const tab = (name: RegExp) => screen.getByRole('tab', { name })
      expect(tab(/^Details/)).toHaveAttribute('tabindex', '0')
      expect(tab(/^Comments/)).toHaveAttribute('tabindex', '-1')
      tab(/^Details/).focus()
      fireEvent.keyDown(tab(/^Details/), { key: 'ArrowRight' })
      expect(tab(/^Comments/)).toHaveFocus()
      expect(tab(/^Comments/)).toHaveAttribute('aria-selected', 'true')
      expect(tab(/^Comments/)).toHaveAttribute('tabindex', '0')
      fireEvent.keyDown(tab(/^Comments/), { key: 'End' })
      expect(tab(/^History/)).toHaveFocus()
      fireEvent.keyDown(tab(/^History/), { key: 'ArrowRight' })
      expect(tab(/^Details/)).toHaveFocus()
      fireEvent.keyDown(tab(/^Details/), { key: 'ArrowLeft' })
      expect(tab(/^History/)).toHaveAttribute('aria-selected', 'true')
      fireEvent.keyDown(tab(/^History/), { key: 'Home' })
      expect(tab(/^Details/)).toHaveAttribute('aria-selected', 'true')
      fireEvent.keyDown(tab(/^Details/), { key: 'a' })
      expect(tab(/^Details/)).toHaveAttribute('aria-selected', 'true')
    })

    it('fetches the first History page with counts on open; the History tab shows their sum', async () => {
      timeline().mockResolvedValue({ count: 4, next: null, previous: null, results: [movedEntry], counts: COUNTS })
      render(<CardDetail {...defaultProps()} />)
      expect(screen.queryByTestId('card-tab-count-history')).not.toBeInTheDocument()
      await waitFor(() => expect(screen.getByTestId('card-tab-count-history')).toHaveTextContent('4'))
      expect(timeline()).toHaveBeenCalledWith(1, 1, { limit: 50, offset: 0, include_counts: true }, expect.any(AbortSignal))
      expect(screen.queryByTestId('card-tab-count-details')).not.toBeInTheDocument()
    })

    it('leaves the History count unknown when the fetch fails or has no counts', async () => {
      timeline().mockResolvedValue({ count: 4, next: null, previous: null, results: [] })
      render(<CardDetail {...defaultProps()} />)
      await waitFor(() => expect(timeline()).toHaveBeenCalled())
      expect(screen.getByRole('tab', { name: 'History' })).toBeInTheDocument()
    })

    it('ends Details with a Last activity line that selects History and asks it to focus the newest entry', async () => {
      timeline().mockResolvedValue({ count: 4, next: null, previous: null, results: [movedEntry], counts: COUNTS })
      render(<CardDetail {...defaultProps()} />)
      const line = await screen.findByTestId('card-last-activity')
      expect(line).toHaveTextContent('Last activity: Jordan moved to Review · 2h ago')
      expect(line).toHaveAccessibleName(/Go to History$/)
      await userEvent.setup().click(line)
      expect(screen.getByRole('tab', { name: /^History/ })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByTestId('activity-tab-panel')).toHaveAttribute('data-focus-first', 'true')
    })

    it('shows no Last activity line when the card has no history', async () => {
      timeline().mockResolvedValue({ count: 0, next: null, previous: null, results: [], counts: { ...COUNTS, move: 0, comment: 0, field: 0 } })
      render(<CardDetail {...defaultProps()} />)
      await waitFor(() => expect(screen.getByTestId('card-tab-count-history')).toHaveTextContent('0'))
      expect(screen.queryByTestId('card-last-activity')).not.toBeInTheDocument()
    })

    it('aborts the in-flight History fetch when the sheet unmounts (swap or close)', () => {
      timeline().mockReturnValueOnce(new Promise(() => {}))
      const { unmount } = render(<CardDetail {...defaultProps()} />)
      const signal = timeline().mock.calls[0][3] as AbortSignal
      expect(signal.aborted).toBe(false)
      unmount()
      expect(signal.aborted).toBe(true)
    })

    it('does not draw the bottom fade over the pinned comment composer', async () => {
      rememberCardDetailTab('comments')
      render(<CardDetail {...defaultProps()} />)
      const body = screen.getByRole('tabpanel')
      Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 1000 })
      Object.defineProperty(body, 'clientHeight', { configurable: true, value: 300 })
      fireEvent.scroll(body)
      expect(screen.queryByTestId('card-body-shadow-bottom')).not.toBeInTheDocument()
      await userEvent.setup().click(screen.getByRole('tab', { name: /^Details/ }))
      fireEvent.scroll(screen.getByRole('tabpanel'))
      expect(screen.getByTestId('card-body-shadow-bottom')).toBeInTheDocument()
    })

    it('opens on the tab chosen last, across remounts (session memory)', async () => {
      const { unmount } = render(<CardDetail {...defaultProps()} />)
      await userEvent.setup().click(screen.getByRole('tab', { name: /^History/ }))
      unmount()
      render(<CardDetail {...defaultProps()} card={makeCard({ id: 2 })} />)
      expect(screen.getByRole('tab', { name: /^History/ })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByTestId('activity-tab-panel')).toBeInTheDocument()
    })

    it('Comments shows an empty state, and posting re-fetches History for its count', async () => {
      rememberCardDetailTab('comments')
      ;(addCardComment as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 5, author: fakeUser, body: 'hi', created_at: new Date().toISOString(), updated_at: '' })
      render(<CardDetail {...defaultProps()} />)
      expect(await screen.findByText('No comments yet')).toBeInTheDocument()
      await waitFor(() => expect(timeline()).toHaveBeenCalledTimes(1))
      fireEvent.change(screen.getByTestId('mention-textarea'), { target: { value: 'hi' } })
      await userEvent.setup().click(screen.getByRole('button', { name: 'Comment' }))
      await waitFor(() => expect(timeline()).toHaveBeenCalledTimes(2))
      expect(screen.queryByText('No comments yet')).not.toBeInTheDocument()
    })
  })

  it('renders the rich text editor for description', () => {
    render(<CardDetail {...defaultProps()} />)
    const editor = screen.getByTestId('rich-text-editor')
    expect(editor).toBeInTheDocument()
    expect(editor).toHaveValue('A test card')
  })

  it('saves description when Save button is clicked', async () => {
    mockUpdateCard.mockResolvedValue(makeCard({ description: 'A test card updated' }))
    render(<CardDetail {...defaultProps()} />)
    const editor = screen.getByTestId('rich-text-editor')
    await userEvent.setup().clear(editor)
    await userEvent.setup().type(editor, 'A test card updated')
    await userEvent.setup().click(screen.getByTestId('description-save'))
    await waitFor(() => {
      expect(mockUpdateCard).toHaveBeenCalledWith(1, 1, { description: 'A test card updated' })
    })
  })

  it('renders assignee select with board members', async () => {
    render(<CardDetail {...defaultProps()} />)
    // Trigger shows 'Unassigned' when no assignee is set
    expect(screen.getByRole('combobox')).toBeInTheDocument()
    expect(screen.getByText('Unassigned')).toBeInTheDocument()
    // Open the dropdown to see member options
    await userEvent.setup().click(screen.getByRole('combobox'))
    expect(screen.getByText('Jane Doe')).toBeInTheDocument()
  })

  it('shows an assignee who is not in the member list by name (#1714)', async () => {
    const outsider = { id: 42, username: 'auditor', display_name: 'Audit Reader', avatar_url: '' }
    render(<CardDetail {...defaultProps()} card={makeCard({ assignee: outsider })} />)
    // The trigger names the assignee rather than showing the raw id.
    expect(screen.getByRole('combobox')).toHaveTextContent('Audit Reader')
    expect(screen.queryByText('42')).toBeNull()
    await userEvent.setup().click(screen.getByRole('combobox'))
    expect(screen.getByRole('option', { name: 'Audit Reader' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Jane Doe' })).toBeInTheDocument()
  })

  it('does not list a member assignee twice', async () => {
    render(<CardDetail {...defaultProps()} card={makeCard({ assignee: { id: 1, username: 'jdoe', display_name: 'Jane Doe', avatar_url: '' } })} />)
    await userEvent.setup().click(screen.getByRole('combobox'))
    expect(screen.getAllByRole('option', { name: 'Jane Doe' })).toHaveLength(1)
  })

  it('renders priority buttons', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByText('Low')).toBeInTheDocument()
    expect(screen.getByText('Medium')).toBeInTheDocument()
    expect(screen.getByText('High')).toBeInTheDocument()
    expect(screen.getByText('Urgent')).toBeInTheDocument()
  })

  it('clicking priority button saves', async () => {
    render(<CardDetail {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('High'))
    await waitFor(() => {
      expect(mockUpdateCard).toHaveBeenCalledWith(1, 1, { priority: 'high' })
    })
  })

  it('priority buttons are keyboard reachable and have accessible text labels', () => {
    render(<CardDetail {...defaultProps()} />)
    // Each priority button must be reachable by role and accessible name
    // (per CLAUDE.md radio-group convention, interactive priority controls must
    // have sr-only labels or visible text so screen readers can identify them)
    const lowBtn = screen.getByRole('button', { name: 'Low' })
    const highBtn = screen.getByRole('button', { name: 'High' })
    expect(lowBtn).toBeInTheDocument()
    expect(highBtn).toBeInTheDocument()
    // Buttons must not be disabled — all priorities are always selectable
    expect(lowBtn).not.toBeDisabled()
    expect(highBtn).not.toBeDisabled()
  })

  it('marks an active label with a check, aria-pressed and a legible chip, not a fill change (#2094)', () => {
    const on = { id: 100, uid: 'lbluid000001', name: 'Bug', color: '#FFFFFF' }
    const off = { id: 101, uid: 'lbluid000002', name: 'Keep', color: '#000000' }
    render(<CardDetail {...defaultProps()} board={makeBoard({ labels: [on, off] })} card={makeCard({ labels: [on] })} />)
    const active = screen.getByRole('button', { name: /Bug/ })
    const idle = screen.getByRole('button', { name: /Keep/ })
    expect(active).toHaveAttribute('aria-pressed', 'true')
    expect(active.textContent).toContain('\u2713')
    expect(idle).toHaveAttribute('aria-pressed', 'false')
    expect(idle.querySelector('.invisible')).not.toBeNull()
    expect(active.querySelector('.invisible')).toBeNull()
    expect(active.className).toContain('cf-choice-badge')
    expect(active.style.getPropertyValue('--cf-fg-light')).toMatch(/^#[0-9A-F]{6}$/)
  })

  it('drops a label from an open detail when it is deleted, keeping other edits (#1888)', async () => {
    const bug = { id: 100, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }
    const keep = { id: 101, uid: 'lbluid000002', name: 'Keep', color: '#22C55E' }
    const props = defaultProps()
    const { rerender } = render(<CardDetail {...props} board={makeBoard({ labels: [bug, keep] })} card={makeCard({ labels: [bug, keep] })} />)
    expect(screen.getByText('Bug')).toBeInTheDocument()
    fireEvent.change(screen.getByDisplayValue('Test Card'), { target: { value: 'Edited title' } })

    // label.deleted: board.labels and the live card lose the label, version unchanged
    rerender(<CardDetail {...props} board={makeBoard({ labels: [keep] })} card={makeCard({ labels: [keep] })} />)
    await waitFor(() => expect(screen.queryByText('Bug')).not.toBeInTheDocument())
    expect(screen.getByDisplayValue('Edited title')).toBeInTheDocument()

    // toggling the remaining label must not send the deleted id
    await userEvent.click(screen.getByText('Keep'))
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled())
    const patch = mockUpdateCard.mock.calls[0][2] as { label_ids: number[] }
    expect(patch.label_ids).toEqual([])
  })

  describe('stale-label guards (#1888)', () => {
    const bug = { id: 100, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }
    const keep = { id: 101, uid: 'lbluid000002', name: 'Keep', color: '#22C55E' }
    const fresh = { id: 102, uid: 'lbluid000003', name: 'Fresh', color: '#3B82F6' }

    it('keeps a label that is on the live card but not yet in board.labels (just created)', async () => {
      const props = defaultProps()
      const { rerender } = render(<CardDetail {...props} board={makeBoard({ labels: [keep] })} card={makeCard({ labels: [keep, fresh] })} />)
      rerender(<CardDetail {...props} board={makeBoard({ labels: [keep] })} card={makeCard({ labels: [keep, fresh] })} />)
      await userEvent.click(screen.getByText('Keep'))
      await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled())
      expect((mockUpdateCard.mock.calls[0][2] as { label_ids: number[] }).label_ids).toEqual([102])
    })

    it('keeps a label that left the live card but still exists on the board (only gone-from-both is dropped)', async () => {
      const props = defaultProps()
      const board = makeBoard({ labels: [bug, keep] })
      const { rerender } = render(<CardDetail {...props} board={board} card={makeCard({ labels: [bug, keep] })} />)
      rerender(<CardDetail {...props} board={board} card={makeCard({ labels: [keep] })} />)
      await userEvent.click(screen.getByText('Bug'))
      await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled())
      // local copy still held Bug (version did not change), so the click removed it
      expect((mockUpdateCard.mock.calls[0][2] as { label_ids: number[] }).label_ids).toEqual([101])
    })

    it('a save response carrying a label deleted mid-flight does not bring it back', async () => {
      const props = defaultProps()
      mockUpdateCard.mockResolvedValue({ ...makeCard(), priority: 'high', version: 2, labels: [bug, keep] })
      render(<CardDetail {...props} board={makeBoard({ labels: [keep] })} card={makeCard({ labels: [keep] })} />)
      await userEvent.click(screen.getByRole('button', { name: 'High' }))
      await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled())
      await waitFor(() => expect(props.onUpdated).toHaveBeenCalled())
      expect(screen.queryByText('Bug')).not.toBeInTheDocument()
    })

    it('a failed save does not roll back to a snapshot holding a label deleted mid-flight', async () => {
      const props = defaultProps()
      let reject!: (e: Error) => void
      mockUpdateCard.mockReturnValue(new Promise((_, rej) => { reject = rej }))
      const { rerender } = render(<CardDetail {...props} board={makeBoard({ labels: [bug, keep] })} card={makeCard({ labels: [bug, keep] })} />)
      await userEvent.click(screen.getByRole('button', { name: 'High' }))
      await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled())
      rerender(<CardDetail {...props} board={makeBoard({ labels: [keep] })} card={makeCard({ labels: [keep] })} />)
      await waitFor(() => expect(screen.queryByText('Bug')).not.toBeInTheDocument())
      await act(async () => { reject(new Error('boom')) })
      expect(screen.queryByText('Bug')).not.toBeInTheDocument()
    })
  })

  it('renders existing labels from board', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByText('Bug')).toBeInTheDocument()
  })

  it('renders + New label button', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByText('+ New label')).toBeInTheDocument()
  })

  it('clicking + New label shows input', async () => {
    render(<CardDetail {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('+ New label'))
    expect(screen.getByPlaceholderText('Label name')).toBeInTheDocument()
  })

  it('renders weight with increment/decrement buttons', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('+')).toBeInTheDocument()
  })

  it('names the weight steppers and gives them a focus ring (#1737)', () => {
    render(<CardDetail {...defaultProps()} />)
    for (const name of ['Decrease weight', 'Increase weight']) {
      const btn = screen.getByRole('button', { name })
      expect(btn).toHaveAttribute('type', 'button')
      expect(btn).toHaveClass('focus:ring-2', 'focus:ring-primary-emphasis')
    }
  })

  it('clicking + increments weight', async () => {
    render(<CardDetail {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('+'))
    await waitFor(() => {
      expect(mockUpdateCard).toHaveBeenCalledWith(1, 1, { weight: 2 })
    })
  })

  // #1428 — raising weight past the column's weight limit is refused with a
  // 409; the reason is shown once (no "Couldn't save") and the weight reverts.
  it('explains a weight-limit refusal and reverts the weight', async () => {
    mockUpdateCard.mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          code: 'weight_limit_exceeded', column_name: 'To Do',
          current_weight: 3, weight_limit: 4, card_weight: 2,
        },
      },
    })
    render(<CardDetail {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('+'))
    expect(
      await screen.findByText(
        'Weight limit reached: "To Do" has 3 weight — adding this card (+2) would reach 5 of 4.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    // The reason is set in saveWeight's catch, one microtask before runSave
    // marks the autosave status "error". Let the rejected save fully settle
    // (macrotask flush) before the negative assertion, so it can actually
    // catch a second "Couldn't save" announcement.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByText('Saving…')).not.toBeInTheDocument()
    expect(screen.queryByText("Couldn't save")).not.toBeInTheDocument()
  })

  it('keeps the generic indicator and shows no reason for other weight failures', async () => {
    mockUpdateCard.mockRejectedValueOnce(new Error('Network error'))
    render(<CardDetail {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('+'))
    expect(await screen.findByText("Couldn't save")).toBeInTheDocument()
    expect(screen.queryByText(/Weight limit reached/)).not.toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  // Regression guard (#1305): the weight +/- buttons debounce their PATCH by
  // 600ms (weightSaveTimer). Unmounting (e.g. the modal is closed) before the
  // timer fires must clear it, not fire the save against a torn-down
  // component. Deliberately cancels rather than flushes here — see the
  // comment on weightSaveTimer's cleanup effect in CardDetail.tsx.
  it('clears the pending weight-save debounce timer on unmount, without throwing or saving', async () => {
    const { unmount } = render(<CardDetail {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('+'))
    // Debounced — the PATCH has not fired yet.
    expect(mockUpdateCard).not.toHaveBeenCalled()

    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => unmount()).not.toThrow()
    expect(clearSpy).toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    // The debounce is cancelled, not flushed: wait past the original 600ms
    // delay and confirm the save never happened.
    await new Promise((r) => setTimeout(r, 700))
    expect(mockUpdateCard).not.toHaveBeenCalled()

    clearSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('discards unsaved edits when remounted for a different card (#449)', () => {
    // BoardView passes `key={selectedCard.id}`, so opening a different card
    // from a relation row remounts rather than re-renders. That matters
    // because `localCard` is seeded from a useState initializer with no
    // prop-sync effect — without the remount, card B's panel would show card
    // A's title, weight and labels while B's data loaded.
    const cardA = makeCard({ id: 1, title: 'Card A' })
    const cardB = makeCard({ id: 2, title: 'Card B' })
    const props = defaultProps()

    const { rerender } = render(<CardDetail key={cardA.id} {...props} card={cardA} />)
    fireEvent.change(screen.getByDisplayValue('Card A'), {
      target: { value: 'Unsaved edit' },
    })
    expect(screen.getByDisplayValue('Unsaved edit')).toBeInTheDocument()

    rerender(<CardDetail key={cardB.id} {...props} card={cardB} />)

    expect(screen.queryByDisplayValue('Unsaved edit')).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('Card B')).toBeInTheDocument()
  })

  it('renders the relations section between Weight and Checklist (#449)', async () => {
    render(<CardDetail {...defaultProps()} />)
    const relations = await screen.findByRole('button', { name: /Relations/ })
    expect(relations).toBeInTheDocument()

    // Order matters: Relations closes the classification arc (priority,
    // labels, custom fields, weight) before the contents arc (checklist,
    // attachments) opens. Compare DOM position rather than trusting the JSX.
    const checklist = screen.getByText('Checklist')
    expect(
      relations.compareDocumentPosition(checklist) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('does not render the relations section for a viewer with no relations', async () => {
    const props = defaultProps()
    props.board = makeBoard({ current_user_role: 'viewer' })
    render(<CardDetail {...props} />)
    await waitFor(() => expect(mockGetCardRelations).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /Relations/ })).not.toBeInTheDocument()
  })

  it('renders checklist section', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByText('Checklist')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Add item (Enter)…')).toBeInTheDocument()
  })

  it('renders attachment section with empty state', async () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByText('Attachments')).toBeInTheDocument()
    // A skeleton holds the section until its fetch settles (#1914, frame 6);
    // an empty result then collapses it, and expanding shows the empty state.
    expect(screen.getByTestId('attachments-skeleton')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('attachments-skeleton')).not.toBeInTheDocument())
    await userEvent.setup().click(screen.getByText('Attachments'))
    expect(screen.getByText('No attachments.')).toBeInTheDocument()
  })

  it('renders upload button when uploads_enabled is true', () => {
    render(<CardDetail {...defaultProps()} currentUser={{ ...fakeUser, uploads_enabled: true }} />)
    const btn = screen.getByText('+ Upload')
    expect(btn).toBeInTheDocument()
    expect(btn.tagName).toBe('BUTTON')
  })

  it('renders an aria-disabled upload button with a visible reason when uploads_enabled is false', () => {
    render(<CardDetail {...defaultProps()} currentUser={{ ...fakeUser, uploads_enabled: false }} />)
    // #1179: a real, focusable button (no longer a title-only span), so the
    // reason reaches keyboard and screen-reader users.
    const el = screen.getByRole('button', { name: '+ Upload' })
    expect(el).toHaveAttribute('aria-disabled', 'true')
    expect(el).not.toBeDisabled()
    expect(el.className).toContain('cursor-not-allowed')
    expect(el).toHaveAccessibleDescription('File uploads are disabled by the site administrator.')
  })

  describe('hosted demo (#1179)', () => {
    const demoUser = fakeUser

    it('upload shows the demo reason, taking precedence over uploads-disabled', () => {
      render(<CardDetail {...defaultProps()} currentUser={{ ...demoUser, uploads_enabled: false }} />, { wrapper: flagsWrapper({ demo_mode: true }) })
      const el = screen.getByRole('button', { name: '+ Upload' })
      expect(el).toHaveAttribute('aria-disabled', 'true')
      expect(el).toHaveAccessibleDescription('This is a shared demo — file uploads are off here.')
      expect(screen.queryByText('File uploads are disabled by the site administrator.')).not.toBeInTheDocument()
    })

    it('comment submit is aria-disabled, keyboard-reachable, explains why, and keeps typed text', async () => {
    rememberCardDetailTab('comments')
      const user = userEvent.setup()
      render(<CardDetail {...defaultProps()} currentUser={demoUser} />, { wrapper: flagsWrapper({ demo_mode: true }) })
      const textarea = screen.getByTestId('mention-textarea')
      await user.type(textarea, 'draft thought')
      const submit = screen.getByRole('button', { name: 'Comment' })
      expect(submit).toHaveAttribute('aria-disabled', 'true')
      expect(submit).not.toBeDisabled()
      expect(submit).toHaveAccessibleDescription("This is a shared demo — comments aren't saved here.")
      submit.focus()
      expect(submit).toHaveFocus()
      await user.click(submit)
      await user.keyboard('{Enter}')
      expect(addCardComment).not.toHaveBeenCalled()
      expect(textarea).toHaveValue('draft thought')
    })

    it('#1193: comment delete is aria-disabled, keyboard-reachable, explains why, and never opens the inline confirm', async () => {
    rememberCardDetailTab('comments')
      const { getCardComments, deleteComment } = await import('../api/cards')
      const mockGetComments = getCardComments as ReturnType<typeof vi.fn>
      mockGetComments.mockResolvedValue([
        { id: 1, author: demoUser, body: 'Hello world', created_at: new Date().toISOString(), updated_at: '' },
      ])
      const user = userEvent.setup()
      render(<CardDetail {...defaultProps()} currentUser={demoUser} />, { wrapper: flagsWrapper({ demo_mode: true }) })
      const del = await screen.findByRole('button', { name: /Delete comment/ })
      expect(del).toHaveAttribute('aria-disabled', 'true')
      expect(del).not.toBeDisabled()
      expect(del).toHaveAccessibleName("Delete comment. This is a shared demo — comments can't be deleted here.")
      del.focus()
      expect(del).toHaveFocus()
      await user.click(del)
      expect(screen.queryByText('Delete this comment?')).not.toBeInTheDocument()
      expect(deleteComment).not.toHaveBeenCalled()
    })

    it('#1193: attachment delete is aria-disabled, keyboard-reachable, explains why, and does not call the API', async () => {
      const { getCardAttachments, deleteCardAttachment } = await import('../api/cards')
      const mockGetAttachments = getCardAttachments as ReturnType<typeof vi.fn>
      mockGetAttachments.mockResolvedValue([
        { id: 1, filename: 'design.png', size: 2048, url: '/files/1', uploaded_by: demoUser, uploaded_at: '2026-01-01' },
      ])
      const user = userEvent.setup()
      render(<CardDetail {...defaultProps()} currentUser={demoUser} />, { wrapper: flagsWrapper({ demo_mode: true }) })
      const del = await screen.findByRole('button', { name: /Delete attachment design\.png/ })
      expect(del).toHaveAttribute('aria-disabled', 'true')
      expect(del).not.toBeDisabled()
      expect(del).toHaveAccessibleName("Delete attachment design.png. This is a shared demo — attachments can't be deleted here.")
      del.focus()
      expect(del).toHaveFocus()
      await user.click(del)
      expect(deleteCardAttachment).not.toHaveBeenCalled()
    })

    it('#1193: Add relation is aria-disabled up front, with a visible reason line, and never opens the picker', async () => {
      const { addCardRelation } = await import('../api/cards')
      const user = userEvent.setup()
      render(<CardDetail {...defaultProps()} currentUser={demoUser} />, { wrapper: flagsWrapper({ demo_mode: true }) })
      const addRelation = await screen.findByRole('button', { name: '+ Add relation' })
      expect(addRelation).toHaveAttribute('aria-disabled', 'true')
      expect(addRelation).not.toBeDisabled()
      expect(addRelation).toHaveAccessibleDescription("This is a shared demo — card relations can't be added here.")
      addRelation.focus()
      expect(addRelation).toHaveFocus()
      await user.click(addRelation)
      expect(screen.queryByRole('radio', { name: 'Blocked by' })).not.toBeInTheDocument()
      expect(addCardRelation).not.toHaveBeenCalled()
    })
  })

  it('renders comments section', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByText('Comments')).toBeInTheDocument()
  })

  it('renders comment input for admin', () => {
    rememberCardDetailTab('comments')
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByTestId('mention-textarea')).toBeInTheDocument()
    expect(screen.getByText('Comment')).toBeInTheDocument()
  })

  it('renders delete card button for admin', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByText('Delete card')).toBeInTheDocument()
  })

  it('hides delete card button for viewer', () => {
    const props = defaultProps()
    props.board = makeBoard({ current_user_role: 'viewer' })
    render(<CardDetail {...props} />)
    expect(screen.queryByText('Delete card')).not.toBeInTheDocument()
  })

  it('hides upload button for viewer even when uploads_enabled is true', () => {
    const props = defaultProps()
    props.board = makeBoard({ current_user_role: 'viewer' })
    render(<CardDetail {...props} currentUser={{ ...fakeUser, uploads_enabled: true }} />)
    expect(screen.queryByText('+ Upload')).not.toBeInTheDocument()
  })

  it('disables checklist checkboxes for viewer with explanatory title', () => {
    const props = defaultProps()
    props.board = makeBoard({ current_user_role: 'viewer' })
    render(<CardDetail {...props} />)
    // "Add item" input must not be present for viewers
    expect(screen.queryByPlaceholderText('Add item (Enter)…')).not.toBeInTheDocument()
  })

  it('hides delete/archive buttons for member who does not own the card', () => {
    const otherUser: User = { ...fakeUser, id: 99, username: 'other' }
    const props = defaultProps()
    props.board = makeBoard({
      current_user_role: 'member',
      custom_field_definitions: [],
      swimlane_custom_field_definitions: [],
      members: [{ id: 2, user: otherUser, role: 'member', is_moderator: false, joined_at: '' }],
    })
    props.card = makeCard({ created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" } }) // card owned by user 1, current user is 99
    render(<CardDetail {...props} currentUser={otherUser} />)
    expect(screen.queryByText('Delete card')).not.toBeInTheDocument()
    expect(screen.queryByText('Archive card')).not.toBeInTheDocument()
  })

  it('shows delete/archive buttons for member who owns the card', () => {
    const props = defaultProps()
    props.board = makeBoard({
      current_user_role: 'member',
      custom_field_definitions: [],
      swimlane_custom_field_definitions: [],
      members: [{ id: 1, user: fakeUser, role: 'member', is_moderator: false, joined_at: '' }],
    })
    props.card = makeCard({ created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" } })
    render(<CardDetail {...props} currentUser={fakeUser} />)
    expect(screen.getByText('Delete card')).toBeInTheDocument()
    expect(screen.getByText('Archive card')).toBeInTheDocument()
  })

  it('shows delete/archive buttons for moderator who does not own the card', () => {
    const modUser: User = { ...fakeUser, id: 99, username: 'moderator' }
    const props = defaultProps()
    props.board = makeBoard({
      current_user_role: 'member',
      custom_field_definitions: [],
      swimlane_custom_field_definitions: [],
      members: [{ id: 2, user: modUser, role: 'member', is_moderator: true, joined_at: '' }],
    })
    props.card = makeCard({ created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" } }) // card owned by user 1, moderator is 99
    render(<CardDetail {...props} currentUser={modUser} />)
    expect(screen.getByText('Delete card')).toBeInTheDocument()
    expect(screen.getByText('Archive card')).toBeInTheDocument()
  })

  describe('hosted demo visitor on a card someone else created (#1179)', () => {
    const visitor: User = { ...fakeUser, id: 99, username: 'visitor' }
    const demoProps = (role: 'member' | 'collaborator' = 'member') => {
      const props = defaultProps()
      props.board = makeBoard({
        current_user_role: role,
        custom_field_definitions: [],
        swimlane_custom_field_definitions: [],
        members: [{ id: 2, user: visitor, role, is_moderator: false, joined_at: '' }],
      })
      props.card = makeCard({ created_by: { id: 1, username: 'admin', display_name: 'Admin', avatar_url: '' } })
      return props
    }

    // #1914 (design frame 7): the demo footer note replaces Archive and Delete.
    it('shows an enabled assignee picker, and the demo footer note in place of Archive and Delete', () => {
      render(<CardDetail {...demoProps()} currentUser={visitor} />, { wrapper: flagsWrapper({ demo_mode: true }) })
      expect(screen.queryByRole('button', { name: 'Archive card' })).not.toBeInTheDocument()
      expect(screen.getByTestId('card-demo-footer')).toHaveTextContent("This is a shared demo — cards can't be archived or deleted here.")
      expect(screen.queryByText('Delete card')).not.toBeInTheDocument()
      expect(screen.getByRole('combobox')).not.toBeDisabled()
      expect(screen.queryByText('Assigning cards requires Moderator or Admin access')).not.toBeInTheDocument()
    })

    it('hides Archive and Delete in demo mode even on a card the visitor created', () => {
      const props = demoProps()
      props.card = makeCard({ created_by: { id: 99, username: 'visitor', display_name: 'Visitor', avatar_url: '' } })
      render(<CardDetail {...props} currentUser={visitor} />, { wrapper: flagsWrapper({ demo_mode: true }) })
      expect(screen.queryByRole('button', { name: 'Archive card' })).not.toBeInTheDocument()
      expect(screen.getByTestId('card-demo-footer')).toBeInTheDocument()
      expect(screen.queryByText('Delete card')).not.toBeInTheDocument()
    })

    it('does not widen a collaborator', () => {
      render(<CardDetail {...demoProps('collaborator')} currentUser={visitor} />, { wrapper: flagsWrapper({ demo_mode: true }) })
      expect(screen.queryByText('Archive card')).not.toBeInTheDocument()
    })

    it('outside demo mode a plain member still sees neither Archive nor Delete on others\' cards', () => {
      render(<CardDetail {...demoProps()} currentUser={visitor} />, { wrapper: flagsWrapper({ demo_mode: false }) })
      expect(screen.queryByText('Archive card')).not.toBeInTheDocument()
      expect(screen.queryByText('Delete card')).not.toBeInTheDocument()
      expect(screen.getByRole('combobox')).toBeDisabled()
    })
  })

  it('Archive and Delete buttons carry focus rings', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByRole('button', { name: 'Archive card' }).className).toContain('focus:ring-warning-emphasis')
    expect(screen.getByRole('button', { name: 'Delete card' }).className).toContain('focus:ring-danger-emphasis')
  })

  it('hides comment input for viewer', () => {
    const props = defaultProps()
    props.board = makeBoard({ current_user_role: 'viewer' })
    render(<CardDetail {...props} />)
    expect(screen.queryByTestId('mention-textarea')).not.toBeInTheDocument()
  })

  it('shows comment input for collaborator', () => {
    rememberCardDetailTab('comments')
    const props = defaultProps()
    props.board = makeBoard({ current_user_role: 'collaborator' })
    render(<CardDetail {...props} />)
    expect(screen.getByTestId('mention-textarea')).toBeInTheDocument()
  })

  it('renders due date input', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByText('Due date')).toBeInTheDocument()
  })

  it('shows user date format as placeholder when no due date is set', () => {
    render(<CardDetail {...defaultProps()} userDateFormat="DD/MM/YYYY" />)
    expect(screen.getByText('dd/mm/yyyy')).toBeInTheDocument()
  })

  it('shows ISO format as placeholder when userDateFormat is YYYY-MM-DD', () => {
    render(<CardDetail {...defaultProps()} userDateFormat="YYYY-MM-DD" />)
    expect(screen.getByText('yyyy-mm-dd')).toBeInTheDocument()
  })

  it('shows due date in ISO format when userDateFormat is YYYY-MM-DD', () => {
    const props = defaultProps()
    props.card = makeCard({ due_date: '2099-06-15' })
    render(<CardDetail {...props} userDateFormat="YYYY-MM-DD" />)
    expect(screen.getByText('2099-06-15')).toBeInTheDocument()
  })

  it('shows due date in DD/MM/YYYY format when userDateFormat is DD/MM/YYYY', () => {
    const props = defaultProps()
    props.card = makeCard({ due_date: '2099-06-15' })
    render(<CardDetail {...props} userDateFormat="DD/MM/YYYY" />)
    expect(screen.getByText('15/06/2099')).toBeInTheDocument()
  })

  it('clicking the due date field (no date set) — input is clickable, not pointer-events-none', () => {
    render(<CardDetail {...defaultProps()} userDateFormat="MM/DD/YYYY" />)
    const dateInput = document.querySelector<HTMLInputElement>('input[type="date"]')!
    expect(dateInput).not.toBeNull()
    // Input covers the whole field and receives clicks directly — no pointer-events-none
    expect(dateInput.className).not.toContain('pointer-events-none')
    expect(dateInput.className).toContain('cursor-pointer')
  })

  it('clicking the due date field (date set) — input is clickable, not pointer-events-none', () => {
    const props = defaultProps()
    props.card = makeCard({ due_date: '2099-06-15' })
    render(<CardDetail {...props} userDateFormat="MM/DD/YYYY" />)
    const dateInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="date"]'))
    const activeInput = dateInputs.find((el) => el.value !== '')!
    expect(activeInput).toBeTruthy()
    // Input covers the whole field and receives clicks directly — no pointer-events-none
    expect(activeInput.className).not.toContain('pointer-events-none')
    expect(activeInput.className).toContain('cursor-pointer')
  })

  it('due date picker opens from the focusable date input itself, for both empty and set states (#1376)', () => {
    const showPicker = vi.fn()
    const proto = HTMLInputElement.prototype as HTMLInputElement & { showPicker?: () => void }
    const original = proto.showPicker
    proto.showPicker = showPicker
    try {
      const { unmount } = render(<CardDetail {...defaultProps()} />)
      const emptyInput = document.querySelector<HTMLInputElement>('input[type="date"]')!
      expect(emptyInput).toHaveAccessibleName('Due date')
      emptyInput.focus()
      expect(emptyInput).toHaveFocus()
      fireEvent.click(emptyInput)
      expect(showPicker).toHaveBeenCalledTimes(1)
      unmount()

      const props = defaultProps()
      props.card = makeCard({ due_date: '2099-06-15' })
      render(<CardDetail {...props} />)
      const setInput = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="date"]')).find((el) => el.value !== '')!
      fireEvent.click(setInput)
      expect(showPicker).toHaveBeenCalledTimes(2)
    } finally {
      proto.showPicker = original
    }
  })

  // #1376, #1914: the docked sheet's light backdrop is decorative only: hidden
  // from assistive tech and not a click target (pointer-events-none), so the
  // board behind it stays clickable. Escape/Close are the keyboard paths.
  it('docked backdrop is decorative: aria-hidden, not a click target; Escape/Close are the keyboard paths (#1376)', async () => {
    const props = defaultProps()
    render(<CardDetail {...props} />)
    const backdrop = screen.getByTestId('card-detail-backdrop')
    expect(backdrop).toHaveAttribute('aria-hidden', 'true')
    expect(backdrop.className).toContain('bg-backdrop/20')
    expect(backdrop.className).toContain('pointer-events-none')
    await userEvent.setup().keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('renders comments with author initials', async () => {
    rememberCardDetailTab('comments')
    const mockGetComments = getCardComments as ReturnType<typeof vi.fn>
    mockGetComments.mockResolvedValue([
      { id: 1, author: fakeUser, body: 'Hello world', created_at: new Date().toISOString(), updated_at: '' },
    ])
    render(<CardDetail {...defaultProps()} />)
    await waitFor(() => {
      expect(screen.getByText('Hello world')).toBeInTheDocument()
      expect(screen.getByText('JD')).toBeInTheDocument()
    })
  })

  it('notes an imported comment as imported with the source name, never as a user (#1702)', async () => {
    rememberCardDetailTab('comments')
    const mockGetComments = getCardComments as ReturnType<typeof vi.fn>
    mockGetComments.mockResolvedValue([
      { id: 1, author: fakeUser, body: 'From Trello', created_at: new Date().toISOString(), updated_at: '', imported_from_username: 'Ada Lovelace' },
      { id: 2, author: fakeUser, body: 'Unnamed source', created_at: new Date().toISOString(), updated_at: '', imported_from_username: '' },
      { id: 3, author: fakeUser, body: 'Posted here', created_at: new Date().toISOString(), updated_at: '', imported_from_username: null },
    ])
    render(<CardDetail {...defaultProps()} />)
    const note = await screen.findByText('imported, originally Ada Lovelace')
    expect(note).toHaveAttribute('title', 'imported, originally Ada Lovelace')
    expect(note).toHaveClass('text-xs', 'text-fg-muted', 'truncate')
    // The time never shrinks or wraps; only the name and the note truncate.
    expect(note.previousElementSibling).toHaveClass('shrink-0', 'whitespace-nowrap')
    expect(screen.getByText('imported')).toBeInTheDocument()
    // Exactly the two imported comments carry a note; the posted one does not.
    expect(screen.getAllByText(/^imported/)).toHaveLength(2)
    // The source name is text, not a user: no avatar initials for it.
    expect(screen.queryByText('AL')).not.toBeInTheDocument()
  })

  it('renders card with labels checked', () => {
    const props = defaultProps()
    props.card = makeCard({ labels: [{ id: 100, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }] })
    render(<CardDetail {...props} />)
    expect(screen.getByText('Bug')).toBeInTheDocument()
  })

  it('renders bulk add button in checklist', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByText('Bulk')).toBeInTheDocument()
  })

  it('clicking Bulk shows bulk add modal', async () => {
    render(<CardDetail {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('Bulk'))
    expect(screen.getByText('Add checklist items')).toBeInTheDocument()
    expect(screen.getByText('One item per line')).toBeInTheDocument()
  })

  it('Escape in the new-label input closes only the input; a second Escape closes the panel (#1972)', async () => {
    const props = defaultProps()
    const user = userEvent.setup()
    render(<CardDetail {...props} />)
    await user.click(screen.getByText('+ New label'))
    const input = screen.getByPlaceholderText('Label name')
    expect(input).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByPlaceholderText('Label name')).not.toBeInTheDocument()
    expect(props.onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape in the new-label input returns focus to the + New label trigger (#2036)', async () => {
    const user = userEvent.setup()
    render(<CardDetail {...defaultProps()} />)
    await user.click(screen.getByText('+ New label'))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: '+ New label' })).toHaveFocus()
  })

  it('the cancel button of the new-label input has an accessible name and returns focus (#2036)', async () => {
    const user = userEvent.setup()
    render(<CardDetail {...defaultProps()} />)
    await user.click(screen.getByText('+ New label'))
    await user.click(screen.getByRole('button', { name: 'Cancel new label' }))
    expect(screen.getByRole('button', { name: '+ New label' })).toHaveFocus()
  })

  it('a successful label create returns focus to the + New label trigger (#2036)', async () => {
    const { createLabel } = await import('../api/boards')
    ;(createLabel as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 99, uid: 'x', name: 'Urgent', color: '#ff0000' })
    const user = userEvent.setup()
    render(<CardDetail {...defaultProps()} />)
    await user.click(screen.getByText('+ New label'))
    await user.type(screen.getByRole('textbox', { name: 'New label name' }), 'Urgent{Enter}')
    await waitFor(() => expect(screen.getByRole('button', { name: '+ New label' })).toHaveFocus())
  })

  it('a custom color creates a named label only on Apply, worded "Create label" (#2095)', async () => {
    const { createLabel } = await import('../api/boards')
    const mockCreate = createLabel as ReturnType<typeof vi.fn>
    mockCreate.mockClear()
    mockCreate.mockResolvedValue({ id: 99, uid: 'x', name: 'Plum', color: '#AA00CC' })
    const user = userEvent.setup()
    render(<CardDetail {...defaultProps()} />)
    await user.click(screen.getByText('+ New label'))
    await user.type(screen.getByRole('textbox', { name: 'New label name' }), 'Plum')
    await user.click(screen.getByRole('button', { name: 'Choose custom color' }))
    fireEvent.input(screen.getByRole('textbox', { name: 'Hex value' }), { target: { value: '#aa00cc' } })
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Hue' }), { key: 'ArrowRight', keyCode: 39 })
    expect(mockCreate).not.toHaveBeenCalled()
    fireEvent.input(screen.getByRole('textbox', { name: 'Hex value' }), { target: { value: '#aa00cc' } })
    await user.click(screen.getByRole('button', { name: 'Create label' }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    expect(mockCreate).toHaveBeenCalledWith(expect.anything(), { name: 'Plum', color: '#AA00CC' })
  })

  it('a custom color with no label name yet only sets the draft color, worded "Apply" (#2095)', async () => {
    const { createLabel } = await import('../api/boards')
    const mockCreate = createLabel as ReturnType<typeof vi.fn>
    mockCreate.mockClear()
    const user = userEvent.setup()
    render(<CardDetail {...defaultProps()} />)
    await user.click(screen.getByText('+ New label'))
    await user.click(screen.getByRole('button', { name: 'Choose custom color' }))
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(mockCreate).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'New label name' })).toBeInTheDocument()
  })

  it('Escape in the custom color panel closes only the panel, not the label row or the card (#2095)', async () => {
    const props = defaultProps()
    const user = userEvent.setup()
    render(<CardDetail {...props} />)
    await user.click(screen.getByText('+ New label'))
    await user.click(screen.getByRole('button', { name: 'Choose custom color' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Custom color' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'New label name' })).toBeInTheDocument()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Choose custom color' })).toHaveFocus()
  })

  it('Escape in the title input reverts it without closing the panel; the next Escape closes it (#2036)', async () => {
    const props = defaultProps()
    const user = userEvent.setup()
    render(<CardDetail {...props} />)
    const title = screen.getByDisplayValue('Test Card')
    await user.click(title)
    await user.keyboard('half typed')
    await user.keyboard('{Escape}')
    expect(screen.getByDisplayValue('Test Card')).not.toHaveFocus()
    // #2082: focus lands on the panel, never <body>.
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
    // flushSync before blur: the blur handler must not save the half-typed title.
    expect(mockUpdateCard).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape in a text custom-field input reverts it without closing the panel (#2036)', async () => {
    const props = defaultProps()
    props.board = makeBoard({
      custom_field_definitions: [{
        id: 6, uid: 'cfuid006', name: 'Notes', field_type: 'text',
        choices: [], position: 0, show_on_card: false, is_required: false,
        help_text: '', number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {}, created_at: '',
      }],
    })
    props.card = makeCard({ custom_field_values: [{ field_definition: 6, value: 'saved' }] })
    const user = userEvent.setup()
    render(<CardDetail {...props} />)
    const input = screen.getByDisplayValue('saved')
    await user.click(input)
    await user.keyboard('x')
    await user.keyboard('{Escape}')
    expect(screen.getByDisplayValue('saved')).not.toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
    expect(props.onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape with no label input open still closes the panel (#1972)', async () => {
    const props = defaultProps()
    render(<CardDetail {...props} />)
    await userEvent.setup().keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape closes the bulk-add overlay first, without closing the card panel (#1376)', async () => {
    const props = defaultProps()
    const user = userEvent.setup()
    render(<CardDetail {...props} />)
    await user.click(screen.getByText('Bulk'))
    expect(screen.getByText('Add checklist items')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByText('Add checklist items')).not.toBeInTheDocument()
    expect(props.onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape with focus on a bulk-add dialog button closes only the dialog (#1891)', async () => {
    const props = defaultProps()
    const user = userEvent.setup()
    render(<CardDetail {...props} />)
    for (const name of ['Cancel', 'Add items']) {
      await user.click(screen.getByText('Bulk'))
      const btn = screen.getByRole('button', { name })
      btn.focus()
      expect(btn).toHaveFocus()
      await user.keyboard('{Escape}')
      expect(screen.queryByText('Add checklist items')).not.toBeInTheDocument()
      expect(props.onClose).not.toHaveBeenCalled()
    }
    await user.keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('closing the bulk-add dialog by clicking its backdrop clears a stale error (#1891)', async () => {
    mockAddChecklistItem.mockRejectedValueOnce(new Error('server error'))
    render(<CardDetail {...defaultProps()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('Bulk'))
    await user.type(screen.getByPlaceholderText(/Buy milk/), 'One')
    await user.click(screen.getByRole('button', { name: 'Add items' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    // The backdrop is the dialog's aria-hidden previous sibling.
    fireEvent.click(screen.getByRole('dialog', { name: 'Add checklist items' }).previousElementSibling as Element)
    expect(screen.queryByText('Add checklist items')).not.toBeInTheDocument()
    // The error also renders beside the Bulk button once the dialog is closed, so a
    // stale message would be visible here.
    expect(screen.queryByText(/Added 0 of 1|failed|Could not/)).not.toBeInTheDocument()
  })

  it('Escape closes an open multi-select field menu first, without closing the card panel (#1391)', async () => {
    const props = defaultProps()
    props.board = makeBoard({
      custom_field_definitions: [{
        id: 5, uid: 'cfuid005', name: 'Platforms', field_type: 'multi_select',
        choices: ['web', 'ios'], position: 0, show_on_card: false, is_required: false,
        help_text: '', number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {}, created_at: '',
      }],
    })
    // A stored value opens the Custom fields section automatically.
    props.card = makeCard({ custom_field_values: [{ field_definition: 5, value: '["web"]' }] })
    const user = userEvent.setup()
    render(<CardDetail {...props} />)
    await user.click(screen.getByRole('button', { name: 'Platforms: web' }))
    expect(screen.getByRole('listbox', { name: 'Platforms' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: 'Platforms' })).not.toBeInTheDocument()
    expect(props.onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('renders checklist progress when items exist', async () => {
    const mockGetChecklist = getChecklist as ReturnType<typeof vi.fn>
    mockGetChecklist.mockResolvedValue([
      { id: 1, text: 'Item 1', is_checked: true, position: 0 },
      { id: 2, text: 'Item 2', is_checked: false, position: 1 },
    ])
    render(<CardDetail {...defaultProps()} />)
    await waitFor(() => {
      expect(screen.getByText('Item 1')).toBeInTheDocument()
      expect(screen.getByText('Item 2')).toBeInTheDocument()
      expect(screen.getByText('1/2')).toBeInTheDocument()
    })
  })

  describe('checklist ownership gating (#1943)', () => {
    const owner = { id: 1, username: 'user1', display_name: 'User 1', avatar_url: '' }
    const memberProps = (isModerator = false) => {
      const props = defaultProps()
      props.board = makeBoard({
        current_user_role: 'member',
        members: [{ id: 1, user: fakeUser, role: 'member', is_moderator: isModerator, joined_at: '' }],
      })
      return props
    }
    const items = [
      { id: 1, text: 'Mine', is_checked: false, position: 0, created_by: owner },
      { id: 2, text: 'Theirs', is_checked: false, position: 1, created_by: { ...owner, id: 7 } },
      { id: 3, text: 'Legacy', is_checked: false, position: 2, created_by: null },
    ]

    it('lets a plain member modify only items they created', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue(items)
      render(<CardDetail {...memberProps()} currentUser={fakeUser} />)
      await waitFor(() => expect(screen.getByText('Legacy')).toBeInTheDocument())
      const boxes = screen.getAllByRole('checkbox').filter((b) => (b as HTMLInputElement).type === 'checkbox')
      const checklistBoxes = boxes.slice(-3) as HTMLInputElement[]
      expect(checklistBoxes[0].disabled).toBe(false)
      expect(checklistBoxes[1].disabled).toBe(true)
      expect(checklistBoxes[2].disabled).toBe(true)
      // The reason is in the accessible name, not only the unfocusable title
      expect(
        screen.getByRole('checkbox', { name: 'Legacy. Only the creator or a moderator can modify this item' }),
      ).toBe(checklistBoxes[2])
      expect(checklistBoxes[0]).not.toHaveAttribute('aria-label')
      expect(screen.getAllByTitle('Remove item')).toHaveLength(1)
    })

    it('lets the demo visitor (plain member) modify items created by others', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue(items)
      render(<CardDetail {...memberProps()} currentUser={fakeUser} />, { wrapper: flagsWrapper({ demo_mode: true }) })
      await waitFor(() => expect(screen.getByText('Legacy')).toBeInTheDocument())
      const checklistBoxes = screen.getAllByRole('checkbox').slice(-3) as HTMLInputElement[]
      expect(checklistBoxes.every((b) => !b.disabled)).toBe(true)
      expect(screen.getAllByTitle('Remove item')).toHaveLength(3)
    })

    it('lets a moderator modify every item including null-creator ones', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue(items)
      render(<CardDetail {...memberProps(true)} currentUser={fakeUser} />)
      await waitFor(() => expect(screen.getByText('Legacy')).toBeInTheDocument())
      expect(screen.getAllByTitle('Remove item')).toHaveLength(3)
    })
  })

  describe('checklist assignees, due dates and progress (#445)', () => {
    const owner = { id: 1, username: 'user1', display_name: 'User 1', avatar_url: '' }
    const memberProps = () => {
      const props = defaultProps()
      props.board = makeBoard({
        current_user_role: 'member',
        members: [{ id: 1, user: fakeUser, role: 'member', is_moderator: false, joined_at: '' }],
      })
      return props
    }
    const mine = { id: 1, text: 'Mine', is_checked: false, position: 0, created_by: owner, assignee: null, due_date: null }
    const theirs = { id: 2, text: 'Theirs', is_checked: true, position: 1, created_by: { ...owner, id: 7 }, assignee: null, due_date: null }

    it('assigns an item through the member picker and updates the face fields', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([mine, theirs])
      mockUpdateChecklistItem.mockResolvedValue({ ...mine, assignee: fakeUser })
      const props = memberProps()
      render(<CardDetail {...props} currentUser={fakeUser} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Assign Mine' }))
      const list = screen.getByRole('list', { name: 'Assignee for Mine' })
      const [unassigned, jane] = within(list).getAllByRole('button')
      // The current value ("Unassigned") is pressed, checked and focused first.
      expect(unassigned).toHaveAttribute('aria-pressed', 'true')
      expect(unassigned).toHaveFocus()
      expect(within(unassigned).getByTestId('checklist-assignee-check')).toBeInTheDocument()
      fireEvent.keyDown(unassigned, { key: 'ArrowDown' })
      expect(jane).toHaveFocus()
      fireEvent.keyDown(jane, { key: 'ArrowUp' })
      expect(unassigned).toHaveFocus()
      fireEvent.click(jane)
      await waitFor(() => expect(mockUpdateChecklistItem).toHaveBeenCalledWith(props.board.id, props.card.id, 1, { assignee_id: fakeUser.id }))
      expect(await screen.findByRole('button', { name: /^Assigned to .+\. Change assignee for Mine$/ })).toBeInTheDocument()
      expect(props.onUpdated).toHaveBeenLastCalledWith(expect.objectContaining({
        checklist_open_assignee_ids: [fakeUser.id], checklist_open_due_dates: [],
      }))
    })

    it('sets a due date with the native date input', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([mine])
      mockUpdateChecklistItem.mockResolvedValue({ ...mine, due_date: '2026-11-18' })
      const props = memberProps()
      render(<CardDetail {...props} currentUser={fakeUser} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Set due date for Mine' }))
      const input = screen.getByLabelText('Set due date for Mine') as HTMLInputElement
      expect(input.type).toBe('date')
      fireEvent.change(input, { target: { value: '2026-11-18' } })
      fireEvent.blur(input)
      await waitFor(() => expect(mockUpdateChecklistItem).toHaveBeenCalledWith(props.board.id, props.card.id, 1, { due_date: '2026-11-18' }))
      expect(await screen.findByRole('button', { name: /^Due November 18(, overdue)?\. Change due date for Mine$/ })).toHaveTextContent('Nov 18')
    })

    it('omits both controls on an item the member did not create (R2)', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([mine, theirs])
      render(<CardDetail {...memberProps()} currentUser={fakeUser} />)
      expect(await screen.findByRole('button', { name: 'Assign Mine' })).toBeEnabled()
      expect(screen.queryByRole('button', { name: 'Assign Theirs' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Set due date for Theirs' })).toBeNull()
    })

    it('shows set values on a read-only item as plain text, not dimmed buttons', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([mine, { ...theirs, is_checked: false, assignee: fakeUser, due_date: '2020-01-02' }])
      render(<CardDetail {...memberProps()} currentUser={fakeUser} />)
      await screen.findByRole('button', { name: 'Assign Mine' })
      expect(screen.queryByRole('button', { name: /Change assignee for Theirs/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /Change due date for Theirs/ })).toBeNull()
      expect(screen.getByText(/^Assigned to .+$/, { selector: '.sr-only' })).toBeInTheDocument()
      const due = screen.getByText('Due January 2, overdue', { selector: '.sr-only' })
      expect(due.parentElement).toHaveClass('text-danger')
      expect(due.parentElement).toHaveAttribute('title', 'Due January 2, overdue')
    })

    it('commits a due date on Enter and abandons it on Escape', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([mine])
      mockUpdateChecklistItem.mockResolvedValue({ ...mine, due_date: '2026-11-20' })
      const props = memberProps()
      render(<CardDetail {...props} currentUser={fakeUser} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Set due date for Mine' }))
      let input = screen.getByLabelText('Set due date for Mine') as HTMLInputElement
      fireEvent.change(input, { target: { value: '2026-11-19' } })
      fireEvent.keyDown(input, { key: 'Escape' })
      fireEvent.blur(input)
      expect(screen.queryByLabelText('Set due date for Mine', { selector: 'input' })).toBeNull()
      expect(mockUpdateChecklistItem).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Set due date for Mine' }))
      input = screen.getByLabelText('Set due date for Mine') as HTMLInputElement
      fireEvent.change(input, { target: { value: '2026-11-20' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(mockUpdateChecklistItem).toHaveBeenCalledWith(props.board.id, props.card.id, 1, { due_date: '2026-11-20' }))
    })

    it('shows the empty state and an expandable header with aria-expanded', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([])
      render(<CardDetail {...memberProps()} currentUser={fakeUser} />)
      // An empty checklist loads collapsed; expanding shows the empty state.
      const header = screen.getByRole('button', { name: /^Checklist/ })
      await waitFor(() => expect(header).toHaveAttribute('aria-expanded', 'false'))
      expect(screen.queryByText('No checklist items.')).toBeNull()
      fireEvent.click(header)
      expect(header).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByText('No checklist items.')).toBeInTheDocument()
    })

    it('shows the failure copy when the assign is refused', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([mine])
      mockUpdateChecklistItem.mockRejectedValue(new Error('400'))
      render(<CardDetail {...memberProps()} currentUser={fakeUser} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Assign Mine' }))
      fireEvent.click(within(screen.getByRole('list', { name: 'Assignee for Mine' })).getAllByRole('button')[1])
      expect(await screen.findByText('Failed to assign checklist item. Please try again.')).toBeInTheDocument()
    })

    it('marks an overdue unchecked item in the row', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...mine, due_date: '2020-01-02' }])
      render(<CardDetail {...memberProps()} currentUser={fakeUser} />)
      const due = await screen.findByRole('button', { name: 'Due January 2, overdue. Change due date for Mine' })
      expect(due).toHaveClass('text-danger')
      expect(due).toHaveTextContent('⚑ Jan 2')
    })

    it('shows progress and a session-only Hide completed toggle', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([mine, theirs])
      render(<CardDetail {...memberProps()} currentUser={fakeUser} />)
      const bar = await screen.findByRole('progressbar', { name: 'Checklist progress' })
      expect(bar).toHaveAttribute('aria-valuenow', '1')
      expect(bar).toHaveAttribute('aria-valuemax', '2')
      const toggle = screen.getByRole('button', { name: 'Hide completed' })
      expect(toggle).toHaveAttribute('aria-pressed', 'false')
      expect(within(toggle).queryByTestId('active-mark')).toBeNull()
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-pressed', 'true')
      expect(within(toggle).getByTestId('active-mark')).toBeInTheDocument()
      expect(screen.getByText('1 completed hidden')).toBeInTheDocument()
      expect(screen.queryByText('Theirs')).toBeNull()
      fireEvent.click(toggle)
      expect(screen.getByText('Theirs')).toBeInTheDocument()
    })
  })

  it('renders attachments when present', async () => {
    const mockGetAttachments = getCardAttachments as ReturnType<typeof vi.fn>
    mockGetAttachments.mockResolvedValue([
      { id: 1, filename: 'design.png', size: 2048, url: '/files/1', uploaded_by: fakeUser, uploaded_at: '2026-01-01' },
    ])
    render(<CardDetail {...defaultProps()} />)
    await waitFor(() => {
      expect(screen.getByText('design.png')).toBeInTheDocument()
    })
  })

  it('checklist section collapses and hides items when toggle clicked', async () => {
    const mockGetChecklist = getChecklist as ReturnType<typeof vi.fn>
    mockGetChecklist.mockResolvedValue([
      { id: 1, text: 'Item A', is_checked: false, position: 0 },
    ])
    render(<CardDetail {...defaultProps()} />)
    await waitFor(() => expect(screen.getByText('Item A')).toBeInTheDocument())
    // Click the Checklist toggle to collapse
    await userEvent.setup().click(screen.getByText('Checklist'))
    expect(screen.queryByText('Item A')).not.toBeInTheDocument()
  })

  it('checklist section starts collapsed when empty', async () => {
    // getChecklist returns [] by default in beforeEach
    render(<CardDetail {...defaultProps()} />)
    // The checklist items list is not shown (empty) — add-item input is still present
    await waitFor(() => expect(screen.queryByText('1/1')).not.toBeInTheDocument())
    expect(screen.getByPlaceholderText('Add item (Enter)…')).toBeInTheDocument()
  })

  it('attachments section collapses and hides items when toggle clicked', async () => {
    const mockGetAttachments = getCardAttachments as ReturnType<typeof vi.fn>
    mockGetAttachments.mockResolvedValue([
      { id: 1, filename: 'doc.pdf', size: 1024, url: '/files/1', uploaded_by: fakeUser, uploaded_at: '2026-01-01' },
    ])
    render(<CardDetail {...defaultProps()} />)
    await waitFor(() => expect(screen.getByText('doc.pdf')).toBeInTheDocument())
    await userEvent.setup().click(screen.getByText('Attachments'))
    expect(screen.queryByText('doc.pdf')).not.toBeInTheDocument()
  })

  it('renders mention highlights in comments', async () => {
    rememberCardDetailTab('comments')
    const mockGetComments = getCardComments as ReturnType<typeof vi.fn>
    mockGetComments.mockResolvedValue([
      { id: 1, author: fakeUser, body: 'Hey @jdoe check this', created_at: new Date().toISOString(), updated_at: '' },
    ])
    render(<CardDetail {...defaultProps()} />)
    await waitFor(() => {
      expect(screen.getByText('@jdoe')).toBeInTheDocument()
    })
  })

  it('clicking Delete card shows confirmation modal, not window.confirm', async () => {
    render(<CardDetail {...defaultProps()} />)
    fireEvent.click(screen.getByText('Delete card'))
    expect(screen.getByText('Delete this card?')).toBeInTheDocument()
    expect(screen.getByText('Cancel')).toBeInTheDocument()
    // Confirm button in modal
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('cancelling delete confirmation closes the modal without calling deleteCard', async () => {
    const { deleteCard } = await import('../api/cards')
    render(<CardDetail {...defaultProps()} />)
    fireEvent.click(screen.getByText('Delete card'))
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText('Delete this card?')).not.toBeInTheDocument()
    expect(deleteCard).not.toHaveBeenCalled()
  })

  it('clicking Archive card shows confirmation modal, not window.confirm', async () => {
    render(<CardDetail {...defaultProps()} />)
    await waitForSheetLoaded()
    fireEvent.click(screen.getByText('Archive card'))
    expect(screen.getByText('Archive this card?')).toBeInTheDocument()
  })

  it('save() handles API failure without crashing', async () => {
    const { updateCard } = await import('../api/cards')
    const mockUpdateCard = updateCard as ReturnType<typeof vi.fn>
    mockUpdateCard.mockRejectedValueOnce(new Error('Network error'))
    const props = defaultProps()
    render(<CardDetail {...props} />)
    const titleInput = screen.getByDisplayValue('Test Card')
    fireEvent.change(titleInput, { target: { value: 'Changed title' } })
    fireEvent.blur(titleInput)
    await waitFor(() => {
      // updateCard was called; component stays mounted with no crash
      expect(mockUpdateCard).toHaveBeenCalledWith(expect.anything(), expect.anything(), { title: 'Changed title' })
    })
  })

  describe('checklist tile count sync (#330)', () => {
    it('checking an item calls onUpdated with correct checklist_done count (Bug 1)', async () => {
      const mockGetChecklist = getChecklist as ReturnType<typeof vi.fn>
      mockGetChecklist.mockResolvedValue([
        { id: 1, text: 'Item 1', is_checked: false, position: 0 },
        { id: 2, text: 'Item 2', is_checked: false, position: 1 },
      ])
      mockUpdateChecklistItem.mockResolvedValue({ id: 1, text: 'Item 1', is_checked: true, position: 0 })
      const props = defaultProps()
      render(<CardDetail {...props} />)
      await waitFor(() => expect(screen.getByText('Item 1')).toBeInTheDocument())
      await userEvent.setup().click(screen.getAllByRole('checkbox')[0])
      await waitFor(() => {
        // onUpdated should receive the recalculated count from actual checklist state,
        // not a stale delta from localCard.checklist_done
        const calls = (props.onUpdated as ReturnType<typeof vi.fn>).mock.calls
        const lastCall = calls[calls.length - 1][0]
        expect(lastCall.checklist_done).toBe(1)
        expect(lastCall.checklist_total).toBe(2)
      })
    })

    it('rapid successive checks produce correct final count (Bug 2 — no stale revert)', async () => {
      const mockGetChecklist = getChecklist as ReturnType<typeof vi.fn>
      mockGetChecklist.mockResolvedValue([
        { id: 1, text: 'Item 1', is_checked: false, position: 0 },
        { id: 2, text: 'Item 2', is_checked: false, position: 1 },
      ])
      mockUpdateChecklistItem
        .mockResolvedValueOnce({ id: 1, text: 'Item 1', is_checked: true, position: 0 })
        .mockResolvedValueOnce({ id: 2, text: 'Item 2', is_checked: true, position: 1 })
      const props = defaultProps()
      render(<CardDetail {...props} />)
      await waitFor(() => expect(screen.getByText('Item 2')).toBeInTheDocument())
      const checkboxes = screen.getAllByRole('checkbox')
      await userEvent.setup().click(checkboxes[0])
      await userEvent.setup().click(checkboxes[1])
      await waitFor(() => {
        const calls = (props.onUpdated as ReturnType<typeof vi.fn>).mock.calls
        const lastCall = calls[calls.length - 1][0]
        // Both items checked — final count must be 2, not 1 (the stale-delta value)
        expect(lastCall.checklist_done).toBe(2)
        expect(lastCall.checklist_total).toBe(2)
      })
    })

    it('deleting a checked item calls onUpdated with correct counts', async () => {
      const mockGetChecklist = getChecklist as ReturnType<typeof vi.fn>
      mockGetChecklist.mockResolvedValue([
        { id: 1, text: 'Item 1', is_checked: true, position: 0 },
        { id: 2, text: 'Item 2', is_checked: false, position: 1 },
      ])
      mockDeleteChecklistItem.mockResolvedValue(undefined)
      const props = defaultProps()
      render(<CardDetail {...props} />)
      await waitFor(() => expect(screen.getByText('Item 1')).toBeInTheDocument())
      // Click the delete (×) button next to the first item
      const deleteButtons = screen.getAllByTitle('Remove item')
      await userEvent.setup().click(deleteButtons[0])
      await waitFor(() => {
        const calls = (props.onUpdated as ReturnType<typeof vi.fn>).mock.calls
        const lastCall = calls[calls.length - 1][0]
        expect(lastCall.checklist_total).toBe(1)
        expect(lastCall.checklist_done).toBe(0)
      })
    })
  })

  describe('load failure and checklist add rejection paths (#1375)', () => {
    it('shows a load error when the initial comments/attachments/checklist fetch fails', async () => {
      const mockGetComments = getCardComments as ReturnType<typeof vi.fn>
      mockGetComments.mockRejectedValueOnce(new Error('network error'))
      render(<CardDetail {...defaultProps()} />)
      expect(await screen.findByRole('alert')).toHaveTextContent(/failed to load/i)
    })

    it('does not show a load error when all three initial fetches succeed', async () => {
      render(<CardDetail {...defaultProps()} />)
      await waitFor(() => expect(getCardComments as ReturnType<typeof vi.fn>).toHaveBeenCalled())
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('shows a load error when the refreshSignal-triggered refetch fails', async () => {
      const mockGetComments = getCardComments as ReturnType<typeof vi.fn>
      const props = defaultProps()
      // Initial mount load succeeds — the error must come from the refreshSignal
      // effect specifically, not leak over from the mount effect (#1375).
      const { rerender } = render(<CardDetail {...props} refreshSignal={0} />)
      await waitFor(() => expect(mockGetComments).toHaveBeenCalledTimes(1))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()

      mockGetComments.mockRejectedValueOnce(new Error('network error'))
      rerender(<CardDetail {...props} refreshSignal={1} />)

      expect(await screen.findByRole('alert')).toHaveTextContent(/failed to load/i)
    })

    it('shows an inline error and keeps the typed text when adding a checklist item fails', async () => {
      mockAddChecklistItem.mockRejectedValueOnce(new Error('server error'))
      render(<CardDetail {...defaultProps()} />)
      const user = userEvent.setup()
      const input = screen.getByPlaceholderText('Add item (Enter)…')
      await user.type(input, 'New task')
      await user.keyboard('{Enter}')

      expect(await screen.findByText('Could not add item.')).toBeInTheDocument()
      // The failed item never appears in the list.
      expect(screen.queryByText('New task')).not.toBeInTheDocument()
    })

    it('adds the checklist item and clears the input on success', async () => {
      mockAddChecklistItem.mockResolvedValueOnce({ id: 99, text: 'New task', is_checked: false, position: 0 })
      render(<CardDetail {...defaultProps()} />)
      const user = userEvent.setup()
      const input = screen.getByPlaceholderText('Add item (Enter)…') as HTMLInputElement
      await user.type(input, 'New task')
      await user.keyboard('{Enter}')

      await waitFor(() => expect(screen.getByText('New task')).toBeInTheDocument())
      expect(input.value).toBe('')
      expect(screen.queryByText('Could not add item.')).not.toBeInTheDocument()
    })

    it('bulk add: a mid-batch failure still applies the items that succeeded and reports the rest', async () => {
      mockAddChecklistItem
        .mockResolvedValueOnce({ id: 1, text: 'One', is_checked: false, position: 0 })
        .mockRejectedValueOnce(new Error('server error'))
      render(<CardDetail {...defaultProps()} />)
      const user = userEvent.setup()
      await user.click(screen.getByText('Bulk'))
      const textarea = screen.getByPlaceholderText(/Buy milk/) as HTMLTextAreaElement
      await user.type(textarea, 'One\nTwo')
      await user.click(screen.getByRole('button', { name: 'Add items' }))

      await waitFor(() => expect(screen.getByText('Added 1 of 2 items — the rest failed.')).toBeInTheDocument())
      // The dialog stays open on failure — the user can see what happened and retry.
      expect(screen.getByText('Add checklist items')).toBeInTheDocument()
      // The textarea is rewritten to only the remainder — a literal retry must
      // not re-post "One", which already made it to the server (#1375 follow-up).
      expect(textarea.value).toBe('Two')
      // The one item that did succeed is still reflected once the dialog is dismissed.
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.getByText('One')).toBeInTheDocument()
    })

    it('bulk add: retrying after a partial failure resubmits only the remainder, with no duplicates', async () => {
      mockAddChecklistItem
        .mockResolvedValueOnce({ id: 1, text: 'One', is_checked: false, position: 0 })
        .mockRejectedValueOnce(new Error('server error'))
        .mockResolvedValueOnce({ id: 2, text: 'Two', is_checked: false, position: 1 })
      render(<CardDetail {...defaultProps()} />)
      const user = userEvent.setup()
      await user.click(screen.getByText('Bulk'))
      const textarea = screen.getByPlaceholderText(/Buy milk/) as HTMLTextAreaElement
      await user.type(textarea, 'One\nTwo')
      await user.click(screen.getByRole('button', { name: 'Add items' }))
      await waitFor(() => expect(screen.getByText('Added 1 of 2 items — the rest failed.')).toBeInTheDocument())
      expect(textarea.value).toBe('Two')

      // Retry without editing — only the remainder ("Two") is resubmitted.
      await user.click(screen.getByRole('button', { name: 'Add items' }))
      await waitFor(() => expect(screen.queryByText('Add checklist items')).not.toBeInTheDocument())

      expect(mockAddChecklistItem).toHaveBeenCalledTimes(3)
      // The 3rd call (the retry) only resubmits "Two" — "One" is never re-posted.
      expect(mockAddChecklistItem.mock.calls[2][2]).toBe('Two')
      // Exactly one "One" and one "Two" in the final list — no duplicate.
      expect(screen.getAllByText('One')).toHaveLength(1)
      expect(screen.getAllByText('Two')).toHaveLength(1)
    })

    it('bulk add: all items succeed, closes the dialog, and lists every item', async () => {
      mockAddChecklistItem
        .mockResolvedValueOnce({ id: 1, text: 'One', is_checked: false, position: 0 })
        .mockResolvedValueOnce({ id: 2, text: 'Two', is_checked: false, position: 1 })
      render(<CardDetail {...defaultProps()} />)
      const user = userEvent.setup()
      await user.click(screen.getByText('Bulk'))
      await user.type(screen.getByPlaceholderText(/Buy milk/), 'One\nTwo')
      await user.click(screen.getByRole('button', { name: 'Add items' }))

      await waitFor(() => expect(screen.queryByText('Add checklist items')).not.toBeInTheDocument())
      expect(screen.getByText('One')).toBeInTheDocument()
      expect(screen.getByText('Two')).toBeInTheDocument()
    })
  })

  describe('live refresh on socket event (#1310)', () => {
    it('refetches comments, checklist, attachments, and relations when refreshSignal increments', async () => {
      const mockGetComments = getCardComments as ReturnType<typeof vi.fn>
      const mockGetChecklist = getChecklist as ReturnType<typeof vi.fn>
      const mockGetAttachments = getCardAttachments as ReturnType<typeof vi.fn>
      mockGetComments.mockResolvedValue([])
      mockGetChecklist.mockResolvedValue([])
      mockGetAttachments.mockResolvedValue([])
      mockGetCardRelations.mockResolvedValue([])
      const props = defaultProps()
      const { rerender } = render(<CardDetail {...props} refreshSignal={0} />)
      await waitFor(() => expect(mockGetComments).toHaveBeenCalledTimes(1))
      expect(mockGetChecklist).toHaveBeenCalledTimes(1)
      expect(mockGetAttachments).toHaveBeenCalledTimes(1)
      expect(mockGetCardRelations).toHaveBeenCalledTimes(1)

      // Simulate another user's comment arriving via BoardView's socket handler
      // bumping cardDetailRefreshTick.
      mockGetComments.mockResolvedValue([
        { id: 1, author: fakeUser, body: 'From another session', created_at: new Date().toISOString(), updated_at: '' },
      ])
      rerender(<CardDetail {...props} refreshSignal={1} />)

      fireEvent.click(screen.getByRole('tab', { name: /^Comments/ }))
      await waitFor(() => expect(screen.getByText('From another session')).toBeInTheDocument())
      expect(mockGetComments).toHaveBeenCalledTimes(2)
      expect(mockGetChecklist).toHaveBeenCalledTimes(2)
      expect(mockGetAttachments).toHaveBeenCalledTimes(2)
      expect(mockGetCardRelations).toHaveBeenCalledTimes(2)
    })

    it('under StrictMode fires only the mount fetches (2 each), then exactly one refetch per signal bump (#1479)', async () => {
      const mockGetComments = getCardComments as ReturnType<typeof vi.fn>
      const mockGetChecklist = getChecklist as ReturnType<typeof vi.fn>
      const mockGetAttachments = getCardAttachments as ReturnType<typeof vi.fn>
      mockGetComments.mockResolvedValue([])
      mockGetChecklist.mockResolvedValue([])
      mockGetAttachments.mockResolvedValue([])
      mockGetCardRelations.mockResolvedValue([])
      const props = defaultProps()
      const el = (signal: number) => (
        <StrictMode>
          <CardDetail {...props} refreshSignal={signal} />
        </StrictMode>
      )
      const mocks = [mockGetComments, mockGetChecklist, mockGetAttachments, mockGetCardRelations]
      const { rerender } = render(el(0))
      await waitFor(() => expect(mockGetComments).toHaveBeenCalledTimes(2))
      await new Promise((r) => setTimeout(r, 20))
      for (const m of mocks) expect(m).toHaveBeenCalledTimes(2)

      rerender(el(1))
      await waitFor(() => expect(mockGetComments).toHaveBeenCalledTimes(3))
      await new Promise((r) => setTimeout(r, 20))
      for (const m of mocks) expect(m).toHaveBeenCalledTimes(3)
    })

    it('does not refetch on mount beyond the initial load (refreshSignal defaults to 0)', async () => {
      const mockGetComments = getCardComments as ReturnType<typeof vi.fn>
      render(<CardDetail {...defaultProps()} />)
      await waitFor(() => expect(mockGetComments).toHaveBeenCalledTimes(1))
      // No further calls fire without a refreshSignal change.
      expect(mockGetComments).toHaveBeenCalledTimes(1)
    })

    it('preserves a collapsed checklist section across a refresh-triggered refetch', async () => {
      const mockGetChecklist = getChecklist as ReturnType<typeof vi.fn>
      mockGetChecklist.mockResolvedValue([
        { id: 1, text: 'Item A', is_checked: false, position: 0 },
      ])
      const props = defaultProps()
      const { rerender } = render(<CardDetail {...props} refreshSignal={0} />)
      await waitFor(() => expect(screen.getByText('Item A')).toBeInTheDocument())
      await userEvent.setup().click(screen.getByText('Checklist'))
      expect(screen.queryByText('Item A')).not.toBeInTheDocument()

      mockGetChecklist.mockResolvedValue([
        { id: 1, text: 'Item A', is_checked: false, position: 0 },
        { id: 2, text: 'Item B', is_checked: false, position: 1 },
      ])
      rerender(<CardDetail {...props} refreshSignal={1} />)

      // The refetch happened (new item is in the data), but the section stays
      // collapsed — a background refresh must not snap it back open.
      await waitFor(() => expect(getChecklist as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2))
      expect(screen.queryByText('Item A')).not.toBeInTheDocument()
      expect(screen.queryByText('Item B')).not.toBeInTheDocument()
    })
  })

  describe('comment delete inline confirm (#1365)', () => {
    beforeEach(() => rememberCardDetailTab('comments'))
    async function renderWithComment() {
      const { getCardComments } = await import('../api/cards')
      ;(getCardComments as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 1, author: fakeUser, body: 'Hello world', created_at: new Date().toISOString(), updated_at: '' },
      ])
      const onClose = vi.fn()
      const user = userEvent.setup()
      render(<CardDetail {...defaultProps()} currentUser={fakeUser} onClose={onClose} />)
      await user.click(await screen.findByRole('button', { name: 'Delete comment' }))
      return { user, onClose }
    }

    it('shows a full-sentence prompt with Confirm / Cancel, never Yes / No', async () => {
      await renderWithComment()
      expect(screen.getByText('Delete this comment?')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Yes' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'No' })).not.toBeInTheDocument()
    })

    it('Confirm deletes the comment', async () => {
      const { deleteComment } = await import('../api/cards')
      const { user } = await renderWithComment()
      await user.click(screen.getByRole('button', { name: 'Confirm' }))
      expect(deleteComment).toHaveBeenCalledTimes(1)
    })

    it('announces the prompt through a polite live region (#1421)', async () => {
      await renderWithComment()
      const region = screen.getByText('Delete this comment?').closest('[aria-live]')
      expect(region).not.toBeNull()
      expect(region).toHaveAttribute('aria-live', 'polite')
      expect(region).toHaveAttribute('aria-atomic', 'true')
      expect(region).toHaveAttribute('role', 'status')
    })

    it('disables Confirm and Cancel while in flight and sends only one DELETE (#1421)', async () => {
      const { deleteComment } = await import('../api/cards')
      const mockDelete = deleteComment as ReturnType<typeof vi.fn>
      mockDelete.mockClear()
      let resolveDelete!: () => void
      mockDelete.mockImplementationOnce(() => new Promise<void>((r) => { resolveDelete = r }))
      const { user } = await renderWithComment()
      await user.click(screen.getByRole('button', { name: 'Confirm' }))
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
      await user.click(screen.getByRole('button', { name: 'Confirm' }))
      expect(mockDelete).toHaveBeenCalledTimes(1)
      resolveDelete()
      await waitFor(() => expect(screen.queryByText('Delete this comment?')).not.toBeInTheDocument())
    })

    it('a failed delete keeps the prompt open with an error and re-enables the buttons (#1421)', async () => {
      const { deleteComment } = await import('../api/cards')
      const mockDelete = deleteComment as ReturnType<typeof vi.fn>
      mockDelete.mockClear()
      mockDelete.mockRejectedValueOnce(new Error('boom'))
      const { user } = await renderWithComment()
      await user.click(screen.getByRole('button', { name: 'Confirm' }))
      const err = await screen.findByText('Failed to delete comment. Please try again.')
      expect(err.closest('[role="status"]')).not.toBeNull()
      expect(screen.getByText('Delete this comment?')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
      // Retry succeeds.
      mockDelete.mockResolvedValueOnce(undefined)
      await user.click(screen.getByRole('button', { name: 'Confirm' }))
      await waitFor(() => expect(screen.queryByText('Delete this comment?')).not.toBeInTheDocument())
      expect(mockDelete).toHaveBeenCalledTimes(2)
    })

    it('Cancel dismisses the prompt without deleting', async () => {
      const { deleteComment } = await import('../api/cards')
      ;(deleteComment as ReturnType<typeof vi.fn>).mockClear()
      const { user } = await renderWithComment()
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByText('Delete this comment?')).not.toBeInTheDocument()
      expect(deleteComment).not.toHaveBeenCalled()
    })

    it('Cancel and Escape return focus to the Delete comment trigger (#1367)', async () => {
      const { user } = await renderWithComment()
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.getByRole('button', { name: 'Delete comment' })).toHaveFocus()

      await user.click(screen.getByRole('button', { name: 'Delete comment' }))
      screen.getByRole('button', { name: 'Cancel' }).focus()
      await user.keyboard('{Escape}')
      expect(screen.queryByText('Delete this comment?')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Delete comment' })).toHaveFocus()
    })

    it('Escape cancels the open prompt first and does not close the panel; a second Escape closes it', async () => {
      const { user, onClose } = await renderWithComment()
      await user.keyboard('{Escape}')
      expect(screen.queryByText('Delete this comment?')).not.toBeInTheDocument()
      expect(onClose).not.toHaveBeenCalled()
      await user.keyboard('{Escape}')
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('comment delete prompt with a stale comment id (#1365)', () => {
    beforeEach(() => rememberCardDetailTab('comments'))
    it('a refetch that removes the comment does not let the stale prompt id swallow Escape', async () => {
      const { getCardComments } = await import('../api/cards')
      const mockGet = getCardComments as ReturnType<typeof vi.fn>
      mockGet.mockResolvedValue([
        { id: 1, author: fakeUser, body: 'Hello world', created_at: new Date().toISOString(), updated_at: '' },
      ])
      const onClose = vi.fn()
      const user = userEvent.setup()
      const props = { ...defaultProps(), currentUser: fakeUser, onClose }
      const { rerender } = render(<CardDetail {...props} refreshSignal={0} />)
      await user.click(await screen.findByRole('button', { name: 'Delete comment' }))
      expect(screen.getByText('Delete this comment?')).toBeInTheDocument()

      // Another session deletes the comment; the refreshSignal refetch returns none.
      mockGet.mockResolvedValue([])
      rerender(<CardDetail {...props} refreshSignal={1} />)
      await waitFor(() => expect(screen.queryByText('Delete this comment?')).not.toBeInTheDocument())

      await user.keyboard('{Escape}')
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('Move to popover', () => {
    beforeEach(() => {
      localStorage.clear()
    })

    function makeBoardWithTwoCols(): BoardFull {
      return makeBoard({
        columns: [
          { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
          { id: 11, uid: 'coluid000002', name: 'In Progress', position: 1, color: '#F59E0B', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
        ],
        swimlanes: [
          { id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null },
          { id: 21, uid: 'laneuid00002', name: 'Customer B', contact_email: '', notes: '', position: 1, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null },
        ],
      })
    }

    it('does not show move button when onMoveCard is not provided', () => {
      render(<CardDetail {...defaultProps()} />)
      expect(screen.queryByRole('button', { name: /Move card to different column or swimlane/ })).not.toBeInTheDocument()
    })

    it('shows move button when onMoveCard is provided and canEdit', () => {
      const onMoveCard = vi.fn().mockResolvedValue(undefined)
      render(<CardDetail {...defaultProps()} board={makeBoardWithTwoCols()} onMoveCard={onMoveCard} />)
      expect(screen.getByRole('button', { name: /Move card to different column or swimlane/ })).toBeInTheDocument()
    })

    it('does not show move button for viewer even when onMoveCard provided', () => {
      const onMoveCard = vi.fn().mockResolvedValue(undefined)
      const board = makeBoardWithTwoCols()
      render(<CardDetail {...defaultProps()} board={{ ...board, current_user_role: 'viewer' }} onMoveCard={onMoveCard} />)
      expect(screen.queryByRole('button', { name: /Move card to different column or swimlane/ })).not.toBeInTheDocument()
    })

    it('clicking move button opens popover with column and swimlane selectors', async () => {
      const onMoveCard = vi.fn().mockResolvedValue(undefined)
      render(<CardDetail {...defaultProps()} board={makeBoardWithTwoCols()} onMoveCard={onMoveCard} />)
      await userEvent.setup().click(screen.getByRole('button', { name: /Move card to different column or swimlane/ }))
      expect(screen.getByText('Move to')).toBeInTheDocument()
      expect(screen.getByText('Column')).toBeInTheDocument()
      expect(screen.getByText('Swimlane')).toBeInTheDocument()
    })

    it('Move button is disabled when current location is pre-selected', async () => {
      const onMoveCard = vi.fn().mockResolvedValue(undefined)
      render(<CardDetail {...defaultProps()} board={makeBoardWithTwoCols()} onMoveCard={onMoveCard} />)
      await userEvent.setup().click(screen.getByRole('button', { name: /Move card to different column or swimlane/ }))
      // Move button disabled — card is already in the pre-selected column/swimlane
      const moveBtn = screen.getByRole('button', { name: 'Move' })
      expect(moveBtn).toBeDisabled()
    })

    it('clicking Cancel closes the popover', async () => {
      const onMoveCard = vi.fn().mockResolvedValue(undefined)
      render(<CardDetail {...defaultProps()} board={makeBoardWithTwoCols()} onMoveCard={onMoveCard} />)
      await userEvent.setup().click(screen.getByRole('button', { name: /Move card to different column or swimlane/ }))
      expect(screen.getByText('Move to')).toBeInTheDocument()
      await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByText('Move to')).not.toBeInTheDocument()
    })

    it('calls onMoveCard with new column and swimlane when Move is clicked', async () => {
      const onMoveCard = vi.fn().mockResolvedValue(undefined)
      const board = makeBoardWithTwoCols()
      const { container } = render(<CardDetail {...defaultProps()} board={board} onMoveCard={onMoveCard} />)
      await userEvent.setup().click(screen.getByRole('button', { name: /Move card to different column or swimlane/ }))

      // Scope the column dropdown trigger to buttons inside the popover to avoid
      // matching the breadcrumb "To Do" button (which calls onClose).
      const popover = container.querySelector('[class*="w-64"]')!
      const colTrigger = Array.from(popover.querySelectorAll('button')).find((b) => b.textContent?.includes('To Do'))!
      await userEvent.setup().click(colTrigger)
      await userEvent.setup().click(screen.getByText('In Progress'))

      const moveBtn = screen.getByRole('button', { name: 'Move' })
      expect(moveBtn).not.toBeDisabled()
      await userEvent.setup().click(moveBtn)

      await waitFor(() => {
        expect(onMoveCard).toHaveBeenCalledWith(1, 11, 20, 9999)
      })
    })

    // useBoard.moveCard never rejects — it reports failure as { ok: false, error } (#1761).
    const submitMove = async (onMoveCard: (...a: number[]) => Promise<MoveOutcome | void>) => {
      const board = makeBoardWithTwoCols()
      const user = userEvent.setup()
      const { container } = render(<CardDetail {...defaultProps()} board={board} onMoveCard={onMoveCard} />)
      await user.click(screen.getByRole('button', { name: /Move card to different column or swimlane/ }))
      const popover = container.querySelector('[class*="w-64"]')!
      const colTrigger = Array.from(popover.querySelectorAll('button')).find((b) => b.textContent?.includes('To Do'))!
      await user.click(colTrigger)
      await user.click(screen.getByText('In Progress'))
      await user.click(screen.getByRole('button', { name: 'Move' }))
      return container
    }
    // localCard must not adopt the target: the Move button is disabled only when
    // the target equals the card's current location, so "enabled" proves rollback.
    const expectNotMoved = () => expect(screen.getByRole('button', { name: 'Move' })).not.toBeDisabled()
    const axiosFailure = (status: number, data: unknown = {}) =>
      Object.assign(new Error('fail'), { isAxiosError: true, response: { status, data } })

    it('names a network error and keeps the card in place when the move fails without a response', async () => {
      const onMoveCard = vi.fn().mockResolvedValue({ ok: false, error: Object.assign(new Error('Network Error'), { isAxiosError: true }) })
      await submitMove(onMoveCard)
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Card could not be moved — a network error occurred.')
      })
      expect(screen.queryByText(/limit/)).not.toBeInTheDocument()
      // Popover stays open and the breadcrumb still shows the original column.
      expect(screen.getByText('Move to')).toBeInTheDocument()
      expectNotMoved()
    })

    it('names a permission failure, not a limit, on 403', async () => {
      const onMoveCard = vi.fn().mockResolvedValue({ ok: false, error: axiosFailure(403, { detail: 'no' }) })
      await submitMove(onMoveCard)
      await waitFor(() => {
        expect(screen.getByText('Card could not be moved — you do not have permission.')).toBeInTheDocument()
      })
      expectNotMoved()
    })

    it('uses limit wording only for a limit code', async () => {
      const onMoveCard = vi.fn().mockResolvedValue({ ok: false, error: axiosFailure(409, { code: 'wip_limit_exceeded' }) })
      await submitMove(onMoveCard)
      await waitFor(() => {
        expect(screen.getByText('Card could not be moved — a column limit was reached.')).toBeInTheDocument()
      })
      expectNotMoved()
    })

    it('names the column when the limit body carries column_name', async () => {
      const onMoveCard = vi.fn().mockResolvedValue({ ok: false, error: axiosFailure(409, { code: 'wip_limit_exceeded', column_name: 'In Progress' }) })
      await submitMove(onMoveCard)
      await waitFor(() => {
        expect(screen.getByText('Card could not be moved — "In Progress" has reached its limit.')).toBeInTheDocument()
      })
    })

    it('does not blame a limit when onMoveCard rejects with a plain error', async () => {
      const onMoveCard = vi.fn().mockRejectedValue(new Error('boom'))
      await submitMove(onMoveCard)
      await waitFor(() => {
        expect(screen.getByText('Card could not be moved — a network error occurred.')).toBeInTheDocument()
      })
      expectNotMoved()
    })

    it('closes the popover on a successful move result', async () => {
      const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
      await submitMove(onMoveCard)
      await waitFor(() => {
        expect(screen.queryByText('Move to')).not.toBeInTheDocument()
      })
    })

    describe('card prop changes underneath an open popover (#1773)', () => {
      const openPopover = async (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByRole('button', { name: /Move card to different column or swimlane/ }))

      it('closes the popover, clears the error and follows the refreshed card after a version-conflict refresh', async () => {
        const onMoveCard = vi.fn().mockResolvedValue({ ok: false, error: axiosFailure(409, { code: 'version_conflict' }) })
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { container, rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await openPopover(user)
        const popover = container.querySelector('[class*="w-64"]')!
        await user.click(Array.from(popover.querySelectorAll('button')).find((b) => b.textContent?.includes('To Do'))!)
        await user.click(screen.getByText('In Progress'))
        await user.click(screen.getByRole('button', { name: 'Move' }))
        await waitFor(() => expect(screen.getByText(/Card could not be moved/)).toBeInTheDocument())
        expect(screen.getByText('Move to')).toBeInTheDocument()

        // useBoard reloads the board: the same card arrives with a new version
        // and a location another session chose.
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 2, column: 11, swimlane: 21 })} />)

        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        expect(screen.queryByText(/Card could not be moved/)).not.toBeInTheDocument()
        // The failure message went with the popover, so the panel says why.
        expect(screen.getByTestId('move-notice')).toHaveAttribute('role', 'status')
        expect(screen.getByTestId('move-notice')).toHaveTextContent('This card was changed elsewhere. Its current location is shown.')
        // localCard follows the refreshed card: reopening seeds the targets from it.
        await openPopover(user)
        expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement() // cleared on the next open
        expect(screen.queryByText(/Card could not be moved/)).not.toBeInTheDocument()
        const reopened = container.querySelector('[class*="w-64"]')!
        expect(reopened.textContent).toContain('In Progress')
        expect(reopened.textContent).toContain('Customer B')
        expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled()
      })

      it('closes the popover without a notice when a forced move lands on the popover target', async () => {
        const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { container, rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await openPopover(user)
        const popover = container.querySelector('[class*="w-64"]')!
        await user.click(Array.from(popover.querySelectorAll('button')).find((b) => b.textContent?.includes('To Do'))!)
        await user.click(screen.getByText('In Progress'))

        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 2, column: 11, swimlane: 20 })} />)

        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        // The card landed exactly where the popover was aiming (a forced move):
        // the user's own outcome, so no "changed elsewhere" notice.
        expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
        await openPopover(user)
        const reopened = container.querySelector('[class*="w-64"]')!
        expect(reopened.textContent).toContain('In Progress')
        expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled()
      })

      it('leaves the popover open when the card changes without a version bump (title and column only)', async () => {
        const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await openPopover(user)
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ title: 'Renamed locally', column: 11 })} />)
        expect(screen.getByText('Move to')).toBeInTheDocument()
      })

      it('closes silently on a remote bump that changes nothing the popover was aiming at', async () => {
        const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await openPopover(user) // targets are pre-filled with the current location, nothing chosen
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 2 })} />)
        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
      })

      it('leaves the popover open when the identical card is re-delivered', async () => {
        const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await openPopover(user)
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard()} />)
        expect(screen.getByText('Move to')).toBeInTheDocument()
        expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
      })

      it('resets the popover on a version bump that leaves the location unchanged', async () => {
        const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { container, rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await openPopover(user)
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 2 })} />)
        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        await openPopover(user)
        const reopened = container.querySelector('[class*="w-64"]')!
        expect(reopened.textContent).toContain('To Do')
        expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled()
      })

      it('stays silent on a refresh while the popover is closed and clears an older notice', async () => {
        const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { container, rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await openPopover(user)
        await pickInProgress(user, container)
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 2 })} />)
        await waitFor(() => expect(screen.getByTestId('move-notice')).toHaveTextContent('changed elsewhere'))
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 3 })} />)
        await waitFor(() => expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement())
      })

      it('does not move focus on a version bump while the popover is closed', async () => {
        const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const { rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        ;(document.activeElement as HTMLElement | null)?.blur()
        expect(document.body).toHaveFocus()
        // e.g. the user's own title save returns through onUpdated.
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 2 })} />)
        expect(screen.getByRole('button', { name: /Move card to different column or swimlane/ })).not.toHaveFocus()
        expect(document.body).toHaveFocus()
        expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
      })

      it('clears the notice when the popover is reopened', async () => {
        const conflict = { ok: false, error: axiosFailure(409, { code: 'version_conflict' }) }
        const onMoveCard = vi.fn().mockResolvedValueOnce(conflict).mockResolvedValue({ ok: true })
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { container, rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        const pick = async () => {
          const popover = container.querySelector('[class*="w-64"]')!
          await user.click(Array.from(popover.querySelectorAll('button')).find((b) => b.textContent?.includes('To Do'))!)
          await user.click(screen.getByText('In Progress'))
          await user.click(screen.getByRole('button', { name: 'Move' }))
        }
        await openPopover(user)
        await pick()
        await waitFor(() => expect(screen.getByText(/Card could not be moved/)).toBeInTheDocument())
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 2 })} />)
        await waitFor(() => expect(screen.getByTestId('move-notice')).toHaveTextContent('This card was changed elsewhere. Its current location is shown.'))
        await openPopover(user)
        await pick()
        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
      })

      const NOTICE_TEXT = 'This card was changed elsewhere. Its current location is shown.'
      const pickInProgress = async (user: ReturnType<typeof userEvent.setup>, container: HTMLElement) => {
        const popover = container.querySelector('[class*="w-64"]')!
        await user.click(Array.from(popover.querySelectorAll('button')).find((b) => b.textContent?.includes('To Do'))!)
        await user.click(screen.getByText('In Progress'))
      }

      describe('own saves are not remote changes', () => {
        // Every save bumps the card version server-side and comes back through onUpdated.
        beforeEach(() => {
          mockUpdateCard.mockImplementation((_b: number, _c: number, patch: Record<string, unknown>) =>
            Promise.resolve({ ...makeCard(), ...patch, version: 2 }))
        })

        it('keeps the popover open and silent when the user\'s own title save returns while it is open', async () => {
          const board = makeBoardWithTwoCols()
          const props = defaultProps()
          const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
          const user = userEvent.setup()
          const { rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
          const title = screen.getByDisplayValue('Test Card')
          await user.click(title)
          fireEvent.change(title, { target: { value: 'My edit' } })
          await openPopover(user) // blurs the title: the save starts
          await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledWith(expect.anything(), expect.anything(), { title: 'My edit' }))
          // the save returns through onUpdated: the live card now carries the bumped version
          rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ title: 'My edit', version: 2 })} />)
          expect(screen.getByText('Move to')).toBeInTheDocument()
          expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
        })

        it('does not close a popover opened after the user\'s own save', async () => {
          const board = makeBoardWithTwoCols()
          const props = defaultProps()
          const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
          const user = userEvent.setup()
          const { rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
          const title = screen.getByDisplayValue('Test Card')
          fireEvent.change(title, { target: { value: 'My edit' } })
          fireEvent.blur(title)
          await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled())
          await openPopover(user)
          rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ title: 'My edit', version: 2 })} />)
          expect(screen.getByText('Move to')).toBeInTheDocument()
          expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
        })

        it('shows no notice for an own save after the popover was cancelled with an error showing', async () => {
          const onMoveCard = vi.fn().mockResolvedValue({ ok: false, error: axiosFailure(409, { code: 'wip_limit_exceeded', column_name: 'In Progress' }) })
          const board = makeBoardWithTwoCols()
          const props = defaultProps()
          const user = userEvent.setup()
          const { container, rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
          await openPopover(user)
          await pickInProgress(user, container)
          await user.click(screen.getByRole('button', { name: 'Move' }))
          await waitFor(() => expect(screen.getByText(/has reached its limit/)).toBeInTheDocument())
          await user.click(screen.getByRole('button', { name: 'Cancel' }))
          const title = screen.getByDisplayValue('Test Card')
          fireEvent.change(title, { target: { value: 'My edit' } })
          fireEvent.blur(title)
          await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled())
          rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ title: 'My edit', version: 2 })} />)
          expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
        })
      })

      it('shows the notice and closes for a real remote bump that moves the card elsewhere', async () => {
        const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { container, rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await openPopover(user)
        await pickInProgress(user, container)
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 2, column: 10, swimlane: 21 })} />)
        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        expect(screen.getByTestId('move-notice')).toHaveTextContent(NOTICE_TEXT)
      })

      it('closes silently when the popover showed a limit error and an admin forced move lands on its target', async () => {
        const onMoveCard = vi.fn().mockResolvedValue({ ok: false, error: axiosFailure(409, { code: 'wip_limit_exceeded', column_name: 'In Progress' }) })
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { container, rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await openPopover(user)
        await pickInProgress(user, container)
        await user.click(screen.getByRole('button', { name: 'Move' }))
        await waitFor(() => expect(screen.getByText(/has reached its limit/)).toBeInTheDocument())
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 2, column: 11, swimlane: 20 })} />)
        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
      })

      it('ignores a version bump from its own in-flight move, then closes once it resolves', async () => {
        let resolveMove!: (v: MoveOutcome) => void
        const onMoveCard = vi.fn().mockImplementation(() => new Promise<MoveOutcome>((r) => { resolveMove = r }))
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { container, rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await openPopover(user)
        await pickInProgress(user, container)
        await user.click(screen.getByRole('button', { name: 'Move' }))
        // useBoard swaps in the server's card (new version, new location) before the call resolves.
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 2, column: 11, swimlane: 20 })} />)
        expect(screen.getByText('Move to')).toBeInTheDocument()
        expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
        await act(async () => { resolveMove({ ok: true }) })
        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
      })

      it('treats a socket echo that beats the save response as its own, not a remote change', async () => {
        let resolveSave!: (c: unknown) => void
        mockUpdateCard.mockImplementation(() => new Promise((r) => { resolveSave = r }))
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
        const user = userEvent.setup()
        const { rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        const title = screen.getByDisplayValue('Test Card')
        await user.click(title)
        fireEvent.change(title, { target: { value: 'My edit' } })
        await openPopover(user) // blur starts the save; popover opens
        // The board applies the echo of our PATCH before the HTTP response returns.
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ title: 'My edit', version: 2 })} />)
        expect(screen.getByText('Move to')).toBeInTheDocument()
        expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
        await act(async () => { resolveSave({ ...makeCard(), title: 'My edit', version: 2 }) })
        expect(screen.getByText('Move to')).toBeInTheDocument()
      })

      it('a failed save does not roll the version back behind a refresh that landed while it was in flight', async () => {
        const mockGetChecklist = getChecklist as ReturnType<typeof vi.fn>
        mockGetChecklist.mockResolvedValue([{ id: 1, text: 'Item 1', is_checked: false, position: 0 }])
        mockUpdateChecklistItem.mockResolvedValue({ id: 1, text: 'Item 1', is_checked: true, position: 0 })
        let rejectSave!: (e: Error) => void
        mockUpdateCard.mockImplementation(() => new Promise((_r, rej) => { rejectSave = rej }))
        const props = defaultProps()
        const user = userEvent.setup()
        const { rerender } = render(<CardDetail {...props} />)
        await waitFor(() => expect(screen.getByText('Item 1')).toBeInTheDocument())
        const title = screen.getByDisplayValue('Test Card')
        fireEvent.change(title, { target: { value: 'Edit' } })
        fireEvent.blur(title)
        rerender(<CardDetail {...props} card={makeCard({ version: 9 })} />)
        await act(async () => { rejectSave(new Error('boom')) })
        await user.click(screen.getAllByRole('checkbox')[0])
        await waitFor(() => expect(props.onUpdated).toHaveBeenCalled())
        expect((props.onUpdated as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].version).toBe(9)
      })

      it('ignores the rollback of a failed own move (older version): the error stays, and the later conflict reload still closes with the notice', async () => {
        let resolveMove!: (v: MoveOutcome) => void
        const onMoveCard = vi.fn().mockImplementation(() => new Promise<MoveOutcome>((r) => { resolveMove = r }))
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { container, rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 1 })} />)
        await openPopover(user)
        await pickInProgress(user, container)
        await user.click(screen.getByRole('button', { name: 'Move' }))
        // a remote edit arrives during the request, then useBoard rolls back to the older snapshot
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 2, title: 'Remote' })} />)
        // (React can batch the rollback with the move settling, so the in-flight guard is already off)
        await act(async () => {
          rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 1 })} />)
          resolveMove({ ok: false, error: axiosFailure(409, { code: 'version_conflict' }) })
        })
        expect(screen.getByText('Move to')).toBeInTheDocument()
        expect(screen.getByText(/Card could not be moved/)).toBeInTheDocument()
        expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
        // the conflict reload then lands with a newer version: durable notice
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 3, title: 'Remote' })} />)
        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        expect(screen.getByTestId('move-notice')).toHaveTextContent(NOTICE_TEXT)
      })

      it('syncs the real location when a remote move lands before the own move settles', async () => {
        let resolveMove!: (v: MoveOutcome) => void
        const onMoveCard = vi.fn().mockImplementation(() => new Promise<MoveOutcome>((r) => { resolveMove = r }))
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { container, rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await openPopover(user)
        await pickInProgress(user, container)
        await user.click(screen.getByRole('button', { name: 'Move' }))
        // the conflict reload (or a remote move) arrives before the request settles
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 3, column: 10, swimlane: 21 })} />)
        await act(async () => { resolveMove({ ok: false, error: axiosFailure(409, { code: 'version_conflict' }) }) })
        expect(screen.getByText(/Card could not be moved/)).toBeInTheDocument()
        expect(screen.getByTitle('Customer B')).toBeInTheDocument()
      })

      it('treats a version bump that comes with a location change as remote even while an own save is in flight', async () => {
        mockUpdateCard.mockImplementation(() => new Promise(() => {}))
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
        const user = userEvent.setup()
        const { rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        const title = screen.getByDisplayValue('Test Card')
        await user.click(title)
        fireEvent.change(title, { target: { value: 'My edit' } })
        await openPopover(user) // blur starts the save, popover opens
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 2, column: 11 })} />)
        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        expect(screen.getByTestId('move-notice')).toHaveTextContent(NOTICE_TEXT)
      })

      describe('label saves and title restores', () => {
        beforeEach(() => {
          mockUpdateCard.mockImplementation((_b: number, _c: number, patch: Record<string, unknown>) =>
            Promise.resolve({ ...makeCard(), ...patch, version: 2 }))
        })

        it('an own label toggle keeps an open popover open when its version comes back', async () => {
          const board = makeBoardWithTwoCols()
          const props = defaultProps()
          const user = userEvent.setup()
          const { rerender } = render(<CardDetail {...props} board={board} onMoveCard={vi.fn()} />)
          await openPopover(user)
          await user.click(screen.getByRole('button', { name: 'Bug' }))
          await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled())
          rerender(<CardDetail {...props} board={board} onMoveCard={vi.fn()} card={makeCard({ version: 2 })} />)
          expect(screen.getByText('Move to')).toBeInTheDocument()
          expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
        })

        it('an own label create keeps an open popover open when its version comes back', async () => {
          const { createLabel } = await import('../api/boards')
          ;(createLabel as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 99, uid: 'x', name: 'Urgent', color: '#ff0000' })
          const board = makeBoardWithTwoCols()
          const props = defaultProps()
          const user = userEvent.setup()
          const { rerender } = render(<CardDetail {...props} board={board} onMoveCard={vi.fn()} />)
          await openPopover(user)
          await user.click(screen.getByText('+ New label'))
          const input = screen.getByPlaceholderText('Label name')
          fireEvent.change(input, { target: { value: 'Urgent' } })
          fireEvent.keyDown(input, { key: 'Enter' })
          await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled())
          rerender(<CardDetail {...props} board={board} onMoveCard={vi.fn()} card={makeCard({ version: 2 })} />)
          expect(screen.getByText('Move to')).toBeInTheDocument()
          expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
        })

        it('Escape in the title restores the last saved title, not a remote one', async () => {
          const props = defaultProps()
          const { rerender } = render(<CardDetail {...props} />)
          rerender(<CardDetail {...props} card={makeCard({ title: 'Renamed remotely', version: 5 })} />)
          const title = screen.getByDisplayValue('Test Card')
          title.focus()
          fireEvent.change(title, { target: { value: 'half typed' } })
          fireEvent.keyDown(title, { key: 'Escape' })
          expect(screen.getByDisplayValue('Test Card')).toBeInTheDocument()
          expect(mockUpdateCard).not.toHaveBeenCalled()
        })

        it('clearing the title restores the last saved title and sends nothing', async () => {
          const props = defaultProps()
          const { rerender } = render(<CardDetail {...props} />)
          rerender(<CardDetail {...props} card={makeCard({ title: 'Renamed remotely', version: 5 })} />)
          const title = screen.getByDisplayValue('Test Card')
          fireEvent.change(title, { target: { value: '   ' } })
          fireEvent.blur(title)
          await waitFor(() => expect(screen.getByDisplayValue('Test Card')).toBeInTheDocument())
          expect(mockUpdateCard).not.toHaveBeenCalled()
        })
      })

      it('keeps localCard.version current after its own move resolves, so a checklist onUpdated does not write the old one back', async () => {
        const mockGetChecklist = getChecklist as ReturnType<typeof vi.fn>
        mockGetChecklist.mockResolvedValue([{ id: 1, text: 'Item 1', is_checked: false, position: 0 }])
        mockUpdateChecklistItem.mockResolvedValue({ id: 1, text: 'Item 1', is_checked: true, position: 0 })
        let resolveMove!: (v: MoveOutcome) => void
        const onMoveCard = vi.fn().mockImplementation(() => new Promise<MoveOutcome>((r) => { resolveMove = r }))
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { container, rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await waitFor(() => expect(screen.getByText('Item 1')).toBeInTheDocument())
        await openPopover(user)
        await pickInProgress(user, container)
        await user.click(screen.getByRole('button', { name: 'Move' }))
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 5, column: 11 })} />)
        await act(async () => { resolveMove({ ok: true }) })
        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        await user.click(screen.getAllByRole('checkbox')[0])
        await waitFor(() => expect(props.onUpdated).toHaveBeenCalled())
        expect((props.onUpdated as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].version).toBe(5)
      })

      it('leaves focus on a field outside the popover when the popover closes on a remote bump', async () => {
        const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await openPopover(user)
        const description = screen.getByTestId('rich-text-editor')
        description.focus()
        expect(description).toHaveFocus()
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 2, column: 11 })} />)
        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        expect(description).toHaveFocus()
      })

      describe('title baseline (live card must not drift the blur check)', () => {
        it('sends no PATCH when the title is only focused and blurred after a remote rename', async () => {
          const props = defaultProps()
          const { rerender } = render(<CardDetail {...props} />)
          rerender(<CardDetail {...props} card={makeCard({ title: 'Renamed remotely', version: 2 })} />)
          const title = screen.getByDisplayValue('Test Card')
          fireEvent.focus(title)
          fireEvent.blur(title)
          await new Promise((r) => setTimeout(r, 20))
          expect(mockUpdateCard).not.toHaveBeenCalled()
        })

        it('still saves a title the user typed after a remote rename', async () => {
          const props = defaultProps()
          const { rerender } = render(<CardDetail {...props} />)
          rerender(<CardDetail {...props} card={makeCard({ title: 'Renamed remotely', version: 2 })} />)
          const title = screen.getByDisplayValue('Test Card')
          fireEvent.change(title, { target: { value: 'Typed by me' } })
          fireEvent.blur(title)
          await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledWith(expect.anything(), expect.anything(), { title: 'Typed by me' }))
        })

        it('A to B to A still saves the second rename back', async () => {
          mockUpdateCard.mockImplementation((_b: number, _c: number, patch: Record<string, unknown>) =>
            Promise.resolve({ ...makeCard(), ...patch, version: 2 }))
          const props = defaultProps()
          const { rerender } = render(<CardDetail {...props} />)
          const title = screen.getByDisplayValue('Test Card')
          fireEvent.change(title, { target: { value: 'B' } })
          fireEvent.blur(title)
          await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1))
          rerender(<CardDetail {...props} card={makeCard({ title: 'B', version: 2 })} />)
          fireEvent.change(screen.getByDisplayValue('B'), { target: { value: 'Test Card' } })
          fireEvent.blur(screen.getByDisplayValue('Test Card'))
          await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(2))
          expect(mockUpdateCard).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { title: 'Test Card' })
        })
      })

      it('does not write the pre-refresh version back through a checklist onUpdated', async () => {
        const mockGetChecklist = getChecklist as ReturnType<typeof vi.fn>
        mockGetChecklist.mockResolvedValue([{ id: 1, text: 'Item 1', is_checked: false, position: 0 }])
        mockUpdateChecklistItem.mockResolvedValue({ id: 1, text: 'Item 1', is_checked: true, position: 0 })
        const props = defaultProps()
        const { rerender } = render(<CardDetail {...props} />)
        await waitFor(() => expect(screen.getByText('Item 1')).toBeInTheDocument())
        rerender(<CardDetail {...props} card={makeCard({ version: 7 })} />)
        await userEvent.setup().click(screen.getAllByRole('checkbox')[0])
        await waitFor(() => expect(props.onUpdated).toHaveBeenCalled())
        const last = (props.onUpdated as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]
        expect(last.version).toBe(7)
      })

      it('does not steal focus from another field on a version bump', async () => {
        const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const { rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        const title = screen.getByDisplayValue('Test Card')
        title.focus()
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 2 })} />)
        expect(title).toHaveFocus()
      })

      it('keeps the inline error when its own failed move is rolled back (location changes, version does not)', async () => {
        const onMoveCard = vi.fn().mockResolvedValue({ ok: false, error: axiosFailure(409, { code: 'wip_limit_exceeded', column_name: 'In Progress' }) })
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { container, rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await openPopover(user)
        const popover = container.querySelector('[class*="w-64"]')!
        await user.click(Array.from(popover.querySelectorAll('button')).find((b) => b.textContent?.includes('To Do'))!)
        await user.click(screen.getByText('In Progress'))
        await user.click(screen.getByRole('button', { name: 'Move' }))
        await waitFor(() => expect(screen.getByText(/has reached its limit/)).toBeInTheDocument())
        // Optimistic relocation, then rollback, both at the same version.
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ column: 11 })} />)
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ column: 10 })} />)
        expect(screen.getByText('Move to')).toBeInTheDocument()
        expect(screen.getByText(/has reached its limit/)).toBeInTheDocument()
      })

      it('returns focus to the Move button when the refresh closes the popover', async () => {
        const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { container, rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await openPopover(user)
        const popover = container.querySelector('[class*="w-64"]')!
        ;(popover.querySelector('button') as HTMLButtonElement).focus()
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 2, column: 11 })} />)
        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        expect(screen.getByRole('button', { name: /Move card to different column or swimlane/ })).toHaveFocus()
      })

      const columnFact = () => within(screen.getByRole('list', { name: 'Key facts' })).getByRole('button', { name: /Go to Move/ })

      it('returns focus to the Column fact when the refresh closes a popover it opened (#1916)', async () => {
        const onMoveCard = vi.fn().mockResolvedValue({ ok: true })
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { container, rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await user.click(columnFact())
        const popover = container.querySelector('[class*="w-64"]')!
        ;(popover.querySelector('button') as HTMLButtonElement).focus()
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ version: 2, column: 11 })} />)
        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        expect(columnFact()).toHaveFocus()
      })

      it('Cancel returns focus to the Move button when it opened the popover (#1916)', async () => {
        const board = makeBoardWithTwoCols()
        const user = userEvent.setup()
        render(<CardDetail {...defaultProps()} board={board} onMoveCard={vi.fn()} />)
        await openPopover(user)
        await user.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(screen.queryByText('Move to')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Move card to different column or swimlane/ })).toHaveFocus()
      })

      it('Cancel returns focus to the Column fact when it opened the popover (#1916)', async () => {
        const board = makeBoardWithTwoCols()
        const user = userEvent.setup()
        render(<CardDetail {...defaultProps()} board={board} onMoveCard={vi.fn()} />)
        await user.click(columnFact())
        await user.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(screen.queryByText('Move to')).not.toBeInTheDocument()
        expect(columnFact()).toHaveFocus()
      })

      it('does not close the popover for the optimistic update of its own in-flight move', async () => {
        let resolveMove!: (v: MoveOutcome) => void
        const onMoveCard = vi.fn().mockImplementation(() => new Promise<MoveOutcome>((r) => { resolveMove = r }))
        const board = makeBoardWithTwoCols()
        const props = defaultProps()
        const user = userEvent.setup()
        const { container, rerender } = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} />)
        await openPopover(user)
        const popover = container.querySelector('[class*="w-64"]')!
        await user.click(Array.from(popover.querySelectorAll('button')).find((b) => b.textContent?.includes('To Do'))!)
        await user.click(screen.getByText('In Progress'))
        await user.click(screen.getByRole('button', { name: 'Move' }))
        // useBoard's optimistic update relocates the card while the request is in flight.
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} card={makeCard({ column: 11 })} />)
        expect(screen.getByText('Move to')).toBeInTheDocument()
        await act(async () => { resolveMove({ ok: true }) })
        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
      })
    })

    // The toast's override is outside the panel's focus trap (#1732), so a
    // keyboard user cannot reach it while the panel is open (there is no
    // backdrop since #1914, but the trap stands); the popover offers it itself
    // on a soft-limit refusal.
    describe('admin override in Move popover (#1772)', () => {
      const wipBody = { code: 'wip_limit_exceeded', column_name: 'In Progress', current_count: 3, wip_limit: 3 }
      const hardBody = { code: 'wip_hard_blocked', column_name: 'In Progress', current_count: 3, wip_limit: 3 }
      const weightBody = { code: 'weight_limit_exceeded', column_name: 'In Progress', current_weight: 8, card_weight: 3, weight_limit: 10 }
      const overrideName = 'Move anyway (admin override)'

      type ForceFn = (cardId: number, columnId: number, swimlaneId: number, position: number) => Promise<MoveOutcome>
      const setup = async (opts: {
        moveResult: MoveOutcome
        role?: BoardFull['current_user_role']
        onForceMoveCard?: ForceFn | null
      }) => {
        const board = { ...makeBoardWithTwoCols(), current_user_role: opts.role ?? 'admin' }
        const onMoveCard = vi.fn().mockResolvedValue(opts.moveResult)
        const onForceMoveCard = opts.onForceMoveCard === null ? undefined : (opts.onForceMoveCard ?? vi.fn<ForceFn>().mockResolvedValue({ ok: true }))
        const props = defaultProps()
        const user = userEvent.setup()
        const utils = render(<CardDetail {...props} board={board} onMoveCard={onMoveCard} onForceMoveCard={onForceMoveCard} />)
        await user.click(screen.getByRole('button', { name: /Move card to different column or swimlane/ }))
        const popover = utils.container.querySelector('[class*="w-64"]')!
        await user.click(Array.from(popover.querySelectorAll('button')).find((b) => b.textContent?.includes('To Do'))!)
        await user.click(screen.getByText('In Progress'))
        await user.click(screen.getByRole('button', { name: 'Move' }))
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Card could not be moved/))
        return { ...utils, user, props, board, onMoveCard, onForceMoveCard }
      }

      it('admin + wip_limit_exceeded: shows the numbers and the override, described by the alert', async () => {
        await setup({ moveResult: { ok: false, error: axiosFailure(409, wipBody) } })
        const alert = screen.getByRole('alert')
        expect(alert).toHaveTextContent('Card could not be moved — "In Progress" has reached its limit.')
        expect(alert).toHaveTextContent('Limit 3 cards, 3 active.')
        const override = screen.getByRole('button', { name: overrideName })
        expect(override).toHaveAttribute('aria-describedby', alert.id)
        expect(override).toHaveAttribute('aria-disabled', 'false')
        // The link is an action, not part of the announcement.
        expect(alert).not.toContainElement(override)
        // Nothing is auto-focused when the failure appears.
        expect(override).not.toHaveFocus()
      })

      it('member: shows the numbers but no override', async () => {
        await setup({ moveResult: { ok: false, error: axiosFailure(409, wipBody) }, role: 'member' })
        expect(screen.getByRole('alert')).toHaveTextContent('Limit 3 cards, 3 active.')
        expect(screen.queryByRole('button', { name: overrideName })).not.toBeInTheDocument()
      })

      it('admin + wip_hard_blocked: shows the numbers but no override', async () => {
        await setup({ moveResult: { ok: false, error: axiosFailure(409, hardBody) } })
        expect(screen.getByRole('alert')).toHaveTextContent('Limit 3 cards, 3 active.')
        expect(screen.queryByRole('button', { name: overrideName })).not.toBeInTheDocument()
      })

      // #1150: the row's own limits name the row, and only the soft one
      // offers the override.
      it('admin + swimlane_wip_limit_exceeded: names the swimlane and offers the override', async () => {
        const body = { code: 'swimlane_wip_limit_exceeded', column_name: 'In Progress', swimlane_name: 'Customer A', current_count: 2, wip_limit: 2 }
        await setup({ moveResult: { ok: false, error: axiosFailure(409, body) } })
        const alert = screen.getByRole('alert')
        expect(alert).toHaveTextContent('Card could not be moved — swimlane "Customer A" has reached its limit.')
        expect(alert).toHaveTextContent('Swimlane "Customer A": limit 2 cards, 2 active.')
        expect(screen.getByRole('button', { name: overrideName })).toBeInTheDocument()
      })

      it('admin + swimlane_wip_hard_blocked: no override', async () => {
        const body = { code: 'swimlane_wip_hard_blocked', detail: 'x', column_name: 'In Progress', swimlane_name: 'Customer A', current_count: 1, wip_limit: 1 }
        await setup({ moveResult: { ok: false, error: axiosFailure(409, body) } })
        expect(screen.getByRole('alert')).toHaveTextContent('Swimlane "Customer A": limit 1 card, 1 active.')
        expect(screen.queryByRole('button', { name: overrideName })).not.toBeInTheDocument()
      })

      it('admin + weight_limit_exceeded: shows the weight line and the override', async () => {
        await setup({ moveResult: { ok: false, error: axiosFailure(409, weightBody) }, role: 'site_admin' })
        expect(screen.getByRole('alert')).toHaveTextContent('Weight would reach 11 of 10 (this card +3).')
        expect(screen.getByRole('button', { name: overrideName })).toBeInTheDocument()
      })

      it.each([
        ['a network error', Object.assign(new Error('Network Error'), { isAxiosError: true })],
        ['a 403', axiosFailure(403, { detail: 'no' })],
        ['a version conflict', axiosFailure(409, { code: 'version_conflict', detail: 'stale', current_version: 2 })],
      ])('admin + %s: no override and no numbers', async (_label, error) => {
        await setup({ moveResult: { ok: false, error } })
        const alert = screen.getByRole('alert')
        expect(alert).not.toHaveTextContent(/Limit \d|Weight would reach/)
        expect(screen.queryByRole('button', { name: overrideName })).not.toBeInTheDocument()
      })

      it('shows no override when onForceMoveCard is not provided', async () => {
        await setup({ moveResult: { ok: false, error: axiosFailure(409, wipBody) }, onForceMoveCard: null })
        expect(screen.getByRole('alert')).toHaveTextContent('Limit 3 cards, 3 active.')
        expect(screen.queryByRole('button', { name: overrideName })).not.toBeInTheDocument()
      })

      it('calls onForceMoveCard once with the popover target and locks the popover while in flight', async () => {
        let resolveForce!: (v: MoveOutcome) => void
        const onForceMoveCard = vi.fn<ForceFn>().mockImplementation(() => new Promise<MoveOutcome>((r) => { resolveForce = r }))
        const { user, props } = await setup({ moveResult: { ok: false, error: axiosFailure(409, wipBody) }, onForceMoveCard })
        await user.click(screen.getByRole('button', { name: overrideName }))
        expect(onForceMoveCard).toHaveBeenCalledTimes(1)
        expect(onForceMoveCard).toHaveBeenCalledWith(1, 11, 20, 9999)
        const pending = screen.getByRole('button', { name: 'Moving anyway…' })
        expect(pending).toHaveAttribute('aria-disabled', 'true')
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled()
        // Both target dropdowns are locked too: the target is in flight.
        const popover = document.querySelector('[class*="w-64"]')!
        const triggers = Array.from(popover.querySelectorAll('button'))
        expect(triggers.find((b) => b.textContent?.includes('Customer A'))).toBeDisabled()
        expect(triggers.find((b) => b.textContent?.includes('In Progress'))).toBeDisabled()
        // A second activation while in flight is ignored.
        await user.click(pending)
        expect(onForceMoveCard).toHaveBeenCalledTimes(1)
        // Escape is swallowed: closing would hide the outcome, and the panel stays open.
        await user.keyboard('{Escape}')
        expect(screen.getByText('Move to')).toBeInTheDocument()
        expect(props.onClose).not.toHaveBeenCalled()
        // The header Move trigger cannot toggle the popover closed either.
        await user.click(screen.getByRole('button', { name: /Move card to different column or swimlane/ }))
        expect(screen.getByRole('button', { name: 'Moving anyway…' })).toBeInTheDocument()
        await act(async () => { resolveForce({ ok: true }) })
      })

      it('on success closes the popover silently, shows the target column and focuses the Move trigger', async () => {
        await setup({ moveResult: { ok: false, error: axiosFailure(409, wipBody) } })
        await userEvent.setup().click(screen.getByRole('button', { name: overrideName }))
        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        expect(screen.getByTitle('In Progress')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Move card to different column or swimlane/ })).toHaveFocus()
        expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
      })

      it('on success returns focus to the Column fact when it opened the popover (#1916)', async () => {
        const board = { ...makeBoardWithTwoCols(), current_user_role: 'admin' as const }
        const onMoveCard = vi.fn().mockResolvedValue({ ok: false, error: axiosFailure(409, wipBody) })
        const onForceMoveCard = vi.fn<ForceFn>().mockResolvedValue({ ok: true })
        const user = userEvent.setup()
        const { container } = render(<CardDetail {...defaultProps()} board={board} onMoveCard={onMoveCard} onForceMoveCard={onForceMoveCard} />)
        await user.click(within(screen.getByRole('list', { name: 'Key facts' })).getByRole('button', { name: /Go to Move/ }))
        const popover = container.querySelector('[class*="w-64"]')!
        await user.click(Array.from(popover.querySelectorAll('button')).find((b) => b.textContent?.includes('To Do'))!)
        await user.click(screen.getByText('In Progress'))
        await user.click(screen.getByRole('button', { name: 'Move' }))
        await user.click(await screen.findByRole('button', { name: overrideName }))
        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        expect(within(screen.getByRole('list', { name: 'Key facts' })).getByRole('button', { name: /Go to Move/ })).toHaveFocus()
      })

      it('stays silent when the forced move bumps the live card version mid-flight', async () => {
        let resolveForce!: (v: MoveOutcome) => void
        const onForceMoveCard = vi.fn<ForceFn>().mockImplementation(() => new Promise<MoveOutcome>((r) => { resolveForce = r }))
        const { user, props, board, onMoveCard, rerender } = await setup({ moveResult: { ok: false, error: axiosFailure(409, wipBody) }, onForceMoveCard })
        await user.click(screen.getByRole('button', { name: overrideName }))
        // useBoard writes the server's card (new version, target location) before the promise settles.
        rerender(<CardDetail {...props} board={board} onMoveCard={onMoveCard} onForceMoveCard={onForceMoveCard} card={makeCard({ version: 2, column: 11, swimlane: 20 })} />)
        expect(screen.getByText('Move to')).toBeInTheDocument()
        await act(async () => { resolveForce({ ok: true }) })
        await waitFor(() => expect(screen.queryByText('Move to')).not.toBeInTheDocument())
        expect(screen.getByTestId('move-notice')).toBeEmptyDOMElement()
        expect(screen.getByTitle('In Progress')).toBeInTheDocument()
      })

      it('on failure names the cause inline, drops the override and focuses the popover Move button', async () => {
        const onForceMoveCard = vi.fn<ForceFn>().mockResolvedValue({ ok: false, error: Object.assign(new Error('Network Error'), { isAxiosError: true }) })
        const { user } = await setup({ moveResult: { ok: false, error: axiosFailure(409, wipBody) }, onForceMoveCard })
        await user.click(screen.getByRole('button', { name: overrideName }))
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Card could not be moved — a network error occurred.'))
        expect(screen.getByRole('alert')).not.toHaveTextContent('Limit 3 cards')
        expect(screen.queryByRole('button', { name: overrideName })).not.toBeInTheDocument()
        expect(screen.getByText('Move to')).toBeInTheDocument()
        await waitFor(() => expect(screen.getByRole('button', { name: 'Move' })).toHaveFocus())
      })

      it('on a hard-block refusal of the forced move drops the override and focuses the popover Move button', async () => {
        const onForceMoveCard = vi.fn<ForceFn>().mockResolvedValue({ ok: false, error: axiosFailure(409, hardBody) })
        const { user } = await setup({ moveResult: { ok: false, error: axiosFailure(409, wipBody) }, onForceMoveCard })
        await user.click(screen.getByRole('button', { name: overrideName }))
        await waitFor(() => expect(screen.queryByRole('button', { name: /Move anyway|Moving anyway/ })).not.toBeInTheDocument())
        expect(screen.getByRole('alert')).toHaveTextContent('Card could not be moved — "In Progress" has reached its limit.')
        expect(screen.getByRole('alert')).toHaveTextContent('Limit 3 cards, 3 active.')
        await waitFor(() => expect(screen.getByRole('button', { name: 'Move' })).toHaveFocus())
      })

      it('on a soft-limit refusal of the forced move keeps the override and its focus', async () => {
        const onForceMoveCard = vi.fn<ForceFn>().mockResolvedValue({ ok: false, error: axiosFailure(409, weightBody) })
        const { user } = await setup({ moveResult: { ok: false, error: axiosFailure(409, wipBody) }, onForceMoveCard })
        await user.click(screen.getByRole('button', { name: overrideName }))
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Weight would reach 11 of 10 (this card +3).'))
        const override = screen.getByRole('button', { name: overrideName })
        expect(override).toHaveAttribute('aria-disabled', 'false')
        expect(override).toHaveFocus()
        expect(screen.getByRole('button', { name: 'Move' })).not.toHaveFocus()
      })

      it('shows the cause and focuses the popover Move button when onForceMoveCard rejects (defensive path)', async () => {
        const onForceMoveCard = vi.fn<ForceFn>().mockRejectedValue(new Error('boom'))
        const { user } = await setup({ moveResult: { ok: false, error: axiosFailure(409, wipBody) }, onForceMoveCard })
        await user.click(screen.getByRole('button', { name: overrideName }))
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Card could not be moved — a network error occurred.'))
        expect(screen.queryByRole('button', { name: overrideName })).not.toBeInTheDocument()
        expect(screen.getByText('Move to')).toBeInTheDocument()
        await waitFor(() => expect(screen.getByRole('button', { name: 'Move' })).toHaveFocus())
      })

      it('changing the Column after a failure clears the message, the numbers and the override', async () => {
        const { user, container } = await setup({ moveResult: { ok: false, error: axiosFailure(409, wipBody) } })
        expect(screen.getByRole('button', { name: overrideName })).toBeInTheDocument()
        const popover = container.querySelector('[class*="w-64"]')!
        const colTrigger = Array.from(popover.querySelectorAll('button')).find((b) => b.textContent?.includes('In Progress'))!
        await user.click(colTrigger)
        await user.click(screen.getByRole('option', { name: 'To Do' }))
        expect(screen.getByRole('alert')).toBeEmptyDOMElement()
        expect(screen.queryByRole('button', { name: overrideName })).not.toBeInTheDocument()
      })

      it('changing the Swimlane after a failure clears them too', async () => {
        const { user, container } = await setup({ moveResult: { ok: false, error: axiosFailure(409, weightBody) } })
        expect(screen.getByRole('button', { name: overrideName })).toBeInTheDocument()
        const popover = container.querySelector('[class*="w-64"]')!
        const laneTrigger = Array.from(popover.querySelectorAll('button')).find((b) => b.textContent?.includes('Customer A'))!
        await user.click(laneTrigger)
        await user.click(screen.getByRole('option', { name: 'Customer B' }))
        expect(screen.getByRole('alert')).toBeEmptyDOMElement()
        expect(screen.queryByRole('button', { name: overrideName })).not.toBeInTheDocument()
      })
    })

    describe('first-encounter dot', () => {
      it('shows dot when move-to-seen is absent from localStorage', () => {
        const onMoveCard = vi.fn().mockResolvedValue(undefined)
        render(<CardDetail {...defaultProps()} board={makeBoardWithTwoCols()} onMoveCard={onMoveCard} />)
        // Dot is aria-hidden and has no text — find by its unique class combination
        const wrapper = document.querySelector('.relative.shrink-0')
        expect(wrapper?.querySelector('.bg-primary-emphasis.rounded-full')).toBeInTheDocument()
      })

      it('dot disappears after the move button is clicked for the first time', async () => {
        const onMoveCard = vi.fn().mockResolvedValue(undefined)
        render(<CardDetail {...defaultProps()} board={makeBoardWithTwoCols()} onMoveCard={onMoveCard} />)
        await userEvent.setup().click(screen.getByRole('button', { name: /Move card to different column or swimlane/ }))
        const wrapper = document.querySelector('.relative.shrink-0')
        expect(wrapper?.querySelector('.bg-primary-emphasis.rounded-full')).not.toBeInTheDocument()
      })

      it('dot is absent when move-to-seen is already true in localStorage', () => {
        localStorage.setItem('user:prefs:move-to-seen', 'true')
        const onMoveCard = vi.fn().mockResolvedValue(undefined)
        render(<CardDetail {...defaultProps()} board={makeBoardWithTwoCols()} onMoveCard={onMoveCard} />)
        const wrapper = document.querySelector('.relative.shrink-0')
        expect(wrapper?.querySelector('.bg-primary-emphasis.rounded-full')).not.toBeInTheDocument()
      })
    })
  })
  describe('save() error surfacing', () => {
    it('handles 403 save failure without crashing', async () => {
      const { updateCard } = await import('../api/cards')
      const mockUC = updateCard as ReturnType<typeof vi.fn>
      const err = Object.assign(new Error('Forbidden'), {
        response: { data: { detail: 'Assigning cards requires Moderator or Admin access — ask a board admin.' } },
      })
      mockUC.mockRejectedValueOnce(err)
      render(<CardDetail {...defaultProps()} />)
      const titleInput = screen.getByDisplayValue('Test Card')
      fireEvent.change(titleInput, { target: { value: 'Changed title' } })
      fireEvent.blur(titleInput)
      await waitFor(() => {
        expect(mockUC).toHaveBeenCalledWith(expect.anything(), expect.anything(), { title: 'Changed title' })
      })
    })

    it('handles generic save failure without crashing', async () => {
      const { updateCard } = await import('../api/cards')
      const mockUC = updateCard as ReturnType<typeof vi.fn>
      mockUC.mockRejectedValueOnce(new Error('Network error'))
      render(<CardDetail {...defaultProps()} />)
      const titleInput = screen.getByDisplayValue('Test Card')
      fireEvent.change(titleInput, { target: { value: 'Changed title' } })
      fireEvent.blur(titleInput)
      await waitFor(() => {
        expect(mockUC).toHaveBeenCalledWith(expect.anything(), expect.anything(), { title: 'Changed title' })
      })
    })
  })

  describe('assignee SelectDropdown disabled state', () => {
    it('assignee dropdown is enabled for card owner (member who created the card)', () => {
      const props = defaultProps()
      props.board = makeBoard({
        current_user_role: 'member',
        custom_field_definitions: [],
        swimlane_custom_field_definitions: [],
        members: [{ id: 1, user: fakeUser, role: 'member', is_moderator: false, joined_at: '' }],
      })
      props.card = makeCard({ created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" } }) // fakeUser is the creator
      render(<CardDetail {...props} currentUser={fakeUser} />)
      const trigger = screen.getByRole('combobox')
      expect(trigger).not.toBeDisabled()
    })

    it('assignee dropdown is disabled for non-owner member without moderator flag', () => {
      const otherUser: User = { ...fakeUser, id: 99, username: 'plain_member' }
      const props = defaultProps()
      props.board = makeBoard({
        current_user_role: 'member',
        custom_field_definitions: [],
        swimlane_custom_field_definitions: [],
        members: [{ id: 2, user: otherUser, role: 'member', is_moderator: false, joined_at: '' }],
      })
      props.card = makeCard({ created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" } }) // owned by fakeUser (id 1), not otherUser (id 99)
      render(<CardDetail {...props} currentUser={otherUser} />)
      const trigger = screen.getByRole('combobox')
      expect(trigger).toBeDisabled()
    })

    it('assignee dropdown is enabled for a moderator who does not own the card', () => {
      const modUser: User = { ...fakeUser, id: 99, username: 'mod_member' }
      const props = defaultProps()
      props.board = makeBoard({
        current_user_role: 'member',
        custom_field_definitions: [],
        swimlane_custom_field_definitions: [],
        members: [{ id: 2, user: modUser, role: 'member', is_moderator: true, joined_at: '' }],
      })
      props.card = makeCard({ created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" } }) // owned by fakeUser, not modUser
      render(<CardDetail {...props} currentUser={modUser} />)
      const trigger = screen.getByRole('combobox')
      expect(trigger).not.toBeDisabled()
    })

    it('assignee dropdown is enabled for an admin regardless of ownership', () => {
      const props = defaultProps() // board.current_user_role defaults to 'admin'
      props.card = makeCard({ created_by: { id: 99, username: "other", display_name: "Other", avatar_url: "" } }) // owned by someone else
      render(<CardDetail {...props} currentUser={fakeUser} />)
      const trigger = screen.getByRole('combobox')
      expect(trigger).not.toBeDisabled()
    })
  })

})

describe('CardDetail — MR/PR link section (#352)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateCard.mockImplementation((_boardId: number, _cardId: number, patch: Record<string, unknown>) =>
      Promise.resolve({ ...makeCard(), ...patch })
    )
  })

  it('saves a pasted link through updateCard as a full external_ref object', async () => {
    const props = defaultProps()
    render(<CardDetail {...props} />)
    await userEvent.click(screen.getByRole('button', { name: '+ Link a pull or merge request' }))
    await userEvent.click(screen.getByLabelText('URL'))
    await userEvent.paste('https://github.com/acme/web/pull/12')
    await userEvent.click(screen.getByRole('button', { name: 'Save link' }))
    const ref = { provider: 'github', ref: 'acme/web#12', url: 'https://github.com/acme/web/pull/12' }
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledWith(1, 1, { external_ref: ref }))
    expect(props.onUpdated).toHaveBeenCalledWith(expect.objectContaining({ external_ref: ref }))
    expect(await screen.findByRole('link', { name: 'acme/web#12, opens in new tab' })).toBeInTheDocument()
  })

  it('hides the section from a viewer when the card has no link', () => {
    const props = defaultProps()
    props.board = makeBoard({ current_user_role: 'viewer' })
    render(<CardDetail {...props} />)
    expect(screen.queryByText('Pull / merge request')).not.toBeInTheDocument()
  })
})

describe('CardDetail — custom fields (#371, #1236)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateCard.mockImplementation((_boardId: number, _cardId: number, patch: Record<string, unknown>) =>
      Promise.resolve({ ...makeCard(), ...patch })
    )
  })

  const statusField = {
    id: 500, uid: 'cfduid00001', name: 'Status', field_type: 'dropdown' as const,
    choices: ['Red', 'Green', 'Blue'], position: 0, show_on_card: false,
    is_required: false, help_text: '', number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {}, created_at: '2026-01-01T00:00:00Z',
  }

  // #1236 — CustomFieldEditRow wraps CustomFieldValueInput with no
  // `debounceMs` override, so it relies on the 600ms default (an autosave
  // surface, not a Save-button one). Dropdown commits immediately regardless
  // of debounce, so this exercises the row → onSave → updateCard wiring
  // without needing fake timers.
  it('committing a dropdown custom field value reaches updateCard via onSave', async () => {
    const props = defaultProps()
    props.board = makeBoard({ custom_field_definitions: [statusField] })
    render(<CardDetail {...props} />)

    await userEvent.click(screen.getByRole('button', { name: /Custom fields/ }))
    await userEvent.click(screen.getByRole('button', { name: /— No value —/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Green' }))

    await waitFor(() => {
      expect(mockUpdateCard).toHaveBeenCalledWith(1, 1, {
        custom_field_values: [{ field_definition: 500, value: 'Green' }],
      })
    })
  })

  it('does not render the custom fields section when the board has no definitions', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.queryByText('Custom fields')).not.toBeInTheDocument()
  })

  describe('async delete/archive handlers: in-flight guard + failure path (#1437)', () => {
    const deferred = () => {
      let resolve!: () => void
      const promise = new Promise<void>((r) => { resolve = r })
      return { promise, resolve }
    }

    it('checklist item delete: double-click sends one DELETE', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 1, text: 'Item 1', is_checked: false, position: 0 },
      ])
      const d = deferred()
      mockDeleteChecklistItem.mockImplementationOnce(() => d.promise)
      const props = defaultProps()
      render(<CardDetail {...props} />)
      await waitFor(() => expect(screen.getByText('Item 1')).toBeInTheDocument())
      const btn = screen.getByTitle('Remove item')
      fireEvent.click(btn)
      fireEvent.click(btn)
      expect(mockDeleteChecklistItem).toHaveBeenCalledTimes(1)
      d.resolve()
      await waitFor(() => expect(screen.queryByText('Item 1')).not.toBeInTheDocument())
    })

    it('checklist item delete: a rejection shows an error, keeps the item, and allows retry', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 1, text: 'Item 1', is_checked: false, position: 0 },
      ])
      mockDeleteChecklistItem.mockRejectedValueOnce(new Error('boom'))
      const props = defaultProps()
      render(<CardDetail {...props} />)
      await waitFor(() => expect(screen.getByText('Item 1')).toBeInTheDocument())
      fireEvent.click(screen.getByTitle('Remove item'))
      expect(await screen.findByText('Could not delete item.')).toBeInTheDocument()
      expect(screen.getByText('Item 1')).toBeInTheDocument()
      expect(props.onUpdated).not.toHaveBeenCalled()
      mockDeleteChecklistItem.mockResolvedValueOnce(undefined)
      fireEvent.click(screen.getByTitle('Remove item'))
      await waitFor(() => expect(screen.queryByText('Item 1')).not.toBeInTheDocument())
      expect(screen.queryByText('Could not delete item.')).not.toBeInTheDocument()
    })

    const attachment = { id: 7, filename: 'spec.pdf', size: 10, url: '/f/7', uploaded_by: fakeUser, uploaded_at: '2026-01-01' }

    it('attachment delete: double-click sends one DELETE', async () => {
      const { deleteCardAttachment } = await import('../api/cards')
      const mockDel = deleteCardAttachment as ReturnType<typeof vi.fn>
      ;(getCardAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([attachment])
      const d = deferred()
      mockDel.mockImplementationOnce(() => d.promise)
      render(<CardDetail {...defaultProps()} currentUser={fakeUser} />)
      const btn = await screen.findByRole('button', { name: 'Delete attachment spec.pdf' })
      fireEvent.click(btn)
      fireEvent.click(btn)
      expect(mockDel).toHaveBeenCalledTimes(1)
      d.resolve()
      await waitFor(() => expect(screen.queryByText('spec.pdf')).not.toBeInTheDocument())
    })

    it('attachment delete: a rejection shows an error and allows retry', async () => {
      const { deleteCardAttachment } = await import('../api/cards')
      const mockDel = deleteCardAttachment as ReturnType<typeof vi.fn>
      ;(getCardAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([attachment])
      mockDel.mockRejectedValueOnce(new Error('boom'))
      render(<CardDetail {...defaultProps()} currentUser={fakeUser} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Delete attachment spec.pdf' }))
      expect(await screen.findByText('Could not delete attachment.')).toBeInTheDocument()
      mockDel.mockResolvedValueOnce(undefined)
      fireEvent.click(screen.getByRole('button', { name: 'Delete attachment spec.pdf' }))
      await waitFor(() => expect(mockDel).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(screen.queryByText('spec.pdf')).not.toBeInTheDocument())
    })

    it('card delete: modal stays open and disabled in flight, double-click sends one DELETE', async () => {
      const { deleteCard } = await import('../api/cards')
      const mockDel = deleteCard as ReturnType<typeof vi.fn>
      const d = deferred()
      mockDel.mockImplementationOnce(() => d.promise)
      const props = defaultProps()
      render(<CardDetail {...props} />)
      fireEvent.click(screen.getByText('Delete card'))
      const confirm = screen.getByRole('button', { name: 'Delete' })
      fireEvent.click(confirm)
      fireEvent.click(confirm)
      expect(mockDel).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('button', { name: 'Deleting…' })).toHaveAttribute('aria-disabled', 'true')
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
      expect(props.onDeleted).not.toHaveBeenCalled()
      d.resolve()
      await waitFor(() => expect(props.onDeleted).toHaveBeenCalledWith(props.card.id))
      expect(screen.queryByText('Delete this card?')).not.toBeInTheDocument()
    })

    it('card delete: a rejection keeps the modal open with an error, re-enables buttons, and allows retry', async () => {
      const { deleteCard } = await import('../api/cards')
      const mockDel = deleteCard as ReturnType<typeof vi.fn>
      mockDel.mockRejectedValueOnce(new Error('boom'))
      const props = defaultProps()
      render(<CardDetail {...props} />)
      fireEvent.click(screen.getByText('Delete card'))
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Delete' }))
      const err = await screen.findByText('Could not delete card.')
      // Focus stays on the actionable primary button (never dropped to body) after a failure.
      expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus()
      expect(err.closest('[role="status"]')).not.toBeNull()
      expect(screen.getByText('Delete this card?')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
      expect(props.onDeleted).not.toHaveBeenCalled()
      mockDel.mockResolvedValueOnce(undefined)
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(props.onDeleted).toHaveBeenCalledTimes(1))
    })

    it('card archive: double-click sends one request and closes only on success', async () => {
      const { archiveCard } = await import('../api/cards')
      const mockArch = archiveCard as ReturnType<typeof vi.fn>
      const d = deferred()
      mockArch.mockImplementationOnce(() => d.promise)
      const props = defaultProps()
      render(<CardDetail {...props} />)
      await waitForSheetLoaded()
      fireEvent.click(screen.getByText('Archive card'))
      const confirm = screen.getByRole('button', { name: 'Archive' })
      fireEvent.click(confirm)
      fireEvent.click(confirm)
      expect(mockArch).toHaveBeenCalledTimes(1)
      expect(props.onArchived).not.toHaveBeenCalled()
      d.resolve()
      await waitFor(() => expect(props.onArchived).toHaveBeenCalledWith(props.card.id))
      expect(props.onClose).toHaveBeenCalledTimes(1)
    })

    it('card archive: Escape is swallowed while the request is in flight', async () => {
      const { archiveCard } = await import('../api/cards')
      const d = deferred()
      ;(archiveCard as ReturnType<typeof vi.fn>).mockImplementationOnce(() => d.promise)
      const props = defaultProps()
      render(<CardDetail {...props} />)
      await waitForSheetLoaded()
      fireEvent.click(screen.getByText('Archive card'))
      fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.getByText('Archive this card?')).toBeInTheDocument()
      expect(props.onClose).not.toHaveBeenCalled()
      d.resolve()
      await waitFor(() => expect(props.onArchived).toHaveBeenCalledTimes(1))
    })

    it('checklist and attachment error slots are always-mounted polite live regions', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 1, text: 'Item 1', is_checked: false, position: 0 },
      ])
      mockDeleteChecklistItem.mockRejectedValueOnce(new Error('boom'))
      render(<CardDetail {...defaultProps()} />)
      await waitFor(() => expect(screen.getByText('Item 1')).toBeInTheDocument())
      fireEvent.click(screen.getByTitle('Remove item'))
      const err = await screen.findByText('Could not delete item.')
      const region = err.closest('[aria-live]')
      expect(region).toHaveAttribute('role', 'status')
      expect(region).toHaveAttribute('aria-live', 'polite')
      expect(region).toHaveAttribute('aria-atomic', 'true')
    })

    it('attachment delete error sits inside an always-mounted polite live region', async () => {
      const { deleteCardAttachment } = await import('../api/cards')
      ;(getCardAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([attachment])
      ;(deleteCardAttachment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
      render(<CardDetail {...defaultProps()} currentUser={fakeUser} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Delete attachment spec.pdf' }))
      const err = await screen.findByText('Could not delete attachment.')
      const region = err.closest('[aria-live]')
      expect(region).toHaveAttribute('role', 'status')
      expect(region).toHaveAttribute('aria-live', 'polite')
      expect(region).toHaveAttribute('aria-atomic', 'true')
    })

    it('card archive: a rejection keeps the modal open with an error and Cancel clears it', async () => {
      const { archiveCard } = await import('../api/cards')
      const mockArch = archiveCard as ReturnType<typeof vi.fn>
      mockArch.mockRejectedValueOnce(new Error('boom'))
      const props = defaultProps()
      render(<CardDetail {...props} />)
      await waitForSheetLoaded()
      fireEvent.click(screen.getByText('Archive card'))
      fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
      expect(await screen.findByText('Could not archive card.')).toBeInTheDocument()
      expect(screen.getByText('Archive this card?')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Archive' })).toBeEnabled()
      expect(props.onArchived).not.toHaveBeenCalled()
      expect(props.onClose).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByText('Archive this card?')).not.toBeInTheDocument()
      // Reopening starts clean.
      fireEvent.click(screen.getByText('Archive card'))
      expect(screen.queryByText('Could not archive card.')).not.toBeInTheDocument()
    })
  })

  describe('comment submit, checklist toggle and file upload: in-flight guard + failure path (#1498)', () => {
    const deferred = <T,>() => {
      let resolve!: (v: T) => void
      let reject!: (e: unknown) => void
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
      return { promise, resolve, reject }
    }
    const item = { id: 1, text: 'Item 1', is_checked: false, position: 0 }

    it('comment submit: double-click posts once', async () => {
    rememberCardDetailTab('comments')
      const d = deferred<unknown>()
      ;(addCardComment as ReturnType<typeof vi.fn>).mockImplementationOnce(() => d.promise)
      render(<CardDetail {...defaultProps()} />)
      fireEvent.change(screen.getByTestId('mention-textarea'), { target: { value: 'hello' } })
      const btn = screen.getByRole('button', { name: 'Comment' })
      fireEvent.click(btn)
      fireEvent.click(btn)
      expect(addCardComment).toHaveBeenCalledTimes(1)
      d.resolve({ id: 9, body: 'hello', author: fakeUser, created_at: '2026-01-01', updated_at: '2026-01-01' })
      await waitFor(() => expect(screen.getByTestId('mention-textarea')).toHaveValue(''))
    })

    it('comment submit: a rejection shows an error in a live region, keeps the text, and allows retry', async () => {
    rememberCardDetailTab('comments')
      ;(addCardComment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
      render(<CardDetail {...defaultProps()} />)
      fireEvent.change(screen.getByTestId('mention-textarea'), { target: { value: 'hello' } })
      fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
      const err = await screen.findByText('Could not post comment.')
      expect(err.closest('[aria-live]')).toHaveAttribute('role', 'status')
      expect(screen.getByTestId('mention-textarea')).toHaveValue('hello')
      ;(addCardComment as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 9, body: 'hello', author: fakeUser, created_at: '2026-01-01', updated_at: '2026-01-01' })
      fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
      await waitFor(() => expect(screen.queryByText('Could not post comment.')).not.toBeInTheDocument())
      expect(addCardComment).toHaveBeenCalledTimes(2)
    })

    it('checklist toggle: double-click sends one PATCH', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([item])
      const d = deferred<unknown>()
      mockUpdateChecklistItem.mockImplementationOnce(() => d.promise)
      render(<CardDetail {...defaultProps()} />)
      await waitFor(() => expect(screen.getByText('Item 1')).toBeInTheDocument())
      const box = screen.getAllByRole('checkbox')[0]
      fireEvent.click(box)
      fireEvent.click(box)
      expect(mockUpdateChecklistItem).toHaveBeenCalledTimes(1)
      d.resolve({ ...item, is_checked: true })
      await waitFor(() => expect(screen.getAllByRole('checkbox')[0]).toBeChecked())
    })

    it('checklist toggle: a rejection shows an error and leaves the item unchecked', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([item])
      mockUpdateChecklistItem.mockRejectedValueOnce(new Error('boom'))
      const props = defaultProps()
      render(<CardDetail {...props} />)
      await waitFor(() => expect(screen.getByText('Item 1')).toBeInTheDocument())
      fireEvent.click(screen.getAllByRole('checkbox')[0])
      const err = await screen.findByText('Could not update item.')
      expect(err.closest('[aria-live]')).toHaveAttribute('role', 'status')
      expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked()
      expect(props.onUpdated).not.toHaveBeenCalled()
    })

    const pick = (container: HTMLElement) => {
      const input = container.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File(['x'], 'a.txt', { type: 'text/plain' })
      return { input, file }
    }
    const uploaded = { id: 7, filename: 'a.txt', size: 1, url: '/f/7', uploaded_by: fakeUser, uploaded_at: '2026-01-01' }

    it('file upload: a second change event while the first is pending uploads once', async () => {
      const { uploadCardAttachment } = await import('../api/cards')
      const mockUp = uploadCardAttachment as ReturnType<typeof vi.fn>
      const d = deferred<unknown>()
      mockUp.mockImplementationOnce(() => d.promise)
      const { container } = render(<CardDetail {...defaultProps()} />)
      const { input, file } = pick(container)
      // One act(): both events land before React re-renders, so only the ref
      // (not `uploading` state) can stop the second upload.
      act(() => {
        fireEvent.change(input, { target: { files: [file] } })
        fireEvent.change(input, { target: { files: [file] } })
      })
      expect(mockUp).toHaveBeenCalledTimes(1)
      d.resolve(uploaded)
      await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    })

    it('file upload: a rejection shows an error in the attachment live region and allows retry', async () => {
      const { uploadCardAttachment } = await import('../api/cards')
      const mockUp = uploadCardAttachment as ReturnType<typeof vi.fn>
      mockUp.mockRejectedValueOnce(new Error('boom'))
      const props = defaultProps()
      const { container } = render(<CardDetail {...props} />)
      const { input, file } = pick(container)
      fireEvent.change(input, { target: { files: [file] } })
      const err = await screen.findByText('Could not upload attachment.')
      expect(err.closest('[aria-live]')).toHaveAttribute('role', 'status')
      expect(props.onUpdated).not.toHaveBeenCalled()
      mockUp.mockResolvedValueOnce(uploaded)
      fireEvent.change(input, { target: { files: [file] } })
      await waitFor(() => expect(screen.queryByText('Could not upload attachment.')).not.toBeInTheDocument())
      expect(mockUp).toHaveBeenCalledTimes(2)
    })
  })

  describe('checklist add, bulk add and label create: re-entry guard (#1498)', () => {
    it('checklist add: Enter twice in one tick posts once', async () => {
      let resolve!: (v: unknown) => void
      mockAddChecklistItem.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
      render(<CardDetail {...defaultProps()} />)
      const input = screen.getByPlaceholderText('Add item (Enter)…')
      fireEvent.change(input, { target: { value: 'New task' } })
      act(() => {
        fireEvent.keyDown(input, { key: 'Enter' })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      expect(mockAddChecklistItem).toHaveBeenCalledTimes(1)
      resolve({ id: 5, text: 'New task', is_checked: false, position: 0 })
      await waitFor(() => expect(screen.getByText('New task')).toBeInTheDocument())
    })

    it('bulk add: double click on Add items posts each line once', async () => {
      let resolve!: (v: unknown) => void
      mockAddChecklistItem.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
      mockAddChecklistItem.mockResolvedValueOnce({ id: 6, text: 'Two', is_checked: false, position: 1 })
      render(<CardDetail {...defaultProps()} />)
      fireEvent.click(screen.getByText('Bulk'))
      fireEvent.change(screen.getByPlaceholderText(/Buy milk/), { target: { value: 'One\nTwo' } })
      const btn = screen.getByRole('button', { name: 'Add items' })
      act(() => {
        fireEvent.click(btn)
        fireEvent.click(btn)
      })
      expect(mockAddChecklistItem).toHaveBeenCalledTimes(1)
      resolve({ id: 5, text: 'One', is_checked: false, position: 0 })
      await waitFor(() => expect(mockAddChecklistItem).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(screen.queryByText('Add checklist items')).not.toBeInTheDocument())
    })

    it('label create: Enter twice in one tick creates one label', async () => {
      const { createLabel } = await import('../api/boards')
      const mockCreate = createLabel as ReturnType<typeof vi.fn>
      let resolve!: (v: unknown) => void
      mockCreate.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
      mockUpdateCard.mockResolvedValue({ ...defaultProps().card })
      render(<CardDetail {...defaultProps()} />)
      fireEvent.click(screen.getByText('+ New label'))
      const input = screen.getByPlaceholderText('Label name')
      fireEvent.change(input, { target: { value: 'Urgent' } })
      act(() => {
        fireEvent.keyDown(input, { key: 'Enter' })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      expect(mockCreate).toHaveBeenCalledTimes(1)
      resolve({ id: 99, name: 'Urgent', color: '#ff0000' })
      await waitFor(() => expect(screen.queryByPlaceholderText('Label name')).not.toBeInTheDocument())
    })

    it('label swatch: with a name typed, clicking a swatch creates the label with that color (#1893)', async () => {
      const { createLabel } = await import('../api/boards')
      const mockCreate = createLabel as ReturnType<typeof vi.fn>
      mockCreate.mockResolvedValueOnce({ id: 99, name: 'Urgent', color: '#3B82F6' })
      mockUpdateCard.mockResolvedValue({ ...defaultProps().card })
      render(<CardDetail {...defaultProps()} />)
      fireEvent.click(screen.getByText('+ New label'))
      expect(screen.getByRole('group', { name: 'Label color' })).toBeInTheDocument()
      fireEvent.change(screen.getByPlaceholderText('Label name'), { target: { value: 'Urgent' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create "Urgent" with color Blue' }))
      await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
      expect(mockCreate.mock.calls[0][1]).toEqual({ name: 'Urgent', color: '#3B82F6' })
    })

    it('label swatch: with no name typed, clicking a swatch selects it and creates nothing (#1893)', async () => {
      const { createLabel } = await import('../api/boards')
      const mockCreate = createLabel as ReturnType<typeof vi.fn>
      mockCreate.mockClear()
      render(<CardDetail {...defaultProps()} />)
      fireEvent.click(screen.getByText('+ New label'))
      const green = screen.getByRole('button', { name: 'Select color Green' })
      expect(green).toHaveAttribute('aria-pressed', 'false')
      fireEvent.click(green)
      expect(mockCreate).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Select color Green' })).toHaveAttribute('aria-pressed', 'true')
    })

    it('label create: a rejection shows the error in a live region and allows retry', async () => {
      const { createLabel } = await import('../api/boards')
      const mockCreate = createLabel as ReturnType<typeof vi.fn>
      mockCreate.mockRejectedValueOnce(new Error('403'))
      render(<CardDetail {...defaultProps()} />)
      fireEvent.click(screen.getByText('+ New label'))
      const input = screen.getByPlaceholderText('Label name')
      fireEvent.change(input, { target: { value: 'Urgent' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      const err = await screen.findByText(/Failed to create label/)
      expect(err.closest('[aria-live]')).toHaveAttribute('role', 'status')
      mockCreate.mockRejectedValueOnce(new Error('403'))
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(2))
    })
  })
})

describe('CardDetail focus trap (#1732)', () => {
  it('panel is an aria-modal dialog and Tab wraps inside it', () => {
    render(<CardDetail {...defaultProps()} />)
    const panel = screen.getByRole('dialog', { name: /./ })
    expect(panel).toHaveAttribute('aria-modal', 'true')
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href]'))
    const last = focusables[focusables.length - 1]
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(panel.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(focusables[0])
  })

  it('restores focus to the opener when the panel closes', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const { unmount } = render(<CardDetail {...defaultProps()} />)
    expect(opener).not.toHaveFocus()
    unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })

  it('bulk-add overlay is a labelled modal dialog, traps Tab, and returns focus to Bulk on close', async () => {
    const user = userEvent.setup()
    render(<CardDetail {...defaultProps()} />)
    const bulk = screen.getByText('Bulk')
    bulk.focus()
    await user.click(bulk)
    const overlay = screen.getByRole('dialog', { name: 'Add checklist items' })
    expect(overlay).toHaveAttribute('aria-modal', 'true')
    const buttons = overlay.querySelectorAll<HTMLElement>('button')
    const focusables = overlay.querySelectorAll<HTMLElement>('button, textarea')
    buttons[buttons.length - 1].focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    // fireEvent does not move focus itself, so this only holds if the trap wrapped it.
    expect(document.activeElement).toBe(focusables[0])
    await user.keyboard('{Escape}')
    expect(screen.queryByText('Add checklist items')).not.toBeInTheDocument()
    expect(bulk).toHaveFocus()
  })

  it('keyboard users can reach the Move popover from the trapped panel', async () => {
    const user = userEvent.setup()
    render(<CardDetail {...defaultProps()} onMoveCard={vi.fn().mockResolvedValue(undefined)} />)
    const trigger = screen.getByRole('button', { name: /Move card to different column or swimlane/ })
    trigger.focus()
    await user.keyboard('{Enter}')
    const moveTo = screen.getByText('Move to')
    const popover = moveTo.parentElement as HTMLElement
    const panel = screen.getByRole('dialog', { name: /./ })
    expect(panel.contains(popover)).toBe(true)
    // Tab through the panel until a popover control takes focus. Stop there: 200
    // unconditional Tabs cost ~1s locally and passed the 5s timeout on a slower CI
    // runner. The bound is only the "never reached" failure path.
    let reached = false
    for (let i = 0; i < 200 && !reached; i++) {
      await user.tab()
      reached = popover.contains(document.activeElement)
    }
    expect(reached).toBe(true)
  })
})

describe('CardDetail — onUpdated payloads follow the live card (#1777)', () => {
  const item = { id: 1, text: 'Item 1', is_checked: false, position: 0 }
  const attachment = { id: 7, filename: 'spec.pdf', size: 10, url: '/f/7', uploaded_by: fakeUser, uploaded_at: '2026-01-01' }
  const renamed = () => makeCard({
    title: 'Renamed remotely',
    weight: 5,
    assignee: { id: 9, username: 'other', display_name: 'Other', avatar_url: '' },
    labels: [{ id: 100, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }],
    version: 4,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getCardComments as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(getCardAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([])
    mockGetCardRelations.mockResolvedValue([])
  })

  const lastPayload = (props: ReturnType<typeof defaultProps>) =>
    (props.onUpdated as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as Card

  const expectLive = (c: Card) => {
    expect(c.title).toBe('Renamed remotely')
    expect(c.weight).toBe(5)
    expect(c.assignee?.id).toBe(9)
    expect(c.labels.map((l) => l.id)).toEqual([100])
    expect(c.version).toBe(4)
  }

  it('checklist toggle after a remote rename keeps the new title and fields', async () => {
    ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([item])
    mockUpdateChecklistItem.mockResolvedValue({ ...item, is_checked: true })
    const props = defaultProps()
    const { rerender } = render(<CardDetail {...props} />)
    await waitFor(() => expect(screen.getByText('Item 1')).toBeInTheDocument())
    rerender(<CardDetail {...props} card={renamed()} />)
    await userEvent.setup().click(screen.getAllByRole('checkbox')[0])
    await waitFor(() => expect(props.onUpdated).toHaveBeenCalled())
    const last = lastPayload(props)
    expectLive(last)
    expect(last.checklist_done).toBe(1)
    expect(last.checklist_total).toBe(1)
  })

  it('a rename that lands while the toggle request is in flight is not reverted', async () => {
    ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([item])
    let resolve!: (v: unknown) => void
    mockUpdateChecklistItem.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    const props = defaultProps()
    const { rerender } = render(<CardDetail {...props} />)
    await waitFor(() => expect(screen.getByText('Item 1')).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    rerender(<CardDetail {...props} card={renamed()} />)
    resolve({ ...item, is_checked: true })
    await waitFor(() => expect(props.onUpdated).toHaveBeenCalled())
    expectLive(lastPayload(props))
  })

  it('checklist delete after a remote rename keeps the new title and fields', async () => {
    ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([item])
    mockDeleteChecklistItem.mockResolvedValue(undefined)
    const props = defaultProps()
    const { rerender } = render(<CardDetail {...props} />)
    await waitFor(() => expect(screen.getByText('Item 1')).toBeInTheDocument())
    rerender(<CardDetail {...props} card={renamed()} />)
    fireEvent.click(screen.getByTitle('Remove item'))
    await waitFor(() => expect(props.onUpdated).toHaveBeenCalled())
    const last = lastPayload(props)
    expectLive(last)
    expect(last.checklist_total).toBe(0)
  })

  it('checklist add after a remote rename keeps the new title and fields', async () => {
    mockAddChecklistItem.mockResolvedValue({ id: 5, text: 'New task', is_checked: false, position: 0 })
    const props = defaultProps()
    const { rerender } = render(<CardDetail {...props} />)
    rerender(<CardDetail {...props} card={{ ...renamed(), checklist_total: 2 }} />)
    const input = screen.getByPlaceholderText('Add item (Enter)…')
    fireEvent.change(input, { target: { value: 'New task' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(props.onUpdated).toHaveBeenCalled())
    const last = lastPayload(props)
    expectLive(last)
    expect(last.checklist_total).toBe(3)
  })

  it('bulk add after a remote rename keeps the new title and fields', async () => {
    mockAddChecklistItem
      .mockResolvedValueOnce({ id: 5, text: 'A', is_checked: false, position: 0 })
      .mockResolvedValueOnce({ id: 6, text: 'B', is_checked: false, position: 1 })
    const props = defaultProps()
    const { rerender } = render(<CardDetail {...props} />)
    rerender(<CardDetail {...props} card={renamed()} />)
    fireEvent.click(screen.getByText('Bulk'))
    fireEvent.change(screen.getByPlaceholderText(/Buy milk/), { target: { value: 'A\nB' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add items' }))
    await waitFor(() => expect(props.onUpdated).toHaveBeenCalled())
    const last = lastPayload(props)
    expectLive(last)
    expect(last.checklist_total).toBe(2)
  })

  it('attachment upload after a remote rename keeps the new title and fields', async () => {
    const { uploadCardAttachment } = await import('../api/cards')
    ;(uploadCardAttachment as ReturnType<typeof vi.fn>).mockResolvedValue(attachment)
    const props = defaultProps()
    const { container, rerender } = render(<CardDetail {...props} />)
    rerender(<CardDetail {...props} card={renamed()} />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.txt')] } })
    await waitFor(() => expect(props.onUpdated).toHaveBeenCalled())
    const last = lastPayload(props)
    expectLive(last)
    expect(last.attachment_count).toBe(1)
  })

  it('attachment delete after a remote rename keeps the new title and fields', async () => {
    const { deleteCardAttachment } = await import('../api/cards')
    ;(deleteCardAttachment as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(getCardAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([attachment])
    const props = defaultProps()
    const { rerender } = render(<CardDetail {...props} currentUser={fakeUser} />)
    const btn = await screen.findByRole('button', { name: 'Delete attachment spec.pdf' })
    rerender(<CardDetail {...props} currentUser={fakeUser} card={{ ...renamed(), attachment_count: 3 }} />)
    fireEvent.click(btn)
    await waitFor(() => expect(props.onUpdated).toHaveBeenCalled())
    const last = lastPayload(props)
    expectLive(last)
    expect(last.attachment_count).toBe(2)
  })

  // The rename lands while the request is pending; the payload must be built
  // from the card as it is AFTER the await, not as it was at click time.
  describe('rename lands while the request is in flight', () => {
    it('checklist add', async () => {
      let resolve!: (v: unknown) => void
      mockAddChecklistItem.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
      const props = defaultProps()
      const { rerender } = render(<CardDetail {...props} />)
      const input = screen.getByPlaceholderText('Add item (Enter)…')
      fireEvent.change(input, { target: { value: 'New task' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      rerender(<CardDetail {...props} card={renamed()} />)
      resolve({ id: 5, text: 'New task', is_checked: false, position: 0 })
      await waitFor(() => expect(props.onUpdated).toHaveBeenCalled())
      expectLive(lastPayload(props))
    })

    it('bulk add', async () => {
      let resolve!: (v: unknown) => void
      mockAddChecklistItem.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
      mockAddChecklistItem.mockResolvedValueOnce({ id: 6, text: 'B', is_checked: false, position: 1 })
      const props = defaultProps()
      const { rerender } = render(<CardDetail {...props} />)
      fireEvent.click(screen.getByText('Bulk'))
      fireEvent.change(screen.getByPlaceholderText(/Buy milk/), { target: { value: 'A\nB' } })
      fireEvent.click(screen.getByRole('button', { name: 'Add items' }))
      rerender(<CardDetail {...props} card={renamed()} />)
      resolve({ id: 5, text: 'A', is_checked: false, position: 0 })
      await waitFor(() => expect(props.onUpdated).toHaveBeenCalled())
      expectLive(lastPayload(props))
    })

    it('checklist delete', async () => {
      ;(getChecklist as ReturnType<typeof vi.fn>).mockResolvedValue([item])
      let resolve!: (v?: unknown) => void
      mockDeleteChecklistItem.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
      const props = defaultProps()
      const { rerender } = render(<CardDetail {...props} />)
      await waitFor(() => expect(screen.getByText('Item 1')).toBeInTheDocument())
      fireEvent.click(screen.getByTitle('Remove item'))
      rerender(<CardDetail {...props} card={renamed()} />)
      resolve()
      await waitFor(() => expect(props.onUpdated).toHaveBeenCalled())
      expectLive(lastPayload(props))
    })

    it('attachment upload', async () => {
      const { uploadCardAttachment } = await import('../api/cards')
      let resolve!: (v: unknown) => void
      ;(uploadCardAttachment as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((r) => { resolve = r }))
      const props = defaultProps()
      const { container, rerender } = render(<CardDetail {...props} />)
      const input = container.querySelector('input[type="file"]') as HTMLInputElement
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.txt')] } })
      rerender(<CardDetail {...props} card={renamed()} />)
      resolve(attachment)
      await waitFor(() => expect(props.onUpdated).toHaveBeenCalled())
      expectLive(lastPayload(props))
    })

    it('attachment delete', async () => {
      const { deleteCardAttachment } = await import('../api/cards')
      let resolve!: (v?: unknown) => void
      ;(deleteCardAttachment as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((r) => { resolve = r }))
      ;(getCardAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([attachment])
      const props = defaultProps()
      const { rerender } = render(<CardDetail {...props} currentUser={fakeUser} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Delete attachment spec.pdf' }))
      rerender(<CardDetail {...props} currentUser={fakeUser} card={renamed()} />)
      resolve()
      await waitFor(() => expect(props.onUpdated).toHaveBeenCalled())
      expectLive(lastPayload(props))
    })
  })
})

describe('CardDetail — label saves follow the live card (#1840)', () => {
  const bug = { id: 100, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }
  const remote = { id: 101, uid: 'lbluid000002', name: 'Remote', color: '#10B981' }
  const other = { id: 102, uid: 'lbluid000003', name: 'Other', color: '#3B82F6' }
  const makeLabelBoard = () => ({ ...makeBoard(), labels: [bug, remote, other] })

  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateCard.mockImplementation((_b: number, _c: number, patch: Record<string, unknown>) =>
      Promise.resolve({ ...makeCard(), ...patch, version: 9 }))
  })

  const lastBody = () => mockUpdateCard.mock.calls.at(-1)![2] as { label_ids: number[] }

  it('a toggle after a remote label add keeps the remote label in label_ids', async () => {
    const props = { ...defaultProps(), board: makeLabelBoard() }
    const { rerender } = render(<CardDetail {...props} />)
    rerender(<CardDetail {...props} card={makeCard({ labels: [remote], version: 4 })} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Other' }))
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled())
    expect(lastBody().label_ids.sort((a, b) => a - b)).toEqual([101, 102])
  })

  it('toggling off a label that was added remotely removes only that label', async () => {
    const props = { ...defaultProps(), board: makeLabelBoard() }
    const { rerender } = render(<CardDetail {...props} />)
    rerender(<CardDetail {...props} card={makeCard({ labels: [bug, remote], version: 4 })} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remote' }))
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled())
    expect(lastBody().label_ids).toEqual([100])
  })

  it('a label removed remotely renders inactive and is not sent back', async () => {
    const props = {
      ...defaultProps(),
      board: makeLabelBoard(),
      card: makeCard({ labels: [bug, remote] }),
    }
    const { rerender } = render(<CardDetail {...props} />)
    rerender(<CardDetail {...props} card={makeCard({ labels: [bug], version: 4 })} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Other' }))
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled())
    expect(lastBody().label_ids.sort((a, b) => a - b)).toEqual([100, 102])
  })

  it('a label create after a remote label add keeps the remote label in label_ids', async () => {
    const { createLabel } = await import('../api/boards')
    ;(createLabel as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 99, uid: 'x', name: 'Urgent', color: '#ff0000' })
    const props = { ...defaultProps(), board: makeLabelBoard() }
    const user = userEvent.setup()
    const { rerender } = render(<CardDetail {...props} />)
    rerender(<CardDetail {...props} card={makeCard({ labels: [remote], version: 4 })} />)
    await user.click(screen.getByText('+ New label'))
    const input = screen.getByPlaceholderText('Label name')
    fireEvent.change(input, { target: { value: 'Urgent' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled())
    expect(lastBody().label_ids.sort((a, b) => a - b)).toEqual([99, 101])
  })
})

describe('CardDetail — custom field and weight saves follow the live card (#1840)', () => {
  const field = (id: number, name: string) => ({
    id, uid: `cfduid0000${id}`, name, field_type: 'dropdown' as const,
    choices: ['Red', 'Green', 'Blue'], position: id, show_on_card: false,
    is_required: false, help_text: '', number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {}, created_at: '2026-01-01T00:00:00Z',
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateCard.mockImplementation((_b: number, _c: number, patch: Record<string, unknown>) =>
      Promise.resolve({ ...makeCard(), ...patch, version: 9 }))
  })

  it('a custom field edit after a remote edit of another field keeps the remote value', async () => {
    const props = { ...defaultProps(), board: makeBoard({ custom_field_definitions: [field(500, 'Status'), field(501, 'Stage')] }) }
    const user = userEvent.setup()
    const { rerender } = render(<CardDetail {...props} />)
    rerender(<CardDetail {...props} card={makeCard({ custom_field_values: [{ field_definition: 501, value: 'Blue' }], version: 4 })} />)
    await user.click(screen.getByRole('button', { name: /Custom fields/ }))
    await user.click(screen.getAllByRole('button', { name: /— No value —/ })[0])
    await user.click(screen.getByRole('menuitem', { name: 'Green' }))
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled())
    const sent = (mockUpdateCard.mock.calls.at(-1)![2] as { custom_field_values: { field_definition: number; value: string }[] }).custom_field_values
    expect(sent).toEqual(expect.arrayContaining([
      { field_definition: 501, value: 'Blue' },
      { field_definition: 500, value: 'Green' },
    ]))
    expect(sent).toHaveLength(2)
  })

  it('the weight buttons step from a remotely changed weight', async () => {
    const props = defaultProps()
    const { rerender } = render(<CardDetail {...props} />)
    rerender(<CardDetail {...props} card={makeCard({ weight: 5, version: 4 })} />)
    expect(screen.getByText('5')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Increase weight' }))
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledWith(1, 1, { weight: 6 }))
  })

  it('a pending weight edit is not reset by an unrelated remote bump', async () => {
    const props = defaultProps()
    const user = userEvent.setup()
    const { rerender } = render(<CardDetail {...props} />)
    await user.click(screen.getByRole('button', { name: 'Increase weight' }))
    rerender(<CardDetail {...props} card={makeCard({ weight: 7, version: 4 })} />)
    expect(screen.getByText('2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Increase weight' }))
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledWith(1, 1, { weight: 3 }))
    expect(mockUpdateCard).toHaveBeenCalledTimes(1)
  })

  it('the weight minus button steps down from a remotely changed weight', async () => {
    const props = defaultProps()
    const { rerender } = render(<CardDetail {...props} />)
    rerender(<CardDetail {...props} card={makeCard({ weight: 5, version: 4 })} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Decrease weight' }))
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledWith(1, 1, { weight: 4 }))
  })
})

// #1969: the response to the panel's own save travels over HTTP, a remote edit
// over the socket, so the older of the two can land last.
describe('CardDetail — a stale save response does not regress the panel (#1969)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('takes the newer live card when the save response lands after a remote frame', async () => {
    let resolveSave!: (c: Card) => void
    mockUpdateCard.mockImplementation(() => new Promise((r) => { resolveSave = r }))
    const props = defaultProps()
    const { rerender } = render(<CardDetail {...props} />)
    const title = screen.getByDisplayValue('Test Card')
    fireEvent.change(title, { target: { value: 'My edit' } })
    fireEvent.blur(title)
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled())
    // Our PATCH committed as v2; another session renamed the card as v3, and
    // its frame reaches the board before our HTTP response does.
    rerender(<CardDetail {...props} card={makeCard({ title: 'Renamed elsewhere', version: 3 })} />)
    await act(async () => { resolveSave(makeCard({ title: 'My edit', version: 2 })) })
    expect(screen.getByDisplayValue('Renamed elsewhere')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('My edit')).not.toBeInTheDocument()
    // The response is still forwarded; useBoard discards it as stale.
    expect(props.onUpdated).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }))
  })

  it('keeps a later save that returned first over an earlier save that returns last', async () => {
    const resolvers: ((c: Card) => void)[] = []
    mockUpdateCard.mockImplementation(() => new Promise((r) => { resolvers.push(r) }))
    const props = defaultProps()
    render(<CardDetail {...props} />)
    const title = screen.getByDisplayValue('Test Card')
    fireEvent.change(title, { target: { value: 'First' } })
    fireEvent.blur(title)
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1))
    fireEvent.change(title, { target: { value: 'Second' } })
    fireEvent.blur(title)
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(2))
    await act(async () => { resolvers[1](makeCard({ title: 'Second', version: 3 })) })
    await act(async () => { resolvers[0](makeCard({ title: 'First', version: 2 })) })
    expect(screen.getByDisplayValue('Second')).toBeInTheDocument()
  })

  it('adopts a response at the same version as the panel', async () => {
    mockUpdateCard.mockResolvedValue(makeCard({ title: 'Saved', attachment_count: 0, version: 2 }))
    const props = defaultProps()
    const { rerender } = render(<CardDetail {...props} />)
    // The socket echo of our own PATCH lands first, at the same version.
    rerender(<CardDetail {...props} card={makeCard({ title: 'Saved', version: 2 })} />)
    const title = screen.getByDisplayValue('Test Card')
    fireEvent.change(title, { target: { value: 'Saved' } })
    fireEvent.blur(title)
    await waitFor(() => expect(props.onUpdated).toHaveBeenCalledWith(expect.objectContaining({ version: 2 })))
    expect(screen.getByDisplayValue('Saved')).toBeInTheDocument()
  })
})

describe('CardDetail — definition of done (#1101)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateCard.mockImplementation((_boardId: number, _cardId: number, patch: Record<string, unknown>) =>
      Promise.resolve({ ...makeCard(), ...patch })
    )
  })

  const withPolicy = (done: string[]) => makeBoard({
    columns: [{
      id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null,
      allow_card_creation: true, is_done: false,
      policy: { v: 1, entry: ['Has an owner'], done, mode: 'confirm' },
    }],
  })

  it("lists the current column's definition of done, display-only", () => {
    render(<CardDetail {...defaultProps()} board={withPolicy(['Reviewed', 'Docs updated'])} />)
    const section = screen.getByRole('region', { name: 'Definition of done · To Do' })
    expect(within(section).getByText('Reviewed')).toBeInTheDocument()
    expect(within(section).getByText('Docs updated')).toBeInTheDocument()
    expect(within(section).getByText('For reference. It never blocks moving the card on.')).toBeInTheDocument()
    // Display-only: nothing to tick.
    expect(within(section).queryByRole('checkbox')).not.toBeInTheDocument()
    // Entry criteria are not shown here.
    expect(within(section).queryByText('Has an owner')).not.toBeInTheDocument()
  })

  it('omits the section when the column has no done criteria', () => {
    render(<CardDetail {...defaultProps()} board={withPolicy([])} />)
    expect(screen.queryByText(/Definition of done/)).not.toBeInTheDocument()
  })

  it('omits the section when the column has no policy', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.queryByText(/Definition of done/)).not.toBeInTheDocument()
  })
})
