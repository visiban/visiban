/**
 * GroupDetail boards re-read (#2150 covers the initial load vs a failed
 * re-read, in the second describe). (#2139): a list write applied while a re-read of
 * the boards list is in flight (a frame, or this session's own create or
 * move-out) is replayed over the re-read's answer, so the answer cannot undo it.
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

import { getGroup, getGroupMembers, getSubgroups, getGroupBoards, getGroupDescendantBoards, createGroupBoard } from '../api/groups'

const mockGetGroup = getGroup as ReturnType<typeof vi.fn>
const mockGetGroupMembers = getGroupMembers as ReturnType<typeof vi.fn>
const mockGetSubgroups = getSubgroups as ReturnType<typeof vi.fn>
const mockGetGroupBoards = getGroupBoards as ReturnType<typeof vi.fn>
const mockGetGroupDescendantBoards = getGroupDescendantBoards as ReturnType<typeof vi.fn>
const mockCreateGroupBoard = createGroupBoard as ReturnType<typeof vi.fn>

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
const bravo = board(2, 'Bravo')

/** A getGroupBoards answer the test releases by hand. */
function deferredBoards() {
  let answer: (b: Board[]) => void = () => {}
  let fail: (e: unknown) => void = () => {}
  mockGetGroupBoards.mockImplementationOnce(() => new Promise<Board[]>((res, rej) => { answer = res; fail = rej }))
  return {
    answer: async (b: Board[]) => { await act(async () => { answer(b) }) },
    fail: async (e: unknown) => { await act(async () => { fail(e) }) },
  }
}

async function loadGroup(boards: Board[] = [alpha, bravo]) {
  mockGetGroupBoards.mockResolvedValueOnce(boards)
  render(
    <MemoryRouter initialEntries={['/groups/1']}>
      <Routes>
        <Route path="/groups/:id" element={<GroupDetail user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />} />
      </Routes>
    </MemoryRouter>,
  )
  await screen.findByText('+ New board')
}

function reconnect() {
  act(() => { capturedOnReconnected?.() })
}

function frame(evt: BoardEvent) {
  act(() => { capturedOnEvent?.(evt) })
}

const deleted = (b: Board) => ({ event: 'board.deleted', data: { board_uid: b.uid } }) as BoardEvent
const created = (b: Board) => ({ event: 'board.created', data: b }) as unknown as BoardEvent

function rows() {
  return Array.from(document.querySelectorAll('[data-board-id]')).map((el) => el.textContent?.trim())
}

