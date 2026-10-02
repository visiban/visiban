import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

describe('CustomFieldEditRow — url (#1390)', () => {
  it('renders the full URL as a safe link when read-only', () => {
    const definition = makeDefinition({ field_type: 'url', name: 'Runbook' })
    render(<CustomFieldEditRow definition={definition} value="https://wiki.example.com/raid" disabled onSave={noop} />)
    const link = screen.getByRole('link', { name: 'Open https://wiki.example.com/raid in new tab' })
    expect(link).toHaveAttribute('href', 'https://wiki.example.com/raid')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveTextContent('https://wiki.example.com/raid')
  })

  it('renders a legacy javascript: value as plain text with no link', () => {
    const definition = makeDefinition({ field_type: 'url', name: 'Runbook' })
    render(<CustomFieldEditRow definition={definition} value="javascript:alert(1)" disabled onSave={noop} />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument()
  })

  it('shows an em dash for an empty read-only value', () => {
    const definition = makeDefinition({ field_type: 'url', name: 'Runbook' })
    render(<CustomFieldEditRow definition={definition} value="" disabled onSave={noop} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('shows the input plus an Open link line when editable', () => {
    const definition = makeDefinition({ field_type: 'url', name: 'Runbook' })
    render(<CustomFieldEditRow definition={definition} value="https://wiki.example.com" disabled={false} onSave={noop} />)
    expect(screen.getByRole('textbox', { name: 'Runbook' })).toHaveValue('https://wiki.example.com')
    expect(screen.getByRole('link', { name: 'Open link in new tab' })).toHaveTextContent('Open link ↗')
  })

  it('maps a server 400 into the inline error slot', async () => {
    const definition = makeDefinition({ field_type: 'url', name: 'Runbook' })
    const onSave = vi.fn().mockRejectedValue({
      response: { status: 400, data: { custom_field_values: ["'Runbook': Only http and https URLs are allowed."] } },
    })
    render(<CustomFieldEditRow definition={definition} value={undefined} disabled={false} onSave={onSave} />)
    const input = screen.getByRole('textbox', { name: 'Runbook' })
    fireEvent.change(input, { target: { value: 'https://example.com' } })
    fireEvent.blur(input)
    expect(onSave).toHaveBeenCalledWith('https://example.com')
    expect(await screen.findByText('Enter a web address starting with http:// or https://')).toBeInTheDocument()
  })
})
