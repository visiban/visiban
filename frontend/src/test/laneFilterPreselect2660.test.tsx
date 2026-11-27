import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import FilterBar, { EMPTY_FILTER } from '../components/Board/FilterBar'
import { LaneFilterControl } from '../components/Board/LaneFilterPopover'
import { isRuleComplete } from '../utils/fieldRules'
import type { LaneFilter } from '../utils/laneFilter'
import { LANE_FILTER_MAX_ITEMS, LANE_FILTER_MAX_RULES } from '../utils/laneFilter'

const fields = [
  { id: 50, uid: 'a', name: 'Tier', field_type: 'dropdown', choices: ['gold', 'silver'], position: 0, show_on_row: false, is_admin_only: false, is_required: false, help_text: '', band_visibility: 'band' },
  { id: 51, uid: 'b', name: 'Region', field_type: 'dropdown', choices: ['EMEA'], position: 1, show_on_row: false, is_admin_only: false, is_required: false, help_text: '', band_visibility: 'band' },
  { id: 52, uid: 'c', name: 'Budget', field_type: 'number', choices: [], position: 2, show_on_row: false, is_admin_only: false, is_required: false, help_text: '', band_visibility: 'band' },
  { id: 53, uid: 'd', name: 'Renewal', field_type: 'date', choices: [], position: 3, show_on_row: false, is_admin_only: false, is_required: false, help_text: '', band_visibility: 'band' },
  { id: 54, uid: 'e', name: 'Approved', field_type: 'checkbox', choices: [], position: 4, show_on_row: false, is_admin_only: false, is_required: false, help_text: '', band_visibility: 'band' },
] as never

const fmt = ((_d: unknown, v: string) => v) as never

function mount(filter: LaneFilter | undefined, preselectField: number | null, onChange = vi.fn(), consumed = vi.fn()) {
  render(
    <LaneFilterControl filter={filter} fields={fields} onChange={onChange} fmt={fmt} activeRuleCount={0}
      preselectField={preselectField} onPreselectConsumed={consumed} />,
  )
  return { onChange, consumed }
}

