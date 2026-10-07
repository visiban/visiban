import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CardDetail from '../components/Card/CardDetail'
import type { Card, BoardFull, User } from '../types'

vi.mock('../api/cards', () => ({
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

vi.mock('../api/boards', () => ({
  createLabel: vi.fn(),
}))

vi.mock('../components/Card/ActivityTabPanel', () => ({
  default: () => <div data-testid="activity-tab-panel">Activity</div>,
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

import { updateCard, getCardComments, getCardAttachments, getChecklist, updateChecklistItem, deleteChecklistItem, getCardRelations, addCardComment, addChecklistItem } from '../api/cards'

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
    blocker_count: 0, external_ref: null,
    ...overrides,
  }
}

function makeBoard(overrides: Partial<BoardFull> = {}): BoardFull {
  return {
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0,
    columns: [{ id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false }],
    swimlanes: [{ id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01' }],
    cards: [], labels: [{ id: 100, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }],
    members: [{ id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false, show_row_chip_field_names: true, export_min_role: 'viewer', card_density: 'comfortable', is_starred: false, created_at: '', updated_at: '', current_user_role: 'admin',
    owner: { id: 1, username: 'jdoe', display_name: 'Jane Doe', avatar_url: '' },
    capabilities: { movement_export: false },
    share_token: null,
    share_token_expires_at: null,
    custom_field_definitions: [],
    swimlane_custom_field_definitions: [],
    ...overrides,
  }
}

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

  it('renders swimlane and column names', () => {
    render(<CardDetail {...defaultProps()} />)
    // Swimlane and column names are in the same <p> split by a span
    expect(screen.getByText(/Customer A/)).toBeInTheDocument()
    expect(screen.getByText(/To Do/)).toBeInTheDocument()
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

  it('clicking the backdrop calls onClose', async () => {
    const props = defaultProps()
    const { container } = render(<CardDetail {...props} />)
    const backdrop = container.querySelector('.bg-backdrop\\/40') as HTMLElement
    await userEvent.setup().click(backdrop)
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('renders details and activity tabs', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByText('details')).toBeInTheDocument()
    expect(screen.getByText('activity')).toBeInTheDocument()
  })

  it('switches to activity tab and shows activity panel', async () => {
    render(<CardDetail {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('activity'))
    expect(screen.getByTestId('activity-tab-panel')).toBeInTheDocument()
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

  it('renders attachment section with empty state', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByText('Attachments')).toBeInTheDocument()
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
    const demoUser = { ...fakeUser, demo_mode: true, demo_next_reset_at: '2026-09-27T13:00:00Z' }

    it('upload shows the demo reason, taking precedence over uploads-disabled', () => {
      render(<CardDetail {...defaultProps()} currentUser={{ ...demoUser, uploads_enabled: false }} />)
      const el = screen.getByRole('button', { name: '+ Upload' })
      expect(el).toHaveAttribute('aria-disabled', 'true')
      expect(el).toHaveAccessibleDescription('This is a shared demo — file uploads are off here.')
      expect(screen.queryByText('File uploads are disabled by the site administrator.')).not.toBeInTheDocument()
    })

    it('comment submit is aria-disabled, keyboard-reachable, explains why, and keeps typed text', async () => {
      const user = userEvent.setup()
      render(<CardDetail {...defaultProps()} currentUser={demoUser} />)
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
      const { getCardComments, deleteComment } = await import('../api/cards')
      const mockGetComments = getCardComments as ReturnType<typeof vi.fn>
      mockGetComments.mockResolvedValue([
        { id: 1, author: demoUser, body: 'Hello world', created_at: new Date().toISOString(), updated_at: '' },
      ])
      const user = userEvent.setup()
      render(<CardDetail {...defaultProps()} currentUser={demoUser} />)
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
      render(<CardDetail {...defaultProps()} currentUser={demoUser} />)
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
      render(<CardDetail {...defaultProps()} currentUser={demoUser} />)
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
    const visitor: User = { ...fakeUser, id: 99, username: 'visitor', demo_mode: true, demo_next_reset_at: '2026-09-27T13:00:00Z' }
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

    it('shows Archive and an enabled assignee picker, and hides Delete (not on the fence allowlist)', () => {
      render(<CardDetail {...demoProps()} currentUser={visitor} />)
      expect(screen.getByRole('button', { name: 'Archive card' })).toBeInTheDocument()
      expect(screen.queryByText('Delete card')).not.toBeInTheDocument()
      expect(screen.getByRole('combobox')).not.toBeDisabled()
      expect(screen.queryByText('Assigning cards requires Moderator or Admin access')).not.toBeInTheDocument()
    })

    it('hides Delete in demo mode even on a card the visitor created', () => {
      const props = demoProps()
      props.card = makeCard({ created_by: { id: 99, username: 'visitor', display_name: 'Visitor', avatar_url: '' } })
      render(<CardDetail {...props} currentUser={visitor} />)
      expect(screen.getByRole('button', { name: 'Archive card' })).toBeInTheDocument()
      expect(screen.queryByText('Delete card')).not.toBeInTheDocument()
    })

    it('does not widen a collaborator', () => {
      render(<CardDetail {...demoProps('collaborator')} currentUser={visitor} />)
      expect(screen.queryByText('Archive card')).not.toBeInTheDocument()
    })

    it('outside demo mode a plain member still sees neither Archive nor Delete on others\' cards', () => {
      render(<CardDetail {...demoProps()} currentUser={{ ...visitor, demo_mode: false }} />)
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

  it('click-only backdrop is hidden from assistive tech; Escape/Close are the keyboard paths (#1376)', async () => {
    const props = defaultProps()
    render(<CardDetail {...props} />)
    const backdrop = document.querySelector('.bg-backdrop\\/40')!
    expect(backdrop).toHaveAttribute('aria-hidden', 'true')
    await userEvent.setup().keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('renders comments with author initials', async () => {
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
      const err = await screen.findByText('Could not delete comment.')
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
          { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
          { id: 11, uid: 'coluid000002', name: 'In Progress', position: 1, color: '#F59E0B', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
        ],
        swimlanes: [
          { id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01' },
          { id: 21, uid: 'laneuid00002', name: 'Customer B', contact_email: '', notes: '', position: 1, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01' },
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

    it('shows error message when onMoveCard rejects', async () => {
      const onMoveCard = vi.fn().mockRejectedValue(new Error('WIP limit'))
      const board = makeBoardWithTwoCols()
      const user = userEvent.setup()
      const { container } = render(<CardDetail {...defaultProps()} board={board} onMoveCard={onMoveCard} />)
      await user.click(screen.getByRole('button', { name: /Move card to different column or swimlane/ }))

      const popover = container.querySelector('[class*="w-64"]')!
      const colTrigger = Array.from(popover.querySelectorAll('button')).find((b) => b.textContent?.includes('To Do'))!
      await user.click(colTrigger)
      await user.click(screen.getByText('In Progress'))
      await user.click(screen.getByRole('button', { name: 'Move' }))

      await waitFor(() => {
        expect(screen.getByText(/Move blocked/)).toBeInTheDocument()
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
})
