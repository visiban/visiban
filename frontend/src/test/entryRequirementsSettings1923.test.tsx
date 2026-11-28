import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardSettingsEntryRequirementsSection from '../components/Board/BoardSettingsEntryRequirementsSection'
import { operatorsFor, toWrite, validateDraft } from '../utils/entryRequirementsEditor'
import type { Column, CustomFieldDefinition, CustomFieldSet, Swimlane } from '../types'

// #1923 MR B: Board settings › Rules & limits › Entry requirements.

const col = (id: number, name: string, over: Partial<Column> = {}): Column => ({
  id, uid: `c${id}`, name, position: id, color: '#3B82F6', wip_limit: null, weight_limit: null,
  allow_card_creation: true, is_done: false, policy: null, entry_enforcement: null, entry_requirements: [], ...over,
})
const field = (id: number, name: string, field_type: CustomFieldDefinition['field_type'], over: Partial<CustomFieldDefinition> = {}) =>
  ({ id, uid: `f${id}`, name, field_type, choices: [], ...over }) as CustomFieldDefinition
const fields = [
  field(1, 'Amount', 'number'), field(2, 'Owner', 'text'), field(3, 'Signed', 'checkbox'),
  field(4, 'Tags', 'multi_select'), field(5, 'Budget', 'dropdown', { is_dimension: true }),
]
const sets: CustomFieldSet[] = [{
  id: 9, uid: 's9', name: 'MEDDIC', description: null, position: 0, default_size: 'summary' as CustomFieldSet['default_size'],
  scope: 'swimlanes', swimlanes: [21, 22], field_ids: [1, 5], created_at: '',
}]
const lanes = [{ id: 21, name: 'Enterprise' }, { id: 22, name: 'Mid-market' }] as Swimlane[]

const proposal = col(2, 'Proposal', {
  entry_enforcement: 'block',
  entry_requirements: [{ uid: 'r1', field_uid: 'f1', field_set_uid: null, operator: 'gt', operand: '50000', position: 0 }],
})
const columns = [col(1, 'Discovery'), proposal, col(3, 'Won')]

function setup(over: Partial<Parameters<typeof BoardSettingsEntryRequirementsSection>[0]> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined)
  render(<BoardSettingsEntryRequirementsSection columns={columns} fields={fields} sets={sets} swimlanes={lanes} isAdmin onSave={onSave} {...over} />)
  return { onSave }
}

describe('operatorsFor / toWrite / validateDraft', () => {
  it('mirrors the server operator table', () => {
    expect(operatorsFor(fields[0])).toEqual(['filled', 'gt', 'gte'])
    expect(operatorsFor(fields[1])).toEqual(['filled'])
    expect(operatorsFor(fields[2])).toEqual([])
    expect(operatorsFor(fields[3])).toEqual(['filled', 'min_count'])
    expect(operatorsFor(fields[4])).toEqual(['satisfied', 'filled'])
  })

  it('sends null when off, keeping the rows', () => {
    const rows = [{ key: 0, kind: 'field' as const, uid: 'f1', operator: 'gt' as const, operand: ' 5 ' }, { key: 1, kind: 'set' as const, uid: 's9', operator: 'set_complete' as const, operand: '' }]
    expect(toWrite({ on: false, mode: 'block', rows })).toEqual({
      entry_enforcement: null,
      requirements: [{ field_uid: 'f1', operator: 'gt', operand: '5' }, { field_set_uid: 's9', operator: 'set_complete' }],
    })
    expect(toWrite({ on: true, mode: 'hard', rows }).entry_enforcement).toBe('hard')
    expect(toWrite({ on: true, mode: 'hard', rows: [] }).entry_enforcement).toBeNull()
  })

  it('names the first bad condition', () => {
    const r = (over: object) => ({ key: 0, kind: 'field' as const, uid: 'f1', operator: 'filled' as const, operand: '', ...over })
    expect(validateDraft({ on: true, mode: 'warn', rows: [r({ uid: '' })] })?.message).toBe('Choose a field for condition 1.')
    expect(validateDraft({ on: true, mode: 'warn', rows: [r({ operator: 'gt', operand: '' })] })?.message).toBe('Enter a number for condition 1.')
    expect(validateDraft({ on: true, mode: 'warn', rows: [r({ operator: 'min_count', operand: '1.5' })] })?.message).toBe('Condition 1 needs a whole number of at least 1.')
    expect(validateDraft({ on: true, mode: 'warn', rows: [r({ operator: 'min_count', operand: '2' })] })).toBeNull()
  })
})

