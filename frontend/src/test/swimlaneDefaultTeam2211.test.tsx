import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditSwimlaneModal from '../components/Board/EditSwimlaneModal'
import { DEFAULT_TEAM_HELP } from '../components/Board/SwimlaneDefaultTeamSection'
import { liveTeamIds } from '../utils/swimlaneDefaultTeam'
import type { EffectiveBoardMember, Swimlane } from '../types'

vi.mock('../api/boards', () => ({
  updateSwimlane: vi.fn(),
  deleteSwimlane: vi.fn(),
}))

import { updateSwimlane } from '../api/boards'

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
    const group = screen.getByRole('group', { name: 'Default team' })
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

  it('hides the section when the board members are not passed', () => {
    renderModal(lane({ default_team: [MIA.user.id] }), null)
    expect(screen.queryByRole('group', { name: 'Default team' })).toBeNull()
  })

  it('drops ids of people who left or became viewers', () => {
    expect(liveTeamIds([99, VIC.user.id, DAN.user.id], MEMBERS)).toEqual([DAN.user.id])
    expect(liveTeamIds(undefined, MEMBERS)).toEqual([])
  })
})
