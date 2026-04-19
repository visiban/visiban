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
  patchBoard: vi.fn(),
  deleteBoard: vi.fn(),
  enableBoardSharing: vi.fn(),
  disableBoardSharing: vi.fn(),
}))

vi.mock('../api/auth', () => ({
  searchUsers: vi.fn(),
}))

import { setBoardMember, removeBoardMember, exportBoardCsv, exportBoardJson, patchBoard, enableBoardSharing, disableBoardSharing } from '../api/boards'
import { searchUsers } from '../api/auth'

const mockSetBoardMember = setBoardMember as ReturnType<typeof vi.fn>
const mockRemoveBoardMember = removeBoardMember as ReturnType<typeof vi.fn>
const mockExportBoardCsv = exportBoardCsv as ReturnType<typeof vi.fn>
const mockExportBoardJson = exportBoardJson as ReturnType<typeof vi.fn>
const mockPatchBoard = patchBoard as ReturnType<typeof vi.fn>
const mockSearchUsers = searchUsers as ReturnType<typeof vi.fn>
const mockEnableBoardSharing = enableBoardSharing as ReturnType<typeof vi.fn>
const mockDisableBoardSharing = disableBoardSharing as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1,
  username: 'admin',
  email: 'admin@example.com',
  first_name: 'Admin',
  last_name: 'User',
  avatar_url: '',
  display_name: 'Admin User',
  is_site_admin: false,
  must_change_password: false, must_change_username: false,
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
  must_change_password: false, must_change_username: false,
  has_usable_password: true,
}

const fakeBoard: BoardFull = {
  id: 1,
  uid: 'boarduid0001',
  name: 'Sprint Board',
  description: '',
  group: null,
  group_name: null,
  columns: [],
  swimlanes: [],
  cards: [],
  labels: [],
  members: [
    { id: 10, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' },
    { id: 11, user: fakeMember2, role: 'member', is_moderator: false, joined_at: '' },
  ],
  staleness_threshold_days: 7,
  stale_warning_pct: 50,
  allowed_priorities: [],
  enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false,
  is_starred: false,
  created_at: '',
  updated_at: '',
  current_user_role: 'admin',
  owner: fakeUser,
  capabilities: { movement_export: false },
  share_token: null,
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
    await user.click(screen.getByRole('button', { name: 'Close' }))
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

  it('Invite tab button does NOT appear in the tab bar', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull()
  })

  it('Invite tab button does NOT appear for non-admins either', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={false} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull()
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
    // Custom dropdown triggers (role="combobox") show the current role label for each member
    const combos = screen.getAllByRole('combobox')
    expect(combos.some((c) => c.textContent?.includes('Admin'))).toBe(true)
    expect(combos.some((c) => c.textContent?.includes('Member'))).toBe(true)
  })

  it('shows role badges (not selects) when isAdmin=false', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={false} onClose={vi.fn()} />)
    // No dropdown triggers when user is not admin — roles shown as text badges
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByText('admin')).toBeInTheDocument()
    expect(screen.getByText('member')).toBeInTheDocument()
  })

  it('changing role select calls setBoardMember with correct args', async () => {
    const user = userEvent.setup()
    mockSetBoardMember.mockResolvedValue({ id: 11, user: fakeMember2, role: 'viewer', is_moderator: false, joined_at: '' })
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    // Open Bob's dropdown (currently showing 'Member') and select 'Viewer'
    const memberCombo = screen.getAllByRole('combobox').find((c) => c.textContent?.includes('Member'))!
    await user.click(memberCombo)
    await user.click(screen.getByRole('option', { name: 'Viewer' }))

    expect(mockSetBoardMember).toHaveBeenCalledWith(1, 2, 'viewer')
  })

  it('role change updates the displayed role after API resolves', async () => {
    const user = userEvent.setup()
    mockSetBoardMember.mockResolvedValue({ id: 11, user: fakeMember2, role: 'viewer', is_moderator: false, joined_at: '' })
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    const memberCombo2 = screen.getAllByRole('combobox').find((c) => c.textContent?.includes('Member'))!
    await user.click(memberCombo2)
    await user.click(screen.getByRole('option', { name: 'Viewer' }))

    await waitFor(() => {
      // After the API resolves, Bob's dropdown trigger shows 'Viewer'
      const combos = screen.getAllByRole('combobox')
      expect(combos.some((c) => c.textContent?.includes('Viewer'))).toBe(true)
    })
  })

  it('clicking ✕ shows inline remove confirmation for that member', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    // Find the ✕ button next to Bob
    const removeButtons = screen.getAllByTitle('Remove direct board role')
    await user.click(removeButtons[removeButtons.length - 1])

    expect(screen.getByText('Bob Smith', { selector: 'span.text-fg' })).toBeInTheDocument()
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

  // ── Add-member section (merged from Invite tab) ──

  it('Members tab shows add-member search input for admins', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    expect(screen.getByPlaceholderText(/search by name or email/i)).toBeInTheDocument()
  })

  it('Members tab does NOT show add-member section for non-admins', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={false} onClose={vi.fn()} />)
    expect(screen.queryByPlaceholderText(/search by name or email/i)).toBeNull()
  })

  it('Members tab shows "Add member" section heading for admins', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    expect(screen.getByText(/add member/i)).toBeInTheDocument()
  })
})

