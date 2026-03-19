import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CreateBoardModal from '../components/Board/CreateBoardModal'
import ImportBoardModal from '../components/Board/ImportBoardModal'
import MoveBoardModal from '../components/Board/MoveBoardModal'
import CreateGroupModal from '../components/Group/CreateGroupModal'
import AddColumnModal from '../components/Board/AddColumnModal'
import EditColumnModal from '../components/Board/EditColumnModal'
import EditSwimlaneModal from '../components/Board/EditSwimlaneModal'
import AddSwimlaneModal from '../components/Swimlane/AddSwimlaneModal'
import ForceChangePasswordModal from '../components/Auth/ForceChangePasswordModal'
import type { User, Board, Column, Swimlane } from '../types'

// Mock APIs
vi.mock('../api/boards', () => ({
  listGroups: vi.fn().mockResolvedValue([]),
  moveBoardToGroup: vi.fn(),
  createColumn: vi.fn(),
  updateColumn: vi.fn(),
  updateSwimlane: vi.fn(),
  deleteSwimlane: vi.fn(),
  createSwimlane: vi.fn(),
  listBoardTemplates: vi.fn().mockResolvedValue([
    {
      id: '1', name: 'Simple Kanban', slug: 'simple_kanban',
      description: 'General task tracking for any team',
      icon: 'columns', lane_label: 'Team', lane_placeholder: 'e.g. Engineering',
      columns_json: [
        { name: 'Backlog', color: '#6B7280', position: 0 },
        { name: 'To Do', color: '#3B82F6', position: 1 },
        { name: 'In Progress', color: '#F59E0B', position: 2 },
        { name: 'In Review', color: '#8B5CF6', position: 3 },
        { name: 'Done', color: '#10B981', position: 4 },
      ],
      sort_order: 40,
    },
    {
      id: '2', name: 'Sales Pipeline', slug: 'sales_pipeline',
      description: 'Track deals per account from lead to close',
      icon: 'chart-up', lane_label: 'Account', lane_placeholder: 'e.g. Acme Corp',
      columns_json: [
        { name: 'Lead', color: '#6B7280', position: 0 },
        { name: 'Qualified', color: '#3B82F6', position: 1 },
        { name: 'Proposal Sent', color: '#F59E0B', position: 2 },
        { name: 'Negotiation', color: '#F97316', position: 3 },
        { name: 'Closed Won', color: '#10B981', position: 4 },
        { name: 'Closed Lost', color: '#9CA3AF', position: 5 },
      ],
      sort_order: 10,
    },
    {
      id: '7', name: 'Blank Board', slug: 'blank',
      description: 'Start empty and add columns and swimlanes yourself',
      icon: 'blank', lane_label: '', lane_placeholder: 'e.g. General',
      columns_json: [],
      sort_order: 70,
    },
  ]),
}))

vi.mock('../api/groups', () => ({
  listGroups: vi.fn().mockResolvedValue([]),
  createGroup: vi.fn(),
}))

vi.mock('../api/auth', () => ({
  changePassword: vi.fn(),
}))

import { createGroup } from '../api/groups'
import { changePassword } from '../api/auth'

const mockCreateGroup = createGroup as ReturnType<typeof vi.fn>
const mockChangePassword = changePassword as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: true,
}

const fakeBoard: Board = {
  id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', owner: fakeUser,
  group: null, group_name: null, member_count: 1, card_count: 0, is_starred: false, created_at: '', updated_at: '',
}

const fakeColumn: Column = {
  id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6',
  wip_limit: null, weight_limit: null, allow_card_creation: true,
}

const fakeSwimlane: Swimlane = {
  id: 20, uid: 'laneuid00001', name: 'Lane A', contact_email: '', notes: '', position: 0,
  color: '#6B7280', is_collapsed: false, created_at: '2026-01-01',
}

