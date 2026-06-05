import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../api/client', () => ({
  default: {
    post: vi.fn(),
    patch: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
}))

import client from '../api/client'
import {
  listGroups, createGroup, getGroup, updateGroup, deleteGroup,
  getGroupMembers, removeGroupMember, updateGroupMemberRole,
  getSubgroups, getGroupBoards, getGroupDescendantBoards, createGroupBoard,
  listInviteLinks, createInviteLink, revokeInviteLink,
  resolveJoinToken, joinGroup,
  starGroup, unstarGroup, listStarredGroups,
  updateGroupBoardDefaults,
  createGroupLabel, updateGroupLabel, deleteGroupLabel,
} from '../api/groups'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockClient = client as any

describe('groups API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('listGroups fetches groups', async () => {
    mockClient.get.mockResolvedValue({ data: { results: [] } })
    const result = await listGroups()
    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/groups/')
    expect(result).toEqual([])
  })

  it('createGroup posts group data', async () => {
    const group = { id: 1, name: 'Engineering' }
    mockClient.post.mockResolvedValue({ data: group })
    const result = await createGroup({ name: 'Engineering' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/v1/groups/', { name: 'Engineering' })
    expect(result).toEqual(group)
  })

  it('getGroup fetches single group', async () => {
    const group = { id: 1, name: 'Test' }
    mockClient.get.mockResolvedValue({ data: group })
    const result = await getGroup(1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/groups/1/')
    expect(result).toEqual(group)
  })

  it('updateGroup patches group', async () => {
    const group = { id: 1, name: 'Updated' }
    mockClient.patch.mockResolvedValue({ data: group })
    const result = await updateGroup(1, { name: 'Updated' })
    expect(mockClient.patch).toHaveBeenCalledWith('/api/v1/groups/1/', { name: 'Updated' })
    expect(result).toEqual(group)
  })

  it('deleteGroup sends delete', async () => {
    mockClient.delete.mockResolvedValue({})
    await deleteGroup(1)
    expect(mockClient.delete).toHaveBeenCalledWith('/api/v1/groups/1/')
  })

  it('getGroupMembers fetches members', async () => {
    mockClient.get.mockResolvedValue({ data: [] })
    const result = await getGroupMembers(1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/groups/1/members/')
    expect(result).toEqual([])
  })

  it('removeGroupMember sends delete', async () => {
    mockClient.delete.mockResolvedValue({})
    await removeGroupMember(1, 5)
    expect(mockClient.delete).toHaveBeenCalledWith('/api/v1/groups/1/members/5/')
  })

  it('updateGroupMemberRole patches role', async () => {
    const membership = { id: 1, role: 'admin' }
    mockClient.patch.mockResolvedValue({ data: membership })
    const result = await updateGroupMemberRole(1, 5, 'admin')
    expect(mockClient.patch).toHaveBeenCalledWith('/api/v1/groups/1/members/5/', { role: 'admin' })
    expect(result).toEqual(membership)
  })

  it('getSubgroups fetches subgroups', async () => {
    mockClient.get.mockResolvedValue({ data: [] })
    const result = await getSubgroups(1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/groups/1/subgroups/')
    expect(result).toEqual([])
  })

  it('getGroupBoards fetches boards', async () => {
    mockClient.get.mockResolvedValue({ data: [] })
    const result = await getGroupBoards(1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/groups/1/boards/')
    expect(result).toEqual([])
  })

  it('getGroupDescendantBoards fetches descendant boards', async () => {
    const boards = [{ id: 1, name: 'Board A' }, { id: 2, name: 'Board B' }]
    mockClient.get.mockResolvedValue({ data: boards })
    const result = await getGroupDescendantBoards(1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/groups/1/descendant-boards/')
    expect(result).toEqual(boards)
  })

  it('createGroupBoard posts board data', async () => {
    const board = { id: 1, name: 'New Board' }
    mockClient.post.mockResolvedValue({ data: board })
    const result = await createGroupBoard(1, { name: 'New Board' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/v1/groups/1/boards/', { name: 'New Board' })
    expect(result).toEqual(board)
  })

  it('listInviteLinks fetches invite links', async () => {
    const links = [{ id: 1, token: 'abc123' }]
    mockClient.get.mockResolvedValue({ data: links })
    const result = await listInviteLinks(1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/groups/1/invite-links/')
    expect(result).toEqual(links)
  })

  it('createInviteLink posts to invite-links endpoint', async () => {
    const link = { id: 1, token: 'abc123' }
    mockClient.post.mockResolvedValue({ data: link })
    const result = await createInviteLink(1, {})
    expect(mockClient.post).toHaveBeenCalledWith('/api/v1/groups/1/invite-links/', {})
    expect(result).toEqual(link)
  })

  it('revokeInviteLink sends delete', async () => {
    mockClient.delete.mockResolvedValue({})
    await revokeInviteLink(1, 7)
    expect(mockClient.delete).toHaveBeenCalledWith('/api/v1/groups/1/invite-links/7/')
  })

  it('resolveJoinToken fetches join info', async () => {
    const info = { group_id: 1, group_name: 'Test' }
    mockClient.get.mockResolvedValue({ data: info })
    const result = await resolveJoinToken('abc123')
    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/groups/join/abc123/')
    expect(result).toEqual(info)
  })

  it('joinGroup posts to join endpoint', async () => {
    const group = { id: 1, name: 'Test' }
    mockClient.post.mockResolvedValue({ data: group })
    const result = await joinGroup('abc123')
    expect(mockClient.post).toHaveBeenCalledWith('/api/v1/groups/join/abc123/')
    expect(result).toEqual(group)
  })

  // ------------------------------------------------------------------
  // Group favorites (star / unstar / list starred) — Part A new tests
  // ------------------------------------------------------------------

  it('starGroup POSTs to the star endpoint and returns response data', async () => {
    mockClient.post.mockResolvedValue({ data: { starred: true } })
    const result = await starGroup(3)
    expect(mockClient.post).toHaveBeenCalledWith('/api/v1/groups/3/star/')
    expect(result).toEqual({ starred: true })
  })

  it('unstarGroup sends DELETE to the star endpoint', async () => {
    mockClient.delete.mockResolvedValue({})
    await unstarGroup(3)
    expect(mockClient.delete).toHaveBeenCalledWith('/api/v1/groups/3/star/')
  })

  it('listStarredGroups GETs the starred filter URL and returns results array', async () => {
    const groups = [{ id: 3, name: 'Starred Group' }]
    mockClient.get.mockResolvedValue({ data: { results: groups } })
    const result = await listStarredGroups()
    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/groups/?starred=true')
    expect(result).toEqual(groups)
  })

  // ------------------------------------------------------------------
  // Board defaults — Part A new tests
  // ------------------------------------------------------------------

  it('updateGroupBoardDefaults PATCHes the board-defaults endpoint with default_board_member_role', async () => {
    const updated = { id: 1, default_board_member_role: 'viewer', allowed_priorities: ['low', 'medium'] }
    mockClient.patch.mockResolvedValue({ data: updated })
    const result = await updateGroupBoardDefaults(1, { default_board_member_role: 'viewer' })
    expect(mockClient.patch).toHaveBeenCalledWith('/api/v1/groups/1/board-defaults/', { default_board_member_role: 'viewer' })
    expect(result).toEqual(updated)
  })

  it('updateGroupBoardDefaults PATCHes the board-defaults endpoint with allowed_priorities', async () => {
    const updated = { id: 1, default_board_member_role: 'member', allowed_priorities: ['high', 'urgent'] }
    mockClient.patch.mockResolvedValue({ data: updated })
    const result = await updateGroupBoardDefaults(1, { allowed_priorities: ['high', 'urgent'] })
    expect(mockClient.patch).toHaveBeenCalledWith('/api/v1/groups/1/board-defaults/', { allowed_priorities: ['high', 'urgent'] })
    expect(result).toEqual(updated)
  })

  // ------------------------------------------------------------------
  // Group labels — Part A new tests
  // ------------------------------------------------------------------

  it('createGroupLabel POSTs to the labels endpoint with name and color', async () => {
    const label = { id: 7, name: 'Bug', color: '#EF4444' }
    mockClient.post.mockResolvedValue({ data: label })
    const result = await createGroupLabel(1, { name: 'Bug', color: '#EF4444' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/v1/groups/1/labels/', { name: 'Bug', color: '#EF4444' })
    expect(result).toEqual(label)
  })

  it('updateGroupLabel PATCHes the specific label endpoint', async () => {
    const updated = { id: 7, name: 'Defect', color: '#EF4444' }
    mockClient.patch.mockResolvedValue({ data: updated })
    const result = await updateGroupLabel(1, 7, { name: 'Defect' })
    expect(mockClient.patch).toHaveBeenCalledWith('/api/v1/groups/1/labels/7/', { name: 'Defect' })
    expect(result).toEqual(updated)
  })

  it('deleteGroupLabel sends DELETE to the specific label endpoint', async () => {
    mockClient.delete.mockResolvedValue({})
    await deleteGroupLabel(1, 7)
    expect(mockClient.delete).toHaveBeenCalledWith('/api/v1/groups/1/labels/7/')
  })
})
