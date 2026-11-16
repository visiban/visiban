import { describe, it, expect, vi } from 'vitest'
import { buildFilterChips, makeLaneValueFormatter } from '../components/Board/filterChips'
import { EMPTY_FILTER } from '../components/Board/FilterBar'
import type { BoardFull } from '../types'

const jane = { id: 1, username: 'jdoe', email: '', first_name: 'Jane', last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe' }
const stray = { id: 2, username: 'sam', email: '', first_name: 'Sam', last_name: 'Lee', avatar_url: '', display_name: 'Sam Lee' }

const board = {
  members: [{ id: 1, user: jane, role: 'admin' }],
  cards: [{ assignee: stray }, { assignee: null }],
  labels: [{ id: 100, name: 'Bug', color: '#EF4444' }],
  custom_field_definitions: [
    { id: 7, name: 'Region', field_type: 'dropdown', choices: ['EMEA'], position: 0 },
    { id: 8, name: 'Notes', field_type: 'text', choices: [], position: 1 },
    { id: 9, name: 'Budget', field_type: 'number', choices: [], position: 2 },
  ],
} as unknown as BoardFull

describe('buildFilterChips (#2315)', () => {
  it('builds one chip per active value and each dismiss clears only its value', () => {
    const onChange = vi.fn()
    const filters = {
      ...EMPTY_FILTER,
      assigneeIds: [-1, 1, 2, 99],
      labelIds: [100, 404],
      priorities: ['high' as const],
      dueDate: 'overdue' as const,
      blockedOnly: true,
      customFields: {
        7: { kind: 'choice' as const, values: ['EMEA'] },
        8: { kind: 'text' as const, query: 'x' },
        9: { kind: 'number' as const, equals: '5' },
      },
    }
    const chips = buildFilterChips(board, filters, onChange, 'MM/DD/YYYY')
    expect(chips.map((c) => c.label)).toEqual([
      'Unassigned', 'Jane Doe', 'Sam Lee', 'Bug', 'High', 'Overdue', 'Blocked only', 'Region: EMEA', 'Notes: x', 'Budget: 5',
    ])
    chips.forEach((c) => c.onDismiss())
    const calls = onChange.mock.calls.map((c) => c[0])
    expect(calls[0].assigneeIds).toEqual([1, 2, 99])
    expect(calls[3].labelIds).toEqual([404])
    expect(calls[4].priorities).toEqual([])
    expect(calls[5].dueDate).toBeNull()
    expect(calls[6].blockedOnly).toBe(false)
    expect(calls[7].customFields[7]).toEqual({ kind: 'choice', values: [] })
  })

  it('makes no chips for an empty filter', () => {
    expect(buildFilterChips(board, EMPTY_FILTER, vi.fn(), 'MM/DD/YYYY')).toEqual([])
  })
})

describe('makeLaneValueFormatter', () => {
  const defs = [{ id: 3, name: 'Deal', field_type: 'number', choices: [], help_text: '' }] as never
  const field = { id: 3 } as never
  it('groups thousands for a plain number and passes unknown fields through', () => {
    const fmt = makeLaneValueFormatter(defs, 'MM/DD/YYYY')
    expect(fmt(field, '50000')).toBe('50,000')
    expect(fmt({ id: 4 } as never, 'raw')).toBe('raw')
    expect(makeLaneValueFormatter(undefined, 'MM/DD/YYYY')(field, 'a')).toBe('a')
  })
})

describe('buildFilterChips — number operators (#2357)', () => {
  const chipFor = (cf: Record<string, unknown>) =>
    buildFilterChips(board, { ...EMPTY_FILTER, customFields: { 9: { kind: 'number', ...cf } as never } }, vi.fn(), 'MM/DD/YYYY').map((c) => c.label)

  it('shows the operator in the chip, one chip per field', () => {
    expect(chipFor({ equals: '', op: 'between', min: '3', max: '8' })).toEqual(['Budget: 3–8'])
    expect(chipFor({ equals: '', op: 'between', min: '13', max: '' })).toEqual(['Budget: ≥ 13'])
    expect(chipFor({ equals: '', op: 'between', min: '', max: '2' })).toEqual(['Budget: ≤ 2'])
    expect(chipFor({ equals: '', op: 'empty' })).toEqual(['Budget: empty'])
    expect(chipFor({ equals: '', op: 'not_empty' })).toEqual(['Budget: has a value'])
    expect(chipFor({ equals: '', op: 'between', min: '8', max: '3' })).toEqual(['Budget: 8–3'])
  })

  it('keeps the legacy equals chip text and drops an inactive range', () => {
    expect(chipFor({ equals: '5' })).toEqual(['Budget: 5'])
    expect(chipFor({ equals: '5', op: 'eq' })).toEqual(['Budget: 5'])
    expect(chipFor({ equals: '', op: 'between', min: '', max: '' })).toEqual([])
  })

  it('dismissing a range chip resets the field to an empty equals entry', () => {
    const onChange = vi.fn()
    const [chip] = buildFilterChips(board, { ...EMPTY_FILTER, customFields: { 9: { kind: 'number', equals: '', op: 'between', min: '3', max: '8' } } }, onChange, 'MM/DD/YYYY')
    chip.onDismiss()
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTER, customFields: { 9: { kind: 'number', equals: '' } } })
  })
})
