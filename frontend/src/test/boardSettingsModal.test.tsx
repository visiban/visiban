import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
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
  getBoardExportHistory: vi.fn().mockResolvedValue({ results: [], count: 0, next: null, previous: null }),
  // #1444 — the Members tab's invite section.
  listBoardInviteLinks: vi.fn().mockResolvedValue([]),
  revokeBoardInviteLink: vi.fn(),
  sendBoardInviteEmail: vi.fn(),
  // #439 — shareable invite links.
  createBoardInviteLink: vi.fn(),
}))

vi.mock('../api/auth', () => ({
  searchUsers: vi.fn(),
  getSiteConfig: vi.fn().mockResolvedValue({
    registration_open: true, registration_mode: 'open', demo_mode: false, demo_login: null,
    invite_email_available: true,
  }),
}))

import { setBoardMember, removeBoardMember, exportBoardCsv, exportBoardJson, patchBoard, enableBoardSharing, disableBoardSharing, getBoardExportHistory } from '../api/boards'
import { searchUsers } from '../api/auth'

const mockSetBoardMember = setBoardMember as ReturnType<typeof vi.fn>
const mockRemoveBoardMember = removeBoardMember as ReturnType<typeof vi.fn>
const mockExportBoardCsv = exportBoardCsv as ReturnType<typeof vi.fn>
const mockExportBoardJson = exportBoardJson as ReturnType<typeof vi.fn>
const mockPatchBoard = patchBoard as ReturnType<typeof vi.fn>
const mockSearchUsers = searchUsers as ReturnType<typeof vi.fn>
const mockEnableBoardSharing = enableBoardSharing as ReturnType<typeof vi.fn>
const mockDisableBoardSharing = disableBoardSharing as ReturnType<typeof vi.fn>
const mockGetBoardExportHistory = getBoardExportHistory as ReturnType<typeof vi.fn>

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
  archived_card_count: 0,
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
  enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false, show_row_chip_field_names: true, export_min_role: 'viewer',
  card_density: 'comfortable',
  is_starred: false,
  created_at: '',
  updated_at: '',
  current_user_role: 'admin',
  custom_field_definitions: [],
  swimlane_custom_field_definitions: [],
  owner: fakeUser,
  capabilities: { movement_export: false },
  share_token: null,
  share_token_expires_at: null,
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

  // #1373 — handleRoleChange had no catch at all (a genuine unhandled promise
  // rejection, not just an unsurfaced error), found while fixing the sibling
  // floating-promise sites in this same component.
  it('shows an error and keeps the previous role when setBoardMember rejects', async () => {
    const user = userEvent.setup()
    mockSetBoardMember.mockRejectedValueOnce(new Error('network error'))
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    const memberCombo = screen.getAllByRole('combobox').find((c) => c.textContent?.includes('Member'))!
    await user.click(memberCombo)
    await user.click(screen.getByRole('option', { name: 'Viewer' }))

    expect(await screen.findByText('Failed to update role. Please try again.')).toBeInTheDocument()
    const combos = screen.getAllByRole('combobox')
    expect(combos.some((c) => c.textContent?.includes('Member'))).toBe(true)
  })

  it('clicking ✕ shows inline remove confirmation for that member', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    // Find the ✕ button next to Bob
    const removeButtons = screen.getAllByTitle('Remove direct board role')
    await user.click(removeButtons[removeButtons.length - 1])

    expect(screen.getByText('Bob Smith', { selector: 'span.text-fg' })).toBeInTheDocument()
    expect(screen.getByText(/from this board\?/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('announces the remove-member prompt through a polite live region (#1421)', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    const removeButtons = screen.getAllByTitle('Remove direct board role')
    await user.click(removeButtons[removeButtons.length - 1])
    const region = screen.getByText(/from this board\?/).closest('[aria-live]')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveAttribute('aria-atomic', 'true')
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

  // #1373 — handleRemoveConfirm had no catch at all (a genuine unhandled
  // promise rejection, not just an unsurfaced error), found while fixing the
  // sibling floating-promise sites in this same component.
  it('shows an error and keeps the member when removeBoardMember rejects', async () => {
    const user = userEvent.setup()
    mockRemoveBoardMember.mockRejectedValueOnce(new Error('network error'))
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    const removeButtons = screen.getAllByTitle('Remove direct board role')
    await user.click(removeButtons[removeButtons.length - 1])
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Failed to remove member. Please try again.')).toBeInTheDocument()
    expect(screen.getByText('Bob Smith')).toBeInTheDocument()
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

  // #1367 — focus returns to the ✕ trigger when the inline confirm is dismissed.
  it('Cancel on remove confirmation returns focus to that member\'s trigger (#1367)', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    const removeButtons = screen.getAllByTitle('Remove direct board role')
    const bobTrigger = removeButtons[removeButtons.length - 1]
    await user.click(bobTrigger)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
    const after = screen.getAllByTitle('Remove direct board role')
    expect(after[after.length - 1]).toHaveFocus()
  })

  it('Confirm stays disabled while the remove request is in flight (#1367)', async () => {
    const user = userEvent.setup()
    mockRemoveBoardMember.mockReturnValue(new Promise(() => {}))
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    const removeButtons = screen.getAllByTitle('Remove direct board role')
    await user.click(removeButtons[removeButtons.length - 1])
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    // The prompt stays open until the request settles, so the guard is live
    // (not dead code) and prevents a double submit.
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled()
  })

  it('Cancel on the hard WIP confirm returns focus to the hard mode toggle (#1367)', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="rules" onUpdateBoardSettings={vi.fn()} />)

    await user.click(screen.getByRole('switch', { name: 'Hard mode (no admin override)' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
    expect(screen.getByRole('switch', { name: 'Hard mode (no admin override)' })).toHaveFocus()
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

// ─── Member-row lock keyed on the member's is_site_admin (#1290) ───────────

describe('BoardSettingsModal — site-admin member lock (#1290)', () => {
  // A real site admin holding an ordinary explicit membership: role "member".
  const siteAdminMember = {
    id: 12,
    user: { id: 3, username: 'root', display_name: 'Root Admin', avatar_url: '' },
    role: 'member' as const,
    is_moderator: false,
    is_site_admin: true,
    joined_at: '',
  }
  // All-content access without site-admin status: synthesized role "site_admin".
  const allContentMember = {
    id: null,
    user: { id: 4, username: 'auditor', display_name: 'Audit Reader', avatar_url: '' },
    role: 'site_admin' as const,
    is_moderator: false,
    is_site_admin: false,
    joined_at: '',
  }
  const lockBoard: BoardFull = {
    ...fakeBoard,
    members: [
      { id: 10, user: fakeUser, role: 'admin', is_moderator: false, is_site_admin: false, joined_at: '' },
      siteAdminMember,
      allContentMember,
    ],
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('locks a site-admin member with an explicit membership for a non-site-admin caller', () => {
    render(<BoardSettingsModal board={lockBoard} isAdmin={true} onClose={vi.fn()} />)
    // Two dropdowns: the caller's own row and the all-content row. The
    // site-admin member's row is static text with no dropdown.
    expect(screen.getAllByRole('combobox')).toHaveLength(2)
    const locked = screen.getByTitle('Site administrator — role managed at the instance level')
    expect(locked).toHaveTextContent('member')
    // One remove button: the site-admin row has none, the all-content row has
    // no membership row to remove (id null).
    expect(screen.getAllByTitle('Remove direct board role')).toHaveLength(1)
    // No moderator checkbox on the locked row either — only the admin's row.
    expect(screen.getAllByText('Moderator')).toHaveLength(1)
  })

  it('leaves an all-content member (role "site_admin", not a site admin) editable', async () => {
    const user = userEvent.setup()
    mockSetBoardMember.mockResolvedValue({ ...allContentMember, id: 13, role: 'viewer' })
    render(<BoardSettingsModal board={lockBoard} isAdmin={true} onClose={vi.fn()} />)
    const dropdown = screen.getByText('Site admin').closest('button') as HTMLButtonElement
    expect(dropdown).not.toBeDisabled()
    await user.click(dropdown)
    await user.click(screen.getByRole('option', { name: 'Viewer' }))
    await waitFor(() => {
      expect(mockSetBoardMember).toHaveBeenCalledWith(lockBoard.id, allContentMember.user.id, 'viewer')
    })
  })

  it('falls back to the role and stays locked when a row has no is_site_admin key', () => {
    const board: BoardFull = {
      ...fakeBoard,
      members: [
        { id: 10, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' },
        { id: null, user: { id: 5, username: 'legacy', display_name: 'Legacy Admin', avatar_url: '' }, role: 'site_admin', is_moderator: false, joined_at: '' },
      ],
    }
    render(<BoardSettingsModal board={board} isAdmin={true} onClose={vi.fn()} />)
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
    expect(screen.getByText('site admin')).toBeInTheDocument()
  })

  it('unlocks a site-admin member when the caller is a site admin', () => {
    render(<BoardSettingsModal board={lockBoard} isAdmin={true} currentUserIsSiteAdmin={true} onClose={vi.fn()} />)
    expect(screen.getAllByRole('combobox')).toHaveLength(3)
    expect(screen.queryByTitle('Site administrator — role managed at the instance level')).toBeNull()
    expect(screen.getAllByTitle('Remove direct board role')).toHaveLength(2)
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

  // Regression guard (#1305): the invite-search debounce (300ms) had no
  // unmount cleanup. Closing the modal mid-debounce must clear the timer,
  // not fire setSuggestions/setDropdownAnchor against a torn-down component.
  it('clears the pending invite-search debounce timer on unmount, without throwing', async () => {
    const { unmount } = render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText(/search by name or email/i)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'al')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // Debounced — searchUsers has not fired yet.
    expect(mockSearchUsers).not.toHaveBeenCalled()

    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => unmount()).not.toThrow()
    expect(clearSpy).toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    // Advancing past the original 300ms delay after unmount must not throw.
    expect(() => { vi.advanceTimersByTime(300) }).not.toThrow()
    expect(errorSpy).not.toHaveBeenCalled()

    clearSpy.mockRestore()
    errorSpy.mockRestore()
  })

  // #1457 — the suggestions are an anchored `fixed` popover of user data.
  async function showSuggestionsAt(top: number, bottom: number, height: number) {
    mockSearchUsers.mockResolvedValue([aliceUser])
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(height)
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText(/search by name or email/i)
    input.getBoundingClientRect = () =>
      ({ top, bottom, left: 40, right: 440, width: 400, height: bottom - top, x: 40, y: top, toJSON: () => ({}) }) as DOMRect
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'ali')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { vi.advanceTimersByTime(350) })
    await waitFor(() => screen.getByText('Alice Wonder'))
    return screen.getByTestId('member-suggestions')
  }

  it('places the suggestions below the search when they fit, capped at the viewport', async () => {
    const panel = await showSuggestionsAt(100, 130, 200)
    expect(panel.style.top).toBe('134px')
    expect(panel.style.visibility).toBe('')
    expect(panel.style.maxHeight).toBe('calc(100vh - 16px)')
    vi.restoreAllMocks()
  })

  it('places the suggestions above the search when they do not fit below', async () => {
    const panel = await showSuggestionsAt(window.innerHeight - 60, window.innerHeight - 30, 200)
    expect(panel.style.top).toBe(`${window.innerHeight - 60 - 4 - 200}px`)
    vi.restoreAllMocks()
  })

  it('flips the suggestions above the search when a later query returns more rows than fit below', async () => {
    const users = Array.from({ length: 8 }, (_, i) => ({
      ...aliceUser, id: 200 + i, username: `user${i}`, email: `user${i}@example.com`, display_name: `User ${i}`,
    }))
    mockSearchUsers.mockResolvedValueOnce([aliceUser]).mockResolvedValue(users)
    // The panel's measured height follows its rendered rows.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'member-suggestions' ? 20 + 52 * this.querySelectorAll('button').length : 0
    })
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText(/search by name or email/i)
    input.getBoundingClientRect = () =>
      ({ top: 638, bottom: 668, left: 40, right: 440, width: 400, height: 30, x: 40, y: 638, toJSON: () => ({}) }) as DOMRect
    const type = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => { vi.advanceTimersByTime(350) })
    }
    await type('ali')
    await waitFor(() => screen.getByText('Alice Wonder'))
    // One row (72px) fits below the input.
    expect(screen.getByTestId('member-suggestions').style.top).toBe('672px')
    await type('use')
    await waitFor(() => screen.getByText('User 7'))
    // Eight rows (436px) do not: it flips above rather than sliding up over the input.
    const top = parseFloat(screen.getByTestId('member-suggestions').style.top)
    expect(top).toBe(638 - 4 - 436)
    expect(top + 436).toBeLessThanOrEqual(638)
    vi.restoreAllMocks()
  })

  it('dismisses the suggestions on an outside scroll, not on a scroll of their own list', async () => {
    const panel = await showSuggestionsAt(100, 130, 200)
    fireEvent.scroll(panel)
    expect(screen.getByTestId('member-suggestions')).toBeInTheDocument()
    fireEvent.scroll(document)
    expect(screen.queryByTestId('member-suggestions')).toBeNull()
    vi.restoreAllMocks()
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

  // #1373 — handleStalenessBlur's patchBoard() call used to be a floating
  // promise: a rejection left the input showing the unsaved value with no
  // error and no revert.
  it('reverts the staleness threshold and shows an error when patchBoard rejects', async () => {
    mockPatchBoard.mockRejectedValueOnce(new Error('network error'))
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Rules' }))

    const input = screen.getByRole('spinbutton', { name: /stale card threshold/i })
    await user.clear(input)
    await user.type(input, '21')
    await user.tab()

    expect(await screen.findByText('Failed to save stale card threshold. Please try again.')).toBeInTheDocument()
    await waitFor(() => expect(input).toHaveValue(7))
  })

  // #1373 — handleStalenessBlur/handleStalenessWarningPctBlur now skip the
  // patchBoard() call entirely when the blurred value matches what was last
  // persisted, instead of always re-saving on every blur.
  it('does not call patchBoard when the staleness threshold is blurred without a change', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Rules' }))

    const input = screen.getByRole('spinbutton', { name: /stale card threshold/i })
    await user.click(input)
    await user.tab()

    expect(mockPatchBoard).not.toHaveBeenCalled()
  })

  it('does not call patchBoard when the warning percentage is blurred without a change', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Rules' }))

    const input = screen.getByRole('spinbutton', { name: /heatmap warning percentage/i })
    await user.click(input)
    await user.tab()

    expect(mockPatchBoard).not.toHaveBeenCalled()
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

  // #1373 — handleStalenessWarningPctBlur's patchBoard() call used to be a
  // floating promise: a rejection left the clamped value showing with no
  // error and no revert.
  it('reverts the warning percentage and shows an error when patchBoard rejects', async () => {
    mockPatchBoard.mockRejectedValueOnce(new Error('network error'))
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Rules' }))

    const input = screen.getByRole('spinbutton', { name: /heatmap warning percentage/i })
    await user.clear(input)
    await user.type(input, '25')
    await user.tab()

    expect(await screen.findByText('Failed to save warning percentage. Please try again.')).toBeInTheDocument()
    await waitFor(() => expect(input).toHaveValue(50))
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

  it('renders with an explicit initialTab="members" starting on the members tab', () => {
    render(
      <BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="members" />
    )
    expect(screen.getByText('Admin User')).toBeInTheDocument()
    expect(screen.getByText('Bob Smith')).toBeInTheDocument()
  })

  it('opens on Swimlane fields and focuses that tab button when deep-linked (#1458)', async () => {
    render(
      <BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="swimlane-fields" />
    )
    const tab = screen.getByRole('button', { name: 'Swimlane fields' })
    await waitFor(() => expect(document.activeElement).toBe(tab))
  })

  it('marks only the active tab with aria-current (#1458)', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="swimlane-fields" />)
    expect(screen.getByRole('button', { name: 'Swimlane fields' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: 'Card fields' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('button', { name: /^Members/ })).not.toHaveAttribute('aria-current')
  })

  it('does not steal focus from a control inside the modal that already has it (#1458)', async () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="data" />)
    const radio = screen.getByRole('radio', { name: /CSV/i })
    radio.focus()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect(document.activeElement).toBe(radio)
  })

  it('opens on Members by default without moving focus to a tab button (#1458)', async () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: /^Members/ }))
    expect(screen.getByText('Bob Smith')).toBeInTheDocument()
  })
})

// ─── Display tab → Card density radio (#961) ───────────────────────────────

describe('BoardSettingsModal — Card density radio', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('admin sees three density radios with the current selection checked', () => {
    render(
      <BoardSettingsModal
        board={{ ...fakeBoard, card_density: 'standard' }}
        isAdmin={true}
        onClose={vi.fn()}
        initialTab="display"
        onUpdateBoardSettings={vi.fn()}
      />,
    )
    const comfortable = screen.getByRole('radio', { name: /Comfortable/i })
    const standard = screen.getByRole('radio', { name: /Standard/i })
    const dense = screen.getByRole('radio', { name: /^Dense/i })
    expect(comfortable).not.toBeChecked()
    expect(standard).toBeChecked()
    expect(dense).not.toBeChecked()
  })

  it('clicking a density radio fires onUpdateBoardSettings({ card_density: ... })', async () => {
    const onUpdate = vi.fn()
    const user = userEvent.setup()
    render(
      <BoardSettingsModal
        board={fakeBoard}
        isAdmin={true}
        onClose={vi.fn()}
        initialTab="display"
        onUpdateBoardSettings={onUpdate}
      />,
    )
    await user.click(screen.getByRole('radio', { name: /^Dense/i }))
    expect(onUpdate).toHaveBeenCalledWith({ card_density: 'dense' })
  })

  it('non-admin sees a read-only line stating the current density', () => {
    render(
      <BoardSettingsModal
        board={{ ...fakeBoard, card_density: 'dense', current_user_role: 'viewer' }}
        isAdmin={false}
        onClose={vi.fn()}
        initialTab="display"
      />,
    )
    expect(screen.queryByRole('radio', { name: /Comfortable/i })).not.toBeInTheDocument()
    expect(screen.getByText(/Only board admins can change this/i)).toBeInTheDocument()
    expect(screen.getByText(/dense/i)).toBeInTheDocument()
  })
})

// ─── Display tab → Per-user density override (#974) ────────────────────────

describe('BoardSettingsModal — personal density override', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not render the "Use my own density" toggle when onSetCardDensityOverride is omitted', () => {
    render(
      <BoardSettingsModal
        board={fakeBoard}
        isAdmin={true}
        onClose={vi.fn()}
        initialTab="display"
        onUpdateBoardSettings={vi.fn()}
      />,
    )
    expect(screen.queryByText(/Use my own density/i)).not.toBeInTheDocument()
  })

  it('shows the toggle for non-admins too, without the admin radio group', () => {
    render(
      <BoardSettingsModal
        board={{ ...fakeBoard, card_density: 'dense', current_user_role: 'viewer' }}
        isAdmin={false}
        onClose={vi.fn()}
        initialTab="display"
        cardDensityOverride={null}
        onSetCardDensityOverride={vi.fn()}
      />,
    )
    expect(screen.queryByRole('radio', { name: /^Comfortable/i })).not.toBeInTheDocument()
    expect(screen.getByText(/Use my own density/i)).toBeInTheDocument()
  })

  it('personal radio group is hidden until the toggle is switched on, and follows the board default copy when off', () => {
    render(
      <BoardSettingsModal
        board={{ ...fakeBoard, card_density: 'standard' }}
        isAdmin={true}
        onClose={vi.fn()}
        initialTab="display"
        onUpdateBoardSettings={vi.fn()}
        cardDensityOverride={null}
        onSetCardDensityOverride={vi.fn()}
      />,
    )
    expect(screen.getByText(/Following the board default for your view/i)).toBeInTheDocument()
    // Two "Comfortable" radios would exist once the personal group renders (admin + personal);
    // with the toggle off, only the admin one is present.
    expect(screen.getAllByRole('radio', { name: /^Comfortable/i })).toHaveLength(1)
  })

  it('switching the toggle on seeds the personal radio from the board default and calls onSetCardDensityOverride', async () => {
    const onSetOverride = vi.fn()
    const user = userEvent.setup()
    render(
      <BoardSettingsModal
        board={{ ...fakeBoard, card_density: 'standard' }}
        isAdmin={true}
        onClose={vi.fn()}
        initialTab="display"
        onUpdateBoardSettings={vi.fn()}
        cardDensityOverride={null}
        onSetCardDensityOverride={onSetOverride}
      />,
    )
    await user.click(screen.getByRole('switch', { name: /Use my own density/i }))
    expect(onSetOverride).toHaveBeenCalledWith('standard')
  })

  it('renders the personal radio group with the override selected and reflects the overriding copy', () => {
    render(
      <BoardSettingsModal
        board={{ ...fakeBoard, card_density: 'dense' }}
        isAdmin={true}
        onClose={vi.fn()}
        initialTab="display"
        onUpdateBoardSettings={vi.fn()}
        cardDensityOverride="comfortable"
        onSetCardDensityOverride={vi.fn()}
      />,
    )
    expect(screen.getByText(/Overriding the board default for your view only/i)).toBeInTheDocument()
    const personalComfortable = screen.getAllByRole('radio', { name: /^Comfortable/i })[1]
    expect(personalComfortable).toBeChecked()
  })

  it('picking a personal density radio calls onSetCardDensityOverride without touching onUpdateBoardSettings', async () => {
    const onUpdateBoard = vi.fn()
    const onSetOverride = vi.fn()
    const user = userEvent.setup()
    render(
      <BoardSettingsModal
        board={{ ...fakeBoard, card_density: 'dense' }}
        isAdmin={true}
        onClose={vi.fn()}
        initialTab="display"
        onUpdateBoardSettings={onUpdateBoard}
        cardDensityOverride="comfortable"
        onSetCardDensityOverride={onSetOverride}
      />,
    )
    const denseRadios = screen.getAllByRole('radio', { name: /^Dense/i })
    await user.click(denseRadios[1]) // [0] is the admin board-default radio, [1] the personal one
    expect(onSetOverride).toHaveBeenCalledWith('dense')
    expect(onUpdateBoard).not.toHaveBeenCalled()
  })

  it('switching the toggle off resets to following the board default', async () => {
    const onSetOverride = vi.fn()
    const user = userEvent.setup()
    render(
      <BoardSettingsModal
        board={{ ...fakeBoard, card_density: 'dense' }}
        isAdmin={true}
        onClose={vi.fn()}
        initialTab="display"
        onUpdateBoardSettings={vi.fn()}
        cardDensityOverride="comfortable"
        onSetCardDensityOverride={onSetOverride}
      />,
    )
    await user.click(screen.getByRole('switch', { name: /Use my own density/i }))
    expect(onSetOverride).toHaveBeenCalledWith(null)
  })

  it('admin flipping the board default does not touch the personal override callback', async () => {
    const onUpdateBoard = vi.fn()
    const onSetOverride = vi.fn()
    const user = userEvent.setup()
    render(
      <BoardSettingsModal
        board={{ ...fakeBoard, card_density: 'standard' }}
        isAdmin={true}
        onClose={vi.fn()}
        initialTab="display"
        onUpdateBoardSettings={onUpdateBoard}
        cardDensityOverride="comfortable"
        onSetCardDensityOverride={onSetOverride}
      />,
    )
    const denseRadios = screen.getAllByRole('radio', { name: /^Dense/i })
    await user.click(denseRadios[0]) // the admin board-default radio
    expect(onUpdateBoard).toHaveBeenCalledWith({ card_density: 'dense' })
    expect(onSetOverride).not.toHaveBeenCalled()
  })
})

