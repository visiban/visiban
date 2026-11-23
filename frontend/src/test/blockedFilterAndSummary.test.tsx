import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FilterBar, { EMPTY_FILTER, countActiveFilters } from '../components/Board/FilterBar'
import SummaryView from '../components/Board/SummaryView'
import AnalyticsView from '../components/Board/AnalyticsView'
import { filterCards, hasActiveClientFilters } from '../utils/filterCards'
import { useSavedFilters } from '../hooks/useSavedFilters'
import type { BoardFull, Card, SavedFilter, User } from '../types'

// AnalyticsView's flow panels are covered by flowMetricsDashboard.test.tsx (#448, #2261).
vi.mock('../api/flowMetrics', async () => (await import('./flowMetricsStubs')).flowMetricsStub())

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
import { getFlowBlocked } from '../api/flowMetrics'

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
    health_status: null, effective_health_status: null, health_status_source: null, health_status_changed_at: null, health_status_changed_by: null, health_status_note: null, health_review_days: null, health_review_due_at: null, health_auto_enabled: false, health_off_track_cards: 3, computed_health_status: null, health_computed_at: null, health_computed_counts: null, health_status_origin: null, default_preset: null,
    swimlane_rollup_field: null,
    commitment_column_uid: null,
    cards_can_have_children: false,
    default_child_board: null,
    parent_name_singular: "",
    parent_name_plural: "",
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0, columns: [], swimlanes: [], cards, labels: [],
    members: [{ id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false,
    show_row_chip_field_names: true, lane_details_cap: 6, export_min_role: 'viewer', card_density: 'comfortable', is_starred: false,
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

  it('shows the active mark only while active (#2185)', () => {
    const { rerender } = render(<FilterBar board={makeBoard()} filters={EMPTY_FILTER} onChange={vi.fn()} />)
    const name = 'Blocked only, 2 blocked cards'
    expect(within(screen.getByRole('button', { name })).queryByTestId('active-mark')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false')
    rerender(<FilterBar board={makeBoard()} filters={{ ...EMPTY_FILTER, blockedOnly: true }} onChange={vi.fn()} />)
    const btn = screen.getByRole('button', { name })
    expect(within(btn).getByTestId('active-mark')).toBeInTheDocument()
    expect(btn).toHaveAttribute('aria-pressed', 'true')
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

describe('Analytics blocked time (#1149), from metrics/blocked (#2261)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAnalytics.mockResolvedValue({
      days: 90, columns: ['Doing', 'Review', 'QA'], swimlanes: [],
      stalled_threshold_days: 7, staleness_threshold_days: 14, stale_warning_pct: 50,
    })
  })

  const none = { definition: 'd', total: { days: 0, blocks: 0 }, blocked_now: 0, columns: [], reasons: [], reason_count: 0 }

  it('lists blocked time per column and the top reasons for the filter bar period', async () => {
    vi.mocked(getFlowBlocked).mockResolvedValue({
      definition: 'd',
      total: { days: 3.5833, blocks: 4 },
      blocked_now: 1,
      columns: [
        { column_uid: 'c1', column_name: 'Doing', days: 3, blocks: 2 },
        { column_uid: 'c2', column_name: 'Review', days: 0, blocks: 0 },
        { column_uid: 'c3', column_name: 'QA', days: 7200 / 86400, blocks: 1 },
      ],
      reasons: [
        { reason: 'Waiting on customer', days: 3, blocks: 2 },
        { reason: 'Vendor', days: 0.5, blocks: 1 },
      ],
      reason_count: 2,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    const section = await screen.findByTestId('analytics-blocked')
    expect(within(section).getByRole('heading', { name: 'Why cards get blocked' })).toBeInTheDocument()
    expect(within(section).getByText('One reason accounts for more than half of all blocked time.')).toBeInTheDocument()
    const reasons = within(section).getByRole('list', { name: 'Block reasons' })
    const items = within(reasons).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Waiting on customer3d · 2')
    // A sub-day total reads in hours, never "0d".
    expect(items[1]).toHaveTextContent('Vendor12h · 1')
    expect(section).toHaveTextContent('2 of 4 blocks started in Doing.')
  })

  it('ranks reasons longest first and scales the danger bars to the longest', async () => {
    vi.mocked(getFlowBlocked).mockResolvedValue({
      ...none,
      total: { days: 6, blocks: 3 },
      columns: [{ column_uid: 'c1', column_name: 'Doing', days: 6, blocks: 1 }],
      reasons: [
        { reason: 'Short', days: 1, blocks: 1 },
        { reason: 'Long', days: 4, blocks: 1 },
        { reason: 'Tiny', days: 0.001, blocks: 1 },
      ],
      reason_count: 3,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    const section = await screen.findByTestId('analytics-blocked')
    const items = within(section).getAllByRole('listitem')
    expect(items.map((li) => li.textContent?.slice(0, 5))).toEqual(['Long4', 'Short', 'Tiny1'])
    const bars = section.querySelectorAll('.bg-danger')
    expect((bars[0] as HTMLElement).style.width).toBe('100%')
    expect((bars[1] as HTMLElement).style.width).toBe('25%')
    expect((bars[2] as HTMLElement).style.width).toBe('2%')
  })

  it('shows one decimal from a day up and hours below it', async () => {
    vi.mocked(getFlowBlocked).mockResolvedValue({
      ...none,
      total: { days: 9.5, blocks: 5 },
      columns: [{ column_uid: 'c1', column_name: 'Doing', days: 9.5, blocks: 5 }],
      reasons: [
        { reason: 'A', days: 6.5, blocks: 2 },
        { reason: 'B', days: 2.5, blocks: 2 },
        { reason: 'C', days: 0.5, blocks: 1 },
      ],
      reason_count: 3,
    })
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    const section = await screen.findByTestId('analytics-blocked')
    const items = within(section).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('A6.5d · 2')
    expect(items[1]).toHaveTextContent('B2.5d · 2')
    expect(items[2]).toHaveTextContent('C12h · 1')
  })

  it('shows an empty state with the next action when nothing was blocked (#2457)', async () => {
    vi.mocked(getFlowBlocked).mockResolvedValue(none)
    render(<AnalyticsView boardId={1} currentUserRole="admin" />)
    await screen.findByTestId('flow-cycle-time')
    const section = screen.getByTestId('analytics-blocked')
    expect(within(section).getByRole('heading', { name: 'Why cards get blocked' })).toBeInTheDocument()
    expect(screen.getByTestId('analytics-blocked-empty')).toHaveTextContent(/No block reasons recorded in this period/)
    expect(screen.getByTestId('analytics-blocked-empty')).toHaveTextContent(/Mark a card as blocked/)
  })
})
