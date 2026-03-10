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
  getSubgroups, getGroupBoards, createGroupBoard,
  generateInviteLink, deactivateInviteLink,
  resolveJoinToken, joinGroup,
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
    expect(mockClient.get).toHaveBeenCalledWith('/api/groups/')
    expect(result).toEqual([])
  })

  it('createGroup posts group data', async () => {
    const group = { id: 1, name: 'Engineering' }
    mockClient.post.mockResolvedValue({ data: group })
    const result = await createGroup({ name: 'Engineering' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/groups/', { name: 'Engineering' })
    expect(result).toEqual(group)
  })

  it('getGroup fetches single group', async () => {
    const group = { id: 1, name: 'Test' }
    mockClient.get.mockResolvedValue({ data: group })
    const result = await getGroup(1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/groups/1/')
    expect(result).toEqual(group)
  })

  it('updateGroup patches group', async () => {
    const group = { id: 1, name: 'Updated' }
    mockClient.patch.mockResolvedValue({ data: group })
    const result = await updateGroup(1, { name: 'Updated' })
    expect(mockClient.patch).toHaveBeenCalledWith('/api/groups/1/', { name: 'Updated' })
    expect(result).toEqual(group)
  })

  it('deleteGroup sends delete', async () => {
    mockClient.delete.mockResolvedValue({})
    await deleteGroup(1)
    expect(mockClient.delete).toHaveBeenCalledWith('/api/groups/1/')
  })

  it('getGroupMembers fetches members', async () => {
    mockClient.get.mockResolvedValue({ data: [] })
    const result = await getGroupMembers(1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/groups/1/members/')
    expect(result).toEqual([])
  })

  it('removeGroupMember sends delete', async () => {
    mockClient.delete.mockResolvedValue({})
    await removeGroupMember(1, 5)
    expect(mockClient.delete).toHaveBeenCalledWith('/api/groups/1/members/5/')
  })

  it('updateGroupMemberRole patches role', async () => {
    const membership = { id: 1, role: 'admin' }
    mockClient.patch.mockResolvedValue({ data: membership })
    const result = await updateGroupMemberRole(1, 5, 'admin')
    expect(mockClient.patch).toHaveBeenCalledWith('/api/groups/1/members/5/', { role: 'admin' })
    expect(result).toEqual(membership)
  })

  it('getSubgroups fetches subgroups', async () => {
    mockClient.get.mockResolvedValue({ data: [] })
    const result = await getSubgroups(1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/groups/1/subgroups/')
    expect(result).toEqual([])
  })

  it('getGroupBoards fetches boards', async () => {
    mockClient.get.mockResolvedValue({ data: [] })
    const result = await getGroupBoards(1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/groups/1/boards/')
    expect(result).toEqual([])
  })

  it('createGroupBoard posts board data', async () => {
    const board = { id: 1, name: 'New Board' }
    mockClient.post.mockResolvedValue({ data: board })
    const result = await createGroupBoard(1, { name: 'New Board' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/groups/1/boards/', { name: 'New Board' })
    expect(result).toEqual(board)
  })

  it('generateInviteLink posts to invite endpoint', async () => {
    const link = { id: 1, token: 'abc123' }
    mockClient.post.mockResolvedValue({ data: link })
    const result = await generateInviteLink(1)
    expect(mockClient.post).toHaveBeenCalledWith('/api/groups/1/invite-link/')
    expect(result).toEqual(link)
  })

  it('deactivateInviteLink sends delete', async () => {
    mockClient.delete.mockResolvedValue({})
    await deactivateInviteLink(1)
    expect(mockClient.delete).toHaveBeenCalledWith('/api/groups/1/invite-link/')
  })

  it('resolveJoinToken fetches join info', async () => {
    const info = { group_id: 1, group_name: 'Test' }
    mockClient.get.mockResolvedValue({ data: info })
    const result = await resolveJoinToken('abc123')
    expect(mockClient.get).toHaveBeenCalledWith('/api/groups/join/abc123/')
    expect(result).toEqual(info)
  })

  it('joinGroup posts to join endpoint', async () => {
    const group = { id: 1, name: 'Test' }
    mockClient.post.mockResolvedValue({ data: group })
    const result = await joinGroup('abc123')
    expect(mockClient.post).toHaveBeenCalledWith('/api/groups/join/abc123/')
    expect(result).toEqual(group)
  })
})
