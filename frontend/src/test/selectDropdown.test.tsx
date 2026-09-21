import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRef } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SelectDropdown from '../components/Common/SelectDropdown'
import SingleSelectDropdown from '../components/Common/SingleSelectDropdown'
import CheckboxDropdown from '../components/Common/CheckboxDropdown'

const options = [
  { value: 'a', label: 'Option A' },
  { value: 'b', label: 'Option B' },
  { value: 'c', label: 'Option C' },
]

describe('SelectDropdown', () => {
  beforeEach(() => {
    // no mocks needed — component is self-contained
  })

  it('renders without crashing', () => {
    render(<SelectDropdown value="a" onChange={() => undefined} options={options} />)
    expect(screen.getByRole('combobox')).toBeInTheDocument()
    expect(screen.getByText('Option A')).toBeInTheDocument()
  })

  it('has correct ARIA attributes when closed', () => {
    render(<SelectDropdown value="a" onChange={() => undefined} options={options} />)
    const trigger = screen.getByRole('combobox')
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('sets aria-expanded to true when open', async () => {
    render(<SelectDropdown value="a" onChange={() => undefined} options={options} />)
    await userEvent.setup().click(screen.getByRole('combobox'))
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true')
  })

  it('opens the menu when the trigger is clicked', async () => {
    render(<SelectDropdown value="a" onChange={() => undefined} options={options} />)
    await userEvent.setup().click(screen.getByRole('combobox'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.getAllByRole('option').length).toBe(3)
  })

  it('closes the menu when the trigger is clicked again', async () => {
    const user = userEvent.setup()
    render(<SelectDropdown value="a" onChange={() => undefined} options={options} />)
    await user.click(screen.getByRole('combobox'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.click(screen.getByRole('combobox'))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('marks the current value option as aria-selected=true', async () => {
    render(<SelectDropdown value="b" onChange={() => undefined} options={options} />)
    await userEvent.setup().click(screen.getByRole('combobox'))
    const selected = screen.getAllByRole('option').find(
      (opt) => opt.getAttribute('aria-selected') === 'true',
    )
    expect(selected).toBeDefined()
    expect(selected?.textContent).toBe('Option B')
  })

  it('calls onChange with the selected value and closes the menu', async () => {
    const onChange = vi.fn()
    render(<SelectDropdown value="a" onChange={onChange} options={options} />)
    await userEvent.setup().click(screen.getByRole('combobox'))
    await userEvent.setup().click(screen.getByRole('option', { name: 'Option B' }))
    expect(onChange).toHaveBeenCalledWith('b')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('opens with ArrowDown and selects with Enter', async () => {
    const onChange = vi.fn()
    render(<SelectDropdown value="a" onChange={onChange} options={options} />)
    const trigger = screen.getByRole('combobox')
    trigger.focus()
    // ArrowDown opens the dropdown
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    // ArrowDown again moves to next option
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    // Enter selects the active option
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('b')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('opens with Space and navigates with arrow keys', () => {
    const onChange = vi.fn()
    render(<SelectDropdown value="a" onChange={onChange} options={options} />)
    const trigger = screen.getByRole('combobox')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: ' ' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    // ArrowDown → next option; ArrowUp → back to first
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('a')
  })

  it('ArrowUp at the first option stays on the first option (no wrap)', () => {
    const onChange = vi.fn()
    render(<SelectDropdown value="a" onChange={onChange} options={options} />)
    const trigger = screen.getByRole('combobox')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // open; activeIndex = 0 (current value is 'a')
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })   // attempt to go above first — clamps at 0
    fireEvent.keyDown(trigger, { key: 'Enter' })
    // Should select the first option ('a') — no wrap
    expect(onChange).toHaveBeenCalledWith('a')
  })

  it('highlights the active option', () => {
    render(<SelectDropdown value="a" onChange={() => undefined} options={options} />)
    const trigger = screen.getByRole('combobox')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    // After opening + ArrowDown, activeIndex = 1 (Option B)
    const opts = screen.getAllByRole('option')
    expect(opts[1].className).toContain('bg-surface-hover')
  })

  it('closes with Escape key', () => {
    render(<SelectDropdown value="a" onChange={() => undefined} options={options} />)
    const trigger = screen.getByRole('combobox')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  describe('size variants', () => {
    it('renders with default sm size', () => {
      render(<SelectDropdown value="a" onChange={() => undefined} options={options} size="sm" />)
      const trigger = screen.getByRole('combobox')
      // sm variant uses px-2.5 py-1.5
      expect(trigger.className).toMatch(/px-2\.5/)
    })

    it('renders with xs size', () => {
      render(<SelectDropdown value="a" onChange={() => undefined} options={options} size="xs" />)
      const trigger = screen.getByRole('combobox')
      // xs variant uses px-2 (without the .5)
      expect(trigger.className).toMatch(/px-2\b/)
    })
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
      const trigger = screen.getByRole('combobox')
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
      const trigger = screen.getByRole('combobox')
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
      const trigger = screen.getByRole('combobox')
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
      await userEvent.setup().click(screen.getByRole('combobox'))
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    it('does not respond to keyboard when disabled', () => {
      render(
        <SelectDropdown
          value="a"
          onChange={() => undefined}
          options={options}
          disabled={true}
        />
      )
      const trigger = screen.getByRole('combobox')
      trigger.focus()
      fireEvent.keyDown(trigger, { key: 'ArrowDown' })
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })
  })
})

describe('SingleSelectDropdown', () => {
  it('renders without crashing', () => {
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={() => undefined} />
    )
    expect(screen.getByRole('button', { name: /Filter/ })).toBeInTheDocument()
  })

  it('shows the label when nothing is selected', () => {
    render(
      <SingleSelectDropdown label="Priority" options={options} selected={null} onChange={() => undefined} />
    )
    expect(screen.getByRole('button').textContent).toMatch(/Priority/)
  })

  it('shows the selected option label when one is selected', () => {
    render(
      <SingleSelectDropdown label="Priority" options={options} selected="b" onChange={() => undefined} />
    )
    expect(screen.getByRole('button').textContent).toMatch(/Option B/)
  })

  it('has aria-haspopup="menu" and aria-expanded="false" when closed', () => {
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={() => undefined} />
    )
    const trigger = screen.getByRole('button')
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('sets aria-expanded to true when open', async () => {
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={() => undefined} />
    )
    await userEvent.setup().click(screen.getByRole('button'))
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  })

  it('opens menu on click and shows all options as menuitems', async () => {
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={() => undefined} />
    )
    await userEvent.setup().click(screen.getByRole('button'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem').length).toBe(3)
  })

  it('closes menu when clicking the trigger a second time', async () => {
    const user = userEvent.setup()
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={() => undefined} />
    )
    await user.click(screen.getByRole('button'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.click(screen.getByRole('button'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('calls onChange with the selected value when a menuitem is clicked', async () => {
    const onChange = vi.fn()
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={onChange} />
    )
    await userEvent.setup().click(screen.getByRole('button'))
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Option B' }))
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('calls onChange with null when the already-selected option is clicked (deselect)', async () => {
    const onChange = vi.fn()
    render(
      <SingleSelectDropdown label="Filter" options={options} selected="b" onChange={onChange} />
    )
    await userEvent.setup().click(screen.getByRole('button'))
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Option B' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('opens with ArrowDown and navigates between items', () => {
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={() => undefined} />
    )
    const trigger = screen.getByRole('button')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('opens with Enter key', () => {
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={() => undefined} />
    )
    const trigger = screen.getByRole('button')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('closes with Escape key', () => {
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={() => undefined} />
    )
    const trigger = screen.getByRole('button')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    // Escape is handled via useDropdownEscape — fire on document
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
// #964 — CheckboxDropdown had no dedicated unit tests before this change; it
// was only ever exercised indirectly through FilterBar/CustomFieldFilterControl.
// This suite covers the new onOpenChange/badge/hideSelectionSummary props (and
// the forwardRef) directly, at the component level, independent of FilterBar's
// own facet-collapse wiring (which has its own coverage in filterBar.test.tsx).
describe('CheckboxDropdown', () => {
  const cbOptions = [
    { value: 'a', label: 'Option A' },
    { value: 'b', label: 'Option B' },
  ]

  it('renders without crashing', () => {
    render(<CheckboxDropdown label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument()
  })

  it('shows a badge with the count and a folded-in aria-label when badge is truthy', () => {
    render(<CheckboxDropdown label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} badge={3} />)
    const trigger = screen.getByRole('button')
    expect(trigger).toHaveTextContent('3')
    expect(trigger).toHaveAttribute('aria-label', 'Filter, 3 active')
  })

  it('suppresses the badge and aria-label when badge is 0', () => {
    render(<CheckboxDropdown label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} badge={0} />)
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-label')
  })

  it('suppresses the badge and aria-label when badge is undefined', () => {
    render(<CheckboxDropdown label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} />)
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-label')
  })

  it('badge count reflects the passed prop regardless of open/closed state', async () => {
    render(<CheckboxDropdown label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} badge={2} />)
    const trigger = screen.getByRole('button')
    expect(trigger).toHaveTextContent('2')
    await userEvent.setup().click(trigger)
    expect(trigger).toHaveTextContent('2')
  })

  it('hideSelectionSummary keeps the visible and accessible label pinned to the static label even with selections', () => {
    render(
      <CheckboxDropdown label="+ Filter" options={cbOptions} selected={['a', 'b']} onChange={() => undefined} hideSelectionSummary />
    )
    const trigger = screen.getByRole('button', { name: '+ Filter' })
    expect(trigger).toHaveTextContent('+ Filter')
    expect(trigger.textContent).not.toContain('Option A')
  })

  it('without hideSelectionSummary, the trigger label reflects the normal selection summary', () => {
    render(<CheckboxDropdown label="Filter" options={cbOptions} selected={['a']} onChange={() => undefined} />)
    expect(screen.getByRole('button').textContent).toMatch(/Filter: Option A/)
  })

  it('calls onOpenChange(true) then onOpenChange(false) across a click-toggle open/close cycle', async () => {
    const onOpenChange = vi.fn()
    render(
      <CheckboxDropdown label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} onOpenChange={onOpenChange} />
    )
    const user = userEvent.setup()
    const trigger = screen.getByRole('button')
    await user.click(trigger)
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    await user.click(trigger)
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('calls onOpenChange(false) on outside click', async () => {
    const onOpenChange = vi.fn()
    render(
      <div>
        <button>Outside</button>
        <CheckboxDropdown label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} onOpenChange={onOpenChange} />
      </div>
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Filter' }))
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    await user.click(screen.getByText('Outside'))
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('calls onOpenChange(false) on Escape', async () => {
    const onOpenChange = vi.fn()
    render(
      <CheckboxDropdown label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} onOpenChange={onOpenChange} />
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button'))
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('forwards a ref to the trigger button element', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<CheckboxDropdown ref={ref} label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} />)
    expect(ref.current).toBe(screen.getByRole('button'))
  })
})