describe('GroupDetail boards re-read (#2139)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnEvent = null
    capturedOnReconnected = null
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupDescendantBoards.mockResolvedValue([])
  })

  it('replaces the list with the answer when no write landed during the re-read', async () => {
    await loadGroup()
    const reread = deferredBoards()
    reconnect()
    await reread.answer([bravo, board(3, 'Missed While Offline')])
    expect(rows()).toEqual(['Bravo', 'Missed While Offline'])
  })

  it('keeps a board deleted during the re-read gone when the answer still lists it', async () => {
    await loadGroup()
    const reread = deferredBoards()
    reconnect()
    frame(deleted(alpha))
    expect(screen.queryByText('Alpha')).toBeNull()
    // The answer was read before the delete committed.
    await reread.answer([alpha, bravo])
    expect(rows()).toEqual(['Bravo'])
  })

  it('keeps a board deleted during the re-read gone when the answer lacks it too', async () => {
    await loadGroup()
    const reread = deferredBoards()
    reconnect()
    frame(deleted(alpha))
    await reread.answer([bravo])
    expect(rows()).toEqual(['Bravo'])
  })

  it('removes a moved-out board by its legacy integer id when the answer still lists it', async () => {
    await loadGroup()
    const reread = deferredBoards()
    reconnect()
    frame({ event: 'board.deleted', data: { board_id: alpha.id } } as BoardEvent)
    await reread.answer([alpha, bravo])
    expect(rows()).toEqual(['Bravo'])
  })

  it('keeps a board created during the re-read when the answer lacks it', async () => {
    await loadGroup()
    const reread = deferredBoards()
    reconnect()
    frame(created(board(3, 'Created Meanwhile')))
    // The answer was read before the create committed.
    await reread.answer([alpha, bravo])
    expect(rows()).toEqual(['Alpha', 'Bravo', 'Created Meanwhile'])
  })

  it('takes the answer copy of a board created during the re-read that the answer already lists', async () => {
    await loadGroup()
    const reread = deferredBoards()
    reconnect()
    frame(created(board(3, 'Created Meanwhile')))
    await reread.answer([alpha, bravo, board(3, 'Created Meanwhile', { is_starred: true })])
    expect(rows()).toEqual(['Alpha', 'Bravo', 'Created Meanwhile'])
    const row = screen.getByText('Created Meanwhile').closest('[data-board-id]') as HTMLElement
    expect(row).toHaveAttribute('data-starred', 'true')
  })

  it('leaves a board created and then deleted during the same re-read gone', async () => {
    await loadGroup()
    const reread = deferredBoards()
    reconnect()
    const gamma = board(3, 'Gamma')
    frame(created(gamma))
    frame(deleted(gamma))
    // Read between the create and the delete.
    await reread.answer([alpha, bravo, gamma])
    expect(rows()).toEqual(['Alpha', 'Bravo'])
  })

  it('keeps a board moved out and back in during the same re-read', async () => {
    await loadGroup()
    const reread = deferredBoards()
    reconnect()
    frame({ event: 'board.deleted', data: { board_uid: alpha.uid, board_id: alpha.id } } as BoardEvent)
    frame(created(alpha))
    // Read between the two moves.
    await reread.answer([bravo])
    expect(rows()).toEqual(['Bravo', 'Alpha'])
  })

  it('keeps a rename applied during the re-read over an older answer', async () => {
    await loadGroup()
    const reread = deferredBoards()
    reconnect()
    frame({ event: 'board.updated', data: { ...alpha, name: 'Alpha Renamed' } } as unknown as BoardEvent)
    await reread.answer([alpha, bravo])
    expect(rows()).toEqual(['Alpha Renamed', 'Bravo'])
  })

  it('keeps the user star change applied during the re-read over an older answer', async () => {
    await loadGroup()
    const reread = deferredBoards()
    reconnect()
    frame({ event: 'board.star_changed', data: { uid: alpha.uid, user_id: fakeUser.id, is_starred: true } } as BoardEvent)
    await reread.answer([alpha, bravo])
    const row = screen.getByText('Alpha').closest('[data-board-id]') as HTMLElement
    expect(row).toHaveAttribute('data-starred', 'true')
  })

  it('does not let an older overlapping re-read that answers last bring a deleted board back', async () => {
    await loadGroup()
    const first = deferredBoards()
    reconnect()
    frame(deleted(alpha))
    const second = deferredBoards()
    reconnect()
    // The second read was sent after the delete, so its answer lacks Alpha.
    await second.answer([bravo])
    await first.answer([alpha, bravo])
    expect(rows()).toEqual(['Bravo'])
  })

  it('replays a write made during the newer of two overlapping re-reads over its answer', async () => {
    await loadGroup()
    const first = deferredBoards()
    reconnect()
    const second = deferredBoards()
    reconnect()
    frame(deleted(alpha))
    // The older read answers first and is dropped; it must not close the newer read's replay.
    await first.answer([alpha, bravo])
    expect(rows()).toEqual(['Bravo'])
    await second.answer([alpha, bravo])
    expect(rows()).toEqual(['Bravo'])
  })

  it('does not replay an earlier re-read delete over a later re-read', async () => {
    await loadGroup()
    const first = deferredBoards()
    reconnect()
    frame(deleted(alpha))
    await first.answer([alpha, bravo])
    expect(rows()).toEqual(['Bravo'])
    // Alpha came back (moved back in) while the socket was down; the later re-read lists it.
    const later = deferredBoards()
    reconnect()
    await later.answer([alpha, bravo])
    expect(rows()).toEqual(['Alpha', 'Bravo'])
  })

  it('does not replay a delete from a failed re-read over the next one', async () => {
    await loadGroup()
    const failed = deferredBoards()
    reconnect()
    frame(deleted(alpha))
    await failed.fail(new Error('network'))
    expect(rows()).toEqual(['Bravo'])
    const later = deferredBoards()
    reconnect()
    await later.answer([alpha, bravo])
    expect(rows()).toEqual(['Alpha', 'Bravo'])
  })

  it('keeps a board deleted during the re-read a group.updated (health change) starts', async () => {
    await loadGroup()
    const reread = deferredBoards()
    frame({ event: 'group.updated', data: { id: 1 } } as BoardEvent)
    frame(deleted(alpha))
    await reread.answer([alpha, bravo])
    expect(rows()).toEqual(['Bravo'])
  })

  it('applies a frame that arrives after the answer on top of it', async () => {
    await loadGroup()
    const reread = deferredBoards()
    reconnect()
    await reread.answer([alpha, bravo])
    frame(deleted(alpha))
    expect(rows()).toEqual(['Bravo'])
  })

  it('keeps a board this session created during the re-read', async () => {
    await loadGroup()
    const reread = deferredBoards()
    reconnect()
    mockCreateGroupBoard.mockResolvedValue(board(4, 'Made Here'))
    fireEvent.click(screen.getByText('+ New board'))
    fireEvent.click(screen.getByText('Confirm create board'))
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/boards/4'))
    await reread.answer([alpha, bravo])
    expect(rows()).toEqual(['Alpha', 'Bravo', 'Made Here'])
  })

  it('keeps a board this session moved out during the re-read gone', async () => {
    await loadGroup()
    const reread = deferredBoards()
    reconnect()
    fireEvent.click(screen.getByRole('button', { name: 'Move Alpha to another group' }))
    fireEvent.click(screen.getByText('Confirm move board'))
    expect(screen.queryByText('Alpha')).toBeNull()
    await reread.answer([alpha, bravo])
    expect(rows()).toEqual(['Bravo'])
  })
})

