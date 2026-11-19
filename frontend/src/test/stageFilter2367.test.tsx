import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FilterPanel from '../components/Board/FilterPanel'
import { EMPTY_FILTER, countActiveFilters } from '../components/Board/FilterBar'
import type { FilterState } from '../components/Board/FilterBar'
import { buildFilterChips } from '../components/Board/filterChips'
import { filterCards, hasActiveClientFilters } from '../utils/filterCards'
import { matchesStageFilters, sanitizeSubColumnIds, sanitizeTrackStates } from '../utils/stageFilter'
import type { BoardFull, Card, Column } from '../types'

// #2367 — sub-column and Track state filters. Review (id 10) is split into
// Doing (101) and Ready (102) with one track (Technical, field 7) whose
// "Yes" choice resolves done; Backlog (id 11) is a plain stage.
const review = {
  id: 10, name: 'Review', position: 1,
  sub_columns: [
    { id: 101, uid: 's1', position: 0, name: 'Doing' },
    { id: 102, uid: 's2', position: 1, name: 'Ready' },
  ],
  tracks: [{ id: 1, field_id: 7, field_uid: 'f7', name: 'Technical', position: 0 }],
} as unknown as Column
const backlog = { id: 11, name: 'Backlog', position: 0, sub_columns: [], tracks: [] } as unknown as Column
const defs = [{ id: 7, name: 'Technical', field_type: 'dropdown', choices: ['Yes', 'No'], choice_resolutions: { Yes: 'satisfied', No: 'open' }, is_dimension: true }]
const ctx = {
  columns: [review, backlog],
  swimlanes: [{ id: 20, not_applicable_field_ids: [] }, { id: 21, not_applicable_field_ids: [7] }],
  definitions: defs as never,
}

function card(over: Partial<Card>): Card {
  return {
    id: 1, uid: 'c', column: 10, swimlane: 20, title: 'C', description: '', priority: 'medium', assignee: null, labels: [],
    due_date: null, weight: 1, position: 0, custom_field_values: [], archived_at: null, blocker_count: 0, is_blocked: false,
    gates_passed: 0, ...over,
  } as unknown as Card
}

const cards = [
  card({ id: 1, gates_passed: 0, custom_field_values: [{ field_definition: 7, value: 'Yes' }] }),
  card({ id: 2, gates_passed: 1 }),
  card({ id: 3, gates_passed: 1, swimlane: 21 }),
  card({ id: 4, column: 11 }),
]

describe('stage filters (#2367)', () => {
  it('filters by sub-column and ignores plain-stage cards when one is picked', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, subColumnIds: [102] }, null, undefined, [], undefined, ctx)).toEqual([2, 3])
    expect(filterCards(cards, { ...EMPTY_FILTER, subColumnIds: [101, 102] }, null, undefined, [], undefined, ctx)).toEqual([1, 2, 3])
  })

  it('filters by track state, with a lane mark overriding the card value', () => {
    const f = (trackStates: FilterState['trackStates']) => filterCards(cards, { ...EMPTY_FILTER, trackStates }, null, undefined, [], undefined, ctx)
    expect(f(['done'])).toEqual([1])
    expect(f(['open'])).toEqual([2])
    expect(f(['not_applicable'])).toEqual([3])
    expect(f(['done', 'open'])).toEqual([1, 2])
  })

  it('ANDs the two filters and matches nothing without stage context (absent-input guard)', () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, subColumnIds: [102], trackStates: ['open'] }, null, undefined, [], undefined, ctx)).toEqual([2])
    expect(filterCards(cards, { ...EMPTY_FILTER, subColumnIds: [102] })).toEqual([])
    expect(matchesStageFilters(cards[0], [101], undefined, undefined)).toBe(false)
    expect(matchesStageFilters(cards[0], undefined, undefined, undefined)).toBe(true)
  })

  it('counts as active, and empty arrays do not', () => {
    expect(hasActiveClientFilters({ ...EMPTY_FILTER, subColumnIds: [1] })).toBe(true)
    expect(hasActiveClientFilters({ ...EMPTY_FILTER, trackStates: ['open'] })).toBe(true)
    expect(hasActiveClientFilters({ ...EMPTY_FILTER, subColumnIds: [], trackStates: [] })).toBe(false)
    expect(countActiveFilters({ ...EMPTY_FILTER, subColumnIds: [1], trackStates: ['open'] })).toBe(2)
  })

  it('sanitizes persisted shapes tolerantly', () => {
    expect(sanitizeSubColumnIds([1, 'x', 2.5, 3])).toEqual([1, 3])
    expect(sanitizeSubColumnIds('1')).toBeUndefined()
    expect(sanitizeSubColumnIds([])).toBeUndefined()
    expect(sanitizeTrackStates(['open', 'bogus', 'done'])).toEqual(['done', 'open'])
    expect(sanitizeTrackStates(null)).toBeUndefined()
  })

  it('builds dismissable chips, dropping the key when the last value goes', () => {
    const onChange = vi.fn()
    const board = { columns: [review, backlog], cards: [], labels: [], custom_field_definitions: [], members: [], swimlanes: [] } as unknown as BoardFull
    const filters: FilterState = { ...EMPTY_FILTER, subColumnIds: [101, 999], trackStates: ['open'] }
    const chips = buildFilterChips(board, filters, onChange, 'MM/DD/YYYY')
    expect(chips.map((c) => c.label)).toEqual(['Review: Doing', 'Any track open'])
    chips[0].onDismiss()
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, subColumnIds: [999] })
    chips[1].onDismiss()
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, trackStates: undefined })
  })
})

