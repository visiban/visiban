/**
 * GroupDetail drives the REAL useGroupSocket (fake WebSocket): a server-sent 1000
 * (member removed) swaps in the unavailable page (#2041).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom'
import GroupDetail from '../pages/GroupDetail'
import type { User, Group } from '../types'

// #1374 — real useNavigate so the many `void navigate(...)` sites (escape,
// 404/403 redirect, create/import board, delete group, breadcrumb, Trello
// import) can be asserted on without wiring up extra routes per test.
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

vi.mock('../components/Board/CreateBoardModal', () => ({
  default: ({ onConfirm, onCancel }: { onConfirm: (n: string, t: string, s: string, d: boolean) => void; onCancel: () => void }) => (
    <div data-testid="create-board-modal">
      <button onClick={() => onConfirm('New Board', 'simple_kanban', '', false)}>Confirm create board</button>
      <button onClick={onCancel}>Cancel create board</button>
    </div>
  ),
}))

vi.mock('../components/Board/ImportBoardModal', () => ({
  default: ({ onImport, onCancel, onSwitchToTrello }: { onImport: (file: File, name?: string, options?: Record<string, boolean>) => void; onCancel: () => void; onSwitchToTrello?: () => void }) => (
    <div data-testid="import-board-modal">
      <button onClick={() => onImport(new File(['{}'], 'board.json'), 'Imported Board')}>Confirm import board</button>
      <button onClick={() => onImport(new File(['{}'], 'board.json'), undefined, { labels: false, cards: true, comments: true, checklist: true, history: true })}>Confirm selective import board</button>
      <button onClick={onCancel}>Cancel import board</button>
      {onSwitchToTrello && <button onClick={onSwitchToTrello}>Switch to Trello</button>}
    </div>
  ),
}))

vi.mock('../components/Board/TrelloImportModal', () => ({
  default: ({ onCancel, onImported }: { onCancel: () => void; onImported: (board: { id: number }) => void }) => (
    <div data-testid="trello-import-modal">
      <button onClick={() => onImported({ id: 77 })}>Confirm trello import</button>
      <button onClick={onCancel}>Cancel trello import</button>
    </div>
  ),
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

// A 4003 close probes the session (#2044); stub it so no real call is made.
vi.mock('../utils/sessionProbe', () => ({ probeSession: vi.fn().mockResolvedValue(undefined) }))

vi.mock('../api/auth', () => ({
  getVersion: vi.fn().mockResolvedValue('0.3.0'),
  // InviteLinkPanel's EmailInviteForm reads it (#731); unavailable keeps the
  // section hidden so these tests stay about the page.
  getSiteConfig: vi.fn().mockResolvedValue({
    registration_open: true,
    registration_mode: 'open',
    demo_mode: false,
    demo_login: null,
    invite_email_available: false,
  }),
}))

import { getGroup, getGroupMembers, getSubgroups, getGroupBoards, getGroupDescendantBoards, deleteGroup } from '../api/groups'

const mockGetGroup = getGroup as ReturnType<typeof vi.fn>
const mockGetGroupMembers = getGroupMembers as ReturnType<typeof vi.fn>
const mockGetSubgroups = getSubgroups as ReturnType<typeof vi.fn>
const mockGetGroupBoards = getGroupBoards as ReturnType<typeof vi.fn>
const mockGetGroupDescendantBoards = getGroupDescendantBoards as ReturnType<typeof vi.fn>
const mockDeleteGroup = deleteGroup as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false,
}

const fakeGroup: Group = {
  id: 1, name: 'Engineering', description: '', owner: fakeUser,
  parent: null, parent_name: null,
  member_count: 2, board_count: 1, subgroup_count: 0, created_at: '',
  default_board_member_role: 'member', allowed_priorities: [], shared_labels: [],
  is_starred: false, navigation_only: false, can_place_boards: false,
  health_status: null, effective_health_status: null, health_status_source: null,
}

function renderGroupDetail(locationState?: Record<string, unknown>, user: User = fakeUser) {
  const initialEntries = locationState
    ? [{ pathname: '/groups/1', state: locationState }]
    : ['/groups/1']
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/groups/:id" element={<GroupDetail user={user} onLogout={vi.fn()} onUserUpdated={vi.fn()} />} />
      </Routes>
    </MemoryRouter>
  )
}
type FakeWS = { onopen: (() => void) | null; onclose: ((e: { code: number }) => void) | null; close: ReturnType<typeof vi.fn> }
let sockets: FakeWS[]
class FakeWebSocket {
  onopen: (() => void) | null = null
  onmessage: unknown = null
  onclose: ((e: { code: number }) => void) | null = null
  close = vi.fn()
  constructor() { sockets.push(this as unknown as FakeWS) }
}

describe('GroupDetail with the real group socket (#2041)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sockets = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    mockGetGroupDescendantBoards.mockResolvedValue([])
    mockGetGroup.mockResolvedValue({ ...fakeGroup, can_place_boards: true })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the unavailable page when the server closes the socket with 1000 and the group is gone', async () => {
    renderGroupDetail()
    await screen.findByText('+ New board')
    mockGetGroup.mockRejectedValue({ response: { status: 404 } })
    act(() => { sockets[0].onclose?.({ code: 1000 }) })
    expect(await screen.findByRole('heading', { level: 1, name: "This group isn't available" })).toBeInTheDocument()
  })

  it('keeps the group when the re-read after a server 1000 still succeeds', async () => {
    renderGroupDetail()
    await screen.findByText('+ New board')
    act(() => { sockets[0].onclose?.({ code: 1000 }) })
    await act(async () => {})
    expect(mockGetGroup.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByRole('heading', { name: "This group isn't available" })).toBeNull()
    expect(screen.getByText('+ New board')).toBeInTheDocument()
  })

  it("does not re-read on a server close or 4003 while this session is deleting the group", async () => {
    renderGroupDetail()
    await screen.findByText('+ New board')
    let finish: () => void = () => {}
    mockDeleteGroup.mockImplementation(() => new Promise<void>((res) => { finish = res }))
    fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
    fireEvent.click(await screen.findByRole('button', { name: 'Delete group' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete group' }))
    const calls = mockGetGroup.mock.calls.length
    mockGetGroup.mockRejectedValue({ response: { status: 404 } })
    act(() => { sockets[0].onclose?.({ code: 1000 }) })
    await act(async () => {})
    expect(mockGetGroup.mock.calls.length).toBe(calls)
    act(() => { sockets[sockets.length - 1].onclose?.({ code: 4003 }) })
    await act(async () => {})
    expect(mockGetGroup.mock.calls.length).toBe(calls)
    expect(screen.queryByRole('heading', { name: "This group isn't available" })).toBeNull()
    await act(async () => { finish() })
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'))
  })

  it('does not re-read when GroupDetail itself unmounts', async () => {
    const { unmount } = renderGroupDetail()
    await screen.findByText('+ New board')
    const calls = mockGetGroup.mock.calls.length
    unmount()
    act(() => { sockets[0].onclose?.({ code: 1000 }) })
    expect(mockGetGroup.mock.calls.length).toBe(calls)
  })

  it("drops a late 404 for the previous group after navigating to another (stale guard)", async () => {
    let rejectOne: (e: unknown) => void = () => {}
    mockGetGroup.mockImplementationOnce(() => new Promise((_, rej) => { rejectOne = rej }))
    mockGetGroupMembers.mockImplementationOnce(() => new Promise(() => {}))
    mockGetSubgroups.mockImplementationOnce(() => new Promise(() => {}))
    mockGetGroupBoards.mockImplementationOnce(() => new Promise(() => {}))
    function Harness() {
      const [go, setGo] = useState(false)
      return (
        <MemoryRouter initialEntries={['/groups/1']}>
          <Routes>
            <Route path="/groups/:id" element={<GroupDetail user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />} />
          </Routes>
          {go && <Navigate to="/groups/2" />}
          <button onClick={() => setGo(true)}>go-to-2</button>
        </MemoryRouter>
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByText('go-to-2'))
    await screen.findByText('+ New board')
    await act(async () => { rejectOne({ response: { status: 404 } }) })
    expect(screen.queryByRole('heading', { name: "This group isn't available" })).toBeNull()
    expect(screen.getByText('+ New board')).toBeInTheDocument()
  })

  it("drops a late failed access re-read for the previous group", async () => {
    let rejectLate: (e: unknown) => void = () => {}
    function Harness() {
      const [go, setGo] = useState(false)
      return (
        <MemoryRouter initialEntries={['/groups/1']}>
          <Routes>
            <Route path="/groups/:id" element={<GroupDetail user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />} />
          </Routes>
          {go && <Navigate to="/groups/2" />}
          <button onClick={() => setGo(true)}>go-to-2</button>
        </MemoryRouter>
      )
    }
    render(<Harness />)
    await screen.findByText('+ New board')
    // Group 1's access re-read stays pending, then the user moves to group 2.
    mockGetGroup.mockImplementationOnce(() => new Promise((_, rej) => { rejectLate = rej }))
    act(() => { sockets[0].onclose?.({ code: 1000 }) })
    mockGetGroup.mockResolvedValue({ ...fakeGroup, can_place_boards: true })
    fireEvent.click(screen.getByText('go-to-2'))
    await screen.findByText('+ New board')
    await act(async () => { rejectLate({ response: { status: 404 } }) })
    expect(screen.queryByRole('heading', { name: "This group isn't available" })).toBeNull()
  })
})

describe('GroupDetail first-open resync (#2088)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sockets = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    mockGetGroupDescendantBoards.mockResolvedValue([])
    mockGetGroup.mockResolvedValue({ ...fakeGroup, can_place_boards: true })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('re-reads the boards once when the socket first opens more than 1 s after the load', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    renderGroupDetail()
    await screen.findByText('+ New board')
    const loads = mockGetGroupBoards.mock.calls.length
    now.mockReturnValue(1_000_000 + 1500)
    act(() => { sockets[0].onopen?.() })
    await act(async () => {})
    expect(mockGetGroupBoards.mock.calls.length).toBe(loads + 1)
    now.mockRestore()
  })

  it('does not re-read when the socket first opens within 1 s of the load', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    renderGroupDetail()
    await screen.findByText('+ New board')
    const loads = mockGetGroupBoards.mock.calls.length
    now.mockReturnValue(1_000_000 + 200)
    act(() => { sockets[0].onopen?.() })
    await act(async () => {})
    expect(mockGetGroupBoards.mock.calls.length).toBe(loads)
    now.mockRestore()
  })

  it('re-reads once for a first open that succeeds only after a failed attempt and retry', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    renderGroupDetail()
    await screen.findByText('+ New board')
    const loads = mockGetGroupBoards.mock.calls.length
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    act(() => { sockets[0].onclose?.({ code: 1006 }) })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(sockets).toHaveLength(2)
    now.mockReturnValue(1_000_000 + 3100)
    act(() => { sockets[1].onopen?.() })
    await act(async () => {})
    expect(mockGetGroupBoards.mock.calls.length).toBe(loads + 1)
    now.mockRestore()
  })
})
