import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import GroupDetail from '../pages/GroupDetail'
import type { User, Group } from '../types'
import type { BoardEvent } from '../hooks/useBoardSocket'

// Capture the onEvent callback passed to useGroupSocket so tests can simulate
// server-pushed board.created/updated/deleted events.
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
}))

vi.mock('../api/boards', () => ({
  importBoard: vi.fn(),
}))

vi.mock('../api/notifications', () => ({
  getUnreadCount: vi.fn().mockResolvedValue(0),
  listNotifications: vi.fn().mockResolvedValue([]),
  markAllRead: vi.fn(),
  markRead: vi.fn(),
}))

vi.mock('../api/auth', () => ({
  getVersion: vi.fn().mockResolvedValue('0.3.0'),
}))

import { getGroup, getGroupMembers, getSubgroups, getGroupBoards, getGroupDescendantBoards, updateGroup } from '../api/groups'

const mockGetGroup = getGroup as ReturnType<typeof vi.fn>
const mockGetGroupMembers = getGroupMembers as ReturnType<typeof vi.fn>
const mockGetSubgroups = getSubgroups as ReturnType<typeof vi.fn>
const mockGetGroupBoards = getGroupBoards as ReturnType<typeof vi.fn>
const mockGetGroupDescendantBoards = getGroupDescendantBoards as ReturnType<typeof vi.fn>
const mockUpdateGroup = updateGroup as ReturnType<typeof vi.fn>

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
  is_starred: false,
}