// ─── Add-member flow (in Members tab) ──────────────────────────────────────

// Helper to stage a user. Uses fake timers + manual debounce advance.
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
  must_change_password: false, must_change_username: false,
  has_usable_password: true,
}

async function stageAlice() {
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

describe('BoardSettingsModal — add-member flow (Members tab)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('typing <2 chars shows no suggestions', async () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

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
    // Staged user defaults to 'member' role — at least one 'Member' combobox is present
    // (there may be another for the existing Bob Smith row)
    const memberCombos = screen.getAllByRole('combobox').filter((c) => c.textContent?.includes('Member'))
    expect(memberCombos.length).toBeGreaterThanOrEqual(1)
  })

  it('can change the staged user role', async () => {
    mockSearchUsers.mockResolvedValue([aliceUser])
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await stageAlice()

    // Two 'Member' comboboxes exist: Bob Smith's row + Alice's staged entry.
    // The staged entry is the last one — click it to open the dropdown.
    const memberCombos = screen.getAllByRole('combobox').filter((c) => c.textContent?.includes('Member'))
    await act(async () => {
      memberCombos[memberCombos.length - 1].click()
    })
    await act(async () => {
      screen.getByRole('option', { name: 'Viewer' }).click()
    })

    // Alice's staged dropdown now shows 'Viewer'
    const combos = screen.getAllByRole('combobox')
    expect(combos.some((c) => c.textContent?.includes('Viewer'))).toBe(true)
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

    const submitBtn = screen.getByRole('button', { name: /add to board/i })
    expect(submitBtn).toBeDisabled()
  })

  it('submit calls setBoardMember for each staged user and shows success message', async () => {
    mockSearchUsers.mockResolvedValue([aliceUser])
    mockSetBoardMember.mockResolvedValue({ id: 99, user: aliceUser, role: 'member', is_moderator: false, joined_at: '' })
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

  it('clicking Data tab shows format radio options and Export button', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Data' }))
    expect(screen.getByRole('radio', { name: /JSON/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /CSV/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export JSON' })).toBeInTheDocument()
  })

  it('JSON is pre-selected and Export JSON calls exportBoardJson and onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'Data' }))
    expect(screen.getByRole('radio', { name: /JSON/i })).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Export JSON' }))

    expect(mockExportBoardJson).toHaveBeenCalledWith(1)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('selecting CSV and clicking Export CSV calls exportBoardCsv and onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'Data' }))
    await user.click(screen.getByRole('radio', { name: /CSV/i }))
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(mockExportBoardCsv).toHaveBeenCalledWith(1)
    expect(onClose).toHaveBeenCalledOnce()
  })
})

// ─── Analytics tab — staleness threshold ────────────────────────────────────

describe('BoardSettingsModal — Rules tab staleness threshold', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPatchBoard.mockResolvedValue({})
  })

  it('shows staleness threshold input for admins in Rules tab', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Rules' }))

    const input = screen.getByRole('spinbutton', { name: /stale card threshold/i })
    expect(input).toBeInTheDocument()
    expect(input).toHaveValue(7)
  })

  it('staleness threshold input is editable for admins', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Rules' }))

    const input = screen.getByRole('spinbutton', { name: /stale card threshold/i })
    expect(input).not.toHaveAttribute('readonly')
    expect(input).not.toBeDisabled()
  })

  it('calls patchBoard on blur with updated staleness value', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Rules' }))

    const input = screen.getByRole('spinbutton', { name: /stale card threshold/i })
    await user.clear(input)
    await user.type(input, '21')
    await user.tab() // triggers blur

    await waitFor(() => {
      expect(mockPatchBoard).toHaveBeenCalledWith(1, { staleness_threshold_days: 21 })
    })
  })

  it('shows read-only staleness text for non-admins in Rules tab', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={false} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Rules' }))

    // Should show the values as plain text, not inputs
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(screen.getByText(/7 days.*50%/i)).toBeInTheDocument()
  })

  it('calls patchBoard on blur with updated stale_warning_pct value', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Rules' }))

    const input = screen.getByRole('spinbutton', { name: /heatmap warning percentage/i })
    await user.clear(input)
    await user.type(input, '25')
    await user.tab()

    await waitFor(() => {
      expect(mockPatchBoard).toHaveBeenCalledWith(1, { stale_warning_pct: 25 })
    })
  })

  it('falls back to 14 days when staleness_threshold_days is null', async () => {
    const user = userEvent.setup()
    const boardNoThreshold: BoardFull = { ...fakeBoard, staleness_threshold_days: null as unknown as number }
    render(<BoardSettingsModal board={boardNoThreshold} isAdmin={false} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Rules' }))

    expect(screen.getByText(/14 days/i)).toBeInTheDocument()
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
    expect(screen.getByRole('radio', { name: /JSON/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /CSV/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export JSON' })).toBeInTheDocument()
  })

  it('renders with initialTab="members" (default) starting on the members tab', () => {
    render(
      <BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="members" />
    )
    expect(screen.getByText('Admin User')).toBeInTheDocument()
    expect(screen.getByText('Bob Smith')).toBeInTheDocument()
  })
})

// ─── Sharing tab ───────────────────────────────────────────────────────────

describe('BoardSettingsModal — Sharing tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnableBoardSharing.mockResolvedValue({ share_token: 'abc-token-123', share_url: 'http://localhost/share/abc-token-123' })
    mockDisableBoardSharing.mockResolvedValue({})
  })

  it('Sharing tab is visible for admins', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Sharing' })).toBeInTheDocument()
  })

  it('Sharing tab is NOT visible for non-admins', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={false} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Sharing' })).toBeNull()
  })

  it('Sharing tab shows toggle and explanatory copy', async () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="sharing" />)
    expect(screen.getByText('Public sharing')).toBeInTheDocument()
    expect(screen.getByText('Enable public share link')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Enable public share link' })).toBeInTheDocument()
  })

  it('enabling share calls enableBoardSharing and shows URL', async () => {
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="sharing" />)

    const toggle = screen.getByRole('switch', { name: 'Enable public share link' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await user.click(toggle)
    await waitFor(() => expect(mockEnableBoardSharing).toHaveBeenCalledWith(1))
    await waitFor(() => expect(screen.getByText(/abc-token-123/)).toBeInTheDocument())
  })

  it('disabling share calls disableBoardSharing and hides URL', async () => {
    const user = (await import('@testing-library/user-event')).default.setup()
    const boardWithToken = { ...fakeBoard, share_token: 'existing-token-xyz' }
    render(<BoardSettingsModal board={boardWithToken} isAdmin={true} onClose={vi.fn()} initialTab="sharing" />)

    // URL should be visible initially
    expect(screen.getByText(/existing-token-xyz/)).toBeInTheDocument()

    const toggle = screen.getByRole('switch', { name: 'Enable public share link' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await user.click(toggle)
    await waitFor(() => expect(mockDisableBoardSharing).toHaveBeenCalledWith(1))
    await waitFor(() => expect(screen.queryByText(/existing-token-xyz/)).toBeNull())
  })

  it('does not show Sharing tab content for non-admin even if navigated directly', () => {
    // Non-admin cannot select "sharing" tab — it won't exist in DOM
    render(<BoardSettingsModal board={fakeBoard} isAdmin={false} onClose={vi.fn()} />)
    expect(screen.queryByText('Public sharing')).toBeNull()
  })
})

// ─── Moderator toggle ────────────────────────────────────────────────────

describe('BoardSettingsModal — Moderator toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows moderator checkbox for all non-site-admin members when isAdmin', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    // Both admin and member rows now show a Moderator checkbox (#574)
    expect(screen.getAllByText('Moderator').length).toBeGreaterThanOrEqual(2)
  })

  it('admin-role moderator checkbox is checked and disabled (#574)', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    // All checkboxes: admin row is first (checked+disabled), member row is second (editable)
    const checkboxes = screen.getAllByRole('checkbox')
    const adminCheckbox = checkboxes[0]
    expect(adminCheckbox).toBeChecked()
    expect(adminCheckbox).toBeDisabled()
  })

  it('member-role moderator checkbox is enabled and reflects is_moderator value', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    const checkboxes = screen.getAllByRole('checkbox')
    // Member checkbox is the second one (admin's disabled checkbox is first)
    const memberCheckbox = checkboxes[1]
    expect(memberCheckbox).not.toBeDisabled()
    expect(memberCheckbox).not.toBeChecked() // is_moderator: false in fixture
  })

  it('hides moderator checkbox when isAdmin is false', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={false} onClose={vi.fn()} />)
    expect(screen.queryByText('Moderator')).toBeNull()
  })

  it('toggling moderator calls setBoardMember with is_moderator', async () => {
    const user = userEvent.setup()
    mockSetBoardMember.mockResolvedValue({ id: 11, user: fakeMember2, role: 'member', is_moderator: true, joined_at: '' })
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    // Member's checkbox is the second one; the first (admin) is disabled
    const checkboxes = screen.getAllByRole('checkbox')
    await user.click(checkboxes[1])

    expect(mockSetBoardMember).toHaveBeenCalledWith(1, 2, 'member', true)
  })

  it('collaborator-role moderator checkbox is unchecked and disabled (#574)', () => {
    const boardWithCollab = {
      ...fakeBoard,
      members: [
        { id: 12, user: fakeMember2, role: 'collaborator' as const, is_moderator: false, joined_at: '' },
      ],
    }
    render(<BoardSettingsModal board={boardWithCollab} isAdmin={true} onClose={vi.fn()} />)
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).not.toBeChecked()
    expect(checkbox).toBeDisabled()
  })

  it('viewer-role moderator checkbox is unchecked and disabled (#574)', () => {
    const boardWithViewer = {
      ...fakeBoard,
      members: [
        { id: 13, user: fakeMember2, role: 'viewer' as const, is_moderator: false, joined_at: '' },
      ],
    }
    render(<BoardSettingsModal board={boardWithViewer} isAdmin={true} onClose={vi.fn()} />)
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).not.toBeChecked()
    expect(checkbox).toBeDisabled()
  })
})