describe('GroupDetail initial load vs a failed re-read (#2150)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnEvent = null
    capturedOnReconnected = null
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupDescendantBoards.mockResolvedValue([])
  })

  function renderPage() {
    render(
      <MemoryRouter initialEntries={['/groups/1']}>
        <Routes>
          <Route path="/groups/:id" element={<GroupDetail user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('keeps the initial load list when a re-read started before it answers then fails', async () => {
    const load = deferredBoards()
    renderPage()
    const reread = deferredBoards()
    reconnect()
    await reread.fail(new Error('network'))
    await load.answer([alpha, bravo])
    await screen.findByText('+ New board')
    expect(rows()).toEqual(['Alpha', 'Bravo'])
  })

  it('keeps the initial load list when the load answers first and the re-read then fails', async () => {
    const load = deferredBoards()
    renderPage()
    const reread = deferredBoards()
    reconnect()
    await load.answer([alpha, bravo])
    await screen.findByText('+ New board')
    await reread.fail(new Error('network'))
    expect(rows()).toEqual(['Alpha', 'Bravo'])
  })

  it('carries a frame applied while the re-read was in flight over the initial load list', async () => {
    const load = deferredBoards()
    renderPage()
    const reread = deferredBoards()
    reconnect()
    frame(created(board(3, 'Frame Board')))
    await load.answer([alpha, bravo])
    await screen.findByText('+ New board')
    await reread.fail(new Error('network'))
    expect(rows()).toEqual(['Alpha', 'Bravo', 'Frame Board'])
  })

  it('still lets a successful re-read supersede the older initial load', async () => {
    const load = deferredBoards()
    renderPage()
    const reread = deferredBoards()
    reconnect()
    await reread.answer([bravo])
    await load.answer([alpha, bravo])
    await screen.findByText('+ New board')
    expect(rows()).toEqual(['Bravo'])
  })

  it('carries a deleted board over the initial load list', async () => {
    const load = deferredBoards()
    renderPage()
    const reread = deferredBoards()
    reconnect()
    frame(deleted(alpha))
    await load.answer([alpha, bravo])
    await screen.findByText('+ New board')
    await reread.fail(new Error('network'))
    expect(rows()).toEqual(['Bravo'])
  })

  it('carries a frame over the load list when the re-read failed before the load answered', async () => {
    const load = deferredBoards()
    renderPage()
    const reread = deferredBoards()
    reconnect()
    frame(deleted(alpha))
    await reread.fail(new Error('network'))
    await load.answer([alpha, bravo])
    await screen.findByText('+ New board')
    expect(rows()).toEqual(['Bravo'])
    // A frame after the load still applies on top of the load's list.
    frame(created(board(3, 'Later')))
    expect(rows()).toEqual(['Bravo', 'Later'])
  })

  it('applies the load list of the next group after a re-read applied on the previous one', async () => {
    mockGetGroupBoards.mockResolvedValueOnce([alpha])
    const router = createMemoryRouter(
      [{ path: '/groups/:id', element: <GroupDetail user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} /> }],
      { initialEntries: ['/groups/1'] },
    )
    render(<RouterProvider router={router} />)
    await screen.findByText('+ New board')
    const reread = deferredBoards()
    reconnect()
    await reread.answer([alpha])
    // Same route element, new :id: GroupDetail is not remounted.
    mockGetGroupBoards.mockResolvedValueOnce([board(9, 'Other Group Board', { group: 2 })])
    await act(async () => { await router.navigate('/groups/2') })
    await waitFor(() => expect(rows()).toEqual(['Other Group Board']))
  })

  it('keeps a write recorded between two failed re-reads when the load answers later', async () => {
    const load = deferredBoards()
    renderPage()
    const r1 = deferredBoards()
    reconnect()
    frame(created(board(3, 'Between')))
    const r2 = deferredBoards()
    reconnect()
    await r1.fail(new Error('network'))
    await r2.fail(new Error('network'))
    await load.answer([alpha, bravo])
    await screen.findByText('+ New board')
    expect(rows()).toEqual(['Alpha', 'Bravo', 'Between'])
  })

  it('keeps a delete recorded before a newer re-read that fails, though the older answer was superseded', async () => {
    const load = deferredBoards()
    renderPage()
    const r1 = deferredBoards()
    reconnect()
    frame(deleted(alpha))
    const r2 = deferredBoards()
    reconnect()
    await r1.answer([alpha, bravo])
    await r2.fail(new Error('network'))
    await load.answer([alpha, bravo])
    await screen.findByText('+ New board')
    expect(rows()).toEqual(['Bravo'])
  })
})
