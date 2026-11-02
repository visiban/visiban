import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FilterBar, { EMPTY_FILTER, countActiveFilters } from '../components/Board/FilterBar'
import SummaryView from '../components/Board/SummaryView'
import AnalyticsView from '../components/Board/AnalyticsView'
import { filterCards, hasActiveClientFilters } from '../utils/filterCards'
import { useSavedFilters } from '../hooks/useSavedFilters'
import type { BoardFull, Card, SavedFilter, User } from '../types'

vi.mock('../api/boards', () => ({
  getBoardSummary: vi.fn(),
  getBoardAnalytics: vi.fn(),
}))

vi.mock('../api/savedFilters', () => ({
  listSavedFilters: vi.fn().mockResolvedValue([]),
  createSavedFilter: vi.fn(),
  deleteSavedFilter: vi.fn(),
}))

import { getBoardAnalytics, getBoardSummary } from '../api/boards'

const mockSummary = getBoardSummary as ReturnType<typeof vi.fn>
const mockAnalytics = getBoardAnalytics as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false,
}

function makeCard(id: number, overrides: Partial<Card> = {}): Card {
  return {
    id, uid: `carduid0000${id}`, column: 10, swimlane: 20, title: `Card ${id}`, description: '',
    priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1, position: id,
    created_by: null, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0,
    checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1,
    custom_field_values: [], blocker_count: 0, external_ref: null,
    is_blocked: false, blocked_at: null, blocked_reason: '',
    ...overrides,
  }
}

const CARDS = [
  makeCard(1, { is_blocked: true, blocked_at: '2026-10-01T00:00:00Z', blocked_reason: 'Vendor' }),
  makeCard(2, { is_blocked: true, blocker_count: 1 }),
  makeCard(3),
]

function makeBoard(cards: Card[] = CARDS): BoardFull {
  return {
    health_status: null, effective_health_status: null, health_status_source: null,
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0, columns: [], swimlanes: [], cards, labels: [],
    members: [{ id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false,
    show_row_chip_field_names: true, export_min_role: 'viewer', card_density: 'comfortable', is_starred: false,
    created_at: '', updated_at: '', current_user_role: 'admin', owner: fakeUser,
    capabilities: { movement_export: false }, share_token: null, share_token_expires_at: null,
    share_link_active: false, custom_field_definitions: [], swimlane_custom_field_definitions: [],
  }
}

describe('Blocked only filter (#1149)', () => {
  it('keeps manual and relation blocks only', () => {
    expect(filterCards(CARDS, { ...EMPTY_FILTER, blockedOnly: true })).toEqual([1, 2])
    expect(filterCards(CARDS, EMPTY_FILTER)).toEqual([1, 2, 3])
    // A filter persisted before the field existed.
    const legacy = { ...EMPTY_FILTER }
    delete legacy.blockedOnly
    expect(filterCards(CARDS, legacy)).toEqual([1, 2, 3])
  })

  it('counts as an active client filter', () => {
    expect(hasActiveClientFilters({ ...EMPTY_FILTER, blockedOnly: true })).toBe(true)
    expect(hasActiveClientFilters(EMPTY_FILTER)).toBe(false)
    expect(countActiveFilters({ ...EMPTY_FILTER, blockedOnly: true })).toBe(1)
  })

  it('toggle is pressed-state, carries the count in its name, and flips the filter', () => {
    const onChange = vi.fn()
    const { rerender } = render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={onChange} />)
    const toggle = screen.getByRole('button', { name: 'Blocked only, 2 blocked cards' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTER, blockedOnly: true })

    rerender(<FilterBar board={makeBoard()} filters={{ ...EMPTY_FILTER, blockedOnly: true }} onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'Blocked only, 2 blocked cards' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('uses the singular for one blocked card', () => {
    render(<FilterBar board={makeBoard([CARDS[0], CARDS[2]])} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Blocked only, 1 blocked card' })).toBeInTheDocument()
  })

  it('shows a dismissible "Blocked only" chip while active', () => {
    const onChange = vi.fn()
    render(<FilterBar board={makeBoard()} filters={{ ...EMPTY_FILTER, blockedOnly: true }} onChange={onChange} />)
    // FilterChip renders a role=button span and an inner × button with one name.
    const [, dismiss] = screen.getAllByRole('button', { name: 'Remove Blocked only filter' })
    fireEvent.click(dismiss)
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTER, blockedOnly: false })
  })

  it('is also a facet under "+ Filter", counted in its badge', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={onChange} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('+ Filter'))
    await user.click(screen.getByRole('checkbox', { name: 'Blocked' }))
    await user.click(screen.getByRole('button', { name: 'Blocked' }))
    await user.click(screen.getByText('Blocked only (2)'))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, blockedOnly: true })

    rerender(<FilterBar board={makeBoard()} filters={{ ...EMPTY_FILTER, blockedOnly: true }} onChange={onChange} />)
    const trigger = screen.getByText('+ Filter').closest('button') as HTMLButtonElement
    expect(trigger).toHaveAttribute('aria-label', '+ Filter, 1 active')
  })

  it('saved filters restore blockedOnly and default it to off', async () => {
    const { result } = renderHook(() => useSavedFilters(1))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const saved = (state_json: Record<string, unknown>): SavedFilter => ({
      id: 1, name: 'x', state_json, state_version: 1, created_at: '',
    })
    expect(result.current.hydrateFilter(saved({ blockedOnly: true })).blockedOnly).toBe(true)
    expect(result.current.hydrateFilter(saved({})).blockedOnly).toBe(false)
    expect(result.current.hydrateFilter(saved({ blockedOnly: 'yes' })).blockedOnly).toBe(false)
  })
})

