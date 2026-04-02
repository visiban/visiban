import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CreateGroupModal from '../components/Group/CreateGroupModal'
import type { Group } from '../types'

vi.mock('../api/groups', () => ({
  createGroup: vi.fn(),
}))

import { createGroup } from '../api/groups'

const mockCreateGroup = createGroup as ReturnType<typeof vi.fn>

function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 1,
    name: 'Engineering',
    description: '',
    owner: { id: 1, username: 'admin', display_name: 'Admin', avatar_url: '' },
    parent: null,
    parent_name: null,
    member_count: 1,
    board_count: 0,
    subgroup_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    default_board_member_role: 'member',
    allowed_priorities: [],
    shared_labels: [],
    is_starred: false,
    ...overrides,
  }
}

describe('CreateGroupModal', () => {
  const onCreated = vi.fn()
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ----------------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------------

  it('renders with title "New Group" when no parent is provided', () => {
    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    expect(screen.getByText('New Group')).toBeInTheDocument()
  })

  it('renders title reflecting the parent group name when parentGroup is provided', () => {
    const parent = makeGroup({ name: 'Engineering' })
    render(<CreateGroupModal parentGroup={parent} onCreated={onCreated} onClose={onClose} />)
    expect(screen.getByText('New subgroup of "Engineering"')).toBeInTheDocument()
  })

  it('renders Name input and Create button', () => {
    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    expect(screen.getByPlaceholderText('e.g. Engineering')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create/i })).toBeInTheDocument()
  })

  // ----------------------------------------------------------------
  // Disabled state — empty name
  // ----------------------------------------------------------------

  it('disables the Create button when the name field is empty', () => {
    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled()
  })

  it('enables the Create button once a non-whitespace name is entered', async () => {
    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    await userEvent.setup().type(screen.getByPlaceholderText('e.g. Engineering'), 'Infra')
    expect(screen.getByRole('button', { name: /create/i })).not.toBeDisabled()
  })

  // ----------------------------------------------------------------
  // Enter key — happy path
  // ----------------------------------------------------------------

  it('calls createGroup with trimmed name when Enter is pressed on the Name input', async () => {
    const created = makeGroup({ name: 'Infra' })
    mockCreateGroup.mockResolvedValue(created)

    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    const user = userEvent.setup()
    const input = screen.getByPlaceholderText('e.g. Engineering')

    await user.type(input, 'Infra')
    await user.keyboard('{Enter}')

    expect(mockCreateGroup).toHaveBeenCalledOnce()
    expect(mockCreateGroup).toHaveBeenCalledWith({ name: 'Infra', parent: null })
  })

  it('calls onCreated with the returned group after Enter-key submit', async () => {
    const created = makeGroup({ name: 'Infra' })
    mockCreateGroup.mockResolvedValue(created)

    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('e.g. Engineering'), 'Infra')
    await user.keyboard('{Enter}')

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created))
  })

  it('passes the parent group id when Enter is pressed in a subgroup modal', async () => {
    const parent = makeGroup({ id: 7, name: 'Engineering' })
    const created = makeGroup({ id: 99, name: 'Frontend', parent: 7 })
    mockCreateGroup.mockResolvedValue(created)

    render(<CreateGroupModal parentGroup={parent} onCreated={onCreated} onClose={onClose} />)
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('e.g. Engineering'), 'Frontend')
    await user.keyboard('{Enter}')

    expect(mockCreateGroup).toHaveBeenCalledWith({ name: 'Frontend', parent: 7 })
  })

  // ----------------------------------------------------------------
  // Enter key — empty name must NOT submit
  // ----------------------------------------------------------------

  it('does NOT call createGroup when Enter is pressed with an empty name', async () => {
    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    const user = userEvent.setup()

    // Focus the input without typing, then press Enter
    await user.click(screen.getByPlaceholderText('e.g. Engineering'))
    await user.keyboard('{Enter}')

    expect(mockCreateGroup).not.toHaveBeenCalled()
  })

  it('does NOT call createGroup when Enter is pressed with a whitespace-only name', async () => {
    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('e.g. Engineering'), '   ')
    await user.keyboard('{Enter}')

    expect(mockCreateGroup).not.toHaveBeenCalled()
  })

  // ----------------------------------------------------------------
  // Button-click submit (sanity parity)
  // ----------------------------------------------------------------

  it('calls createGroup when the Create button is clicked with a valid name', async () => {
    const created = makeGroup({ name: 'Design' })
    mockCreateGroup.mockResolvedValue(created)

    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('e.g. Engineering'), 'Design')
    await user.click(screen.getByRole('button', { name: /create/i }))

    expect(mockCreateGroup).toHaveBeenCalledOnce()
  })

  // ----------------------------------------------------------------
  // Loading state
  // ----------------------------------------------------------------

  it('shows "Creating…" on the button while the API call is in flight', async () => {
    // Never resolve so the saving state remains visible
    mockCreateGroup.mockReturnValue(new Promise(() => {}))

    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('e.g. Engineering'), 'Ops')
    await user.keyboard('{Enter}')

    expect(await screen.findByText('Creating…')).toBeInTheDocument()
  })

  // ----------------------------------------------------------------
  // Success feedback
  // ----------------------------------------------------------------

  it('shows a success message and resets the input after a successful save', async () => {
    const created = makeGroup({ name: 'Ops' })
    mockCreateGroup.mockResolvedValue(created)

    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('e.g. Engineering'), 'Ops')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(screen.getByText(/✓ "Ops" created/)).toBeInTheDocument()
    )
    // Input is cleared so the user can type the next group immediately
    expect(screen.getByPlaceholderText('e.g. Engineering')).toHaveValue('')
  })

  it('relabels Cancel to Close after a successful save', async () => {
    const created = makeGroup({ name: 'Ops' })
    mockCreateGroup.mockResolvedValue(created)

    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('e.g. Engineering'), 'Ops')
    await user.keyboard('{Enter}')

    await waitFor(() => expect(screen.getByText("Close")).toBeInTheDocument())
    expect(screen.queryByText("Cancel")).not.toBeInTheDocument()
  })

  // ----------------------------------------------------------------
  // Error state
  // ----------------------------------------------------------------

  it('shows a server-provided error message when createGroup rejects with a detail error', async () => {
    mockCreateGroup.mockRejectedValue({
      response: { data: { detail: 'A group with this name already exists.' } },
    })

    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('e.g. Engineering'), 'Duplicate')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(screen.getByText('A group with this name already exists.')).toBeInTheDocument()
    )
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('shows a server-provided error message when createGroup rejects with a name field error', async () => {
    mockCreateGroup.mockRejectedValue({
      response: { data: { name: ['This field may not be blank.'] } },
    })

    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('e.g. Engineering'), 'Bad')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(screen.getByText('This field may not be blank.')).toBeInTheDocument()
    )
  })

  it('shows a fallback error message when the API rejects with no structured body', async () => {
    mockCreateGroup.mockRejectedValue(new Error('Network Error'))

    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('e.g. Engineering'), 'Oops')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(screen.getByText('Failed to create group.')).toBeInTheDocument()
    )
  })

  // ----------------------------------------------------------------
  // Description character counter
  // ----------------------------------------------------------------

  it('disables Create when description exceeds 500 characters', async () => {
    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('e.g. Engineering'), 'Valid Name')
    // Use fireEvent.change for the large string — userEvent.type fires one event
    // per character and is too slow for 500+ chars in CI's default 5 s timeout.
    fireEvent.change(screen.getByPlaceholderText('What is this group for?'), {
      target: { value: 'x'.repeat(501) },
    })

    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled()
  })

  // ----------------------------------------------------------------
  // Cancel / close
  // ----------------------------------------------------------------

  it('calls onClose when the Cancel button is clicked', async () => {
    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /cancel/i }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  // ----------------------------------------------------------------
  // Accessibility
  // ----------------------------------------------------------------

  it('Name input is focusable and reachable by placeholder text', () => {
    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    const input = screen.getByPlaceholderText('e.g. Engineering')
    expect(input).toBeInTheDocument()
    expect(input.tagName).toBe('INPUT')
  })

  it('Create button is reachable by role', () => {
    render(<CreateGroupModal onCreated={onCreated} onClose={onClose} />)
    expect(screen.getByRole('button', { name: /create/i })).toBeInTheDocument()
  })
})