// ─── Show at-limit WIP indicator toggle (#973) ─────────────────────────────

describe('BoardSettingsModal — Show at-limit WIP indicator toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders as a peer of Enforce weight limits, unchecked by default', async () => {
    const user = userEvent.setup()
    render(
      <BoardSettingsModal
        board={fakeBoard}
        isAdmin={true}
        onClose={vi.fn()}
        onUpdateBoardSettings={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Rules' }))

    const toggle = screen.getByRole('switch', { name: 'Show at-limit WIP indicator' })
    expect(toggle).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('wires the Swimlane fields tab row-chip names switch to onUpdateBoardSettings (#1418)', async () => {
    const onUpdate = vi.fn()
    const user = userEvent.setup()
    render(
      <BoardSettingsModal
        board={fakeBoard}
        isAdmin={true}
        onClose={vi.fn()}
        initialTab="swimlane-fields"
        onUpdateBoardSettings={onUpdate}
      />,
    )
    await user.click(screen.getByRole('switch', { name: 'Show field names on row chips' }))
    expect(onUpdate).toHaveBeenCalledWith({ show_row_chip_field_names: false })
  })

  it('clicking the toggle fires onUpdateBoardSettings({ show_wip_at_limit: true })', async () => {
    const onUpdate = vi.fn()
    const user = userEvent.setup()
    render(
      <BoardSettingsModal
        board={fakeBoard}
        isAdmin={true}
        onClose={vi.fn()}
        onUpdateBoardSettings={onUpdate}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Rules' }))
    await user.click(screen.getByRole('switch', { name: 'Show at-limit WIP indicator' }))
    expect(onUpdate).toHaveBeenCalledWith({ show_wip_at_limit: true })
  })

  it('reflects checked state when the setting is already on', async () => {
    const user = userEvent.setup()
    render(
      <BoardSettingsModal
        board={{ ...fakeBoard, show_wip_at_limit: true }}
        isAdmin={true}
        onClose={vi.fn()}
        onUpdateBoardSettings={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Rules' }))

    expect(screen.getByRole('switch', { name: 'Show at-limit WIP indicator' })).toHaveAttribute('aria-checked', 'true')
  })

  it('non-admins see a read-only line instead of the toggle', async () => {
    const user = userEvent.setup()
    render(
      <BoardSettingsModal
        board={{ ...fakeBoard, show_wip_at_limit: true, current_user_role: 'viewer' }}
        isAdmin={false}
        onClose={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Rules' }))

    expect(screen.queryByRole('switch', { name: 'Show at-limit WIP indicator' })).not.toBeInTheDocument()
    expect(screen.getByText(/At-limit WIP indicator: shown/i)).toBeInTheDocument()
  })
})

// ─── Sharing tab ───────────────────────────────────────────────────────────

describe('BoardSettingsModal — Sharing tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnableBoardSharing.mockResolvedValue({ share_token: 'abc-token-123', share_url: 'http://localhost/share/abc-token-123', share_token_expires_at: null })
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
    await waitFor(() => expect(mockEnableBoardSharing).toHaveBeenCalledWith(1, null))
    await waitFor(() => expect(screen.getByText(/abc-token-123/)).toBeInTheDocument())
  })

  it('selecting a TTL forwards expires_in_days to enableBoardSharing (#804)', async () => {
    mockEnableBoardSharing.mockResolvedValue({
      share_token: 'tok-7d',
      share_url: 'http://localhost/share/tok-7d',
      share_token_expires_at: '2026-04-28T00:00:00Z',
    })
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="sharing" />)

    // Open the TTL select and choose "7 days"
    const ttlTrigger = screen.getByRole('combobox')
    await user.click(ttlTrigger)
    const sevenDays = await screen.findByRole('option', { name: '7 days' })
    await user.click(sevenDays)

    const toggle = screen.getByRole('switch', { name: 'Enable public share link' })
    await user.click(toggle)

    await waitFor(() => expect(mockEnableBoardSharing).toHaveBeenCalledWith(1, 7))
    await waitFor(() => expect(screen.getByTestId('share-expiry-line').textContent).toMatch(/Expires/))
  })

  it('shows "Never expires" when sharing is enabled with no TTL (#804)', () => {
    const boardWithToken = { ...fakeBoard, share_token: 'tok-perm', share_token_expires_at: null }
    render(<BoardSettingsModal board={boardWithToken} isAdmin={true} onClose={vi.fn()} initialTab="sharing" />)
    expect(screen.getByTestId('share-expiry-line').textContent).toBe('Never expires')
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

  // #1373 — the Toggle's onChange used to call handleEnableShare()/handleDisableShare()
  // as a bare floating promise. Both already manage their own loading/error state
  // (shareStatus) internally, so the fix is `void` at the call site — these tests
  // confirm that internal error handling still surfaces correctly through it.
  it('shows an error when enabling sharing fails', async () => {
    mockEnableBoardSharing.mockRejectedValueOnce(new Error('network error'))
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="sharing" />)

    await user.click(screen.getByRole('switch', { name: 'Enable public share link' }))

    expect(await screen.findByText('Failed to enable sharing. Please try again.')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Enable public share link' })).toHaveAttribute('aria-checked', 'false')
  })

  it('shows an error when disabling sharing fails', async () => {
    mockDisableBoardSharing.mockRejectedValueOnce(new Error('network error'))
    const user = (await import('@testing-library/user-event')).default.setup()
    const boardWithToken = { ...fakeBoard, share_token: 'existing-token-xyz' }
    render(<BoardSettingsModal board={boardWithToken} isAdmin={true} onClose={vi.fn()} initialTab="sharing" />)

    await user.click(screen.getByRole('switch', { name: 'Enable public share link' }))

    expect(await screen.findByText('Failed to disable sharing. Please try again.')).toBeInTheDocument()
    // The link is still shown — the disable did not actually go through.
    expect(screen.getByText(/existing-token-xyz/)).toBeInTheDocument()
  })

  // #1373 — handleCopyShareUrl's navigator.clipboard.writeText() call used to be
  // a floating promise: a rejection still showed "Copied!" even though nothing
  // was copied.
  it('shows an error instead of "Copied!" when the clipboard write fails', async () => {
    // userEvent.setup() installs its own clipboard stub on navigator.clipboard
    // (unconditionally, overriding anything set beforehand), so the rejecting
    // mock must be installed AFTER setup() to take effect.
    const user = (await import('@testing-library/user-event')).default.setup()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
      writable: true,
    })
    const boardWithToken = { ...fakeBoard, share_token: 'existing-token-xyz' }
    render(<BoardSettingsModal board={boardWithToken} isAdmin={true} onClose={vi.fn()} initialTab="sharing" />)

    await user.click(screen.getByText('Copy'))

    expect(await screen.findByText('Failed to copy link. Please copy it manually.')).toBeInTheDocument()
    expect(screen.queryByText('Copied!')).not.toBeInTheDocument()
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

  // #1373 — handleModeratorToggle had no catch at all (a genuine unhandled
  // promise rejection, not just an unsurfaced error), found while fixing the
  // sibling floating-promise sites in this same component.
  it('shows an error and leaves the checkbox unchanged when setBoardMember rejects', async () => {
    const user = userEvent.setup()
    mockSetBoardMember.mockRejectedValueOnce(new Error('network error'))
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)

    const checkboxes = screen.getAllByRole('checkbox')
    await user.click(checkboxes[1])

    expect(await screen.findByText('Failed to update moderator status. Please try again.')).toBeInTheDocument()
    expect(screen.getAllByRole('checkbox')[1]).not.toBeChecked()
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

// ─── Export controls (#842 + #843) ─────────────────────────────────────────

describe('BoardSettingsModal — Export permission (#843)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPatchBoard.mockResolvedValue({})
  })

  it('admin sees the threshold dropdown on the Data tab', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="data" />)
    expect(screen.getByText('Export permission')).toBeInTheDocument()
    // SelectDropdown renders its trigger as role="combobox"; the selected
    // option label is rendered as child text inside the button.
    expect(screen.getByText('Anyone with read access (default)')).toBeInTheDocument()
  })

  it('non-admin sees a plain-English read-only sentence (no dropdown)', () => {
    const boardAdminOnly = { ...fakeBoard, export_min_role: 'admin' as const, current_user_role: 'member' as const }
    render(<BoardSettingsModal board={boardAdminOnly} isAdmin={false} onClose={vi.fn()} initialTab="data" />)
    expect(screen.getByText('Only admins can export this board.')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('Export section is hidden when role is below threshold', () => {
    const boardAdminOnly = { ...fakeBoard, export_min_role: 'admin' as const, current_user_role: 'member' as const }
    render(<BoardSettingsModal board={boardAdminOnly} isAdmin={false} onClose={vi.fn()} initialTab="data" />)
    expect(screen.queryByRole('button', { name: /Export JSON|Export CSV/i })).toBeNull()
  })

  it('Export section is visible when role meets threshold', () => {
    const boardMember = { ...fakeBoard, export_min_role: 'member' as const, current_user_role: 'member' as const }
    render(<BoardSettingsModal board={boardMember} isAdmin={false} onClose={vi.fn()} initialTab="data" />)
    expect(screen.getByRole('button', { name: /Export JSON/i })).toBeInTheDocument()
  })
})

describe('BoardSettingsModal — Export history (#842)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBoardExportHistory.mockResolvedValue({ results: [], count: 0, next: null, previous: null })
  })

  it('admin sees Export history section on the Data tab', async () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="data" />)
    await waitFor(() => expect(screen.getByText('Export history')).toBeInTheDocument())
  })

  it('non-admin does not see Export history section', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={false} onClose={vi.fn()} initialTab="data" />)
    expect(screen.queryByText('Export history')).toBeNull()
  })

  it('renders export history entries with actor_role_label and format (#1014)', async () => {
    mockGetBoardExportHistory.mockResolvedValue({
      results: [
        {
          id: 7,
          actor: { id: 9, username: 'alice', display_name: 'Alice', avatar_url: '' },
          actor_role_label: 'member',
          export_format: 'csv',
          row_count: 12,
          created_at: '2026-04-22T14:31:02Z',
        },
      ],
      count: 1, next: null, previous: null,
    })
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="data" />)
    await waitFor(() => expect(screen.getByText('Export history')).toBeInTheDocument())
    // Match the full body line so we hit only the history entry, not the
    // generic "Export CSV" button elsewhere on the tab.
    await waitFor(() =>
      expect(screen.getByText(/member — CSV · 12 cards/)).toBeInTheDocument()
    )
    // Display name (rendered via userDisplayName) is what surfaces in the row.
    expect(screen.getByText('Alice')).toBeInTheDocument()
  })

  it('renders movement exports as "Movements (CSV)" with a movement count (#1499)', async () => {
    mockGetBoardExportHistory.mockResolvedValue({
      results: [
        {
          id: 9,
          actor: { id: 9, username: 'alice', display_name: 'Alice', avatar_url: '' },
          actor_role_label: 'admin',
          export_format: 'movements_csv',
          row_count: 5,
          created_at: '2026-04-22T14:31:02Z',
        },
      ],
      count: 1, next: null, previous: null,
    })
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="data" />)
    await waitFor(() =>
      expect(screen.getByText(/admin — Movements \(CSV\) · 5 movements/)).toBeInTheDocument()
    )
    expect(screen.queryByText(/MOVEMENTS_CSV/)).toBeNull()
  })

  it('renders "(deactivated user)" when actor is null (#1014)', async () => {
    mockGetBoardExportHistory.mockResolvedValue({
      results: [
        {
          id: 8,
          actor: null,
          actor_role_label: 'admin',
          export_format: 'json',
          row_count: 1,
          created_at: '2026-04-22T15:00:00Z',
        },
      ],
      count: 1, next: null, previous: null,
    })
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="data" />)
    await waitFor(() => expect(screen.getByText('Export history')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('(deactivated user)')).toBeInTheDocument())
    // Singular form for row_count of 1.
    expect(screen.getByText(/1 card$/)).toBeInTheDocument()
  })

  it('renders an error message when getBoardExportHistory rejects (#1014)', async () => {
    mockGetBoardExportHistory.mockRejectedValue(new Error('Network down'))
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} initialTab="data" />)
    await waitFor(() => expect(screen.getByText('Export history')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText(/Could not load export history/i)).toBeInTheDocument())
  })
})