describe('FilterPanel stage rows (#2367)', () => {
  function setup(board: Partial<BoardFull>, filters: FilterState = EMPTY_FILTER) {
    const onChange = vi.fn()
    render(
      <FilterPanel
        board={{ id: 1, uid: 'b', name: 'B', cards: [], swimlanes: [], labels: [], members: [], custom_field_definitions: [], swimlane_custom_field_definitions: [], ...board } as unknown as BoardFull}
        filters={filters} onChange={onChange} activeCount={countActiveFilters(filters)} icon={null}
        savedFilters={[]} activeFilterId={null} onLoadSaved={vi.fn()} filterBarShown={false}
        onToggleFilterBar={vi.fn()} onOpenLaneFilters={vi.fn()}
      />,
    )
    return onChange
  }

  it('shows Sub-column and Track state rows only when the board has them', async () => {
    const u = userEvent.setup()
    setup({ columns: [backlog] })
    await u.click(screen.getByRole('button', { name: /^Filters/ }))
    expect(screen.queryByRole('button', { name: /^Sub-column/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Track state/ })).toBeNull()
  })

  it('toggles a sub-column and a track state, and shows the active value', async () => {
    const u = userEvent.setup()
    const onChange = setup({ columns: [review, backlog] })
    await u.click(screen.getByRole('button', { name: /^Filters/ }))
    await u.click(screen.getByRole('button', { name: /^Sub-column/ }))
    await u.click(screen.getByRole('checkbox', { name: 'Review: Ready' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, subColumnIds: [102] })
    await u.click(screen.getByRole('button', { name: /^Track state/ }))
    await u.click(screen.getByRole('checkbox', { name: 'Not applicable' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, trackStates: ['not_applicable'] })
  })

  it('reads an active value on the row and unchecks back to undefined', async () => {
    const u = userEvent.setup()
    const onChange = setup({ columns: [review] }, { ...EMPTY_FILTER, subColumnIds: [101], trackStates: ['done'] })
    await u.click(screen.getByRole('button', { name: /^Filters/ }))
    expect(screen.getByRole('button', { name: /^Sub-column/ })).toHaveTextContent('Review: Doing')
    expect(screen.getByRole('button', { name: /^Track state/ })).toHaveTextContent('Done')
    await u.click(screen.getByRole('button', { name: /^Track state/ }))
    await u.click(screen.getByRole('checkbox', { name: 'Done' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, subColumnIds: [101], trackStates: undefined })
  })
})
