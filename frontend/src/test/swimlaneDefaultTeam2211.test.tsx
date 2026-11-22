import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditSwimlaneModal from '../components/Board/EditSwimlaneModal'
import { DEFAULT_TEAM_HELP } from '../components/Board/SwimlaneDefaultTeamSection'
import { assignableMembers, childCaption, laneCaption, laneDefaultAssignee, liveTeamIds, teamRowNames } from '../utils/swimlaneDefaultTeam'
import { noAccessText } from '../components/Board/SwimlaneDefaultTeamSection'
import { waitFor } from '@testing-library/react'
import type { EffectiveBoardMember, Swimlane } from '../types'

vi.mock('../api/boards', () => ({
  updateSwimlane: vi.fn(),
  deleteSwimlane: vi.fn(),
  getSwimlaneDefaultTeamAccess: vi.fn(() => Promise.resolve({ members: [] })),
}))

import { getSwimlaneDefaultTeamAccess, updateSwimlane } from '../api/boards'

const mockUpdate = updateSwimlane as ReturnType<typeof vi.fn>

function lane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 1, uid: 'u1', name: 'Acme Corp', color: '#6B7280', position: 0, is_collapsed: false,
    created_at: '2026-01-01T00:00:00Z', wip_limit: null, weight_limit: null, limit_enforcement: null,
    limit_column_ids: null, health_status: null, effective_health_status: null, health_status_origin: null,
    computed_health_status: null, health_computed_at: null, health_computed_counts: null,
    ...overrides,
  }
}

function member(id: number, display_name: string, role: EffectiveBoardMember['role'] = 'member'): EffectiveBoardMember {
  return { id, role, joined_at: '2026-01-01T00:00:00Z', user: { id, username: display_name.toLowerCase().replace(' ', ''), display_name, avatar_url: '' } }
}

const MIA = member(10, 'Mia Reyes')
const DAN = member(11, 'Dan Kovacs')
const VIC = member(12, 'Vic Viewer', 'viewer')
const MEMBERS = [MIA, DAN, VIC]

function renderModal(swimlane: Swimlane, members: EffectiveBoardMember[] | null = MEMBERS) {
  return render(
    <EditSwimlaneModal
      boardId={1} swimlane={swimlane} cardCount={0}
      onUpdated={vi.fn()} onDeleted={vi.fn()} onClose={vi.fn()} members={members ?? undefined}
    />,
  )
}

