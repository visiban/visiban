import { describe, it, expect, vi } from 'vitest'
import { render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FilterPanel from '../components/Board/FilterPanel'
import { EMPTY_FILTER, countActiveFilters, type FilterState } from '../components/Board/FilterBar'
import { buildFilterChips } from '../components/Board/filterChips'
import { filterCards, hasActiveClientFilters } from '../utils/filterCards'
import {
  matchesPlannedFilter, plannedFilterAvailable, plannedFilterChipLabel, plannedFilterLabel, sanitizePlannedFilter,
} from '../utils/plannedFilter'
import { useSavedFilters } from '../hooks/useSavedFilters'
import { usePersistedFilters } from '../hooks/usePersistedFilters'
import type { BoardFull, Card, SavedFilter } from '../types'

vi.mock('../api/savedFilters', () => ({
  listSavedFilters: vi.fn().mockResolvedValue([]),
  createSavedFilter: vi.fn(),
  updateSavedFilter: vi.fn(),
  deleteSavedFilter: vi.fn(),
}))

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

const CARDS = [makeCard(1, { planned: true }), makeCard(2, { planned: false }), makeCard(3)]

function makeBoard(cards: Card[]): BoardFull {
  return {
    id: 1, uid: 'b1', name: 'Delivery', cards, columns: [], swimlanes: [], labels: [], members: [],
    current_user_role: 'member', custom_field_definitions: [],
  } as unknown as BoardFull
}

describe('Planned filter rule (#2550)', () => {
  it('sanitizes to hide, only or Any', () => {
    expect(sanitizePlannedFilter('hide')).toBe('hide')
    expect(sanitizePlannedFilter('only')).toBe('only')
    for (const v of ['any', '', 'Hide', true, 1, null, undefined, ['hide']]) expect(sanitizePlannedFilter(v)).toBeUndefined()
  })
  it('matches on the card planned state; a card never read counts as not planned', () => {
    expect(matchesPlannedFilter({ planned: true }, 'only')).toBe(true)
    expect(matchesPlannedFilter({}, 'only')).toBe(false)
    expect(matchesPlannedFilter(undefined, 'hide')).toBe(true)
    expect(matchesPlannedFilter({ planned: true }, 'hide')).toBe(false)
    expect(matchesPlannedFilter({ planned: true }, undefined)).toBe(true)
  })
  it('labels the row and the chip', () => {
    expect(plannedFilterLabel(undefined)).toBeNull()
    expect(plannedFilterLabel('hide')).toBe('Hide planned')
    expect(plannedFilterLabel('only')).toBe('Only planned')
    expect(plannedFilterChipLabel('hide')).toBe('Planned: hidden')
    expect(plannedFilterChipLabel('only')).toBe('Planned: only')
  })
  it('the row shows with planned cards, and always while active', () => {
    expect(plannedFilterAvailable([{ planned: false }], undefined)).toBe(false)
    expect(plannedFilterAvailable([{ planned: true }], undefined)).toBe(true)
    expect(plannedFilterAvailable([], 'hide')).toBe(true)
  })
  it('filterCards hides or keeps only planned cards, and counts as an active filter', () => {
    expect(filterCards(CARDS, { ...EMPTY_FILTER, plannedFilter: 'hide' })).toEqual([2, 3])
    expect(filterCards(CARDS, { ...EMPTY_FILTER, plannedFilter: 'only' })).toEqual([1])
    expect(filterCards(CARDS, EMPTY_FILTER)).toEqual([1, 2, 3])
    expect(hasActiveClientFilters({ ...EMPTY_FILTER, plannedFilter: 'only' })).toBe(true)
    expect(countActiveFilters({ ...EMPTY_FILTER, plannedFilter: 'hide' })).toBe(1)
    expect(countActiveFilters(EMPTY_FILTER)).toBe(0)
  })
  it('adds a removable chip that drops the key', () => {
    const onChange = vi.fn()
    const chips = buildFilterChips(makeBoard(CARDS), { ...EMPTY_FILTER, plannedFilter: 'hide' }, onChange, 'MM/DD/YYYY')
    const chip = chips.find((c) => c.key === 'planned')!
    expect(chip.label).toBe('Planned: hidden')
    chip.onDismiss()
    expect(onChange.mock.calls[0][0]).not.toHaveProperty('plannedFilter')
  })
})

describe('Planned filter persistence (#2550)', () => {
  it('saved filters restore plannedFilter; a bad or missing value is Any', async () => {
    const { result } = renderHook(() => useSavedFilters(1))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const saved = (state_json: Record<string, unknown>): SavedFilter => ({ id: 1, name: 'x', state_json, state_version: 1, created_at: '' })
    expect(result.current.hydrateFilter(saved({ plannedFilter: 'only' })).plannedFilter).toBe('only')
    expect(result.current.hydrateFilter(saved({})).plannedFilter).toBeUndefined()
    expect(result.current.hydrateFilter(saved({ plannedFilter: 'all' }))).not.toHaveProperty('plannedFilter')
  })
  it('the persisted board filter restores it too', () => {
    localStorage.setItem('board:2550:filters', JSON.stringify({ ...EMPTY_FILTER, plannedFilter: 'hide' }))
    const { result } = renderHook(() => usePersistedFilters(2550))
    expect(result.current.filters.plannedFilter).toBe('hide')
    localStorage.setItem('board:2551:filters', JSON.stringify({ ...EMPTY_FILTER, plannedFilter: 'nope' }))
    const { result: other } = renderHook(() => usePersistedFilters(2551))
    expect(other.current.filters).not.toHaveProperty('plannedFilter')
    localStorage.clear()
  })
})

describe('Planned row in the filter panel (#2550)', () => {
  function setup(board: BoardFull, filters: FilterState = EMPTY_FILTER) {
    const onChange = vi.fn()
    render(
      <FilterPanel
        board={board} filters={filters} onChange={onChange} activeCount={countActiveFilters(filters)} icon={null}
        savedFilters={[]} activeFilterId={null} onLoadSaved={vi.fn()} filterBarShown={false}
        onToggleFilterBar={vi.fn()} onOpenLaneFilters={vi.fn()}
      />,
    )
    return onChange
  }
  it('sits after Due date, names its value, and sets Hide, Only and Any', async () => {
    const u = userEvent.setup()
    const onChange = setup(makeBoard(CARDS))
    await u.click(screen.getByRole('button', { name: /^Filters/ }))
    const names = screen.getAllByRole('button', { expanded: false }).map((b) => b.getAttribute('aria-label') ?? b.textContent)
    const due = names.findIndex((n) => n?.startsWith('Due date'))
    expect(names[due + 1]).toBe('Planned filter: Any')
    await u.click(screen.getByRole('button', { name: 'Planned filter: Any' }))
    await u.click(screen.getByRole('radio', { name: 'Hide planned' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, plannedFilter: 'hide' })
    await u.click(screen.getByRole('radio', { name: 'Only planned' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, plannedFilter: 'only' })
  })
  it('an active row reads its value and Any drops the key', async () => {
    const u = userEvent.setup()
    const onChange = setup(makeBoard([makeCard(2)]), { ...EMPTY_FILTER, plannedFilter: 'hide' })
    await u.click(screen.getByRole('button', { name: /^Filters/ }))
    await u.click(screen.getByRole('button', { name: 'Planned filter: Hide planned' }))
    await u.click(screen.getByRole('radio', { name: 'Any' }))
    expect(onChange.mock.calls.at(-1)![0]).not.toHaveProperty('plannedFilter')
  })
  it('has no row on a board without planned cards', async () => {
    const u = userEvent.setup()
    setup(makeBoard([makeCard(2)]))
    await u.click(screen.getByRole('button', { name: /^Filters/ }))
    expect(screen.queryByRole('button', { name: /^Planned filter/ })).toBeNull()
  })
})
