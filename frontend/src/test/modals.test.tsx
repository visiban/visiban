import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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
  id: 1, name: 'Test Board', description: '', owner: fakeUser,
  group: null, group_name: null, member_count: 1, card_count: 0, is_starred: false, created_at: '', updated_at: '',
}

const fakeColumn: Column = {
  id: 10, name: 'To Do', position: 0, color: '#3B82F6',
  wip_limit: null, weight_limit: null, allow_card_creation: true,
}

const fakeSwimlane: Swimlane = {
  id: 20, name: 'Lane A', contact_email: '', notes: '', position: 0,
  color: '#6B7280', is_collapsed: false, created_at: '2026-01-01',
}

describe('CreateBoardModal', () => {
  it('renders modal with template picker', () => {
    render(<CreateBoardModal onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('New Board')).toBeInTheDocument()
    expect(screen.getByText('Simple Kanban')).toBeInTheDocument()
    expect(screen.getByText('Sales Pipeline')).toBeInTheDocument()
    expect(screen.getByText('Blank Board')).toBeInTheDocument()
    expect(screen.getByText('Create Board')).toBeInTheDocument()
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
