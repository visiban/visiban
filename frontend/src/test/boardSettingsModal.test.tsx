import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardSettingsModal from '../components/Board/BoardSettingsModal'
import type { BoardFull, User } from '../types'

vi.mock('../api/boards', () => ({
  setBoardMember: vi.fn(),
  removeBoardMember: vi.fn(),
  exportBoardCsv: vi.fn(),
  exportBoardJson: vi.fn(),
}))

vi.mock('../api/auth', () => ({
  searchUsers: vi.fn(),
}))

import { setBoardMember, removeBoardMember, exportBoardCsv, exportBoardJson } from '../api/boards'
import { searchUsers } from '../api/auth'

const mockSetBoardMember = setBoardMember as ReturnType<typeof vi.fn>
const mockRemoveBoardMember = removeBoardMember as ReturnType<typeof vi.fn>
const mockExportBoardCsv = exportBoardCsv as ReturnType<typeof vi.fn>
const mockExportBoardJson = exportBoardJson as ReturnType<typeof vi.fn>
const mockSearchUsers = searchUsers as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1,
  username: 'admin',
  email: 'admin@example.com',
  first_name: 'Admin',
  last_name: 'User',
  avatar_url: '',
  display_name: 'Admin User',
  is_site_admin: false,
  must_change_password: false,
  has_usable_password: true,
}

const fakeMember2: User = {
  id: 2,
  username: 'bob',
  email: 'bob@example.com',
  first_name: 'Bob',
  last_name: 'Smith',
  avatar_url: '',
  display_name: 'Bob Smith',
  is_site_admin: false,
  must_change_password: false,
  has_usable_password: true,
}

const fakeBoard: BoardFull = {
  id: 1,
  name: 'Sprint Board',
  description: '',
  group: null,
  group_name: null,
  columns: [],
  swimlanes: [],
  cards: [],
  labels: [],
  members: [
    { id: 10, user: fakeUser, role: 'admin', joined_at: '' },
    { id: 11, user: fakeMember2, role: 'member', joined_at: '' },
  ],
  staleness_threshold_days: 7,
  close_editor_on_enter: false,
  allowed_priorities: [],
  created_at: '',
  updated_at: '',
  current_user_role: 'admin',
}

// ─── Modal basics ──────────────────────────────────────────────────────────

describe('BoardSettingsModal — modal basics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders "Board Settings" heading', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    expect(screen.getByText('Board Settings')).toBeInTheDocument()
  })

  it('close button calls onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: '×' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('clicking the backdrop (dark overlay) calls onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { container } = render(
      <BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={onClose} />
    )
    // The outer fixed div is the backdrop; it has class "fixed inset-0"
    const backdrop = container.firstChild as HTMLElement
    await user.click(backdrop)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('Escape key calls onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={onClose} />)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })
})

// ─── Members tab ───────────────────────────────────────────────────────────

