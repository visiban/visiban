import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardMembersModal from '../components/Board/BoardMembersModal'
import type { BoardFull, User } from '../types'

vi.mock('../api/boards', () => ({
  setBoardMember: vi.fn(),
  removeBoardMember: vi.fn(),
}))

import { setBoardMember, removeBoardMember } from '../api/boards'
const mockSetBoardMember = setBoardMember as ReturnType<typeof vi.fn>
const mockRemoveBoardMember = removeBoardMember as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false,
}

const fakeBob = {
  id: 2, username: 'bob', display_name: 'Bob Smith', avatar_url: '',
}

const fakeBoard: BoardFull = {
  id: 1, uid: 'boarduid0001', name: 'Test', description: '', group: null, group_name: null,
  columns: [], swimlanes: [], cards: [], labels: [],
  members: [
    { id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' },
    { id: 2, user: fakeBob, role: 'member', is_moderator: false, joined_at: '' },
  ],
  staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
  enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, export_min_role: 'viewer', is_starred: false, created_at: '', updated_at: '', current_user_role: 'admin',
  owner: { id: 1, username: 'jdoe', display_name: 'Jane Doe', avatar_url: '' },
  capabilities: { movement_export: false },
}

describe('BoardMembersModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders member list', () => {
    render(<BoardMembersModal board={fakeBoard} onClose={vi.fn()} onMembersChanged={vi.fn()} />)
    expect(screen.getByText('Board Members')).toBeInTheDocument()
    expect(screen.getByText('Jane Doe')).toBeInTheDocument()
    expect(screen.getByText('Bob Smith')).toBeInTheDocument()
  })

  it('shows role legend', () => {
    render(<BoardMembersModal board={fakeBoard} onClose={vi.fn()} onMembersChanged={vi.fn()} />)
    expect(screen.getByText(/Full access/)).toBeInTheDocument()
    expect(screen.getByText(/Read-only/)).toBeInTheDocument()
  })

  it('renders role dropdowns', () => {
    render(<BoardMembersModal board={fakeBoard} onClose={vi.fn()} onMembersChanged={vi.fn()} />)
    // Custom dropdown triggers (role="combobox") show the current role label
    const combos = screen.getAllByRole('combobox')
    expect(combos.some((c) => c.textContent?.includes('Admin'))).toBe(true)
    expect(combos.some((c) => c.textContent?.includes('Member'))).toBe(true)
  })

  // --- New scenarios for #392 ---

  it('remove member: confirmation prompt appears when × button is clicked', async () => {
    render(<BoardMembersModal board={fakeBoard} onClose={vi.fn()} onMembersChanged={vi.fn()} />)
    // The × button has title "Remove direct board role"
    const removeBtn = screen.getAllByTitle('Remove direct board role')[0]
    await userEvent.setup().click(removeBtn)
    expect(screen.getByText('Remove?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'No' })).toBeInTheDocument()
  })

  it('remove member: confirming calls removeBoardMember and invokes onMembersChanged', async () => {
    mockRemoveBoardMember.mockResolvedValue(undefined)
    const onMembersChanged = vi.fn()
    render(
      <BoardMembersModal
        board={fakeBoard}
        onClose={vi.fn()}
        onMembersChanged={onMembersChanged}
      />
    )
    const user = userEvent.setup()
    const removeBtn = screen.getAllByTitle('Remove direct board role')[0]
    await user.click(removeBtn)
    await user.click(screen.getByRole('button', { name: 'Yes' }))
    await waitFor(() => {
      expect(mockRemoveBoardMember).toHaveBeenCalledWith(fakeBoard.id, expect.any(Number))
    })
    expect(onMembersChanged).toHaveBeenCalled()
  })

  it('remove member: cancelling confirmation dismisses prompt without API call', async () => {
    const user = userEvent.setup()
    render(<BoardMembersModal board={fakeBoard} onClose={vi.fn()} onMembersChanged={vi.fn()} />)
    const removeBtn = screen.getAllByTitle('Remove direct board role')[0]
    await user.click(removeBtn)
    expect(screen.getByText('Remove?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'No' }))
    expect(screen.queryByText('Remove?')).not.toBeInTheDocument()
    expect(mockRemoveBoardMember).not.toHaveBeenCalled()
  })

  it('role change via dropdown: selecting a new role calls setBoardMember', async () => {
    mockSetBoardMember.mockResolvedValue({ id: 2, user: fakeBob, role: 'viewer', is_moderator: false, joined_at: '' })
    const onMembersChanged = vi.fn()
    const user = userEvent.setup()
    render(
      <BoardMembersModal
        board={fakeBoard}
        onClose={vi.fn()}
        onMembersChanged={onMembersChanged}
      />
    )
    // Find the Bob's role dropdown (second combobox — Admin is first, Member is second)
    const combos = screen.getAllByRole('combobox')
    const bobCombo = combos.find((c) => c.textContent?.includes('Member'))!
    await user.click(bobCombo)
    // Select "Viewer" from the listbox
    const viewerOption = screen.getByRole('option', { name: 'Viewer' })
    await user.click(viewerOption)
    await waitFor(() => {
      expect(mockSetBoardMember).toHaveBeenCalledWith(fakeBoard.id, fakeBob.id, 'viewer')
    })
    expect(onMembersChanged).toHaveBeenCalled()
  })

  it('site_admin member shows "site admin" badge instead of role dropdown', () => {
    const boardWithSiteAdmin: BoardFull = {
      ...fakeBoard,
      members: [
        { id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' },
        { id: 3, user: { id: 3, username: 'sysadmin', display_name: 'Sys Admin', avatar_url: '' }, role: 'site_admin', is_moderator: false, joined_at: '' },
      ],
    }
    render(<BoardMembersModal board={boardWithSiteAdmin} onClose={vi.fn()} onMembersChanged={vi.fn()} />)
    expect(screen.getByText('site admin')).toBeInTheDocument()
    // Only one combobox: the admin member's dropdown; site_admin has no dropdown
    const combos = screen.getAllByRole('combobox')
    expect(combos).toHaveLength(1)
  })
})
