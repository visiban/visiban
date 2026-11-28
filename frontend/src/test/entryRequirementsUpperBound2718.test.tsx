import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { AxiosError, AxiosHeaders } from 'axios'
import { ToastProvider } from '../contexts/ToastContext'
import BoardSettingsEntryRequirementsSection from '../components/Board/BoardSettingsEntryRequirementsSection'
import MoveBlockedToast from '../components/Board/MoveBlockedToast'
import EntryWarnToast from '../components/Board/EntryWarnToast'
import { NO_OVERRIDE } from '../utils/forceOverride'
import type { MoveBlockedError } from '../hooks/useBoard'
import type { Column, CustomFieldDefinition, EntryUnmetItem } from '../types'
import {
  NEEDS_OPERAND, NUMBER_COMPARISONS, OPERATOR_LABEL, formatComparisonOperand, operatorsFor, toWrite, validateDraft,
} from '../utils/entryRequirementsEditor'
import { entryNeedsLine, limitBlockedMessage, toastBody, unmetRequirementLabel } from '../components/Board/moveBlockedMessages'

// #2718: "is less than" / "is at most", and bounds shown in the field's number format.

const field = (id: number, name: string, field_type: CustomFieldDefinition['field_type'], over: Partial<CustomFieldDefinition> = {}) =>
  ({ id, uid: `f${id}`, name, field_type, choices: [], number_prefix: '', number_suffix: '', number_decimals: null, ...over }) as CustomFieldDefinition
const winProb = field(1, 'Win probability', 'number', { number_suffix: '%' })
const amount = field(2, 'Amount', 'number', { number_prefix: '$' })
const plain = field(3, 'Score', 'number')
const tags = field(4, 'Tags', 'multi_select')
const fields = [winProb, amount, plain, tags]

const item = (over: Partial<EntryUnmetItem>): EntryUnmetItem => ({
  requirement_uid: 'r1', operator: 'lte', operand: '20',
  field_uid: 'f1', field_name: 'Win probability', field_set_uid: null, field_set_name: null, ...over,
})

const col = (id: number, name: string, over: Partial<Column> = {}): Column => ({
  id, uid: `c${id}`, name, position: id, color: '#3B82F6', wip_limit: null, weight_limit: null,
  allow_card_creation: true, is_done: false, policy: null, entry_enforcement: null, entry_requirements: [], ...over,
})
const qualified = col(2, 'Qualified', {
  entry_enforcement: 'warn',
  entry_requirements: [{ uid: 'r1', field_uid: 'f1', field_set_uid: null, operator: 'lte', operand: '20', position: 0 }],
})

function setup(over: Partial<Parameters<typeof BoardSettingsEntryRequirementsSection>[0]> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined)
  render(<BoardSettingsEntryRequirementsSection columns={[col(1, 'Lead'), qualified]} fields={fields} sets={[]} swimlanes={[]} isAdmin onSave={onSave} {...over} />)
  return { onSave }
}

describe('upper-bound operators (#2718)', () => {
  it('number fields offer four comparisons, labeled in US English', () => {
    expect(operatorsFor(winProb)).toEqual(['filled', 'gt', 'gte', 'lt', 'lte'])
    expect(operatorsFor(tags)).not.toContain('lt')
    expect(OPERATOR_LABEL.lt).toBe('is less than')
    expect(OPERATOR_LABEL.lte).toBe('is at most')
    expect([...NUMBER_COMPARISONS]).toEqual(['gt', 'gte', 'lt', 'lte'])
    expect(NEEDS_OPERAND.has('lt') && NEEDS_OPERAND.has('lte')).toBe(true)
  })

  it('sends and validates the operand for lt and lte', () => {
    const rows = [{ key: 0, kind: 'field' as const, uid: 'f1', operator: 'lte' as const, operand: ' 20 ' }]
    expect(toWrite({ on: true, mode: 'block', rows }).requirements).toEqual([{ field_uid: 'f1', operator: 'lte', operand: '20' }])
    expect(validateDraft({ on: true, mode: 'block', rows: [{ ...rows[0], operator: 'lt', operand: '' }] })?.message).toBe('Enter a number for condition 1.')
  })
})

describe('formatComparisonOperand', () => {
  it('uses the field format, else a plain grouped number', () => {
    expect(formatComparisonOperand('20', winProb)).toBe('20%')
    expect(formatComparisonOperand('50000', amount)).toBe('$50,000')
    // The bound is exact: the field's decimals never round it (19.5 is not "20%").
    expect(formatComparisonOperand('2.5', field(5, 'Hours', 'number', { number_decimals: 2 }))).toBe('2.5')
    const pct0 = field(6, 'Win', 'number', { number_suffix: '%', number_decimals: 0 })
    expect(formatComparisonOperand('19.5', pct0)).toBe('19.5%')
    expect(unmetRequirementLabel(item({ operand: '19.5', field_uid: 'f6' }), [pct0])).toBe('Win probability at most 19.5%')
    expect(formatComparisonOperand('0.12345', plain)).toBe('0.123')
    expect(formatComparisonOperand('50000', plain)).toBe('50,000')
    expect(formatComparisonOperand('50000', undefined)).toBe('50,000')
    expect(formatComparisonOperand('50000', tags)).toBe('50,000')
    expect(formatComparisonOperand('abc', null)).toBe('abc')
    expect(formatComparisonOperand(null, winProb)).toBe('')
  })
})

