import { describe, it, expect } from 'vitest'
import { buildSidebarTree } from '../utils/groupTree'
import type { Group, Board, User } from '../types'

const fakeUser: User = {
  id: 1, username: 'u', email: 'u@example.com', first_name: '', last_name: '',
  avatar_url: '', display_name: 'U', is_site_admin: false,
  must_change_password: false, has_usable_password: true,
}

function makeGroup(id: number, parent: number | null = null): Group {
  return {
    id, name: `Group ${id}`, description: '', owner: fakeUser,
    parent, parent_name: null, member_count: 0, board_count: 0,
    subgroup_count: 0, created_at: '', default_board_member_role: 'member',
    allowed_priorities: [], shared_labels: [], is_starred: false,
  }
}

function makeBoard(id: number, group: number | null = null): Board {
  return {
    id, uid: `uid${id}`, name: `Board ${id}`, description: '', owner: fakeUser,
    group, group_name: group !== null ? `Group ${group}` : null,
    member_count: 0, card_count: 0, staleness_threshold_days: 7,
    stale_warning_pct: 50, allowed_priorities: [], enforce_wip_limits: false, enforce_wip_hard: false,
    enforce_weight_limits: false, is_starred: false, created_at: '', updated_at: '',
  }
}

describe('buildSidebarTree', () => {
  it('returns empty array for no groups', () => {
    expect(buildSidebarTree([], [])).toEqual([])
  })

  it('returns single root node for a group with no parent', () => {
    const tree = buildSidebarTree([makeGroup(1)], [])
    expect(tree).toHaveLength(1)
    expect(tree[0].group.id).toBe(1)
    expect(tree[0].children).toHaveLength(0)
    expect(tree[0].boards).toHaveLength(0)
  })

  it('nests a subgroup under its parent', () => {
    const tree = buildSidebarTree([makeGroup(1), makeGroup(2, 1)], [])
    expect(tree).toHaveLength(1)
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].group.id).toBe(2)
  })

  it('assigns boards to their group node', () => {
    const tree = buildSidebarTree([makeGroup(1)], [makeBoard(10, 1)])
    expect(tree[0].boards).toHaveLength(1)
    expect(tree[0].boards[0].id).toBe(10)
  })

  it('boards with no group are not included in the tree', () => {
    const tree = buildSidebarTree([makeGroup(1)], [makeBoard(10, null)])
    expect(tree[0].boards).toHaveLength(0)
  })

  it('boards in a subgroup appear on the subgroup node', () => {
    const tree = buildSidebarTree([makeGroup(1), makeGroup(2, 1)], [makeBoard(10, 2)])
    expect(tree[0].boards).toHaveLength(0)
    expect(tree[0].children[0].boards).toHaveLength(1)
    expect(tree[0].children[0].boards[0].id).toBe(10)
  })

  it('handles three levels of nesting', () => {
    const tree = buildSidebarTree([makeGroup(1), makeGroup(2, 1), makeGroup(3, 2)], [])
    expect(tree).toHaveLength(1)
    expect(tree[0].children[0].children[0].group.id).toBe(3)
  })

  it('treats a subgroup as root when its parent is not in the list', () => {
    // User has access to subgroup 2 but not its parent 1
    const tree = buildSidebarTree([makeGroup(2, 1)], [])
    expect(tree).toHaveLength(1)
    expect(tree[0].group.id).toBe(2)
  })

  it('returns multiple root nodes for multiple top-level groups', () => {
    const tree = buildSidebarTree([makeGroup(1), makeGroup(2)], [])
    expect(tree).toHaveLength(2)
  })

  it('boards whose group ID is absent from groups are silently ignored', () => {
    // board 10 references group 99 which doesn't exist
    const tree = buildSidebarTree([makeGroup(1)], [makeBoard(10, 99)])
    expect(tree[0].boards).toHaveLength(0)
  })
})