describe('Swimlane default team (#2211)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('lists the team as rows with a count, a named Remove, and the help text', () => {
    renderModal(lane({ default_team: [MIA.user.id, DAN.user.id] }))
    const group = screen.getByRole('group', { name: 'Default team members' })
    expect(within(group).getByText('Mia Reyes')).toBeInTheDocument()
    expect(within(group).getByRole('button', { name: 'Remove Dan Kovacs from default team' })).toBeInTheDocument()
    expect(screen.getByText('2 people')).toBeInTheDocument()
    expect(screen.getByText(DEFAULT_TEAM_HELP)).toBeInTheDocument()
  })

  it('removes a person and sends the edited team on save', async () => {
    const user = userEvent.setup()
    mockUpdate.mockResolvedValue(lane())
    renderModal(lane({ default_team: [MIA.user.id, DAN.user.id] }))
    await user.click(screen.getByRole('button', { name: 'Remove Mia Reyes from default team' }))
    expect(screen.getByText('1 person')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(mockUpdate).toHaveBeenCalledWith(1, 1, expect.objectContaining({ default_team: [DAN.user.id] }))
  })

  it('adds a member from the dropdown, which never offers viewers', async () => {
    const user = userEvent.setup()
    mockUpdate.mockResolvedValue(lane())
    renderModal(lane({ default_team: [MIA.user.id] }))
    await user.click(screen.getByRole('button', { name: /Add a member/ }))
    expect(screen.queryByRole('menuitemradio', { name: /Vic Viewer/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Vic Viewer/ })).toBeNull()
    await user.click(screen.getByText('Dan Kovacs'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(mockUpdate).toHaveBeenCalledWith(1, 1, expect.objectContaining({ default_team: [MIA.user.id, DAN.user.id] }))
  })

  it('does not send the team when it was not edited', async () => {
    const user = userEvent.setup()
    mockUpdate.mockResolvedValue(lane())
    renderModal(lane({ default_team: [MIA.user.id] }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(mockUpdate.mock.calls[0][2]).not.toHaveProperty('default_team')
  })

  it('says so when everyone assignable is already on the team', () => {
    renderModal(lane({ default_team: [MIA.user.id, DAN.user.id] }))
    expect(screen.getByText('Everyone who can be assigned cards is on the team.')).toBeInTheDocument()
  })

  it('says no one can be assigned when the board has only viewers', () => {
    renderModal(lane(), [VIC])
    expect(screen.getByText('No one on this board can be assigned cards.')).toBeInTheDocument()
  })

  it('Escape closes the Add a member menu and keeps the modal open', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <EditSwimlaneModal
        boardId={1} swimlane={lane()} cardCount={0}
        onUpdated={vi.fn()} onDeleted={vi.fn()} onClose={onClose} members={MEMBERS}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Add a member/ }))
    expect(screen.getByText('Dan Kovacs')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByText('Dan Kovacs')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('hides the section when the board members are not passed', () => {
    renderModal(lane({ default_team: [MIA.user.id] }), null)
    expect(screen.queryByRole('group', { name: 'Default team members' })).toBeNull()
  })

  it('drops ids of people who left or became viewers', () => {
    expect(liveTeamIds([99, VIC.user.id, DAN.user.id], MEMBERS)).toEqual([DAN.user.id])
    expect(liveTeamIds(undefined, MEMBERS)).toEqual([])
  })

  it('does not offer or keep unlisted roster rows (role site_admin)', () => {
    const WIDE = member(13, 'Wes Wide', 'site_admin')
    const all = [...MEMBERS, WIDE]
    expect(assignableMembers(all).map((m) => m.user.id)).toEqual([MIA.user.id, DAN.user.id])
    expect(liveTeamIds([WIDE.user.id, DAN.user.id], all)).toEqual([DAN.user.id])
  })

  it('sends back only ids it can show', async () => {
    const user = userEvent.setup()
    mockUpdate.mockResolvedValue(lane())
    renderModal(lane({ default_team: [99, MIA.user.id] }))
    expect(screen.queryByText('99')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove Mia Reyes from default team' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockUpdate.mock.calls[0][2].default_team).toEqual([])
  })
})

describe('lane default team pre-assignment helpers (#2211)', () => {
  it('pre-assigns the first active, assignable member and names the rest', () => {
    const l = lane({ default_team: [12, 11, 10], default_team_members: [{ id: 12, is_active: true }, { id: 11, is_active: false }, { id: 10, is_active: true }] })
    // 12 is a viewer (dropped), 11 is deactivated (never pre-assigned or named).
    const d = laneDefaultAssignee(l, MEMBERS)
    expect(d?.assignee?.id).toBe(10)
    expect(d?.others).toEqual([])
    expect(teamRowNames(l, MEMBERS)).toEqual(['Mia Reyes'])
  })

  it('is null for a lane with no team, no members or nobody eligible', () => {
    expect(laneDefaultAssignee(lane(), MEMBERS)).toBeNull()
    expect(laneDefaultAssignee(lane({ default_team: [10] }), undefined)).toBeNull()
    expect(laneDefaultAssignee(lane({ default_team: [12] }), MEMBERS)).toBeNull()
    expect(teamRowNames(lane(), undefined)).toEqual([])
  })

  it('keeps team order and works without default_team_members (older server)', () => {
    const d = laneDefaultAssignee(lane({ default_team: [11, 10] }), MEMBERS)
    expect(d?.assignee?.id).toBe(11)
    expect(d?.others).toEqual(['Mia Reyes'])
  })

  it('captions and the no-access warning', () => {
    expect(laneCaption('Acme Corp')).toBe("From the Acme Corp default team. Remove anyone this card shouldn't have.")
    expect(childCaption('Acme Corp', 'Pipeline', 'Delivery')).toBe("From the Acme Corp default team on Pipeline, the lane the parent is in. Delivery's own lanes are not consulted.")
    expect(noAccessText({ id: 1, boards: [{ id: 2, name: 'Delivery' }, { id: 3, name: 'Onboarding' }], hidden_count: 0 })).toBe('No access to Delivery, Onboarding: skipped on new children')
    expect(noAccessText({ id: 1, boards: [], hidden_count: 2 })).toBe("No access to 2 boards you can't open: skipped on new children")
    expect(noAccessText({ id: 1, boards: [{ id: 2, name: 'Delivery' }], hidden_count: 1 })).toBe("No access to Delivery, 1 board you can't open: skipped on new children")
  })
})

describe('Edit swimlane deactivated members and access warning (#2211)', () => {
  beforeEach(() => { mockUpdate.mockReset() })

  it('marks a deactivated member, blocks a team save until they are removed, then saves', async () => {
    mockUpdate.mockResolvedValue(lane())
    const l = lane({ default_team: [10, 11], default_team_members: [{ id: 10, is_active: true }, { id: 11, is_active: false }] })
    renderModal(l)
    const team = screen.getByRole('group', { name: 'Default team members' })
    expect(team).toHaveTextContent('Deactivated: remove to save the team')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Remove Mia Reyes from default team' }))
    await user.click(screen.getByRole('button', { name: /^Save/ }))
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(screen.getByText('Remove the deactivated people from the default team, then save.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove Dan Kovacs from default team' }))
    await user.click(screen.getByRole('button', { name: /^Save/ }))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith(1, 1, expect.objectContaining({ default_team: [] })))
  })

  it('does not offer a removed deactivated person again in Add a member', async () => {
    renderModal(lane({ default_team: [11], default_team_members: [{ id: 11, is_active: false }] }))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Remove Dan Kovacs from default team' }))
    await user.click(screen.getByRole('button', { name: /Add a member/ }))
    expect(screen.getByText('Mia Reyes')).toBeInTheDocument()
    expect(screen.queryByText('Dan Kovacs')).toBeNull()
  })

  it('shows who is skipped on new children, from the access endpoint', async () => {
    vi.mocked(getSwimlaneDefaultTeamAccess).mockResolvedValueOnce({ members: [{ id: 11, boards: [{ id: 5, name: 'Delivery' }], hidden_count: 0 }] })
    renderModal(lane({ default_team: [10, 11] }))
    expect(await screen.findByText('No access to Delivery: skipped on new children')).toBeInTheDocument()
    expect(getSwimlaneDefaultTeamAccess).toHaveBeenCalledWith(1, 1)
  })

  it('Remove moves focus to the next row, then the previous, then the section, and announces it', async () => {
    renderModal(lane({ default_team: [10, 11] }))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Remove Mia Reyes from default team' }))
    expect(screen.getByRole('button', { name: 'Remove Dan Kovacs from default team' })).toHaveFocus()
    expect(screen.getByText('Removed Mia Reyes from default team.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove Dan Kovacs from default team' }))
    expect(screen.getByRole('region', { name: /Default team/ })).toHaveFocus()
  })

  it('keeps list semantics under the group and links a warning to its Remove', async () => {
    vi.mocked(getSwimlaneDefaultTeamAccess).mockResolvedValueOnce({ members: [{ id: 11, boards: [{ id: 5, name: 'Delivery' }], hidden_count: 0 }] })
    renderModal(lane({ default_team: [10, 11] }))
    await screen.findByText('No access to Delivery: skipped on new children')
    const group = screen.getByRole('group', { name: 'Default team members' })
    expect(group.tagName).toBe('DIV')
    expect(within(group).getByRole('list')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Dan Kovacs from default team' }))
      .toHaveAccessibleDescription('No access to Delivery: skipped on new children')
    expect(screen.getByRole('button', { name: 'Remove Mia Reyes from default team' })).not.toHaveAttribute('aria-describedby')
  })

  it('shows the save error as an alert and offers "Back to board"', async () => {
    const onClose = vi.fn()
    render(
      <EditSwimlaneModal boardId={1} swimlane={lane({ default_team: [10, 11], default_team_members: [{ id: 10, is_active: true }, { id: 11, is_active: false }] })}
        cardCount={0} onUpdated={vi.fn()} onDeleted={vi.fn()} onClose={onClose} members={MEMBERS} />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Remove Mia Reyes from default team' }))
    await user.click(screen.getByRole('button', { name: /^Save/ }))
    expect(screen.getByRole('alert')).toHaveTextContent('Remove the deactivated people from the default team, then save.')
    await user.click(screen.getByRole('button', { name: 'Back to board' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('adding the last candidate moves focus to the new row and announces it', async () => {
    renderModal(lane({ default_team: [10] }))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Add a member/ }))
    await user.click(screen.getByText('Dan Kovacs'))
    expect(screen.queryByRole('button', { name: /Add a member/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove Dan Kovacs from default team' })).toHaveFocus()
    expect(screen.getByText('Added Dan Kovacs to default team.')).toBeInTheDocument()
  })

  it('a refused save puts focus on the first deactivated row', async () => {
    renderModal(lane({ default_team: [10, 11], default_team_members: [{ id: 10, is_active: true }, { id: 11, is_active: false }] }))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Remove Mia Reyes from default team' }))
    await user.click(screen.getByRole('button', { name: /^Save/ }))
    expect(screen.getByRole('button', { name: 'Remove Dan Kovacs from default team' })).toHaveFocus()
  })

  it('never pre-assigns someone removed from the board (no swimlane.updated is sent for it)', () => {
    // The server drops a removed member from lane teams without a lane broadcast; the member
    // list the client already holds loses them, and that is what decides who is sent.
    const l = lane({ default_team: [10, 11] })
    expect(laneDefaultAssignee(l, [DAN])?.assignee?.id).toBe(11)
    expect(laneDefaultAssignee(l, [VIC])).toBeNull()
  })

  it('does not ask for access when the lane has no team', () => {
    vi.mocked(getSwimlaneDefaultTeamAccess).mockClear()
    renderModal(lane())
    expect(getSwimlaneDefaultTeamAccess).not.toHaveBeenCalled()
  })
})