describe('BoardSettingsModal — Members tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows all member names', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    expect(screen.getByText('Admin User')).toBeInTheDocument()
    expect(screen.getByText('Bob Smith')).toBeInTheDocument()
  })

  it('shows role selects for each member when isAdmin=true', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    const selects = screen.getAllByRole('combobox')
    // At least 2 selects (one per member) on the members tab
    expect(selects.length).toBeGreaterThanOrEqual(2)
  })

  it('shows role badges (not selects) when isAdmin=false', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={false} onClose={vi.fn()} />)
    expect(screen.queryByRole('combobox')).toBeNull()
    // Role values should appear as text badges
    expect(screen.getByText('admin')).toBeInTheDocument()
    expect(screen.getByText('member')).toBeInTheDocument()
  })

  it('changing role select calls setBoardMember with correct args', async () => {
    const user = userEvent.setup()
    mockSetBoardMember.mockResolvedValue({ id: 11, user: fakeMember2, role: 'viewer', joined_at: '' })
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    // Find Bob's role select (value starts as 'member')
    const selects = screen.getAllByRole('combobox')
    const bobSelect = selects.find((s) => (s as HTMLSelectElement).value === 'member') as HTMLSelectElement
    await user.selectOptions(bobSelect, 'viewer')

    expect(mockSetBoardMember).toHaveBeenCalledWith(1, 2, 'viewer')
  })

  it('role change updates the displayed role after API resolves', async () => {
    const user = userEvent.setup()
    mockSetBoardMember.mockResolvedValue({ id: 11, user: fakeMember2, role: 'viewer', joined_at: '' })
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    const selects = screen.getAllByRole('combobox')
    const bobSelect = selects.find((s) => (s as HTMLSelectElement).value === 'member') as HTMLSelectElement
    await user.selectOptions(bobSelect, 'viewer')

    await waitFor(() => {
      // After the API resolves, the same select element should now show 'viewer'
      expect((bobSelect as HTMLSelectElement).value).toBe('viewer')
    })
  })

  it('clicking ✕ shows inline remove confirmation for that member', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    // Find the ✕ button next to Bob
    const removeButtons = screen.getAllByTitle('Remove direct board role')
    await user.click(removeButtons[removeButtons.length - 1])

    expect(screen.getByText('Bob Smith', { selector: 'span.text-white' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('confirm remove calls removeBoardMember and removes the member from the list', async () => {
    const user = userEvent.setup()
    mockRemoveBoardMember.mockResolvedValue(undefined)
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    const removeButtons = screen.getAllByTitle('Remove direct board role')
    await user.click(removeButtons[removeButtons.length - 1])

    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => {
      expect(mockRemoveBoardMember).toHaveBeenCalledWith(1, 2)
    })
    await waitFor(() => {
      expect(screen.queryByText('Bob Smith')).toBeNull()
    })
  })

  it('cancel on remove confirmation hides the confirmation', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    const removeButtons = screen.getAllByTitle('Remove direct board role')
    await user.click(removeButtons[removeButtons.length - 1])
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  })

  it('shows empty state "No members yet." when members=[]', () => {
    const emptyBoard: BoardFull = { ...fakeBoard, members: [] }
    render(<BoardSettingsModal board={emptyBoard} isAdmin={true} onClose={vi.fn()} />)
    expect(screen.getByText('No members yet.')).toBeInTheDocument()
  })

  it('footer note about inherited members is visible', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    expect(screen.getByText(/inherited from group membership/i)).toBeInTheDocument()
  })
})

// ─── Invite tab ────────────────────────────────────────────────────────────

// Helper to stage a user in the invite tab. Uses real timers + manual debounce advance.
// Must be called inside a test that has already set up fake timers.
const aliceUser: User = {
  id: 99,
  username: 'alice',
  email: 'alice@example.com',
  first_name: 'Alice',
  last_name: 'Wonder',
  avatar_url: '',
  display_name: 'Alice Wonder',
  is_site_admin: false,
  must_change_password: false,
  has_usable_password: true,
}

