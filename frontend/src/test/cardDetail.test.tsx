import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CardDetail from '../components/Card/CardDetail'
import type { Card, BoardFull, User } from '../types'

vi.mock('../api/cards', () => ({
  deleteCard: vi.fn(),
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

import { updateCard, getCardComments, getCardAttachments, getChecklist } from '../api/cards'

const mockUpdateCard = updateCard as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false,
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, column: 10, swimlane: 20, title: 'Test Card', description: 'A test card',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1,
    position: 0, created_by: 1, created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z', last_moved_at: null,
    attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false,
    ...overrides,
  }
}

function makeBoard(overrides: Partial<BoardFull> = {}): BoardFull {
  return {
    id: 1, name: 'Test Board', description: '', group: null, group_name: null,
    columns: [{ id: 10, name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true }],
    swimlanes: [{ id: 20, name: 'Customer A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01' }],
    cards: [], labels: [{ id: 100, name: 'Bug', color: '#EF4444' }],
    members: [{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }],
    staleness_threshold_days: 7, close_editor_on_enter: false, allowed_priorities: [],
    is_starred: false, created_at: '', updated_at: '', current_user_role: 'admin',
    ...overrides,
  }
}

const defaultProps = () => ({
  card: makeCard(),
  board: makeBoard(),
  onClose: vi.fn(),
  onDeleted: vi.fn(),
  onUpdated: vi.fn(),
  onLabelAdded: vi.fn(),
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

  it('renders description textarea', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByPlaceholderText('Add a description…')).toBeInTheDocument()
  })

  it('saves description on blur', async () => {
    render(<CardDetail {...defaultProps()} />)
    const textarea = screen.getByPlaceholderText('Add a description…')
    await userEvent.setup().click(textarea)
    await userEvent.setup().type(textarea, ' updated')
    textarea.blur()
    await waitFor(() => {
      expect(mockUpdateCard).toHaveBeenCalled()
    })
  })

  it('renders assignee select with board members', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByText('Unassigned')).toBeInTheDocument()
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

  it('renders upload button', () => {
    render(<CardDetail {...defaultProps()} />)
    expect(screen.getByText('+ Upload')).toBeInTheDocument()
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
    props.card = makeCard({ labels: [{ id: 100, name: 'Bug', color: '#EF4444' }] })
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
})