describe('unmet labels with upper bounds', () => {
  it('labels lt and lte, formatted when the board fields are passed', () => {
    expect(unmetRequirementLabel(item({}))).toBe('Win probability at most 20')
    expect(unmetRequirementLabel(item({}), fields)).toBe('Win probability at most 20%')
    expect(unmetRequirementLabel(item({ operator: 'lt' }), fields)).toBe('Win probability less than 20%')
    expect(unmetRequirementLabel(item({ operator: 'gt', operand: '50000', field_uid: 'f2', field_name: 'Amount' }), fields)).toBe('Amount more than $50,000')
    expect(unmetRequirementLabel(item({ operator: 'gte', operand: '50000', field_uid: 'f2', field_name: 'Amount' }), fields)).toBe('Amount at least $50,000')
    // An unknown field uid falls back to the plain number.
    expect(unmetRequirementLabel(item({ field_uid: 'gone' }), fields)).toBe('Win probability at most 20')
    // min_count is a count of choices: never the field format.
    expect(unmetRequirementLabel(item({ operator: 'min_count', operand: '2', field_uid: 'f1', field_name: 'Tags' }), fields)).toBe('Tags with at least 2 choices')
  })

  it('threads the fields through the Needs line, the toast body and the inline message', () => {
    const refusal: MoveBlockedError = {
      code: 'entry_requirements_unmet', detail: 'x', mode: 'block', column_name: 'Qualified',
      unmet: [item({})], also: [],
    } as MoveBlockedError
    expect(entryNeedsLine([item({})], fields)).toBe('Needs: Win probability at most 20%.')
    expect(toastBody(refusal, fields)).toBe('Needs: Win probability at most 20%.')
    const err = new AxiosError('conflict', '409', undefined, undefined, {
      status: 409, statusText: 'Conflict', headers: {}, config: { headers: new AxiosHeaders() }, data: refusal,
    })
    expect(limitBlockedMessage(err, fields)).toBe("Can't move to Qualified: Needs: Win probability at most 20%.")
    expect(limitBlockedMessage(err)).toBe("Can't move to Qualified: Needs: Win probability at most 20.")
  })
})

const wrap = (ui: ReactNode) => <ToastProvider>{ui}</ToastProvider>

describe('toasts format the bound with the board fields', () => {
  it('MoveBlockedToast', () => {
    const refusal = {
      code: 'entry_requirements_unmet', detail: 'x', mode: 'block', column_name: 'Qualified', unmet: [item({})], also: [],
    } as MoveBlockedError
    render(wrap(<MoveBlockedToast error={refusal} eligibility={NO_OVERRIDE} onForce={vi.fn()} onDismiss={vi.fn()} fields={fields} />))
    expect(within(screen.getByTestId('move-blocked-toast')).getByText(/Needs: Win probability at most 20%\./)).toBeInTheDocument()
  })

  it('EntryWarnToast', async () => {
    render(wrap(<EntryWarnToast warning={{ cardId: 9, columnName: 'Qualified', unmet: [item({ operator: 'lt' })], seq: 1 }} onDismiss={vi.fn()} fields={fields} />))
    const t = within(await screen.findByTestId('entry-warn-toast'))
    expect(t.getByText(/Needs: Win probability less than 20%\./)).toBeInTheDocument()
  })
})

describe('editor operand box (#2718)', () => {
  it('lists the four comparisons and shows the suffix beside a still-named value box', () => {
    setup({ initialColumnId: 2 })
    const operator = screen.getByRole('combobox', { name: 'Condition 1 operator' })
    expect(within(operator).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'is filled', 'is more than', 'is at least', 'is less than', 'is at most',
    ])
    const box = screen.getByRole('spinbutton', { name: 'Condition 1 value' })
    expect(box).toHaveValue(20)
    expect(screen.getByTestId('entry-operand-suffix')).toHaveTextContent('%')
    expect(screen.queryByTestId('entry-operand-prefix')).not.toBeInTheDocument()
    expect(box).toHaveAccessibleDescription('%')
  })

  it('shows a prefix for a money field and nothing for a plain one, and none for min_count', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: '+ Field condition' }))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Condition 1 field' }), 'f2')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Condition 1 operator' }), 'lt')
    expect(screen.getByTestId('entry-operand-prefix')).toHaveTextContent('$')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Condition 1 field' }), 'f3')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Condition 1 operator' }), 'lte')
    expect(screen.getByRole('spinbutton', { name: 'Condition 1 value' })).not.toHaveAccessibleDescription()
    expect(screen.queryByTestId('entry-operand-prefix')).not.toBeInTheDocument()
    expect(screen.queryByTestId('entry-operand-suffix')).not.toBeInTheDocument()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Condition 1 field' }), 'f4')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Condition 1 operator' }), 'min_count')
    expect(screen.queryByTestId('entry-operand-suffix')).not.toBeInTheDocument()
  })

  it('non-admins read the bound in the field format', () => {
    setup({ isAdmin: false })
    expect(screen.getByText(/\(Warn\): Win probability is at most 20%\./)).toBeInTheDocument()
  })

  it('shows the exact bound, not one rounded to the field decimals', () => {
    const pct0 = field(1, 'Win probability', 'number', { number_suffix: '%', number_decimals: 0 })
    const rounded = col(2, 'Qualified', {
      entry_enforcement: 'warn',
      entry_requirements: [{ uid: 'r1', field_uid: 'f1', field_set_uid: null, operator: 'lte', operand: '19.5', position: 0 }],
    })
    setup({ isAdmin: false, fields: [pct0], columns: [col(1, 'Lead'), rounded] })
    expect(screen.getByText(/\(Warn\): Win probability is at most 19\.5%\./)).toBeInTheDocument()
  })
})
