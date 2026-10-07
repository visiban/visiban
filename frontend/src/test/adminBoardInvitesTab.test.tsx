import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardInvitesTab from '../components/Admin/BoardInvitesTab'
import type { AdminBoardInviteLink } from '../types'

// #439 — Admin → Board Invites: every board's invites with a status filter,
// pagination and inline revoke.

vi.mock('../api/auth', () => ({
  getAdminBoardInviteLinks: vi.fn(),
  revokeAdminBoardInviteLink: vi.fn(),
}))

import { getAdminBoardInviteLinks, revokeAdminBoardInviteLink } from '../api/auth'

const mockList = getAdminBoardInviteLinks as ReturnType<typeof vi.fn>
const mockRevoke = revokeAdminBoardInviteLink as ReturnType<typeof vi.fn>

function row(overrides: Partial<AdminBoardInviteLink> = {}): AdminBoardInviteLink {
  return {
    id: 1,
    board_id: 10,
    board_name: 'Launch Plan',
    role: 'member',
    delivery: 'link',
    status: 'pending',
    prefix: 'vbnb_ab1',
    expires_at: '2026-10-08T12:00:00Z',
    created_at: '2026-10-01T12:00:00Z',
    created_by_username: 'alice',
    single_use: false,
    use_count: 0,
    can_register: true,
    ...overrides,
  }
}

function page(results: AdminBoardInviteLink[], extra: { count?: number; offset?: number; page_size?: number } = {}) {
  return { count: results.length, offset: 0, page_size: 50, results, ...extra }
}