describe('Summary blocked count (#1149)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const lane = (overrides: Record<string, unknown>) => ({
    id: 1, name: 'Customer A', color: '#3B82F6', total_cards: 5,
    stage_distribution: { 'To Do': 5 }, velocity_7d: 0, velocity_30d: 0,
    active_cards: 5, done_30d: 0, avg_cycle_days: null, ...overrides,
  })

  it('shows the per-swimlane blocked count, and a dash for zero or an older server', async () => {
    mockSummary.mockResolvedValue({
      swimlanes: [lane({ blocked_cards: 4 }), lane({ id: 2, name: 'Customer B', blocked_cards: 0 }), lane({ id: 3, name: 'Customer C' })],
    })
    render(<SummaryView boardId={1} columns={['To Do']} />)
    expect(await screen.findByRole('columnheader', { name: 'Blocked' })).toBeInTheDocument()
    const cells = screen.getAllByTestId('summary-blocked-count')
    expect(cells[0]).toHaveTextContent('4')
    expect(within(cells[0]).getByText('4')).toHaveClass('text-danger')
    expect(cells[1]).toHaveTextContent('—')
    expect(cells[2]).toHaveTextContent('—')
  })
})

describe('Analytics blocked time (#1149)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const base = {
    days: 30, columns: ['Doing', 'Review', 'QA'], swimlanes: [],
    stalled_threshold_days: 7, staleness_threshold_days: 14, stale_warning_pct: 50,
  }

  it('lists blocked time per column and the top reasons', async () => {
    mockAnalytics.mockResolvedValue({
      ...base,
      blocked: {
        days_per_column: { Doing: 3, Review: 0, QA: 0 },
        seconds_per_column: { Doing: 3 * 86400, Review: 0, QA: 7200 },
        blocks_per_column: { Doing: 2, Review: 0, QA: 1 },
        top_reasons: [
          { reason: 'Waiting on customer', count: 2, total_days: 3, total_seconds: 3 * 86400 },
          // An older server: no seconds, so days are used.
          { reason: 'Vendor', count: 1, total_days: 0.5 },
        ],
      },
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    const section = await screen.findByTestId('analytics-blocked')
    expect(within(section).getByRole('heading', { name: 'Blocked time (last 30 days)' })).toBeInTheDocument()
    const table = within(section).getByRole('table', { name: 'Blocked time per column' })
    expect(within(table).getByText('Doing')).toBeInTheDocument()
    expect(within(table).queryByText('Review')).not.toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Time blocked' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Times blocked' })).toBeInTheDocument()
    expect(within(table).getByText('3d')).toBeInTheDocument()
    // A sub-day block reads in hours, never "0d".
    expect(within(table).getByText('2h')).toBeInTheDocument()
    const reasons = within(section).getByRole('list', { name: 'Top block reasons' })
    expect(within(reasons).getByText('Waiting on customer')).toBeInTheDocument()
    expect(within(reasons).getByText('2 blocks · 3d')).toBeInTheDocument()
    expect(within(reasons).getByText('1 block · 12h')).toBeInTheDocument()
  })

  it('renders no section when nothing was blocked, or for an older server', async () => {
    mockAnalytics.mockResolvedValue({
      ...base,
      blocked: { days_per_column: { Doing: 0, Review: 0, QA: 0 }, blocks_per_column: { Doing: 0, Review: 0, QA: 0 }, top_reasons: [] },
    })
    const { unmount } = render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    await screen.findByRole('group', { name: 'Analytics view mode' })
    expect(screen.queryByTestId('analytics-blocked')).not.toBeInTheDocument()
    unmount()
    mockAnalytics.mockResolvedValue(base)
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    await screen.findByRole('group', { name: 'Analytics view mode' })
    expect(screen.queryByTestId('analytics-blocked')).not.toBeInTheDocument()
  })
})