describe('BoardSettingsEntryRequirementsSection', () => {
  it('renders the stage strip as a radiogroup with mode names and opens on the deep-linked column', () => {
    setup({ initialColumnId: 2 })
    const strip = screen.getByRole('radiogroup', { name: 'Column to edit' })
    const proposalMarker = within(strip).getByRole('radio', { name: 'Entering Proposal: Block, 1 requirement' })
    expect(proposalMarker).toHaveAttribute('aria-checked', 'true')
    expect(proposalMarker).toHaveAttribute('tabindex', '0')
    expect(within(strip).getByRole('radio', { name: 'Entering Discovery: off, 0 requirements' })).toHaveAttribute('tabindex', '-1')
    expect(screen.getByText('Entering Proposal')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Requirements on' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: /^Block/, checked: true })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Condition 1 value' })).toHaveValue(50000)
    // Lane scope is derived and shown (Amount is in the lane-scoped MEDDIC set).
    expect(screen.getByText(/Applies in swimlanes where MEDDIC shows: Enterprise, Mid-market\. Cards created directly in Proposal are checked too\./)).toBeInTheDocument()
  })

  it('says where a derived lane scope is changed, with a link to Field sets (#2672)', () => {
    const onOpenFieldSets = vi.fn()
    setup({ initialColumnId: 2, onOpenFieldSets })
    expect(screen.getByTestId('entry-lanes-help')).toHaveTextContent("Set by the field set's lanes. Change them in Field sets.")
    screen.getByRole('button', { name: 'Field sets' }).click()
    expect(onOpenFieldSets).toHaveBeenCalledTimes(1)
  })

  it('shows the lane-scope note as plain text without a Field sets handler (#2672)', () => {
    setup({ initialColumnId: 2 })
    expect(screen.getByTestId('entry-lanes-help')).toHaveTextContent('Change them in Field sets.')
    expect(screen.queryByRole('button', { name: 'Field sets' })).toBeNull()
  })

  it('moves with the arrow keys (roving tabindex) and Home/End', async () => {
    setup()
    const first = screen.getByRole('radio', { name: /Entering Discovery/ })
    first.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: /Entering Proposal/ })).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('radio', { name: /Entering Won/ })).toHaveAttribute('aria-checked', 'true')
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: /Entering Discovery/ })).toHaveFocus()
    await userEvent.keyboard('{Home}{ArrowLeft}')
    expect(screen.getByRole('radio', { name: /Entering Won/ })).toHaveFocus()
  })

  it('adds a field condition and a set condition and saves one replace-all body', async () => {
    const { onSave } = setup()
    await userEvent.click(screen.getByRole('button', { name: '+ Field condition' }))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Condition 1 field' }), 'f4')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Condition 1 operator' }), 'min_count')
    await userEvent.type(screen.getByRole('spinbutton', { name: 'Condition 1 value' }), '2')
    await userEvent.click(screen.getByRole('button', { name: '+ Whole field set complete' }))
    expect(screen.getByRole('combobox', { name: 'Condition 2 field set' })).toHaveValue('s9')
    // A new column's first requirements start on Warn, with the switch turned on.
    await userEvent.click(screen.getByRole('switch', { name: 'Requirements on' }))
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save requirements' }))
    expect(onSave).toHaveBeenCalledWith(1, {
      entry_enforcement: 'warn',
      requirements: [{ field_uid: 'f4', operator: 'min_count', operand: '2' }, { field_set_uid: 's9', operator: 'set_complete' }],
    })
    expect(await screen.findByText('Entry requirements saved for Discovery.')).toBeInTheDocument()
  })

  it('disables checkbox fields with the reason, and shows the dimension helper', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: '+ Field condition' }))
    expect(screen.getByRole('option', { name: "Signed (checkbox fields can't be required yet)" })).toBeDisabled()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Condition 1 field' }), 'f5')
    expect(screen.getByRole('combobox', { name: 'Condition 1 operator' })).toHaveValue('satisfied')
    expect(screen.getByText('Not applicable in a lane counts as satisfied.')).toBeInTheDocument()
  })

  it('refuses an incomplete draft without a request, and shows the server error', async () => {
    const onSave = vi.fn().mockRejectedValue({ response: { data: { requirements: { 0: 'Unknown field on this board.' } } } })
    setup({ onSave })
    await userEvent.click(screen.getByRole('button', { name: '+ Field condition' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save requirements' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText('Choose a field for condition 1.')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Condition 1 field' }), 'f2')
    await userEvent.click(screen.getByRole('button', { name: 'Save requirements' }))
    expect(await screen.findByText('Condition 1: Unknown field on this board.')).toBeInTheDocument()
  })

  it('renders the shared Toggle with a visible label that flips it (#2717)', async () => {
    setup({ initialColumnId: 2 })
    const sw = screen.getByRole('switch', { name: 'Requirements on' })
    expect(sw).toHaveAttribute('aria-checked', 'true')
    // Shared Toggle structure: a text-free button whose track is a child span holding the knob span.
    // The old hand-rolled button carried the "Requirements on" text inside itself.
    expect(sw).toHaveTextContent('')
    expect(sw).toHaveClass('group/toggle')
    const track = sw.firstElementChild
    expect(track?.tagName).toBe('SPAN')
    expect(track?.firstElementChild?.tagName).toBe('SPAN')
    expect(screen.getByText('Requirements on', { selector: 'label' })).toHaveAttribute('for', sw.id)
    await userEvent.click(screen.getByText('Requirements on', { selector: 'label' }))
    expect(sw).toHaveAttribute('aria-checked', 'false')
  })

  it('turning requirements off keeps the rows and sends null, with no confirm', async () => {
    const { onSave } = setup({ initialColumnId: 2 })
    await userEvent.click(screen.getByRole('switch', { name: 'Requirements on' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save requirements' }))
    expect(onSave).toHaveBeenCalledWith(2, { entry_enforcement: null, requirements: [{ field_uid: 'f1', operator: 'gt', operand: '50000' }] })
  })

  it('caps at 10 conditions with aria-disabled add buttons', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ uid: `r${i}`, field_uid: 'f2', field_set_uid: null, operator: 'filled' as const, operand: null, position: i }))
    setup({ columns: [col(1, 'Full', { entry_enforcement: 'warn', entry_requirements: many })] })
    const add = screen.getByRole('button', { name: '+ Field condition' })
    expect(add).toHaveAttribute('aria-disabled', 'true')
    expect(add).toHaveAccessibleDescription('A column can have up to 10 requirements.')
    await userEvent.click(add)
    expect(screen.queryByRole('combobox', { name: 'Condition 11 field' })).not.toBeInTheDocument()
  })

  it('asks before discarding edits when switching columns, and Escape keeps the draft', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: '+ Field condition' }))
    await userEvent.click(screen.getByRole('radio', { name: /Entering Won/ }))
    expect(screen.getByText('Discard changes to “Discovery” and open “Won”?')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByText(/Discard changes/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: /Entering Won/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByText('Entering Won')).toBeInTheDocument()
  })

  it('moves focus to the new marker after Discard and back after Cancel, and drops a stale prompt (#1923)', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: '+ Field condition' }))
    await userEvent.click(screen.getByRole('radio', { name: /Entering Won/ }))
    await userEvent.click(within(screen.getByRole('group', { name: 'Discard' })).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('radio', { name: /Entering Discovery/ })).toHaveFocus()
    await userEvent.click(screen.getByRole('radio', { name: /Entering Won/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByRole('radio', { name: /Entering Won/ })).toHaveFocus()
    // A prompt left open clears once the draft is no longer dirty.
    await userEvent.click(screen.getByRole('button', { name: '+ Field condition' }))
    await userEvent.click(screen.getByRole('radio', { name: /Entering Discovery/ }))
    expect(screen.getByRole('group', { name: 'Discard' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove condition 1' }))
    expect(screen.queryByRole('group', { name: 'Discard' })).not.toBeInTheDocument()
  })

  it('explains why Requirements on with no conditions will save as off (#1923)', async () => {
    setup()
    await userEvent.click(screen.getByRole('switch', { name: 'Requirements on' }))
    expect(screen.getByText('Add at least one condition to turn requirements on.')).toBeInTheDocument()
  })

  it('shows an empty state and hides the field-condition button when the board has no fields (#1923)', () => {
    setup({ fields: [], sets: [] })
    expect(screen.getByText('Add card fields first (Board settings › Card fields).')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '+ Field condition' })).not.toBeInTheDocument()
  })

  it('links an unchosen-field error to the status line (#1923)', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: '+ Field condition' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save requirements' }))
    const select = screen.getByRole('combobox', { name: 'Condition 1 field' })
    expect(select).toHaveAttribute('aria-describedby', expect.stringMatching(/status/))
  })

  it('removes a condition and Cancel restores the saved rows', async () => {
    setup({ initialColumnId: 2 })
    await userEvent.click(screen.getByRole('button', { name: 'Remove condition 1' }))
    expect(screen.getByText('No conditions yet.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('spinbutton', { name: 'Condition 1 value' })).toHaveValue(50000)
  })

  it('non-admins read one sentence per column', () => {
    setup({ isAdmin: false })
    expect(screen.getByText(/\(Block\): Amount is more than 50000\./)).toBeInTheDocument()
    expect(screen.getByText('Only board admins can change entry requirements.')).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })

  it('says so on a board with no columns', () => {
    setup({ columns: [] })
    expect(screen.getByText('This board has no columns yet.')).toBeInTheDocument()
  })
})
