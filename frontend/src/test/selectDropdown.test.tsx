import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SelectDropdown from '../components/Common/SelectDropdown'

const options = [
  { value: 'a', label: 'Option A' },
  { value: 'b', label: 'Option B' },
]

describe('SelectDropdown', () => {
  beforeEach(() => {
    // no mocks needed — component is self-contained
  })

  it('renders without crashing', () => {
    render(<SelectDropdown value="a" onChange={() => undefined} options={options} />)
    expect(screen.getByRole('button', { name: /Option A/ })).toBeInTheDocument()
  })

  it('opens the menu when the trigger is clicked', async () => {
    render(<SelectDropdown value="a" onChange={() => undefined} options={options} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /Option A/ }))
    expect(screen.getByText('Option B')).toBeInTheDocument()
  })

  it('calls onChange with the selected value and closes the menu', async () => {
    const onChange = vi.fn()
    render(<SelectDropdown value="a" onChange={onChange} options={options} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /Option A/ }))
    await userEvent.setup().click(screen.getByText('Option B'))
    expect(onChange).toHaveBeenCalledWith('b')
    expect(screen.queryByText('Option B')).not.toBeInTheDocument()
  })

  describe('disabled + disabledReason', () => {
    it('applies title and aria-label from disabledReason when disabled', () => {
      render(
        <SelectDropdown
          value="a"
          onChange={() => undefined}
          options={options}
          disabled={true}
          disabledReason="Test reason"
        />
      )
      const trigger = screen.getByRole('button')
      expect(trigger).toBeDisabled()
      expect(trigger).toHaveAttribute('title', 'Test reason')
      expect(trigger).toHaveAttribute('aria-label', 'Test reason')
    })

    it('does not set title or aria-label when disabled with no disabledReason', () => {
      render(
        <SelectDropdown
          value="a"
          onChange={() => undefined}
          options={options}
          disabled={true}
        />
      )
      const trigger = screen.getByRole('button')
      expect(trigger).toBeDisabled()
      expect(trigger).not.toHaveAttribute('title')
      expect(trigger).not.toHaveAttribute('aria-label')
    })

    it('does not set title or aria-label when enabled even if disabledReason is provided', () => {
      render(
        <SelectDropdown
          value="a"
          onChange={() => undefined}
          options={options}
          disabled={false}
          disabledReason="Should not appear"
        />
      )
      const trigger = screen.getByRole('button')
      expect(trigger).not.toBeDisabled()
      expect(trigger).not.toHaveAttribute('title')
      expect(trigger).not.toHaveAttribute('aria-label')
    })

    it('does not open the menu when disabled and clicked', async () => {
      render(
        <SelectDropdown
          value="a"
          onChange={() => undefined}
          options={options}
          disabled={true}
          disabledReason="Not allowed"
        />
      )
      await userEvent.setup().click(screen.getByRole('button'))
      // Menu should not appear — Option B is only in the dropdown panel
      expect(screen.queryByText('Option B')).not.toBeInTheDocument()
    })
  })
})
