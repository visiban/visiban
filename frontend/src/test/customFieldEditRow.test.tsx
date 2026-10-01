import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import CustomFieldEditRow from '../components/Card/CustomFieldEditRow'
import type { CustomFieldDefinition } from '../types'

// #1349 — CustomFieldEditRow has two conditional branches with no dedicated
// coverage: the `!isCheckbox &&` name-label suppression (checkbox's
// ToggleField renders the field name itself, so the row's own label would
// duplicate it) and `help_text` rendering. cardDetail.test.tsx (#1236) only
// exercises the dropdown → onSave wiring path through the full CardDetail
// tree; this file renders the row directly for every field type it supports.

function makeDefinition(overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id: 500,
    uid: 'cfduid00001',
    name: 'Status',
    field_type: 'text',
    choices: [],
    position: 0,
    show_on_card: false,
    is_required: false,
    help_text: '',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const noop = () => Promise.resolve()

describe('CustomFieldEditRow — name label suppression (#1349)', () => {
  it('does not render a separate name-label paragraph for a checkbox field', () => {
    const definition = makeDefinition({ field_type: 'checkbox', name: 'Is blocked' })
    render(<CustomFieldEditRow definition={definition} value="false" disabled={false} onSave={noop} />)
    // The row's own `<p>` label is suppressed; ToggleField renders the name instead.
    expect(screen.queryByText('Is blocked', { selector: 'p' })).not.toBeInTheDocument()
  })

  it('still exposes the field name as the checkbox switch\'s accessible name', () => {
    const definition = makeDefinition({ field_type: 'checkbox', name: 'Is blocked' })
    render(<CustomFieldEditRow definition={definition} value="false" disabled={false} onSave={noop} />)
    expect(screen.getByRole('switch', { name: 'Is blocked' })).toBeInTheDocument()
  })

  it.each<[CustomFieldDefinition['field_type'], Partial<CustomFieldDefinition>]>([
    ['text', {}],
    ['number', {}],
    ['date', {}],
    ['dropdown', { choices: ['Red', 'Green'] }],
  ])('renders the name-label paragraph for a %s field', (fieldType, extra) => {
    const definition = makeDefinition({ field_type: fieldType, name: 'Status', ...extra })
    render(<CustomFieldEditRow definition={definition} value={undefined} disabled={false} onSave={noop} />)
    const label = screen.getByText('Status', { selector: 'p' })
    expect(label).toBeInTheDocument()
  })
})

describe('CustomFieldEditRow — help_text rendering (#1349)', () => {
  it('renders help_text when present on a non-checkbox field', () => {
    const definition = makeDefinition({ field_type: 'text', help_text: 'Shown on the card front.' })
    render(<CustomFieldEditRow definition={definition} value={undefined} disabled={false} onSave={noop} />)
    expect(screen.getByText('Shown on the card front.')).toBeInTheDocument()
  })

  it('does not render a help_text paragraph when help_text is empty', () => {
    const definition = makeDefinition({ field_type: 'text', help_text: '' })
    const { container } = render(<CustomFieldEditRow definition={definition} value={undefined} disabled={false} onSave={noop} />)
    // The only other <p> in the row is AutosaveIndicator's status paragraph
    // (`aria-live="polite"`) — excluding it isolates the name-label and
    // help_text paragraphs. Only the name label should remain.
    const nonStatusParagraphs = container.querySelectorAll('p:not([aria-live])')
    expect(nonStatusParagraphs).toHaveLength(1)
    expect(nonStatusParagraphs[0].textContent).toBe('Status')
  })

  it('does not render help_text for a checkbox field even when help_text is set', () => {
    // ToggleField renders help_text as its own `description` prop instead
    // (see CustomFieldValueInput's checkbox case); the row must not also
    // render it in its own `!isCheckbox &&` paragraph.
    const definition = makeDefinition({ field_type: 'checkbox', name: 'Is blocked', help_text: 'Blocks downstream work.' })
    render(<CustomFieldEditRow definition={definition} value="false" disabled={false} onSave={noop} />)
    expect(screen.getAllByText('Blocks downstream work.')).toHaveLength(1)
  })
})