describe('CreateBoardModal', () => {
  it('renders modal with template picker after loading', async () => {
    render(<CreateBoardModal onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('New Board')).toBeInTheDocument()
    expect(screen.getByText('Create Board')).toBeInTheDocument()
    // Templates are fetched asynchronously
    await waitFor(() => expect(screen.getByText('Simple Kanban')).toBeInTheDocument())
    expect(screen.getByText('Sales Pipeline')).toBeInTheDocument()
    expect(screen.getByText('Blank Board')).toBeInTheDocument()
  })

  it('disables create button when name is empty', () => {
    render(<CreateBoardModal onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('Create Board')).toBeDisabled()
  })

  it('calls onCancel when cancel is clicked', async () => {
    const onCancel = vi.fn()
    render(<CreateBoardModal onConfirm={vi.fn()} onCancel={onCancel} />)
    await userEvent.setup().click(screen.getByText('Cancel'))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('shows swimlane prompt with template lane_label after template load', async () => {
    render(<CreateBoardModal onConfirm={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Simple Kanban')).toBeInTheDocument())
    // Simple Kanban has lane_label "Team"
    expect(screen.getByText(/First Team \(swimlane\)/i)).toBeInTheDocument()
  })

  it('shows default-board checkbox', async () => {
    render(<CreateBoardModal onConfirm={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Set as my default board')).toBeInTheDocument())
  })

  it('shows default board tip when user has no default', async () => {
    const userWithNoDefault = { ...fakeUser, default_board_id: null }
    render(<CreateBoardModal onConfirm={vi.fn()} onCancel={vi.fn()} user={userWithNoDefault} />)
    await waitFor(() => expect(screen.getByText(/Tip: Set a default to skip/i)).toBeInTheDocument())
  })

  it('does not show tip when user already has a default', async () => {
    const userWithDefault = { ...fakeUser, default_board_id: 5 }
    render(<CreateBoardModal onConfirm={vi.fn()} onCancel={vi.fn()} user={userWithDefault} />)
    await waitFor(() => screen.getByLabelText('Set as my default board'))
    expect(screen.queryByText(/Tip: Set a default to skip/i)).not.toBeInTheDocument()
  })

  it('passes setAsDefault=true when checkbox is checked', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<CreateBoardModal onConfirm={onConfirm} onCancel={vi.fn()} />)
    const user = userEvent.setup()
    // Wait for templates to load
    await waitFor(() => expect(screen.getByLabelText('Set as my default board')).toBeInTheDocument())
    const nameInput = screen.getByPlaceholderText(/e.g. Q3 Pipeline/i)
    await user.type(nameInput, 'My Board')
    await user.click(screen.getByLabelText('Set as my default board'))
    await user.click(screen.getByText('Create Board'))
    expect(onConfirm).toHaveBeenCalledWith('My Board', 'simple_kanban', '', true)
  })

  it('passes setAsDefault=false by default', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<CreateBoardModal onConfirm={onConfirm} onCancel={vi.fn()} />)
    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByLabelText('Set as my default board')).toBeInTheDocument())
    const nameInput = screen.getByPlaceholderText(/e.g. Q3 Pipeline/i)
    await user.type(nameInput, 'My Board')
    await user.click(screen.getByText('Create Board'))
    expect(onConfirm).toHaveBeenCalledWith('My Board', 'simple_kanban', '', false)
  })
})

