import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toggle, ToggleField } from '../components/Common/Toggle'

describe('Toggle', () => {
  it('renders with role=switch', () => {
    render(<Toggle checked={false} onChange={vi.fn()} aria-label="Test toggle" />)
    expect(screen.getByRole('switch', { name: 'Test toggle' })).toBeInTheDocument()
  })

  it('reflects unchecked state via aria-checked', () => {
    render(<Toggle checked={false} onChange={vi.fn()} aria-label="Test toggle" />)
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('reflects checked state via aria-checked', () => {
    render(<Toggle checked={true} onChange={vi.fn()} aria-label="Test toggle" />)
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })

  it('calls onChange with true when clicking unchecked toggle', async () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} aria-label="Test toggle" />)
    await userEvent.setup().click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('calls onChange with false when clicking checked toggle', async () => {
    const onChange = vi.fn()
    render(<Toggle checked={true} onChange={onChange} aria-label="Test toggle" />)
    await userEvent.setup().click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('does not call onChange when disabled', async () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} disabled aria-label="Test toggle" />)
    await userEvent.setup().click(screen.getByRole('switch'))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('ToggleField', () => {
  it('renders label text', () => {
    render(<ToggleField checked={false} onChange={vi.fn()} label="Single use" />)
    expect(screen.getByText('Single use')).toBeInTheDocument()
  })

  it('renders description when provided', () => {
    render(<ToggleField checked={false} onChange={vi.fn()} label="Single use" description="Link expires after one join." />)
    expect(screen.getByText('Link expires after one join.')).toBeInTheDocument()
  })

  it('toggle is associated with label via aria-labelledby', () => {
    render(<ToggleField checked={false} onChange={vi.fn()} label="Single use" />)
    const toggle = screen.getByRole('switch')
    const labelId = toggle.getAttribute('aria-labelledby')
    expect(labelId).toBeTruthy()
    expect(document.getElementById(labelId!)).toHaveTextContent('Single use')
  })

  it('calls onChange when clicked', async () => {
    const onChange = vi.fn()
    render(<ToggleField checked={false} onChange={onChange} label="Single use" />)
    await userEvent.setup().click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})
