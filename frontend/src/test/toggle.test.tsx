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

describe('Toggle aria-describedby', () => {
  it('forwards aria-describedby to the switch', () => {
    // A disabled toggle has to be able to say why it is disabled (#356).
    render(
      <>
        <Toggle checked={false} onChange={vi.fn()} disabled aria-label="Email" aria-describedby="why" />
        <span id="why">Turn on the in-app notification above to enable email.</span>
      </>,
    )
    const toggle = screen.getByRole('switch')
    expect(toggle).toHaveAttribute('aria-describedby', 'why')
    expect(document.getElementById('why')).toHaveTextContent(
      'Turn on the in-app notification above to enable email.',
    )
  })

  it('omits the attribute when no description is given', () => {
    render(<Toggle checked={false} onChange={vi.fn()} aria-label="Plain" />)
    expect(screen.getByRole('switch')).not.toHaveAttribute('aria-describedby')
  })
})

describe('Toggle ariaDisabled', () => {
  it('stays in the tab order (unlike native disabled)', () => {
    render(<Toggle checked={false} onChange={vi.fn()} ariaDisabled aria-label="Email" />)
    const toggle = screen.getByRole('switch')
    expect(toggle).not.toBeDisabled()
    expect(toggle).not.toHaveAttribute('disabled')
    toggle.focus()
    expect(toggle).toHaveFocus()
  })

  it('renders aria-disabled="true"', () => {
    render(<Toggle checked={false} onChange={vi.fn()} ariaDisabled aria-label="Email" />)
    expect(screen.getByRole('switch')).toHaveAttribute('aria-disabled', 'true')
  })

  it('omits aria-disabled when not set', () => {
    render(<Toggle checked={false} onChange={vi.fn()} aria-label="Email" />)
    expect(screen.getByRole('switch')).not.toHaveAttribute('aria-disabled')
  })

  it('ignores click activation', async () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} ariaDisabled aria-label="Email" />)
    await userEvent.setup().click(screen.getByRole('switch'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('ignores keyboard activation (Enter and Space) while focused', async () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} ariaDisabled aria-label="Email" />)
    const user = userEvent.setup()
    const toggle = screen.getByRole('switch')
    toggle.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps native disabled behavior unchanged when ariaDisabled is not used', () => {
    render(<Toggle checked={false} onChange={vi.fn()} disabled aria-label="Email" />)
    const toggle = screen.getByRole('switch')
    expect(toggle).toBeDisabled()
    expect(toggle).not.toHaveAttribute('aria-disabled')
  })
})

describe('ToggleField ariaDisabled passthrough (#1179)', () => {
  it('forwards ariaDisabled and aria-describedby to the switch, which stays focusable', () => {
    render(
      <>
        <ToggleField checked={false} onChange={vi.fn()} label="Density" ariaDisabled aria-describedby="why" />
        <p id="why">This is a shared demo — settings can't be changed here.</p>
      </>,
    )
    const toggle = screen.getByRole('switch')
    expect(toggle).toHaveAttribute('aria-disabled', 'true')
    expect(toggle).not.toBeDisabled()
    expect(toggle).toHaveAccessibleDescription("This is a shared demo — settings can't be changed here.")
    toggle.focus()
    expect(toggle).toHaveFocus()
  })

  it('ignores clicks on the switch AND on the label text while ariaDisabled', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ToggleField checked={false} onChange={onChange} label="Density" ariaDisabled />)
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByText('Density'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('leaves existing consumers unchanged when the prop is omitted', async () => {
    const onChange = vi.fn()
    render(<ToggleField checked={false} onChange={onChange} label="Density" />)
    expect(screen.getByRole('switch')).not.toHaveAttribute('aria-disabled')
    await userEvent.setup().click(screen.getByText('Density'))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})

describe('ToggleField keyboard and label activation (#1376)', () => {
  it('Space and Enter on the switch toggle it', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ToggleField checked={false} onChange={onChange} label="Single use" />)
    screen.getByRole('switch').focus()
    await user.keyboard(' ')
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('clicking the label text toggles exactly once via the native label association', async () => {
    const onChange = vi.fn()
    render(<ToggleField checked={false} onChange={onChange} label="Single use" description="Expires after one join." />)
    await userEvent.setup().click(screen.getByText('Single use'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('clicking the label does nothing while ariaDisabled', async () => {
    const onChange = vi.fn()
    render(<ToggleField checked={false} onChange={onChange} label="Single use" ariaDisabled />)
    await userEvent.setup().click(screen.getByText('Single use'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
