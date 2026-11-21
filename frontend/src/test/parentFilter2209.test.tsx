import { describe, it, expect, vi } from 'vitest'
import { render, renderHook, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FilterPanel from '../components/Board/FilterPanel'
import { EMPTY_FILTER, countActiveFilters, type FilterState } from '../components/Board/FilterBar'
import { buildFilterChips } from '../components/Board/filterChips'
import { filterCards, hasActiveClientFilters } from '../utils/filterCards'
import {
  matchesParentFilter, parentFilterAvailable, parentFilterLabel, parentFilterOptions, parseParentFilterParam, sanitizeParentFilter,
} from '../utils/parentFilter'
import { usePersistedFilters } from '../hooks/usePersistedFilters'
import type { BoardFull, Card, CardParent } from '../types'

const visible = (id: number, title: string): CardParent => ({
  hidden: false, id, title, board_id: 1, board_name: 'Pipeline', column_id: 1, column_name: 'Qualify',
  swimlane_id: 1, swimlane_name: 'Acme', archived: false, board_parent_name_singular: '',
})

function card(id: number, parent: CardParent | null | undefined): Card {
  return {
    id, title: `C${id}`, description: '', assignee: null, labels: [], priority: 'medium', due_date: null,
    custom_field_values: [], column: 1, swimlane: 1, blocked_at: null, parent,
  } as unknown as Card
}

const cards = [
  card(1, visible(50, 'Initech: security review')),
  card(2, visible(51, 'Acme: platform renewal')),
  card(3, { hidden: true }),
  card(4, null),
  card(5, undefined),
  card(6, visible(50, 'Initech: security review')),
]

function makeBoard(over: Partial<BoardFull> = {}): BoardFull {
  return {
    id: 7, uid: 'b7', name: 'Delivery', cards, columns: [], swimlanes: [], labels: [], members: [],
    current_user_role: 'member', custom_field_definitions: [], swimlane_custom_field_definitions: [],
    cards_can_have_children: false, ...over,
  } as unknown as BoardFull
}

describe('Parent filter (#2209 row 10)', () => {
  it('matches Any, Any parent, No parent and one parent; a hidden parent never matches an id', () => {
    const ids = (f: FilterState['parentFilter']) => cards.filter((c) => matchesParentFilter(c, f)).map((c) => c.id)
    expect(ids(undefined)).toEqual([1, 2, 3, 4, 5, 6])
    expect(ids('any')).toEqual([1, 2, 3, 6])
    expect(ids('none')).toEqual([4, 5])
    expect(ids(50)).toEqual([1, 6])
    expect(ids(99)).toEqual([])
    expect(filterCards(cards, { ...EMPTY_FILTER, parentFilter: 51 })).toEqual([2])
  })

  it('offers only parents the viewer can open, once each, by title', () => {
    expect(parentFilterOptions(cards)).toEqual([
      { id: 51, title: 'Acme: platform renewal' },
      { id: 50, title: 'Initech: security review' },
    ])
    expect(parentFilterLabel(undefined, cards)).toBeNull()
    expect(parentFilterLabel('any', cards)).toBe('Any parent')
    expect(parentFilterLabel('none', cards)).toBe('No parent')
    expect(parentFilterLabel(50, cards)).toBe('Initech: security review')
    // An id no visible card names still reads as active, and names nothing.
    expect(parentFilterLabel(77, cards)).toBe('A card not shown here')
  })

  it('accepts only any, none or a positive id from storage, saved filters and the URL', () => {
    for (const v of ['any', 'none', 5]) expect(sanitizeParentFilter(v)).toBe(v)
    for (const v of [undefined, null, 0, -1, 1.5, '5', true, 2 ** 31, {}]) expect(sanitizeParentFilter(v)).toBeUndefined()
    expect(parseParentFilterParam('12')).toBe(12)
    expect(parseParentFilterParam('none')).toBe('none')
    expect(parseParentFilterParam(null)).toBeUndefined()
    expect(parseParentFilterParam('x')).toBeUndefined()
  })

  it('counts as an active client filter, and is restored from storage', () => {
    expect(countActiveFilters({ ...EMPTY_FILTER, parentFilter: 'none' })).toBe(1)
    expect(hasActiveClientFilters({ ...EMPTY_FILTER, parentFilter: 'any' })).toBe(true)
    expect(hasActiveClientFilters(EMPTY_FILTER)).toBe(false)
    localStorage.setItem('board:7:filters', JSON.stringify({ ...EMPTY_FILTER, parentFilter: 50 }))
    expect(renderHook(() => usePersistedFilters(7, [])).result.current.filters.parentFilter).toBe(50)
    localStorage.setItem('board:7:filters', JSON.stringify({ ...EMPTY_FILTER, parentFilter: 'bogus' }))
    expect('parentFilter' in renderHook(() => usePersistedFilters(7, [])).result.current.filters).toBe(false)
    localStorage.clear()
  })

  it('a chip names the parent and dismissing it returns to Any', () => {
    const onChange = vi.fn()
    const chips = buildFilterChips(makeBoard(), { ...EMPTY_FILTER, parentFilter: 50 }, onChange, 'MM/DD/YYYY')
    const chip = chips.find((c) => c.key === 'parent')!
    expect(chip.label).toBe('Parent: Initech: security review')
    chip.onDismiss()
    expect(onChange.mock.calls[0][0]).not.toHaveProperty('parentFilter')
  })

  it('shows the row on a child board with linked cards, not on a parent board or a board with none', () => {
    expect(parentFilterAvailable(makeBoard(), undefined)).toBe(true)
    expect(parentFilterAvailable(makeBoard({ cards_can_have_children: true }), undefined)).toBe(false)
    expect(parentFilterAvailable(makeBoard({ cards: [card(4, null), card(5, undefined)] }), undefined)).toBe(false)
    // An active filter (a URL or saved one) keeps its row so it can be changed.
    expect(parentFilterAvailable(makeBoard({ cards: [] }), 5)).toBe(true)
  })

  it('Filter panel: the Parent row opens a single-select and sets or clears the value', async () => {
    const u = userEvent.setup()
    const onChange = vi.fn()
    const filters = { ...EMPTY_FILTER, parentFilter: 50 }
    render(
      <FilterPanel
        board={makeBoard()} filters={filters} onChange={onChange} activeCount={countActiveFilters(filters)} icon={null}
        savedFilters={[]} activeFilterId={null} onLoadSaved={vi.fn()} filterBarShown={false} onToggleFilterBar={vi.fn()}
        onOpenLaneFilters={vi.fn()}
      />,
    )
    await u.click(screen.getByRole('button', { name: /^Filters/ }))
    const row = screen.getByRole('button', { name: /^Parent/ })
    expect(row).toHaveTextContent('Initech: security review')
    await u.click(row)
    const group = screen.getByRole('radiogroup', { name: 'Parent' })
    const names = within(group).getAllByRole('radio').map((r) => r.closest('label')!.textContent)
    expect(names).toEqual(['Any', 'Any parent', 'No parent', 'Acme: platform renewal', 'Initech: security review'])
    expect(within(group).getByRole('radio', { name: 'Initech: security review' })).toBeChecked()
    await u.click(within(group).getByRole('radio', { name: 'No parent' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ parentFilter: 'none' }))
    await u.click(within(group).getByRole('radio', { name: 'Any' }))
    expect(onChange.mock.calls.at(-1)![0]).not.toHaveProperty('parentFilter')
  })
})