// ─── Hosted demo (#1179) ───────────────────────────────────────────────────

describe('BoardSettingsModal — hosted demo (#1179)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPatchBoard.mockResolvedValue({})
  })

  it('shows ONE shared notice and makes admin controls inert but focusable', async () => {
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} demoMode onClose={vi.fn()} />)
    const notice = document.getElementById('board-settings-demo-notice')
    expect(notice).toHaveTextContent("This is a shared demo — settings can't be changed here.")
    expect(notice).toHaveAttribute('role', 'note')

    await user.click(screen.getByRole('button', { name: 'Rules' }))
    expect(screen.getAllByText("This is a shared demo — settings can't be changed here.")).toHaveLength(1)
    const region = screen.getByTestId('demo-inert')
    expect(region).toHaveAttribute('role', 'group')
    expect(region).toHaveAttribute('aria-disabled', 'true')
    expect(region).toHaveAttribute('aria-describedby', 'board-settings-demo-notice')

    const input = screen.getByRole('spinbutton', { name: /stale card threshold/i })
    expect(input).not.toBeDisabled()
    input.focus()
    expect(input).toHaveFocus()
    await user.type(input, '21')
    await user.tab()
    expect(input).toHaveValue(7)
    expect(mockPatchBoard).not.toHaveBeenCalled()
  })

  it('blocks a toggle click inside the region', async () => {
    const user = userEvent.setup()
    const onUpdateBoardSettings = vi.fn()
    render(
      <BoardSettingsModal board={fakeBoard} isAdmin={true} demoMode onClose={vi.fn()} onUpdateBoardSettings={onUpdateBoardSettings} />,
    )
    await user.click(screen.getByRole('button', { name: 'Rules' }))
    for (const sw of screen.getAllByRole('switch')) {
      await user.click(sw)
    }
    expect(onUpdateBoardSettings).not.toHaveBeenCalled()
    expect(mockPatchBoard).not.toHaveBeenCalled()
  })

  it('tabs and Close still work in demo mode', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} demoMode onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Data' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('a non-admin visitor sees no notice and no inert region (nothing admin to explain)', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={false} demoMode onClose={vi.fn()} />)
    expect(document.getElementById('board-settings-demo-notice')).toBeNull()
    expect(screen.queryByTestId('demo-inert')).not.toBeInTheDocument()
  })

  it('renders no demo notice or wrapper outside demo mode', () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    expect(document.getElementById('board-settings-demo-notice')).toBeNull()
    expect(screen.queryByTestId('demo-inert')).not.toBeInTheDocument()
  })
})