describe('Lanes popover preselect (#2660)', () => {
  it('adds a rule for the field when none exists, once the popover opens', async () => {
    const { onChange } = mount(undefined, 50)
    screen.getByRole('button', { name: /Lanes/ }).click()
    await screen.findByRole('dialog')
    const next = onChange.mock.calls[0][0] as LaneFilter
    expect(next.items[0]).toMatchObject({ kind: 'rule', field: 50, op: 'is' })
  })

  it('adds nothing when the field already has a rule, and clears the request', async () => {
    const filter = { items: [{ kind: 'rule', id: 1, join: 'and', field: 50, op: 'is', value: 'gold' }] } as unknown as LaneFilter
    const { onChange, consumed } = mount(filter, 50)
    screen.getByRole('button', { name: /Lanes/ }).click()
    await screen.findByRole('dialog')
    expect(onChange).not.toHaveBeenCalled()
    expect(consumed).toHaveBeenCalled()
  })

  it('does nothing extra without a preselect', async () => {
    const { onChange } = mount(undefined, null)
    screen.getByRole('button', { name: /Lanes/ }).click()
    await screen.findByRole('dialog')
    expect(onChange).not.toHaveBeenCalled()
  })

  it.each([[52, 'number'], [53, 'date']])('auto-adds a %i (%s) rule with its type\'s first operator, which can be completed', async (fid) => {
    const { onChange } = mount(undefined, fid)
    screen.getByRole('button', { name: /Lanes/ }).click()
    await screen.findByRole('dialog')
    const next = onChange.mock.calls[0][0] as LaneFilter
    expect(next.items[0]).toMatchObject({ kind: 'rule', field: fid, op: 'between' })
    const rule = next.items[0] as never as { field: number; op: 'between'; min?: string; max?: string }
    const t = fid === 52 ? 'number' : 'date'
    expect(isRuleComplete(rule as never, t)).toBe(false)
    expect(isRuleComplete({ ...rule, min: fid === 52 ? '5' : '2026-01-02', max: fid === 52 ? '9' : '2026-02-03' } as never, t)).toBe(true)
  })

  it('auto-adds a checkbox rule with op is', async () => {
    const { onChange } = mount(undefined, 54)
    screen.getByRole('button', { name: /Lanes/ }).click()
    await screen.findByRole('dialog')
    expect((onChange.mock.calls[0][0] as LaneFilter).items[0]).toMatchObject({ field: 54, op: 'is' })
  })

  it('at the item cap adds no rule and focuses the existing first item', async () => {
    const items = Array.from({ length: LANE_FILTER_MAX_ITEMS }, (_, i) => ({ kind: 'rule', id: i + 1, join: 'and', field: 51, op: 'is', value: 'EMEA' }))
    const { onChange } = mount({ items } as unknown as LaneFilter, 50)
    screen.getByRole('button', { name: /Lanes/ }).click()
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.querySelector('[data-lane-row="1"] button')).toBe(document.activeElement))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('with two existing rules, preselecting the second field focuses the second rule', async () => {
    const items = [
      { kind: 'rule', id: 1, join: 'and', field: 50, op: 'is', value: 'gold' },
      { kind: 'rule', id: 2, join: 'and', field: 51, op: 'is', value: 'EMEA' },
    ]
    const { onChange } = mount({ items } as unknown as LaneFilter, 51)
    screen.getByRole('button', { name: /Lanes/ }).click()
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.querySelector('[data-lane-row="2"] button')).toBe(document.activeElement))
    expect(dialog.querySelector('[data-lane-row="1"] button')).not.toBe(document.activeElement)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('at the group rule limit adds no rule and focuses the first item', async () => {
    const rules = Array.from({ length: LANE_FILTER_MAX_RULES }, (_, i) => ({ kind: 'rule', id: i + 2, join: 'and', field: 51, op: 'is', value: 'EMEA' }))
    // Two items (a group holding every rule, plus one): under the item cap but at the rule cap.
    const items = [{ kind: 'group', id: 1, join: 'and', rules }]
    const { onChange } = mount({ items } as unknown as LaneFilter, 50)
    screen.getByRole('button', { name: /Lanes/ }).click()
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.querySelector('[data-lane-row="2"] button')).toBe(document.activeElement))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('focuses the new rule, then a later open does not preselect again', async () => {
    function Harness() {
      const [filter, setFilter] = useState<LaneFilter | undefined>(undefined)
      const [pre, setPre] = useState<number | null>(50)
      return (
        <>
          <button onClick={() => setFilter(undefined)}>reset</button>
          <LaneFilterControl filter={filter} fields={fields} onChange={setFilter} fmt={fmt} activeRuleCount={0}
            preselectField={pre} onPreselectConsumed={() => setPre(null)} />
        </>
      )
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: /Lanes/ })
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.querySelector('[data-lane-row] button')).toBe(document.activeElement))
    expect(dialog.querySelectorAll('[data-lane-row]')).toHaveLength(1)
    // The request was consumed: after the rules are cleared, a plain reopen must not preselect again.
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('reset'))
    fireEvent.click(trigger)
    const again = await screen.findByRole('dialog')
    expect(again.querySelectorAll('[data-lane-row]')).toHaveLength(0)
  })

  it('FilterBar threads preselectField and onPreselectConsumed to the Lanes popover', async () => {
    const board = {
      id: 1, uid: 'u', name: 'B', columns: [], swimlanes: [], cards: [], labels: [], members: [],
      custom_field_definitions: [], swimlane_custom_field_definitions: fields, current_user_role: 'admin',
    } as never
    const onChange = vi.fn()
    const consumed = vi.fn()
    render(<FilterBar board={board} filters={EMPTY_FILTER} onChange={onChange} lanePreselectField={50} onLanePreselectConsumed={consumed} />)
    screen.getByRole('button', { name: /Lanes/ }).click()
    await screen.findByRole('dialog')
    expect(consumed).toHaveBeenCalled()
    expect(onChange.mock.calls[0][0].laneFilter.items[0]).toMatchObject({ field: 50 })
  })
})
