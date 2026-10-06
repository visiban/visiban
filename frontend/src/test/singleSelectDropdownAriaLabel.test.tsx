import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import SingleSelectDropdown from '../components/Common/SingleSelectDropdown'

// #1444 — the optional ariaLabel prop names a trigger whose visible text is
// only the selected value; without it the trigger is unchanged.
const OPTIONS = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]

describe('SingleSelectDropdown ariaLabel', () => {
  it('names the trigger "<ariaLabel>: <selected>" when passed', () => {
    render(<SingleSelectDropdown label="Pick" ariaLabel="Letter" options={OPTIONS} selected="b" onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Letter: Beta' })).toBeInTheDocument()
  })

  it('uses the placeholder label when nothing is selected', () => {
    render(<SingleSelectDropdown label="Pick" ariaLabel="Letter" options={OPTIONS} selected={null} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Letter: Pick' })).toBeInTheDocument()
  })

  it('leaves existing callers unchanged: no aria-label, text is the name', () => {
    render(<SingleSelectDropdown label="Pick" options={OPTIONS} selected="a" onChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Alpha' })
    expect(trigger).not.toHaveAttribute('aria-label')
  })
})