async function stageAlice() {
  // navigate to invite tab (no debounce involved for the click)
  await act(async () => {
    screen.getByRole('button', { name: 'Invite' }).click()
  })

  const input = screen.getByPlaceholderText(/search by name or email/i)

  // Fire change event directly to avoid userEvent timing interactions with fake timers
  await act(async () => {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    nativeInputValueSetter?.call(input, 'ali')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

  // Advance the debounce timer
  await act(async () => {
    vi.advanceTimersByTime(350)
  })

  // Wait for suggestion to appear
  await waitFor(() => screen.getByText('Alice Wonder'))

  // Click the suggestion using mousedown (as the component uses onMouseDown)
  await act(async () => {
    screen.getByText('Alice Wonder').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })

  await waitFor(() => screen.getByText(/to be added/i))
}

describe('BoardSettingsModal — Invite tab', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('Invite tab is NOT shown when isAdmin=false', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={false} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull()
  })

  it('clicking Invite tab shows the search input when isAdmin=true', async () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await act(async () => { screen.getByRole('button', { name: 'Invite' }).click() })
    expect(screen.getByPlaceholderText(/search by name or email/i)).toBeInTheDocument()
  })

  it('typing <2 chars shows no suggestions', async () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await act(async () => { screen.getByRole('button', { name: 'Invite' }).click() })

    const input = screen.getByPlaceholderText(/search by name or email/i)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'a')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { vi.advanceTimersByTime(350) })

    expect(mockSearchUsers).not.toHaveBeenCalled()
  })

  it('typing ≥2 chars calls searchUsers after debounce', async () => {
    mockSearchUsers.mockResolvedValue([])
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await act(async () => { screen.getByRole('button', { name: 'Invite' }).click() })

    const input = screen.getByPlaceholderText(/search by name or email/i)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'al')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { vi.advanceTimersByTime(350) })

    await waitFor(() => { expect(mockSearchUsers).toHaveBeenCalledWith('al') })
  })

  it('clicking a suggestion adds it to the staged list', async () => {
    mockSearchUsers.mockResolvedValue([aliceUser])
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await stageAlice()
    expect(screen.getByText(/to be added/i)).toBeInTheDocument()
  })

  it('staged invite shows the user name and a role select', async () => {
    mockSearchUsers.mockResolvedValue([aliceUser])
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await stageAlice()

    expect(screen.getAllByText('Alice Wonder').length).toBeGreaterThanOrEqual(1)
    const selects = screen.getAllByRole('combobox')
    expect(selects.length).toBeGreaterThanOrEqual(1)
  })

  it('can change the staged user role', async () => {
    mockSearchUsers.mockResolvedValue([aliceUser])
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await stageAlice()

    const selects = screen.getAllByRole('combobox')
    const stagedSelect = selects[selects.length - 1] as HTMLSelectElement

    await act(async () => {
      stagedSelect.value = 'viewer'
      stagedSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(stagedSelect.value).toBe('viewer')
  })

  it('can remove a staged user via ✕ button', async () => {
    mockSearchUsers.mockResolvedValue([aliceUser])
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await stageAlice()

    const removeBtn = screen.getByTitle('Remove from invite list')
    await act(async () => { removeBtn.click() })

    await waitFor(() => { expect(screen.queryByText(/to be added/i)).toBeNull() })
  })

  it('submit button is disabled when staged list is empty', async () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await act(async () => { screen.getByRole('button', { name: 'Invite' }).click() })

    const submitBtn = screen.getByRole('button', { name: /add to board/i })
    expect(submitBtn).toBeDisabled()
  })

  it('submit calls setBoardMember for each staged user and shows success message', async () => {
    mockSearchUsers.mockResolvedValue([aliceUser])
    mockSetBoardMember.mockResolvedValue({ id: 99, user: aliceUser, role: 'member', joined_at: '' })
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await stageAlice()

    const submitBtn = screen.getByRole('button', { name: /add 1 member to board/i })
    await act(async () => { submitBtn.click() })

    await waitFor(() => { expect(mockSetBoardMember).toHaveBeenCalledWith(1, 99, 'member') })
    await waitFor(() => { expect(screen.getByText(/added 1 member to the board/i)).toBeInTheDocument() })
  })

  it('submit shows error message on failure', async () => {
    mockSearchUsers.mockResolvedValue([aliceUser])
    mockSetBoardMember.mockRejectedValue(new Error('Server error'))
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await stageAlice()

    const submitBtn = screen.getByRole('button', { name: /add 1 member to board/i })
    await act(async () => { submitBtn.click() })

    await waitFor(() => { expect(screen.getByText(/failed to add some members/i)).toBeInTheDocument() })
  })
})

// ─── Data tab ──────────────────────────────────────────────────────────────

describe('BoardSettingsModal — Data tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('clicking Data tab shows Export CSV and Export JSON buttons', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Data' }))
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export JSON' })).toBeInTheDocument()
  })

  it('Export CSV button calls exportBoardCsv and onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'Data' }))
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(mockExportBoardCsv).toHaveBeenCalledWith(1)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('Export JSON button calls exportBoardJson and onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'Data' }))
    await user.click(screen.getByRole('button', { name: 'Export JSON' }))

    expect(mockExportBoardJson).toHaveBeenCalledWith(1)
    expect(onClose).toHaveBeenCalledOnce()
  })
})

// ─── initialTab prop ───────────────────────────────────────────────────────

describe('BoardSettingsModal — initialTab prop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders with initialTab="data" starting on the data tab', () => {
    render(
      <BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="data" />
    )
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export JSON' })).toBeInTheDocument()
  })

  it('renders with initialTab="invite" starting on the invite tab', () => {
    render(
      <BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="invite" />
    )
    expect(screen.getByPlaceholderText(/search by name or email/i)).toBeInTheDocument()
  })
})