// ─── Danger Zone: archived cards (#1289) ────────────────────────────────────

describe('BoardSettingsModal — Danger Zone and archived cards (#1289)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function renderDangerZone(board: BoardFull) {
    return render(
      <BoardSettingsModal board={board} isAdmin={true} onClose={vi.fn()} onBoardDeleted={vi.fn()} initialTab="data" />
    )
  }

  it('requires typed confirmation for a board holding only archived cards', async () => {
    const user = userEvent.setup()
    renderDangerZone({ ...fakeBoard, cards: [], archived_card_count: 2 })
    expect(screen.getByText('This board has 2 archived cards, which will also be permanently deleted.')).toBeInTheDocument()
    const deleteButton = screen.getByRole('button', { name: 'Delete board' })
    expect(deleteButton).toBeDisabled()
    await user.type(screen.getByPlaceholderText('Sprint Board'), 'Sprint Board')
    expect(deleteButton).toBeEnabled()
  })

  it('uses the singular for one archived card', () => {
    renderDangerZone({ ...fakeBoard, cards: [], archived_card_count: 1 })
    expect(screen.getByText('This board has 1 archived card, which will also be permanently deleted.')).toBeInTheDocument()
  })

  it('mentions archived cards and allows single-click delete for an empty board', () => {
    renderDangerZone({ ...fakeBoard, cards: [], archived_card_count: 0 })
    expect(screen.getByText(/all its cards \(including archived cards\), columns, and history/)).toBeInTheDocument()
    expect(screen.queryByText(/archived cards?, which will also be permanently deleted/)).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Sprint Board')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete board' })).toBeEnabled()
  })
})