describe('BoardInvitesTab (#439)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockList.mockResolvedValue(page([]))
  })

  it('shows Loading… then the empty state for the default Pending filter', async () => {
    mockList.mockReturnValueOnce(new Promise(() => {}))
    const { unmount } = render(<BoardInvitesTab />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    unmount()
    render(<BoardInvitesTab />)
    expect(await screen.findByText('No pending board invites.')).toBeInTheDocument()
    expect(mockList).toHaveBeenLastCalledWith({ status: 'pending', offset: 0 })
  })

  it('shows the load error', async () => {
    mockList.mockRejectedValue(new Error('boom'))
    render(<BoardInvitesTab />)
    expect(await screen.findByText('Failed to load board invites.')).toHaveClass('text-danger')
  })

  it('renders every column, including the removed-account dash and the existing-accounts pill', async () => {
    mockList.mockResolvedValue(page([
      row({ id: 1, board_name: 'Launch Plan', role: 'viewer', delivery: 'email', can_register: false }),
      row({ id: 2, board_name: 'Roadmap', created_by_username: null }),
    ]))
    render(<BoardInvitesTab />)
    const first = (await screen.findByText('Launch Plan')).closest('tr') as HTMLElement
    expect(within(first).getByText('Viewer')).toBeInTheDocument()
    expect(within(first).getByText('Email')).toBeInTheDocument()
    expect(within(first).getByText('Pending')).toBeInTheDocument()
    expect(within(first).getByText('Existing accounts only')).toBeInTheDocument()
    expect(within(first).getByText('Oct 8, 2026')).toBeInTheDocument()
    expect(within(first).getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('Launch Plan')).toHaveAttribute('title', 'Launch Plan')
    const second = screen.getByText('Roadmap').closest('tr') as HTMLElement
    expect(within(second).getByText('Link')).toBeInTheDocument()
    expect(within(second).getByTitle('Account removed')).toHaveTextContent('—')
    expect(within(second).queryByText('Existing accounts only')).not.toBeInTheDocument()
    expect(screen.getByText('2 invites')).toBeInTheDocument()
  })

  it('the Status filter refetches from offset 0, and the All empty state differs', async () => {
    const user = userEvent.setup()
    render(<BoardInvitesTab />)
    await screen.findByText('No pending board invites.')
    mockList.mockResolvedValue(page([row({ status: 'revoked' })]))
    await user.click(screen.getByRole('button', { name: /^Status: / }))
    await user.click(screen.getByRole('menuitem', { name: 'Revoked' }))
    await waitFor(() => expect(mockList).toHaveBeenLastCalledWith({ status: 'revoked', offset: 0 }))
    const revokedRow = (await screen.findByText('Launch Plan')).closest('tr') as HTMLElement
    expect(within(revokedRow).getByText('Revoked')).toBeInTheDocument()
    // Only pending rows can be revoked.
    expect(within(revokedRow).queryByRole('button', { name: /Revoke/ })).not.toBeInTheDocument()

    mockList.mockResolvedValue(page([]))
    await user.click(screen.getByRole('button', { name: /^Status: / }))
    await user.click(screen.getByRole('menuitem', { name: 'All' }))
    expect(await screen.findByText('No board invites yet.')).toBeInTheDocument()
  })

  it('paginates with the Users-tab footer', async () => {
    const user = userEvent.setup()
    mockList.mockResolvedValue(page([row({ id: 1 }), row({ id: 2, board_name: 'Second' })], { count: 5, page_size: 2 }))
    render(<BoardInvitesTab />)
    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument()
    expect(screen.getByText('5 invites')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '← Prev' })).toBeDisabled()
    mockList.mockResolvedValue(page([row({ id: 3 })], { count: 5, page_size: 2, offset: 2 }))
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await waitFor(() => expect(mockList).toHaveBeenLastCalledWith({ status: 'pending', offset: 2 }))
    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '← Prev' }))
    await waitFor(() => expect(mockList).toHaveBeenLastCalledWith({ status: 'pending', offset: 0 }))
  })

  it('revoke confirms in an inserted row, and under Pending the row leaves the list', async () => {
    const user = userEvent.setup()
    mockList.mockResolvedValue(page([row({ id: 1 }), row({ id: 2, board_name: 'Roadmap', prefix: 'vbnb_rm2' })]))
    mockRevoke.mockResolvedValue(row({ id: 1, status: 'revoked' }))
    render(<BoardInvitesTab />)
    await user.click(await screen.findByRole('button', { name: 'Revoke invite vbnb_ab1 for Launch Plan' }))
    const prompt = screen.getByText(
      'Revoke this invite link to Launch Plan? Anyone holding it will no longer be able to join.',
    )
    expect(prompt.closest('td')).toHaveAttribute('colspan', '7')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith(1))
    await waitFor(() => expect(screen.queryByText('Launch Plan')).not.toBeInTheDocument())
    expect(screen.getByText('Roadmap')).toBeInTheDocument()
    expect(screen.getByText('1 invite')).toBeInTheDocument()
  })

  it('under All a revoked row is replaced in place from the response', async () => {
    const user = userEvent.setup()
    mockList.mockResolvedValue(page([row({ id: 1, delivery: 'email' })]))
    mockRevoke.mockResolvedValue(row({ id: 1, delivery: 'email', status: 'revoked' }))
    render(<BoardInvitesTab />)
    await screen.findByText('Launch Plan')
    await user.click(screen.getByRole('button', { name: /^Status: / }))
    await user.click(screen.getByRole('menuitem', { name: 'All' }))
    await waitFor(() => expect(mockList).toHaveBeenLastCalledWith({ status: 'all', offset: 0 }))
    await user.click(await screen.findByRole('button', { name: /Revoke invite vbnb_ab1/ }))
    expect(
      screen.getByText('Revoke this invite to Launch Plan? The person it was emailed to will no longer be able to join.'),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    const updated = screen.getByText('Launch Plan').closest('tr') as HTMLElement
    expect(await within(updated).findByText('Revoked')).toBeInTheDocument()
  })

  it('Cancel and Escape close the prompt and return focus to Revoke', async () => {
    const user = userEvent.setup()
    mockList.mockResolvedValue(page([row()]))
    render(<BoardInvitesTab />)
    const trigger = await screen.findByRole('button', { name: 'Revoke invite vbnb_ab1 for Launch Plan' })
    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Revoke invite vbnb_ab1 for Launch Plan' })).toHaveFocus(),
    )
    await user.click(screen.getByRole('button', { name: 'Revoke invite vbnb_ab1 for Launch Plan' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    expect(mockRevoke).not.toHaveBeenCalled()
  })

  it('a 400 says it is no longer pending, refetches, and focuses the heading', async () => {
    const user = userEvent.setup()
    mockList.mockResolvedValue(page([row()]))
    mockRevoke.mockRejectedValue({ response: { status: 400 } })
    render(<BoardInvitesTab />)
    await user.click(await screen.findByRole('button', { name: /Revoke invite vbnb_ab1/ }))
    mockList.mockResolvedValue(page([]))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(
      await screen.findByText("This invite is no longer pending, so it can't be revoked."),
    ).toBeInTheDocument()
    expect(mockList).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('No pending board invites.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Board Invites' })).toHaveFocus())
  })

  it('any other failure keeps the prompt open with the buttons re-enabled', async () => {
    const user = userEvent.setup()
    mockList.mockResolvedValue(page([row()]))
    let reject: (e: unknown) => void = () => {}
    mockRevoke.mockReturnValue(new Promise((_r, rej) => { reject = rej }))
    render(<BoardInvitesTab />)
    await user.click(await screen.findByRole('button', { name: /Revoke invite vbnb_ab1/ }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    // In flight: both disabled, and a second click sends nothing.
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    reject({ response: { status: 500 } })
    expect(await screen.findByText('Could not revoke invite.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled()
    expect(mockRevoke).toHaveBeenCalledTimes(1)
  })
})

describe('BoardInvitesTab — gate fixes (#439)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockList.mockResolvedValue(page([]))
  })

  it('load error is an alert with Try again that refetches', async () => {
    const user = userEvent.setup()
    mockList.mockRejectedValueOnce(new Error('boom'))
    render(<BoardInvitesTab />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load board invites.')
    mockList.mockResolvedValueOnce(page([row()]))
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Launch Plan')).toBeInTheDocument()
    expect(mockList).toHaveBeenLastCalledWith({ status: 'pending', offset: 0 })
  })

  it('a revoke that empties a later page steps back a page', async () => {
    const user = userEvent.setup()
    mockList.mockResolvedValueOnce(page([row({ id: 1 }), row({ id: 2, board_name: 'Second' })], { count: 3, page_size: 2 }))
    render(<BoardInvitesTab />)
    await screen.findByText('Second')
    mockList.mockResolvedValueOnce(page([row({ id: 3, board_name: 'Last' })], { count: 3, page_size: 2, offset: 2 }))
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await screen.findByText('Last')
    mockRevoke.mockResolvedValue(row({ id: 3, status: 'revoked' }))
    mockList.mockResolvedValueOnce(page([row({ id: 1 }), row({ id: 2, board_name: 'Second' })], { count: 2, page_size: 2 }))
    await user.click(screen.getByRole('button', { name: /Revoke invite vbnb_ab1 for Last/ }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(mockList).toHaveBeenLastCalledWith({ status: 'pending', offset: 0 }))
    expect(await screen.findByText('Second')).toBeInTheDocument()
    expect(screen.queryByText('No pending board invites.')).not.toBeInTheDocument()
  })

  it('a successful revoke moves focus to the heading', async () => {
    const user = userEvent.setup()
    mockList.mockResolvedValue(page([row(), row({ id: 2, board_name: 'Roadmap', prefix: 'vbnb_rm2' })]))
    mockRevoke.mockResolvedValue(row({ status: 'revoked' }))
    render(<BoardInvitesTab />)
    await user.click(await screen.findByRole('button', { name: /Revoke invite vbnb_ab1/ }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Board Invites' })).toHaveFocus())
  })

  it('the conflict message clears on the next interaction', async () => {
    const user = userEvent.setup()
    const conflict = "This invite is no longer pending, so it can't be revoked."
    mockList.mockResolvedValue(page([row(), row({ id: 2, board_name: 'Roadmap', prefix: 'vbnb_rm2' })]))
    mockRevoke.mockRejectedValue({ response: { status: 400 } })
    render(<BoardInvitesTab />)
    await user.click(await screen.findByRole('button', { name: /Revoke invite vbnb_ab1/ }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText(conflict)).toBeInTheDocument()
    // Opening the next revoke prompt, then canceling it, clears it.
    await user.click(screen.getByRole('button', { name: /Revoke invite vbnb_rm2/ }))
    expect(screen.queryByText(conflict)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText(conflict)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Status: / }))
    await user.click(screen.getByRole('menuitem', { name: 'All' }))
    expect(screen.queryByText(conflict)).not.toBeInTheDocument()
  })

  it('a removed creator is announced, not just a dash', async () => {
    mockList.mockResolvedValue(page([row({ created_by_username: null })]))
    render(<BoardInvitesTab />)
    const cell = await screen.findByTitle('Account removed')
    expect(within(cell).getByText('Account removed')).toHaveClass('sr-only')
  })
})

