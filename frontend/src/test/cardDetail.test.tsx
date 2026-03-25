import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CardDetail from '../components/Card/CardDetail'
import type { Card, BoardFull, User } from '../types'

vi.mock('../api/cards', () => ({
  deleteCard: vi.fn(),
  archiveCard: vi.fn(),
  getCardComments: vi.fn().mockResolvedValue([]),
  addCardComment: vi.fn(),
  updateCard: vi.fn(),
  getCardAttachments: vi.fn().mockResolvedValue([]),
  uploadCardAttachment: vi.fn(),
  deleteCardAttachment: vi.fn(),
  getChecklist: vi.fn().mockResolvedValue([]),
  addChecklistItem: vi.fn(),
  updateChecklistItem: vi.fn(),
  deleteChecklistItem: vi.fn(),
}))

vi.mock('../api/boards', () => ({
  createLabel: vi.fn(),
}))

vi.mock('../components/Card/CardMovementTimeline', () => ({
  default: () => <div data-testid="movement-timeline">Timeline</div>,
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

import { updateCard, getCardComments, getCardAttachments, getChecklist } from '../api/cards'

const mockUpdateCard = updateCard as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false,
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Test Card', description: 'A test card',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: 0, created_by: 1, created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z', last_moved_at: null,
    attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
    ...overrides,
  }
}

function makeBoard(overrides: Partial<BoardFull> = {}): BoardFull {
  return {
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    columns: [{ id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true }],
    swimlanes: [{ id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01' }],
    cards: [], labels: [{ id: 100, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }],
    members: [{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_weight_limits: false, is_starred: false, created_at: '', updated_at: '', current_user_role: 'admin',
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

  it('renders details and history tabs', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByText('details')).toBeInTheDocument()
    expect(screen.getByText('history')).toBeInTheDocument()
  })

  it('switches to history tab and shows timeline', async () => {
    render(<CardDetail {...defaultProps()} />)
    await userEvent.setup().click(screen.getByText('history'))
    expect(screen.getByTestId('movement-timeline')).toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: /Unassigned/ })).toBeInTheDocument()
    // Open the dropdown to see member options
    await userEvent.setup().click(screen.getByRole('button', { name: /Unassigned/ }))
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

  it('renders disabled upload text when uploads_enabled is false', () => {
    render(<CardDetail {...defaultProps()} currentUser={{ ...fakeUser, uploads_enabled: false }} />)
    const el = screen.getByText('+ Upload')
    expect(el).toBeInTheDocument()
    // Must not be an interactive button
    expect(el.tagName).not.toBe('BUTTON')
    expect(el.className).toContain('cursor-not-allowed')
    expect((el as HTMLElement).title).toContain('disabled')
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

  it('save() shows inline error and rolls back on API failure', async () => {
    const { updateCard } = await import('../api/cards')
    const mockUpdateCard = updateCard as ReturnType<typeof vi.fn>
    mockUpdateCard.mockRejectedValueOnce(new Error('Network error'))
    const props = defaultProps()
    render(<CardDetail {...props} />)
    // Blur the title to trigger a save (value unchanged so no save is triggered — change it first)
    const titleInput = screen.getByDisplayValue('Test Card')
    fireEvent.change(titleInput, { target: { value: 'Changed title' } })
    fireEvent.blur(titleInput)
    await waitFor(() => {
      expect(screen.getByText('Failed to save — please try again.')).toBeInTheDocument()
    })
  })

  describe('Move to popover', () => {
    function makeBoardWithTwoCols(): BoardFull {
      return makeBoard({
        columns: [
          { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true },
          { id: 11, uid: 'coluid000002', name: 'In Progress', position: 1, color: '#F59E0B', wip_limit: null, weight_limit: null, allow_card_creation: true },
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
      const { container } = render(<CardDetail {...defaultProps()} board={board} onMoveCard={onMoveCard} />)
      await userEvent.setup().click(screen.getByRole('button', { name: /Move card to different column or swimlane/ }))

      const popover = container.querySelector('[class*="w-64"]')!
      const colTrigger = Array.from(popover.querySelectorAll('button')).find((b) => b.textContent?.includes('To Do'))!
      await userEvent.setup().click(colTrigger)
      await userEvent.setup().click(screen.getByText('In Progress'))
      await userEvent.setup().click(screen.getByRole('button', { name: 'Move' }))

      await waitFor(() => {
        expect(screen.getByText(/Move blocked/)).toBeInTheDocument()
      })
    })
  })
})