// ─── Invite by email (#1444) ────────────────────────────────────────────────

describe('BoardSettingsModal — invite by email (#1444)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('admins get the invite section with the pending list; non-admins do not', async () => {
    const { unmount } = render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    expect(await screen.findByText('Invite by email')).toBeInTheDocument()
    expect(screen.getByText('Pending invites')).toBeInTheDocument()
    unmount()
    render(<BoardSettingsModal board={{ ...fakeBoard, current_user_role: 'member' }} isAdmin={false} onClose={vi.fn()} />)
    expect(screen.queryByText('Pending invites')).not.toBeInTheDocument()
    expect(screen.queryByText('Invite by email')).not.toBeInTheDocument()
  })

  it('admins can create shareable invite links from the Members tab (#439)', async () => {
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'New link' })).toBeInTheDocument()
    expect(await screen.findByText('or create a shareable link')).toBeInTheDocument()
    expect(
      screen.getByText('Anyone with an invite link can join this board after signing in. To let people view without signing in, use the Sharing tab.'),
    ).toBeInTheDocument()
  })

  it('an email-shaped query with no addable match offers "Invite by email", which prefills the form', async () => {
    mockSearchUsers.mockResolvedValue([])
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await screen.findByText('Invite by email')
    await user.type(screen.getByPlaceholderText(/search by name or email/i), 'new.person@example.com')
    const bridge = await screen.findByRole('button', { name: 'Invite by email' }, { timeout: 2000 })
    expect(bridge.closest('p')).toHaveTextContent('No results for new.person@example.com.')
    await user.click(bridge)
    expect(screen.getByRole('textbox', { name: 'Email address' })).toHaveValue('new.person@example.com')
    expect(screen.getByPlaceholderText(/search by name or email/i)).toHaveValue('')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send invite' })).toHaveFocus())
  })

  it('no bridge for a non-email query, or when someone addable matched', async () => {
    const user = userEvent.setup()
    mockSearchUsers.mockResolvedValue([])
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await screen.findByText('Invite by email')
    await user.type(screen.getByPlaceholderText(/search by name or email/i), 'nobody')
    await waitFor(() => expect(mockSearchUsers).toHaveBeenCalledWith('nobody'))
    expect(screen.queryByRole('button', { name: 'Invite by email' })).not.toBeInTheDocument()

    mockSearchUsers.mockResolvedValue([{ ...fakeMember2, id: 99, email: 'carol@example.com', username: 'carol' }])
    await user.clear(screen.getByPlaceholderText(/search by name or email/i))
    await user.type(screen.getByPlaceholderText(/search by name or email/i), 'carol@example.com')
    await waitFor(() => expect(mockSearchUsers).toHaveBeenCalledWith('carol@example.com'))
    expect(screen.queryByRole('button', { name: 'Invite by email' })).not.toBeInTheDocument()
  })

  it('no bridge when the search matched only people already on the board or staged', async () => {
    const user = userEvent.setup()
    // The raw result is Bob, already a member: nothing addable, but an
    // account does match — so no invite is offered.
    mockSearchUsers.mockResolvedValue([{ ...fakeMember2, email: 'bob@example.com' }])
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await screen.findByText('Invite by email')
    await user.type(screen.getByPlaceholderText(/search by name or email/i), 'bob@example.com')
    await waitFor(() => expect(mockSearchUsers).toHaveBeenCalledWith('bob@example.com'))
    await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
    expect(screen.queryByRole('button', { name: 'Invite by email' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('member-suggestions')).not.toBeInTheDocument()
  })

  it('no bridge when sending by email is unavailable', async () => {
    const { getSiteConfig } = await import('../api/auth')
    ;(getSiteConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      registration_open: true, registration_mode: 'open', demo_mode: false, demo_login: null,
      invite_email_available: false,
    })
    mockSearchUsers.mockResolvedValue([])
    const user = userEvent.setup()
    render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    await user.type(screen.getByPlaceholderText(/search by name or email/i), 'x@example.com')
    await waitFor(() => expect(mockSearchUsers).toHaveBeenCalledWith('x@example.com'))
    expect(screen.queryByRole('button', { name: 'Invite by email' })).not.toBeInTheDocument()
  })

  it('a member who joins while open is appended without replacing in-progress rows', async () => {
    const { rerender } = render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} />)
    expect(screen.getByText('Bob Smith')).toBeInTheDocument()
    const carol: User = { ...fakeMember2, id: 3, username: 'carol', display_name: 'Carol Jones', email: 'carol@example.com' }
    rerender(
      <BoardSettingsModal
        board={{
          ...fakeBoard,
          // Bob's row arrives with a different role — the modal's own row wins.
          members: [
            { ...fakeBoard.members[0] },
            { ...fakeBoard.members[1], role: 'viewer' },
            { id: 12, user: carol, role: 'viewer', is_moderator: false, joined_at: '' },
          ],
        }}
        isAdmin={true}
        onClose={vi.fn()}
      />,
    )
    expect(await screen.findByText('Carol Jones')).toBeInTheDocument()
    expect(screen.getAllByText('Bob Smith')).toHaveLength(1)
  })

  it('passes inviteReloadSignal through to the invite list', async () => {
    const { listBoardInviteLinks } = await import('../api/boards')
    const mockList = listBoardInviteLinks as ReturnType<typeof vi.fn>
    const { rerender } = render(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} inviteReloadSignal={0} />)
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1))
    rerender(<BoardSettingsModal board={fakeBoard} isAdmin={true} onClose={vi.fn()} inviteReloadSignal={1} />)
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
  })
})
