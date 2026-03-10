import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import GroupTree, { buildGroupTree } from '../components/Group/GroupTree'
import type { Group, User } from '../types'

vi.mock('../api/groups', () => ({
  createGroup: vi.fn(),
}))

const fakeOwner: User = {
  id: 1, username: 'admin', email: 'a@b.com', first_name: 'Admin',
  last_name: '', avatar_url: '', display_name: 'Admin',
  is_site_admin: false, must_change_password: false,
}

function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 1, name: 'Engineering', owner: fakeOwner,
    parent: null, parent_name: null,
    member_count: 3, board_count: 2, subgroup_count: 0, created_at: '',
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
})
