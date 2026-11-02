import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

import { blockCard, unblockCard } from '../api/cards'
import { flagsWrapper } from './instanceFlagsWrapper'

const mockBlockCard = blockCard as ReturnType<typeof vi.fn>
const mockUnblockCard = unblockCard as ReturnType<typeof vi.fn>

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
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0,
    columns: [{ id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false }],
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

const props = (overrides: Record<string, unknown> = {}) => ({
  card: makeCard(),
  board: makeBoard(),
  currentUser: fakeUser,
  onClose: vi.fn(),
  onDeleted: vi.fn(),
  onUpdated: vi.fn(),
  onArchived: vi.fn(),
  ...overrides,
})

describe('CardDetail — manual block (#1149)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('offers Block… in the header to an editor, and opens the inline form', () => {
    render(<CardDetail {...props()} />)
    const trigger = screen.getByRole('button', { name: 'Block…' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('card-block-form')).toBeInTheDocument()
    expect(screen.getByLabelText(/Reason/)).toHaveFocus()
  })

  it('Escape closes the form first, then the sheet, and focus returns to Block…', () => {
    const onClose = vi.fn()
    render(<CardDetail {...props({ onClose })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Block…' }))
    screen.getByRole('button', { name: 'Cancel' }).focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('card-block-form')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Block…' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('Cancel returns focus to Block…', () => {
    render(<CardDetail {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Block…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Block…' })).toHaveFocus()
  })

  it.each(['viewer', 'collaborator'] as const)('hides Block… from a %s', (role) => {
    render(<CardDetail {...props({ board: makeBoard({ current_user_role: role }) })} />)
    expect(screen.queryByRole('button', { name: 'Block…' })).not.toBeInTheDocument()
  })

  it("hides Block… from a member on another user's card", () => {
    const member = { ...fakeUser, id: 2 }
    render(<CardDetail {...props({
      currentUser: member,
      board: makeBoard({ current_user_role: 'member', members: [{ id: 2, user: member, role: 'member', is_moderator: false, joined_at: '' }] }),
    })} />)
    expect(screen.queryByRole('button', { name: 'Block…' })).not.toBeInTheDocument()
  })

  it('hides Block… in the shared demo', () => {
    render(<CardDetail {...props()} />, { wrapper: flagsWrapper({ demo_mode: true }) })
    expect(screen.queryByRole('button', { name: 'Block…' })).not.toBeInTheDocument()
  })

  it('a blocked card shows the banner instead of Block…', () => {
    render(<CardDetail {...props({ card: makeCard({ is_blocked: true, blocked_at: new Date().toISOString(), blocked_reason: 'Vendor' }) })} />)
    expect(screen.queryByRole('button', { name: 'Block…' })).not.toBeInTheDocument()
    expect(screen.getByTestId('card-blocked-banner')).toHaveTextContent('Vendor')
    expect(screen.getByRole('button', { name: 'Unblock' })).toBeInTheDocument()
  })

  it('a successful block updates the panel and the board', async () => {
    const onUpdated = vi.fn()
    const blocked = makeCard({ version: 2, is_blocked: true, blocked_at: new Date().toISOString(), blocked_reason: 'Vendor' })
    mockBlockCard.mockResolvedValue(blocked)
    render(<CardDetail {...props({ onUpdated })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Block…' }))
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Vendor' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Block card' })) })
    expect(mockBlockCard).toHaveBeenCalledWith(1, 1, 'Vendor')
    expect(onUpdated).toHaveBeenCalledWith(blocked)
    expect(await screen.findByTestId('card-blocked-banner')).toHaveTextContent('Vendor')
    expect(screen.queryByRole('button', { name: 'Block…' })).not.toBeInTheDocument()
  })

  it('after a successful unblock, focus moves to the header Block…', async () => {
    const onUpdated = vi.fn()
    const blocked = makeCard({ is_blocked: true, blocked_at: new Date().toISOString(), blocked_reason: 'Vendor' })
    mockUnblockCard.mockResolvedValue(makeCard({ version: 2 }))
    render(<CardDetail {...props({ card: blocked, onUpdated })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Unblock' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unblock card' })) })
    expect(onUpdated).toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Block…' })).toHaveFocus())
  })

  it("another session's block arrives through the live card", async () => {
    const { rerender } = render(<CardDetail {...props()} />)
    rerender(<CardDetail {...props({ card: makeCard({ version: 2, is_blocked: true, blocked_at: new Date().toISOString(), blocked_reason: 'Remote' }) })} />)
    await waitFor(() => expect(screen.getByTestId('card-blocked-banner')).toHaveTextContent('Remote'))
  })

  it('Block… switches to the Details tab', () => {
    render(<CardDetail {...props()} />)
    fireEvent.click(screen.getByRole('tab', { name: /activity/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Block…' }))
    expect(screen.getByRole('tab', { name: /details/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('card-block-form')).toBeInTheDocument()
  })
})