function renderGroupDetail(locationState?: Record<string, unknown>) {
  const initialEntries = locationState
    ? [{ pathname: '/groups/1', state: locationState }]
    : ['/groups/1']
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/groups/:id" element={<GroupDetail user={fakeUser} onLogout={vi.fn()} onUserUpdated={vi.fn()} />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('GroupDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnEvent = null
    capturedOnReconnected = null
  })

  it('shows loading state', () => {
    mockGetGroup.mockReturnValue(new Promise(() => {}))
    mockGetGroupMembers.mockReturnValue(new Promise(() => {}))
    mockGetSubgroups.mockReturnValue(new Promise(() => {}))
    mockGetGroupBoards.mockReturnValue(new Promise(() => {}))
    renderGroupDetail()
    expect(document.querySelector('[role="status"]')).not.toBeNull()
  })

  it('shows error on failure', async () => {
    mockGetGroup.mockRejectedValue(new Error('fail'))
    mockGetGroupMembers.mockRejectedValue(new Error('fail'))
    mockGetSubgroups.mockRejectedValue(new Error('fail'))
    mockGetGroupBoards.mockRejectedValue(new Error('fail'))
    renderGroupDetail()
    expect(await screen.findByText('Failed to load group')).toBeInTheDocument()
  })

  it('renders group details when loaded', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([
      { id: 1, name: 'Sprint Board', description: '', owner: fakeUser, group: 1, group_name: 'Engineering', member_count: 1, created_at: '', updated_at: '' },
    ])
    renderGroupDetail()

    // Boards tab is shown by default
    expect(await screen.findByText('Sprint Board')).toBeInTheDocument()
    expect(screen.getByText('Subgroups')).toBeInTheDocument()

    // Members and Settings content live in the Settings tab
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0])
    expect(await screen.findByText('Members')).toBeInTheDocument()
  })

  it('shows delete group button for admin', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    // Navigate to Settings tab where the danger zone lives
    fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
    expect(await screen.findByText('Delete group')).toBeInTheDocument()
  })

  it('shows + New board button for admin', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    expect(await screen.findByText('+ New board')).toBeInTheDocument()
  })

  it('shows + Create subgroup button for admin', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    expect(await screen.findByText('+ Create subgroup')).toBeInTheDocument()
  })

  it('shows Import button for admin', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    expect(await screen.findByText('Import')).toBeInTheDocument()
  })

  it('renders subgroups when available', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([
      { id: 2, name: 'Frontend', owner: fakeUser, parent: 1, parent_name: 'Engineering', member_count: 1, board_count: 0, subgroup_count: 0, created_at: '' },
    ])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    expect(await screen.findByText('Frontend')).toBeInTheDocument()
  })

  it('renders member list with roles', async () => {
    const otherUser: User = { ...fakeUser, id: 2, username: 'alice', display_name: 'Alice Smith' }
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
      { id: 2, user: otherUser, role: 'member', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    // Navigate to Settings tab where members are listed
    fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
    expect(await screen.findByText('Alice Smith')).toBeInTheDocument()
    // Admin can see role selectors and remove buttons for other members
    expect(screen.getByText('Remove')).toBeInTheDocument()
  })

  it('hides admin controls for non-admin member', async () => {
    const otherOwner: User = { ...fakeUser, id: 99, username: 'boss', display_name: 'Boss' }
    mockGetGroup.mockResolvedValue({ ...fakeGroup, owner: otherOwner })
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'member', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    // Non-admin lands on Boards tab; Settings tab is hidden entirely
    await screen.findByText(/Subgroups let you organize/)
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.queryByText('Delete group')).not.toBeInTheDocument()
    expect(screen.queryByText('+ New board')).not.toBeInTheDocument()
    expect(screen.queryByText('+ Create subgroup')).not.toBeInTheDocument()
  })

  it('shows invite link panel for admin', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    // Navigate to Settings tab where the invite link panel lives
    fireEvent.click((await screen.findAllByRole('button', { name: 'Settings' }))[0])
    expect(await screen.findByText('Invite links')).toBeInTheDocument()
  })

  it('shows subgroup empty state description for non-admin', async () => {
    const otherOwner: User = { ...fakeUser, id: 99, username: 'boss', display_name: 'Boss' }
    mockGetGroup.mockResolvedValue({ ...fakeGroup, owner: otherOwner })
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'member', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    expect(await screen.findByText('Subgroups let you organize boards and members into nested workspaces.')).toBeInTheDocument()
  })

  it('shows subgroup empty state description for admin', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([
      { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    ])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    expect(await screen.findByText('Subgroups let you organize boards and members into nested workspaces.')).toBeInTheDocument()
  })

  it('shows join confirmation banner when arriving from invite flow', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail({ joinedGroup: 'Engineering' })

    expect(await screen.findByText(/You've joined/)).toBeInTheDocument()
    expect(screen.getByText(/You've joined/).closest('span')).toHaveTextContent("You've joined Engineering. Welcome!")
  })

  it('does not show join banner when navigating directly to group page', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    await screen.findByRole('heading', { name: 'Engineering' }) // wait for load
    expect(screen.queryByText(/You've joined/)).not.toBeInTheDocument()
  })

  it('renders ancestor breadcrumb when ancestors array is present', async () => {
    mockGetGroup.mockResolvedValue({
      ...fakeGroup,
      ancestors: [{ id: 10, name: 'RootOrg' }, { id: 11, name: 'PlatformTeam' }],
    })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    // Both the Navbar and in-page breadcrumbs render the ancestor links
    expect((await screen.findAllByText('RootOrg')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('PlatformTeam').length).toBeGreaterThanOrEqual(1)
  })

  it('does not render breadcrumb for root-level groups', async () => {
    mockGetGroup.mockResolvedValue({ ...fakeGroup, ancestors: [] })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    await screen.findByRole('heading', { name: 'Engineering' })
    expect(screen.queryByRole('navigation', { name: 'Group breadcrumb' })).not.toBeInTheDocument()
  })

  it('admin sees description edit placeholder when description is empty', async () => {
    mockGetGroup.mockResolvedValue({ ...fakeGroup, description: '' })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    await screen.findByRole('heading', { name: 'Engineering' })
    expect(screen.getByText('Add a description…')).toBeInTheDocument()
  })

  it('admin can click description area to edit it', async () => {
    mockGetGroup.mockResolvedValue({ ...fakeGroup, description: 'Our main engineering group' })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    const descText = await screen.findByText('Our main engineering group')
    fireEvent.click(descText)

    const textarea = screen.getByRole('textbox', { name: '' })
    expect((textarea as HTMLTextAreaElement).value).toBe('Our main engineering group')
  })

  it('description edit saves on blur and calls updateGroup', async () => {
    mockGetGroup.mockResolvedValue({ ...fakeGroup, description: 'Original' })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    mockUpdateGroup.mockResolvedValue({ ...fakeGroup, description: 'Updated' })
    renderGroupDetail()

    const descText = await screen.findByText('Original')
    fireEvent.click(descText)

    const textarea = screen.getByRole('textbox', { name: '' })
    fireEvent.change(textarea, { target: { value: 'Updated' } })
    fireEvent.blur(textarea)

    expect(mockUpdateGroup).toHaveBeenCalledWith(1, { description: 'Updated' })
  })

  it('description edit cancels on Escape', async () => {
    mockGetGroup.mockResolvedValue({ ...fakeGroup, description: 'Original' })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    const descText = await screen.findByText('Original')
    fireEvent.click(descText)

    const textarea = screen.getByRole('textbox', { name: '' })
    fireEvent.change(textarea, { target: { value: 'Should not save' } })
    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(screen.queryByRole('textbox', { name: '' })).not.toBeInTheDocument()
    expect(mockUpdateGroup).not.toHaveBeenCalled()
  })

  it('non-admin with description sees plain text, no edit affordance', async () => {
    const otherOwner: User = { ...fakeUser, id: 99, username: 'boss', display_name: 'Boss' }
    mockGetGroup.mockResolvedValue({ ...fakeGroup, description: 'Team description', owner: otherOwner })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'member', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    expect(await screen.findByText('Team description')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Team description'))
    // No textarea should appear for non-admin
    expect(screen.queryByRole('textbox', { name: '' })).not.toBeInTheDocument()
  })

  it('admin can click heading to start inline rename', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    const heading = await screen.findByRole('heading', { name: 'Engineering' })
    fireEvent.click(heading)

    const input = screen.getByRole('textbox')
    expect(input).toBeInTheDocument()
    expect((input as HTMLInputElement).value).toBe('Engineering')
  })

  it('admin rename saves on Enter and updates heading', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    mockUpdateGroup.mockResolvedValue({ ...fakeGroup, name: 'Platform' })
    renderGroupDetail()

    const heading = await screen.findByRole('heading', { name: 'Engineering' })
    fireEvent.click(heading)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Platform' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mockUpdateGroup).toHaveBeenCalledWith(1, { name: 'Platform' })
  })

  it('admin rename cancels on Escape', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    const heading = await screen.findByRole('heading', { name: 'Engineering' })
    fireEvent.click(heading)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Should not save' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(mockUpdateGroup).not.toHaveBeenCalled()
  })

  it('non-admin cannot click heading to rename', async () => {
    const otherOwner: User = { ...fakeUser, id: 99, username: 'boss', display_name: 'Boss' }
    mockGetGroup.mockResolvedValue({ ...fakeGroup, owner: otherOwner })
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'member', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail()

    // Wait for load — non-admin sees empty boards state text
    await screen.findByText(/Subgroups let you organize/)
    // No input should appear — heading is not interactive for non-admins
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('dismisses join banner when × is clicked', async () => {
    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([])
    mockGetSubgroups.mockResolvedValue([])
    mockGetGroupBoards.mockResolvedValue([])
    renderGroupDetail({ joinedGroup: 'Engineering' })

    expect(await screen.findByText(/You've joined/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '×' }))
    expect(screen.queryByText(/You've joined/)).not.toBeInTheDocument()
  })

  it('toggling showSubgroupBoards calls getGroupDescendantBoards with the group ID', async () => {
    // The component issues a single getGroupDescendantBoards(groupId) request when the
    // toggle is turned on — avoiding the previous N+1 pattern of one getGroupBoards call
    // per direct subgroup. This test verifies that N+1 fix is exercised.
    const subgroup = {
      id: 5, name: 'Frontend', owner: fakeUser, parent: 1, parent_name: 'Engineering',
      member_count: 1, board_count: 1, subgroup_count: 0, created_at: '',
    }
    const subgroupBoard = {
      id: 10, name: 'Subgroup Sprint', description: '', owner: fakeUser,
      group: 5, group_name: 'Frontend', member_count: 1, created_at: '', updated_at: '',
    }

    mockGetGroup.mockResolvedValue(fakeGroup)
    mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
    mockGetSubgroups.mockResolvedValue([subgroup])
    mockGetGroupBoards.mockResolvedValue([]) // group's own boards (no duplicates to exclude)
    mockGetGroupDescendantBoards.mockResolvedValue([subgroupBoard])

    renderGroupDetail()

    // Wait for load — toggle is only rendered when subgroups exist
    const toggle = await screen.findByRole('switch')
    expect(toggle).toBeInTheDocument()

    // Toggle on
    fireEvent.click(toggle)

    // The subgroup's board should appear under the toggle section
    expect(await screen.findByText('Subgroup Sprint')).toBeInTheDocument()

    // A single call with the root group ID — not one per subgroup
    expect(mockGetGroupDescendantBoards).toHaveBeenCalledWith(1)
    expect(mockGetGroupDescendantBoards).toHaveBeenCalledTimes(1)
  })

  describe('live updates (#753)', () => {
    const existingBoard = {
      id: 1, name: 'Sprint Board', description: '', owner: fakeUser,
      group: 1, group_name: 'Engineering', member_count: 1,
      created_at: '', updated_at: '',
    }

    async function loadGroup() {
      mockGetGroup.mockResolvedValue(fakeGroup)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([existingBoard])
      renderGroupDetail()
      await screen.findByText('Sprint Board')
    }

    it('appends a new board on board.created and applies the fade-in class', async () => {
      await loadGroup()
      const incoming = { ...existingBoard, id: 2, name: 'Live Board' }
      // act(sync) flushes the state update synchronously, so the row is in the
      // DOM immediately. Using findByText here would poll for up to several
      // hundred ms, during which the component's 200 ms setTimeout can fire and
      // clear animate-fade-in before we assert on it (flaky under CI load).
      act(() => {
        capturedOnEvent?.({ event: 'board.created', data: incoming } as BoardEvent)
      })
      const liveBoard = screen.getByText('Live Board')
      expect(liveBoard).toBeInTheDocument()
      const trigger = liveBoard.closest('[data-board-id]') as HTMLElement
      expect(trigger.parentElement?.className).toContain('animate-fade-in')
    })

    it('ignores duplicate board.created for a board already in the list', async () => {
      await loadGroup()
      act(() => {
        capturedOnEvent?.({ event: 'board.created', data: existingBoard } as BoardEvent)
      })
      // Still exactly one row for Sprint Board.
      expect(screen.getAllByText('Sprint Board')).toHaveLength(1)
    })

    it('patches the existing row on board.updated', async () => {
      await loadGroup()
      act(() => {
        capturedOnEvent?.({
          event: 'board.updated',
          data: { ...existingBoard, name: 'Renamed Board' },
        } as BoardEvent)
      })
      expect(await screen.findByText('Renamed Board')).toBeInTheDocument()
      expect(screen.queryByText('Sprint Board')).not.toBeInTheDocument()
    })

    it('board.updated for an unknown board id is a no-op', async () => {
      await loadGroup()
      act(() => {
        capturedOnEvent?.({
          event: 'board.updated',
          data: { ...existingBoard, id: 999, name: 'Ghost' },
        } as BoardEvent)
      })
      expect(screen.queryByText('Ghost')).not.toBeInTheDocument()
      expect(screen.getByText('Sprint Board')).toBeInTheDocument()
    })

    it('removes the row on board.deleted', async () => {
      await loadGroup()
      act(() => {
        capturedOnEvent?.({
          event: 'board.deleted',
          data: { id: 1, board_uid: 'abc' },
        } as BoardEvent)
      })
      await waitFor(() => {
        expect(screen.queryByText('Sprint Board')).not.toBeInTheDocument()
      })
    })

    it('refetches the boards list on reconnect to recover missed events', async () => {
      await loadGroup()
      // A board was created server-side while we were disconnected; the refetch
      // returns the new list.
      const refreshed = [existingBoard, { ...existingBoard, id: 9, name: 'Missed While Offline' }]
      mockGetGroupBoards.mockResolvedValueOnce(refreshed)
      await act(async () => {
        capturedOnReconnected?.()
      })
      expect(await screen.findByText('Missed While Offline')).toBeInTheDocument()
    })

    it('restores focus to the first remaining board after a remote delete', async () => {
      mockGetGroup.mockResolvedValue(fakeGroup)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      const boardA = { ...existingBoard, id: 1, name: 'Alpha' }
      const boardB = { ...existingBoard, id: 2, name: 'Bravo' }
      mockGetGroupBoards.mockResolvedValue([boardA, boardB])
      renderGroupDetail()
      const alphaBtn = (await screen.findByText('Alpha')).closest('[data-board-id]') as HTMLElement
      alphaBtn.focus()
      expect(document.activeElement).toBe(alphaBtn)

      // Delete the currently-focused board.
      act(() => {
        capturedOnEvent?.({ event: 'board.deleted', data: { id: 1 } } as BoardEvent)
      })

      await waitFor(() => {
        expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
      })
      // Focus moved to the remaining board (Bravo).
      const bravoBtn = screen.getByText('Bravo').closest('[data-board-id]') as HTMLElement
      expect(document.activeElement).toBe(bravoBtn)
    })

    it('refetches the group on group.updated (#906)', async () => {
      const updatedGroup: Group = { ...fakeGroup, owner: { ...fakeUser, id: 2, username: 'newowner', display_name: 'New Owner' } }
      // First call: initial load; second call: triggered by group.updated event
      mockGetGroup
        .mockResolvedValueOnce(fakeGroup)
        .mockResolvedValueOnce(updatedGroup)
      await loadGroup()

      act(() => {
        capturedOnEvent?.({ event: 'group.updated', data: { id: 1, name: fakeGroup.name, owner: { id: 2, username: 'newowner', display_name: 'New Owner', avatar_url: null } } } as BoardEvent)
      })

      // getGroup must be called a second time — once for initial load, once for the event
      await waitFor(() => {
        expect(mockGetGroup).toHaveBeenCalledTimes(2)
      })
    })

    it('patches is_starred on board.star_changed for the current user (#952)', async () => {
      const boardWithUid = { ...existingBoard, uid: 'board-uid-1', is_starred: false }
      mockGetGroup.mockResolvedValue(fakeGroup)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([boardWithUid])
      renderGroupDetail()
      await screen.findByText('Sprint Board')

      act(() => {
        capturedOnEvent?.({
          event: 'board.star_changed',
          data: { uid: 'board-uid-1', user_id: fakeUser.id, is_starred: true },
        } as BoardEvent)
      })

      // No refetch — the boards list is patched in place. Star state mutation
      // is not directly visible in this rendering, but the event handler must
      // accept the payload without throwing and without triggering getGroup.
      expect(mockGetGroup).toHaveBeenCalledTimes(1)
    })

    it('ignores board.star_changed for a different user (#952)', async () => {
      const boardWithUid = { ...existingBoard, uid: 'board-uid-1', is_starred: false }
      mockGetGroup.mockResolvedValue(fakeGroup)
      mockGetGroupMembers.mockResolvedValue([{ id: 1, user: fakeUser, role: 'admin', joined_at: '' }])
      mockGetSubgroups.mockResolvedValue([])
      mockGetGroupBoards.mockResolvedValue([boardWithUid])
      renderGroupDetail()
      await screen.findByText('Sprint Board')

      // Star event for a different user must not affect local state and must
      // not throw.  Star is per-user; the group channel broadcasts to all
      // group members, so each client filters on user_id === me.
      act(() => {
        capturedOnEvent?.({
          event: 'board.star_changed',
          data: { uid: 'board-uid-1', user_id: 999, is_starred: true },
        } as BoardEvent)
      })

      expect(mockGetGroup).toHaveBeenCalledTimes(1)
    })
  })
})
