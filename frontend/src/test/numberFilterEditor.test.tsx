import { describe, it, expect } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FilterPanel from '../components/Board/FilterPanel'
import { EMPTY_FILTER, countActiveFilters } from '../components/Board/FilterBar'
import type { FilterState } from '../components/Board/FilterBar'
import type { BoardFull } from '../types'

// #2357 — the Filter panel's number operator editor, driven through a
// stateful harness so operator switches and carry-over are observable.
const board = {
  id: 1, uid: 'b1', name: 'B', cards: [], columns: [], swimlanes: [], labels: [], members: [],
  current_user_role: 'admin',
  custom_field_definitions: [
    { id: 9, name: 'Estimate', field_type: 'number', choices: [], position: 0, show_on_card: false, number_decimals: 2 },
  ],
  swimlane_custom_field_definitions: [],
} as unknown as BoardFull

function setup(initial: FilterState = EMPTY_FILTER) {
  const seen: FilterState[] = []
  function Harness() {
    const [filters, setFilters] = useState(initial)
    return (
      <FilterPanel
        board={board}
        filters={filters}
        onChange={(f) => { seen.push(f); setFilters(f) }}
        activeCount={countActiveFilters(filters)}
        icon={null}
        savedFilters={[]}
        activeFilterId={null}
        onLoadSaved={() => {}}
        filterBarShown={false}
        onToggleFilterBar={() => {}}
        onOpenLaneFilters={() => {}}
      />
    )
  }
  render(<Harness />)
  return { last: () => seen[seen.length - 1]?.customFields[9] }
}

async function openEstimate(u: ReturnType<typeof userEvent.setup>) {
  await u.click(screen.getByRole('button', { name: /^Filters/ }))
  await u.click(screen.getByRole('button', { name: /^Estimate/ }))
}

async function pick(u: ReturnType<typeof userEvent.setup>, label: string) {
  await u.click(screen.getByRole('button', { name: /^Estimate operator/ }))
  await u.click(screen.getByRole('menuitem', { name: label }))
}

describe('NumberFilterEditor in the Filter panel (#2357)', () => {
  it('lists the operators in order and keeps the equals input unchanged', async () => {
    const u = userEvent.setup()
    setup()
    await openEstimate(u)
    const input = screen.getByRole('spinbutton', { name: 'Estimate' })
    expect(input).toHaveAttribute('step', '0.01')
    await u.click(screen.getByRole('button', { name: /^Estimate operator/ }))
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['equals', 'between', 'at least', 'at most', 'is empty', 'has a value'])
  })

  it('carries the equals value into between and writes equals: ""', async () => {
    const u = userEvent.setup()
    const { last } = setup()
    await openEstimate(u)
    await u.type(screen.getByRole('spinbutton', { name: 'Estimate' }), '3')
    await pick(u, 'between')
    expect(last()).toEqual({ kind: 'number', equals: '', op: 'between', min: '3', max: '' })
    expect(screen.getByRole('button', { name: /^Estimate operator/ })).toHaveFocus()
    expect(screen.getByRole('spinbutton', { name: 'Estimate minimum' })).toHaveValue(3)
    expect(screen.getByText('and')).toBeInTheDocument()
    await u.type(screen.getByRole('spinbutton', { name: 'Estimate maximum' }), '8')
    expect(last()).toEqual({ kind: 'number', equals: '', op: 'between', min: '3', max: '8' })
    expect(screen.getByRole('button', { name: /^Estimate\b(?! operator)/ })).toHaveTextContent('3.00–8.00')
  })

  it('at least shows only the minimum and survives a blank bound; at most moves it', async () => {
    const u = userEvent.setup()
    const { last } = setup()
    await openEstimate(u)
    await pick(u, 'at least')
    expect(screen.getByRole('spinbutton', { name: 'Estimate minimum' })).toBeInTheDocument()
    expect(screen.queryByRole('spinbutton', { name: 'Estimate maximum' })).toBeNull()
    await u.type(screen.getByRole('spinbutton', { name: 'Estimate minimum' }), '13')
    expect(last()).toEqual({ kind: 'number', equals: '', op: 'between', min: '13', max: '' })
    await pick(u, 'at most')
    expect(last()).toEqual({ kind: 'number', equals: '', op: 'between', min: '', max: '13' })
    expect(screen.queryByRole('spinbutton', { name: 'Estimate minimum' })).toBeNull()
    await pick(u, 'equals')
    expect(last()).toEqual({ kind: 'number', equals: '13' })
  })

  it('is empty / has a value show a description instead of inputs', async () => {
    const u = userEvent.setup()
    const { last } = setup({ ...EMPTY_FILTER, customFields: { 9: { kind: 'number', equals: '4' } } })
    await openEstimate(u)
    await pick(u, 'is empty')
    expect(last()).toEqual({ kind: 'number', equals: '', op: 'empty' })
    expect(screen.getByText('Matches cards where this field is empty.')).toBeInTheDocument()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    await pick(u, 'has a value')
    expect(screen.getByText('Matches cards where this field has any value.')).toBeInTheDocument()
    await pick(u, 'equals')
    expect(last()).toEqual({ kind: 'number', equals: '' })
  })

  it('warns, without blocking, when the minimum is greater than the maximum', async () => {
    const u = userEvent.setup()
    const { last } = setup({ ...EMPTY_FILTER, customFields: { 9: { kind: 'number', equals: '', op: 'between', min: '8', max: '9' } } })
    await openEstimate(u)
    // Clearing one bound of an open "between" keeps both inputs on screen.
    await u.clear(screen.getByRole('spinbutton', { name: 'Estimate maximum' }))
    expect(screen.getByRole('spinbutton', { name: 'Estimate maximum' })).toBeInTheDocument()
    await u.type(screen.getByRole('spinbutton', { name: 'Estimate maximum' }), '3')
    expect(last()).toEqual({ kind: 'number', equals: '', op: 'between', min: '8', max: '3' })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Minimum is greater than maximum, so no cards will match.')
    for (const name of ['Estimate minimum', 'Estimate maximum']) {
      const input = screen.getByRole('spinbutton', { name })
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(input).toHaveAttribute('aria-describedby', alert.id)
      expect(input.className).toContain('border-danger')
    }
    await u.clear(screen.getByRole('spinbutton', { name: 'Estimate maximum' }))
    await u.type(screen.getByRole('spinbutton', { name: 'Estimate maximum' }), '9')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('spinbutton', { name: 'Estimate minimum' })).not.toHaveAttribute('aria-invalid')
  })
})