describe('ImportBoardModal', () => {
  it('renders modal with file input', () => {
    render(<ImportBoardModal onImport={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('Import Board')).toBeInTheDocument()
    expect(screen.getByText('Click to select a .json or .csv file')).toBeInTheDocument()
    expect(screen.getByText('Import')).toBeDisabled()
  })

  it('calls onCancel when cancel is clicked', async () => {
    const onCancel = vi.fn()
    render(<ImportBoardModal onImport={vi.fn()} onCancel={onCancel} />)
    await userEvent.setup().click(screen.getByText('Cancel'))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})

describe('MoveBoardModal', () => {
  it('renders modal with board name', () => {
    render(<MoveBoardModal board={fakeBoard} onMoved={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Move board')).toBeInTheDocument()
    expect(screen.getByText(/Test Board/)).toBeInTheDocument()
  })

  it('disables move button when selection unchanged', () => {
    render(<MoveBoardModal board={fakeBoard} onMoved={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Move')).toBeDisabled()
  })

  it('shows Personal (no group) option after loading', async () => {
    render(<MoveBoardModal board={fakeBoard} onMoved={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByText('Personal (no group)')).toBeInTheDocument()
  })

  it('shows cancel button', () => {
    render(<MoveBoardModal board={fakeBoard} onMoved={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Cancel')).toBeInTheDocument()
  })

  it('calls onClose when cancel is clicked', async () => {
    const onClose = vi.fn()
    render(<MoveBoardModal board={fakeBoard} onMoved={vi.fn()} onClose={onClose} />)
    await userEvent.setup().click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows loading state initially', () => {
    render(<MoveBoardModal board={fakeBoard} onMoved={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Loading groups…')).toBeInTheDocument()
  })

  it('enables move button when different selection is made', async () => {
    const boardInGroup: Board = { ...fakeBoard, group: 5 }
    render(<MoveBoardModal board={boardInGroup} onMoved={vi.fn()} onClose={vi.fn()} />)
    // Wait for groups to load
    const personalOption = await screen.findByText('Personal (no group)')
    await userEvent.setup().click(personalOption)
    expect(screen.getByText('Move')).not.toBeDisabled()
  })
})

describe('CreateGroupModal', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders modal for top-level group', () => {
    render(<CreateGroupModal onCreated={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('New Group')).toBeInTheDocument()
  })

  it('renders modal for subgroup', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parent = { ...fakeBoard, name: 'Engineering' } as any
    render(<CreateGroupModal parentGroup={parent} onCreated={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('New subgroup of "Engineering"')).toBeInTheDocument()
  })

  it('disables create when name is empty', () => {
    render(<CreateGroupModal onCreated={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Create')).toBeDisabled()
  })

  it('calls createGroup on submit', async () => {
    const group = { id: 1, name: 'Engineering' }
    mockCreateGroup.mockResolvedValue(group)
    const onCreated = vi.fn()
    const onClose = vi.fn()

    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText('e.g. Engineering'), 'Engineering')
    await user.click(screen.getByText('Create'))

    expect(mockCreateGroup).toHaveBeenCalledWith({ name: 'Engineering', parent: null })
  })

  it('shows success message after creation', async () => {
    const group = { id: 1, name: 'Engineering' }
    mockCreateGroup.mockResolvedValue(group)

    render(<CreateGroupModal onCreated={vi.fn()} onClose={vi.fn()} />)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText('e.g. Engineering'), 'Engineering')
    await user.click(screen.getByText('Create'))

    expect(await screen.findByText('✓ "Engineering" created')).toBeInTheDocument()
    expect(screen.getByText('✓ "Engineering" created')).toHaveClass('text-green-400')
  })

  it('clears success message after 2 seconds', async () => {
    const group = { id: 2, name: 'Design' }
    mockCreateGroup.mockResolvedValue(group)

    render(<CreateGroupModal onCreated={vi.fn()} onClose={vi.fn()} />)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText('e.g. Engineering'), 'Design')
    await user.click(screen.getByText('Create'))

    expect(await screen.findByText('✓ "Design" created')).toBeInTheDocument()
    // Message should disappear after 2 seconds (allow up to 3s for the async timer).
    await waitFor(() => expect(screen.queryByText('✓ "Design" created')).not.toBeInTheDocument(), { timeout: 3000 })
  })

  it('focuses the input after successful creation', async () => {
    const group = { id: 3, name: 'QA' }
    mockCreateGroup.mockResolvedValue(group)

    render(<CreateGroupModal onCreated={vi.fn()} onClose={vi.fn()} />)
    const user = userEvent.setup()
    const input = screen.getByPlaceholderText('e.g. Engineering')
    await user.type(input, 'QA')
    await user.click(screen.getByText('Create'))

    // Wait for the success message to confirm the async operation completed.
    await screen.findByText('✓ "QA" created')
    await waitFor(() => expect(input).toHaveFocus())
  })
})

describe('AddColumnModal', () => {
  it('renders modal', () => {
    render(<AddColumnModal boardId={1} onAdded={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Add Column', { selector: 'h2' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('e.g. In Progress')).toBeInTheDocument()
  })
})

describe('EditColumnModal', () => {
  it('renders modal with column data', () => {
    render(
      <EditColumnModal
        boardId={1}
        column={fakeColumn}
        cardCount={0}
        onUpdated={vi.fn()}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Edit Column')).toBeInTheDocument()
    expect(screen.getByDisplayValue('To Do')).toBeInTheDocument()
    expect(screen.getByText('Delete column')).toBeInTheDocument()
  })

  it('shows cannot delete message when cards exist', () => {
    render(
      <EditColumnModal
        boardId={1}
        column={fakeColumn}
        cardCount={3}
        onUpdated={vi.fn()}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Cannot delete — 3 cards remaining')).toBeInTheDocument()
  })
})

describe('EditSwimlaneModal', () => {
  it('renders modal with swimlane data', () => {
    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={fakeSwimlane}
        cardCount={0}
        onUpdated={vi.fn()}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Edit Swimlane')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Lane A')).toBeInTheDocument()
    expect(screen.getByText('Delete swimlane')).toBeInTheDocument()
  })

  it('shows delete confirmation when delete is clicked', async () => {
    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={fakeSwimlane}
        cardCount={0}
        onUpdated={vi.fn()}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
      />
    )
    await userEvent.setup().click(screen.getByText('Delete swimlane'))
    expect(screen.getByText('Delete swimlane?')).toBeInTheDocument()
  })

  it('shows cannot delete when cards exist', async () => {
    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={fakeSwimlane}
        cardCount={5}
        onUpdated={vi.fn()}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
      />
    )
    await userEvent.setup().click(screen.getByText('Delete swimlane'))
    expect(screen.getByText('Cannot delete swimlane')).toBeInTheDocument()
  })
})

describe('AddSwimlaneModal', () => {
  it('renders modal', () => {
    render(<AddSwimlaneModal boardId={1} onAdded={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Add Swimlane', { selector: 'h2' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Swimlane name')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('email@example.com')).toBeInTheDocument()
  })
})

describe('ForceChangePasswordModal', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders password change form', () => {
    render(<ForceChangePasswordModal user={fakeUser} onChanged={vi.fn()} />)
    expect(screen.getByText('Change your password')).toBeInTheDocument()
    expect(screen.getByText('Set new password')).toBeInTheDocument()
  })

  it('shows mismatch error', async () => {
    const { container } = render(<ForceChangePasswordModal user={fakeUser} onChanged={vi.fn()} />)
    const user = userEvent.setup()

    const passwordInputs = container.querySelectorAll('input[type="password"]')
    await user.type(passwordInputs[0] as HTMLElement, 'oldpassword')
    await user.type(passwordInputs[1] as HTMLElement, 'newpassword123')
    await user.type(passwordInputs[2] as HTMLElement, 'differentpassword')
    await user.click(screen.getByText('Set new password'))

    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument()
  })

  it('shows short password error', async () => {
    const { container } = render(<ForceChangePasswordModal user={fakeUser} onChanged={vi.fn()} />)
    const user = userEvent.setup()
    const passwordInputs = container.querySelectorAll('input[type="password"]')
    await user.type(passwordInputs[0] as HTMLElement, 'oldpw')
    await user.type(passwordInputs[1] as HTMLElement, 'short')
    await user.type(passwordInputs[2] as HTMLElement, 'short')
    await user.click(screen.getByText('Set new password'))

    expect(screen.getByText('New password must be at least 12 characters.')).toBeInTheDocument()
  })

  it('calls changePassword on valid submit', async () => {
    mockChangePassword.mockResolvedValue({ detail: 'ok' })
    const onChanged = vi.fn()
    const { container } = render(<ForceChangePasswordModal user={fakeUser} onChanged={onChanged} />)
    const user = userEvent.setup()
    const passwordInputs = container.querySelectorAll('input[type="password"]')
    await user.type(passwordInputs[0] as HTMLElement, 'oldpassword1')
    await user.type(passwordInputs[1] as HTMLElement, 'newpassword1234')
    await user.type(passwordInputs[2] as HTMLElement, 'newpassword1234')
    await user.click(screen.getByText('Set new password'))

    expect(mockChangePassword).toHaveBeenCalledWith('oldpassword1', 'newpassword1234')
  })
})
