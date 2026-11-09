/**
 * GroupDetail resync of the group, subgroups, members and subgroup boards
 * (#2136): a reconnect or late first open re-reads them as well as the boards
 * list, and a frame applied while a re-read is in flight is replayed over its
 * answer, so the answer cannot undo it (the subgroup list also has the
 * sequence guard).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, createMemoryRouter, RouterProvider } from 'react-router-dom'
import GroupDetail from '../pages/GroupDetail'
import type { User, Group, Board } from '../types'
import type { BoardEvent } from '../hooks/useBoardSocket'

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock('../components/Group/CreateGroupModal', () => ({
  default: ({ onCreated }: { onCreated: (g: Group) => void }) => (
    <button onClick={() => onCreated({ ...fakeGroup, id: 12, name: 'Fresh', parent: 1 })}>Confirm create subgroup</button>
  ),
}))

vi.mock('../components/Board/CreateBoardModal', () => ({
  default: ({ onConfirm }: { onConfirm: (n: string, t: string, s: string, d: boolean) => void }) => (
    <button onClick={() => onConfirm('Made Here', 'simple_kanban', '', false)}>Confirm create board</button>
  ),
}))

// Moves the board to group 2, as the real modal's onMoved reports it.
vi.mock('../components/Board/MoveBoardModal', () => ({
  default: ({ board, onMoved }: { board: Board; onMoved: (b: Board) => void }) => (
    <button onClick={() => onMoved({ ...board, group: 2 })}>Confirm move board</button>
  ),
}))

let capturedOnEvent: ((evt: BoardEvent) => void) | null = null
let capturedOnReconnected: (() => void) | null = null
vi.mock('../hooks/useGroupSocket', () => ({
  useGroupSocket: (
    _groupId: number | null,
    onEvent: (evt: BoardEvent) => void,
    options?: { onReconnected?: () => void },
  ) => {
    capturedOnEvent = onEvent
    capturedOnReconnected = options?.onReconnected ?? null
    return { connected: true, status: 'connected', lastEventAt: null, reconnectAttempt: 0 }
  },
}))

vi.mock('../api/groups', () => ({
  getGroup: vi.fn(),
  getGroupMembers: vi.fn(),
  getSubgroups: vi.fn(),
  getGroupBoards: vi.fn(),
  getGroupDescendantBoards: vi.fn().mockResolvedValue([]),
  createGroupBoard: vi.fn(),
  removeGroupMember: vi.fn(),
  updateGroupMemberRole: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
  listInviteLinks: vi.fn().mockResolvedValue([]),
  createInviteLink: vi.fn(),
  revokeInviteLink: vi.fn(),
  transferGroupOwnership: vi.fn(),
  starGroup: vi.fn().mockResolvedValue({}),
  unstarGroup: vi.fn().mockResolvedValue({}),
  createGroupLabel: vi.fn(),
  deleteGroupLabel: vi.fn().mockResolvedValue({}),
  updateGroupBoardDefaults: vi.fn(),
}))

vi.mock('../api/boards', () => ({
  importBoard: vi.fn(),
  previewTrelloImport: vi.fn(),
  confirmTrelloImport: vi.fn(),
}))

vi.mock('../api/notifications', () => ({
  getUnreadCount: vi.fn().mockResolvedValue(0),
  listNotifications: vi.fn().mockResolvedValue([]),
  markAllRead: vi.fn(),
  markRead: vi.fn(),
}))

vi.mock('../api/auth', () => ({
  getVersion: vi.fn().mockResolvedValue('0.3.0'),
  getSiteConfig: vi.fn().mockResolvedValue({
    registration_open: true,
    registration_mode: 'open',
    demo_mode: false,
    demo_login: null,
    invite_email_available: false,
  }),
}))

import { getGroup, getGroupMembers, getSubgroups, getGroupBoards, getGroupDescendantBoards, createGroupLabel, updateGroup } from '../api/groups'

const mockCreateGroupLabel = createGroupLabel as ReturnType<typeof vi.fn>
const mockUpdateGroup = updateGroup as ReturnType<typeof vi.fn>
const mockGetGroup = getGroup as ReturnType<typeof vi.fn>
const mockGetGroupMembers = getGroupMembers as ReturnType<typeof vi.fn>
const mockGetSubgroups = getSubgroups as ReturnType<typeof vi.fn>
const mockGetGroupBoards = getGroupBoards as ReturnType<typeof vi.fn>
const mockGetGroupDescendantBoards = getGroupDescendantBoards as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false,
}

const fakeGroup: Group = {
  health_status: null, effective_health_status: null, health_status_source: null,
  id: 1, name: 'Engineering', description: '', owner: fakeUser,
  parent: null, parent_name: null,
  member_count: 2, board_count: 1, subgroup_count: 0, created_at: '',
  default_board_member_role: 'member', allowed_priorities: [], shared_labels: [],
  is_starred: false, navigation_only: false, can_place_boards: true,
}

function board(id: number, name: string, extra: Partial<Board> = {}): Board {
  return {
    id, uid: `uid-${id}`, name, description: '', owner: fakeUser,
    group: 1, group_name: 'Engineering', member_count: 1,
    created_at: '', updated_at: '', is_starred: false,
    ...extra,
  } as Board
}

const alpha = board(1, 'Alpha')


function deferred<T>(mock: ReturnType<typeof vi.fn>) {
  let answer: (v: T) => void = () => {}
  let fail: (e: unknown) => void = () => {}
  mock.mockImplementationOnce(() => new Promise<T>((res, rej) => { answer = res; fail = rej }))
  return {
    answer: async (v: T) => { await act(async () => { answer(v) }) },
    fail: async (e: unknown) => { await act(async () => { fail(e) }) },
  }
}

const sub = (id: number, name: string): Group => ({ ...fakeGroup, id, name, parent: 1 })
const member = (id: number, name: string) => ({
  id, user: { ...fakeUser, id, username: name, display_name: name }, role: 'member', joined_at: '',
})

async function loadGroup() {
  mockGetGroupBoards.mockResolvedValueOnce([alpha])
  render(
    <MemoryRouter initialEntries={['/groups/1']}>
      <Routes>
        <Route path="/groups/:id" element={<GroupDetail user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />} />
      </Routes>
    </MemoryRouter>,
  )
  await screen.findByText('+ New board')
}

function openSettings() { fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0]) }
function reconnect() { act(() => { capturedOnReconnected?.() }) }
function frame(evt: BoardEvent) { act(() => { capturedOnEvent?.(evt) }) }

describe('GroupDetail resync of group, subgroups and members (#2136)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnEvent = null
    capturedOnReconnected = null
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([member(1, 'jdoe')])
    mockGetSubgroups.mockResolvedValue([sub(10, 'Platform'), sub(11, 'Mobile')])
    mockGetGroupDescendantBoards.mockResolvedValue([])
    mockGetGroupBoards.mockReset()
    mockGetGroupBoards.mockResolvedValue([alpha])
  })

  it('re-reads the group, subgroups and members on a reconnect and shows what was missed', async () => {
    await loadGroup()
    expect(screen.getByText('Platform')).toBeTruthy()
    mockGetGroup.mockResolvedValue({ ...fakeGroup, shared_labels: [{ id: 5, name: 'Missed Label', color: '#ff0000' }] })
    mockGetSubgroups.mockResolvedValue([sub(10, 'Platform'), sub(12, 'Created While Offline')])
    mockGetGroupMembers.mockResolvedValue([member(1, 'jdoe'), member(2, 'newcomer')])
    reconnect()
    await screen.findByText('Created While Offline')
    expect(screen.queryByText('Mobile')).toBeNull()
    openSettings()
    expect(await screen.findByText('newcomer')).toBeTruthy()
    expect(await screen.findByText('Missed Label')).toBeTruthy()
    expect(mockGetGroup).toHaveBeenCalledTimes(2)
    expect(mockGetSubgroups).toHaveBeenCalledTimes(2)
    expect(mockGetGroupMembers).toHaveBeenCalledTimes(2)
    // Not shown, so not fetched.
    expect(mockGetGroupDescendantBoards).not.toHaveBeenCalled()
  })

  it('re-reads the descendant boards on a reconnect while they are shown', async () => {
    await loadGroup()
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(mockGetGroupDescendantBoards).toHaveBeenCalledTimes(1))
    mockGetGroupDescendantBoards.mockResolvedValue([board(30, 'Deep Board', { group: 10 })])
    reconnect()
    expect(await screen.findByText('Deep Board')).toBeTruthy()
    expect(mockGetGroupDescendantBoards).toHaveBeenCalledTimes(2)
  })

  it('keeps a subgroup deleted during the re-read gone when the answer still lists it', async () => {
    await loadGroup()
    const reread = deferred<Group[]>(mockGetSubgroups)
    reconnect()
    frame({ event: 'group.deleted', data: { id: 11 } } as BoardEvent)
    expect(screen.queryByText('Mobile')).toBeNull()
    // The answer was read before the delete committed.
    await reread.answer([sub(10, 'Platform'), sub(11, 'Mobile')])
    expect(screen.queryByText('Mobile')).toBeNull()
    expect(screen.getByText('Platform')).toBeTruthy()
  })

  it('keeps a subgroup deleted while a group.created re-read is in flight gone', async () => {
    await loadGroup()
    const reread = deferred<Group[]>(mockGetSubgroups)
    frame({ event: 'group.created', data: { id: 12 } } as BoardEvent)
    frame({ event: 'group.deleted', data: { id: 11 } } as BoardEvent)
    await reread.answer([sub(10, 'Platform'), sub(11, 'Mobile'), sub(12, 'Fresh')])
    expect(screen.queryByText('Mobile')).toBeNull()
    expect(screen.getByText('Fresh')).toBeTruthy()
  })

  it('does not let an older overlapping subgroups read that answers last bring a deleted subgroup back', async () => {
    await loadGroup()
    const first = deferred<Group[]>(mockGetSubgroups)
    reconnect()
    const second = deferred<Group[]>(mockGetSubgroups)
    frame({ event: 'group.created', data: { id: 12 } } as BoardEvent)
    frame({ event: 'group.deleted', data: { id: 11 } } as BoardEvent)
    await second.answer([sub(10, 'Platform')])
    await first.answer([sub(10, 'Platform'), sub(11, 'Mobile')])
    expect(screen.queryByText('Mobile')).toBeNull()
  })

  it('keeps a member change from a re-read answered stale: the latest started read wins', async () => {
    await loadGroup()
    openSettings()
    const first = deferred<ReturnType<typeof member>[]>(mockGetGroupMembers)
    reconnect()
    const second = deferred<ReturnType<typeof member>[]>(mockGetGroupMembers)
    frame({ event: 'member.added', data: {} } as BoardEvent)
    await second.answer([member(1, 'jdoe'), member(2, 'newcomer')])
    await first.answer([member(1, 'jdoe')])
    expect(screen.getByText('newcomer')).toBeTruthy()
  })

  it('does not let a stale group answer revert a newer one', async () => {
    await loadGroup()
    openSettings()
    const first = deferred<Group>(mockGetGroup)
    frame({ event: 'group.updated', data: { id: 1 } } as BoardEvent)
    const second = deferred<Group>(mockGetGroup)
    frame({ event: 'group.label.created', data: {} } as BoardEvent)
    await second.answer({ ...fakeGroup, shared_labels: [{ id: 5, name: 'Newest Label', color: '#ff0000' }] })
    await first.answer(fakeGroup)
    expect(screen.getByText('Newest Label')).toBeTruthy()
  })

  it('keeps the current lists when a re-read fails', async () => {
    await loadGroup()
    mockGetGroup.mockRejectedValue(new Error('down'))
    mockGetSubgroups.mockRejectedValue(new Error('down'))
    mockGetGroupMembers.mockRejectedValue(new Error('down'))
    reconnect()
    await waitFor(() => expect(mockGetSubgroups).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Platform')).toBeTruthy()
    expect(screen.getByText('Mobile')).toBeTruthy()
    openSettings()
    expect(screen.getByText('jdoe')).toBeTruthy()
  })

  it('does not let the initial load overwrite a re-read that already applied', async () => {
    let answerSubgroups: (g: Group[]) => void = () => {}
    mockGetSubgroups.mockImplementationOnce(() => new Promise<Group[]>((res) => { answerSubgroups = res }))
    mockGetGroupBoards.mockResolvedValueOnce([alpha])
    render(
      <MemoryRouter initialEntries={['/groups/1']}>
        <Routes>
          <Route path="/groups/:id" element={<GroupDetail user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(capturedOnReconnected).not.toBeNull())
    mockGetSubgroups.mockResolvedValueOnce([sub(10, 'Platform')])
    reconnect()
    await waitFor(() => expect(mockGetSubgroups).toHaveBeenCalledTimes(2))
    await act(async () => { answerSubgroups([sub(10, 'Platform'), sub(11, 'Mobile')]) })
    await screen.findByText('+ New board')
    expect(screen.getByText('Platform')).toBeTruthy()
    expect(screen.queryByText('Mobile')).toBeNull()
  })

  it('keeps the initial load subgroups when a re-read started before it fails', async () => {
    let answerSubgroups: (g: Group[]) => void = () => {}
    mockGetSubgroups.mockImplementationOnce(() => new Promise<Group[]>((res) => { answerSubgroups = res }))
    mockGetGroupBoards.mockResolvedValueOnce([alpha])
    render(
      <MemoryRouter initialEntries={['/groups/1']}>
        <Routes>
          <Route path="/groups/:id" element={<GroupDetail user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(capturedOnReconnected).not.toBeNull())
    mockGetSubgroups.mockRejectedValueOnce(new Error('down'))
    reconnect()
    await waitFor(() => expect(mockGetSubgroups).toHaveBeenCalledTimes(2))
    frame({ event: 'group.deleted', data: { id: 11 } } as BoardEvent)
    await act(async () => { answerSubgroups([sub(10, 'Platform'), sub(11, 'Mobile')]) })
    await screen.findByText('+ New board')
    expect(screen.getByText('Platform')).toBeTruthy()
    expect(screen.queryByText('Mobile')).toBeNull()
  })

  it('keeps a subgroup-board delete applied during the descendant re-read', async () => {
    mockGetGroupDescendantBoards.mockResolvedValue([board(30, 'Deep A', { group: 10 }), board(31, 'Deep B', { group: 10 })])
    await loadGroup()
    fireEvent.click(screen.getByRole('switch'))
    await screen.findByText('Deep A')
    const reread = deferred<Board[]>(mockGetGroupDescendantBoards)
    reconnect()
    frame({ event: 'board.deleted', data: { board_uid: 'uid-30' } } as BoardEvent)
    expect(screen.queryByText('Deep A')).toBeNull()
    await reread.answer([board(30, 'Deep A', { group: 10 }), board(31, 'Deep B', { group: 10 })])
    expect(screen.queryByText('Deep A')).toBeNull()
    expect(screen.getByText('Deep B')).toBeTruthy()
  })

  it('shows a label created here once when a re-read in flight already lists it', async () => {
    const label = { id: 20, name: 'Enhancement', color: '#EAB308' }
    mockCreateGroupLabel.mockResolvedValue(label)
    await loadGroup()
    openSettings()
    await screen.findByText('Shared label library')
    const reread = deferred<Group>(mockGetGroup)
    frame({ event: 'group.label.created', data: {} } as BoardEvent)
    fireEvent.change(screen.getByPlaceholderText('Label name…'), { target: { value: 'Enhancement' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(mockCreateGroupLabel).toHaveBeenCalled())
    await reread.answer({ ...fakeGroup, shared_labels: [label] })
    expect(screen.getAllByText('Enhancement')).toHaveLength(1)
  })

  it('shows a subgroup created here once when a re-read in flight already lists it', async () => {
    await loadGroup()
    fireEvent.click(screen.getByRole('button', { name: '+ Create subgroup' }))
    const reread = deferred<Group[]>(mockGetSubgroups)
    frame({ event: 'group.created', data: { id: 12 } } as BoardEvent)
    fireEvent.click(screen.getByText('Confirm create subgroup'))
    await reread.answer([sub(10, 'Platform'), sub(11, 'Mobile'), sub(12, 'Fresh')])
    expect(screen.getAllByText('Fresh')).toHaveLength(1)
  })

  it('applies is_starred from a group re-read', async () => {
    await loadGroup()
    expect(screen.getByRole('button', { name: 'Star group' })).toBeTruthy()
    mockGetGroup.mockResolvedValue({ ...fakeGroup, is_starred: true })
    reconnect()
    expect(await screen.findByRole('button', { name: 'Unstar group' })).toBeTruthy()
  })

  it('keeps a star frame applied during the re-read over an older is_starred', async () => {
    await loadGroup()
    const reread = deferred<Group>(mockGetGroup)
    reconnect()
    frame({ event: 'group.star_changed', data: { id: 1, user_id: fakeUser.id, is_starred: true } } as BoardEvent)
    await reread.answer({ ...fakeGroup, is_starred: false })
    expect(screen.getByRole('button', { name: 'Unstar group' })).toBeTruthy()
  })

  it('keeps an optimistic rename applied during a group re-read over the older answer', async () => {
    let finishSave: () => void = () => {}
    mockUpdateGroup.mockImplementation(() => new Promise<void>((res) => { finishSave = res }))
    await loadGroup()
    const reread = deferred<Group>(mockGetGroup)
    reconnect()
    fireEvent.click(screen.getByRole('button', { name: 'Engineering' }))
    const input = screen.getByDisplayValue('Engineering')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Renamed')
    await reread.answer(fakeGroup)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Renamed')
    await act(async () => { finishSave() })
  })

  it('rolls a failed rename back over a group re-read answer too', async () => {
    let failSave: (e: unknown) => void = () => {}
    mockUpdateGroup.mockImplementation(() => new Promise<void>((_res, rej) => { failSave = rej }))
    await loadGroup()
    const reread = deferred<Group>(mockGetGroup)
    reconnect()
    fireEvent.click(screen.getByRole('button', { name: 'Engineering' }))
    const input = screen.getByDisplayValue('Engineering')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => { failSave(new Error('no')) })
    await reread.answer(fakeGroup)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Engineering')
  })

  it('lets a descendant-boards re-read supersede the toggle load it races', async () => {
    await loadGroup()
    const toggleLoad = deferred<Board[]>(mockGetGroupDescendantBoards)
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(mockGetGroupDescendantBoards).toHaveBeenCalledTimes(1))
    const reread = deferred<Board[]>(mockGetGroupDescendantBoards)
    reconnect()
    await waitFor(() => expect(mockGetGroupDescendantBoards).toHaveBeenCalledTimes(2))
    await reread.answer([board(31, 'Newer', { group: 10 })])
    await toggleLoad.answer([board(30, 'Older', { group: 10 })])
    expect(screen.getByText('Newer')).toBeTruthy()
    expect(screen.queryByText('Older')).toBeNull()
  })

  it('drops a subgroups re-read answered after the route moved to another group', async () => {
    const router = createMemoryRouter(
      [{ path: '/groups/:id', element: <GroupDetail user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} /> }],
      { initialEntries: ['/groups/1'] },
    )
    render(<RouterProvider router={router} />)
    await screen.findByText('Platform')
    // Reconnect on group 1 starts a re-read, held in flight.
    const held = deferred<Group[]>(mockGetSubgroups)
    reconnect()
    mockGetGroup.mockResolvedValue({ ...fakeGroup, id: 2, name: 'Other' })
    mockGetSubgroups.mockResolvedValue([sub(20, 'Other Child')])
    await act(async () => { await router.navigate('/groups/2') })
    await screen.findByText('Other Child')
    await held.answer([sub(10, 'Stale Child')])
    expect(screen.queryByText('Stale Child')).toBeNull()
    expect(screen.getByText('Other Child')).toBeTruthy()
  })
})
