import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import GroupTree, { buildGroupTree } from '../components/Group/GroupTree'
import type { Group, User } from '../types'

vi.mock('../api/groups', () => ({
  createGroup: vi.fn(),
}))

vi.mock('../components/Group/CreateGroupModal', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="create-group-modal">
      <button onClick={onClose}>Close</button>
    </div>
  ),
}))

const fakeOwner: User = {
  id: 1, username: 'admin', email: 'a@b.com', first_name: 'Admin',
  last_name: '', avatar_url: '', display_name: 'Admin',
  is_site_admin: false, must_change_password: false,
}

function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 1, name: 'Engineering', description: '', owner: fakeOwner,
    parent: null, parent_name: null,
    member_count: 3, board_count: 2, subgroup_count: 0, created_at: '',
    default_board_member_role: 'member', allowed_priorities: [], shared_labels: [],
    is_starred: false,
    ...overrides,
  }
}

describe('buildGroupTree', () => {
  it('returns roots for groups without parents', () => {
    const groups = [makeGroup({ id: 1 }), makeGroup({ id: 2, name: 'Design' })]
    const tree = buildGroupTree(groups)
    expect(tree).toHaveLength(2)
    expect(tree[0].group.name).toBe('Engineering')
    expect(tree[1].group.name).toBe('Design')
  })

  it('nests children under their parent', () => {
    const groups = [
      makeGroup({ id: 1 }),
      makeGroup({ id: 2, name: 'Backend', parent: 1, parent_name: 'Engineering' }),
    ]
    const tree = buildGroupTree(groups)
    expect(tree).toHaveLength(1)
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].group.name).toBe('Backend')
  })

  it('handles orphaned children as roots', () => {
    const groups = [
      makeGroup({ id: 2, name: 'Orphan', parent: 999, parent_name: 'Missing' }),
    ]
    const tree = buildGroupTree(groups)
    expect(tree).toHaveLength(1)
    expect(tree[0].group.name).toBe('Orphan')
  })
})

describe('GroupTree', () => {
  it('renders group names', () => {
    const nodes = buildGroupTree([
      makeGroup({ id: 1, name: 'Engineering' }),
      makeGroup({ id: 2, name: 'Design' }),
    ])
    render(
      <MemoryRouter>
        <GroupTree nodes={nodes} onGroupCreated={vi.fn()} />
      </MemoryRouter>
    )
    expect(screen.getByText('Engineering')).toBeInTheDocument()
    expect(screen.getByText('Design')).toBeInTheDocument()
  })

  it('renders stats for groups', () => {
    const nodes = buildGroupTree([makeGroup({ board_count: 3, member_count: 5 })])
    render(
      <MemoryRouter>
        <GroupTree nodes={nodes} onGroupCreated={vi.fn()} />
      </MemoryRouter>
    )
    expect(screen.getByText(/3 boards/)).toBeInTheDocument()
    expect(screen.getByText(/5 members/)).toBeInTheDocument()
  })

  it('expands children when the chevron is clicked', async () => {
    const nodes = buildGroupTree([
      makeGroup({ id: 1, name: 'Engineering', subgroup_count: 1 }),
      makeGroup({ id: 2, name: 'Backend', parent: 1, parent_name: 'Engineering' }),
    ])
    render(
      <MemoryRouter>
        <GroupTree nodes={nodes} onGroupCreated={vi.fn()} />
      </MemoryRouter>
    )
    expect(screen.queryByText('Backend')).not.toBeInTheDocument()
    // click the expand chevron (first button in the row)
    const allButtons = screen.getAllByRole('button')
    // The chevron is the first button inside the Engineering row
    await userEvent.setup().click(allButtons[0])
    expect(screen.getByText('Backend')).toBeInTheDocument()
  })

  it('opens CreateGroupModal when add-subgroup button is clicked', async () => {
    const nodes = buildGroupTree([makeGroup({ id: 1, name: 'Engineering' })])
    render(
      <MemoryRouter>
        <GroupTree nodes={nodes} onGroupCreated={vi.fn()} />
      </MemoryRouter>
    )
    expect(screen.queryByTestId('create-group-modal')).not.toBeInTheDocument()
    const addBtn = screen.getByTitle('Add subgroup to Engineering')
    await userEvent.setup().click(addBtn)
    expect(screen.getByTestId('create-group-modal')).toBeInTheDocument()
  })

  it('closes CreateGroupModal when modal calls onClose', async () => {
    const nodes = buildGroupTree([makeGroup({ id: 1, name: 'Engineering' })])
    render(
      <MemoryRouter>
        <GroupTree nodes={nodes} onGroupCreated={vi.fn()} />
      </MemoryRouter>
    )
    await userEvent.setup().click(screen.getByTitle('Add subgroup to Engineering'))
    expect(screen.getByTestId('create-group-modal')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByText('Close'))
    expect(screen.queryByTestId('create-group-modal')).not.toBeInTheDocument()
  })
})
