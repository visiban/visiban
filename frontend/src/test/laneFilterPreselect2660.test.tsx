import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LaneFilterControl } from '../components/Board/LaneFilterPopover'
import type { LaneFilter } from '../utils/laneFilter'

const fields = [
  { id: 50, uid: 'a', name: 'Tier', field_type: 'dropdown', choices: ['gold', 'silver'], position: 0, show_on_row: false, is_admin_only: false, is_required: false, help_text: '', band_visibility: 'band' },
  { id: 51, uid: 'b', name: 'Region', field_type: 'dropdown', choices: ['EMEA'], position: 1, show_on_row: false, is_admin_only: false, is_required: false, help_text: '', band_visibility: 'band' },
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
})
