import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import NumberFormatFields from '../components/Board/NumberFormatFields'
import { EMPTY_NUMBER_FORMAT, type NumberFormatDraft } from '../utils/customFieldValue'

function setup(draft: Partial<NumberFormatDraft> = {}) {
  const onChange = vi.fn()
  const full = { ...EMPTY_NUMBER_FORMAT, ...draft }
  render(<NumberFormatFields draft={full} onChange={onChange} />)
  return { onChange, full }
}

describe('NumberFormatFields (#1391)', () => {
  it('shows a preview of the sample value, formatted by the draft', () => {
    setup({ number_prefix: '$', number_suffix: 'k', number_decimals: '2' })
    expect(screen.getByText(/^Preview:/).textContent).toBe('Preview: $1,234.50k')
  })

  it('keeps the value as typed when decimals is empty', () => {
    setup()
    expect(screen.getByText(/^Preview:/).textContent).toBe('Preview: 1234.5')
  })

  it.each([
    ['Prefix', 'number_prefix', '€'],
    ['Suffix', 'number_suffix', 'h'],
    ['Decimals', 'number_decimals', '3'],
  ])('reports a %s edit with the rest of the draft preserved', (label, key, value) => {
    const { onChange, full } = setup({ number_prefix: 'x' })
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
    expect(onChange).toHaveBeenCalledWith({ ...full, [key]: value })
  })

  it('flags an out-of-range decimals value and replaces the preview with the error', () => {
    setup({ number_decimals: '11' })
    const input = screen.getByLabelText('Decimals')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter 0 to 10.')
    expect(screen.queryByText(/^Preview:/)).toBeNull()
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').parentElement?.id)
  })

  it('does not flag a valid value', () => {
    setup({ number_decimals: '10' })
    expect(screen.getByLabelText('Decimals')).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
