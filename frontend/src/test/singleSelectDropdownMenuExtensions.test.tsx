/**
 * SingleSelectDropdown's additive props for the board preset picker (#1146):
 * option descriptions, a trigger suffix and label wrapper, a menu header, and
 * command items that share the roving focus with the options. Every prop is
 * optional; a caller that passes none renders exactly as before.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SingleSelectDropdown from '../components/Common/SingleSelectDropdown'

const OPTIONS = [
  { value: 'a', label: 'Alpha', description: 'First letter' },
  { value: 'b', label: 'Beta' },
]

describe('SingleSelectDropdown menu extensions (#1146)', () => {
  it('renders an option description as a second line inside the menu item', async () => {
    render(<SingleSelectDropdown label="Pick" options={OPTIONS} selected={null} onChange={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Pick' }))
    const alpha = screen.getByRole('menuitem', { name: 'Alpha First letter' })
    expect(within(alpha).getByText('First letter')).toHaveClass('text-xs', 'text-fg-tertiary')
    // An option without a description keeps its bare label.
    expect(screen.getByRole('menuitem', { name: 'Beta' }).innerHTML).toBe('Beta')
  })

  it('renders the trigger suffix and folds the detail into the accessible name', () => {
    render(
      <SingleSelectDropdown
        label="Pick" ariaLabel="Letter" ariaLabelDetail="modified" options={OPTIONS} selected="a"
        onChange={vi.fn()} triggerSuffix={<span>Modified</span>} labelClassName="truncate"
      />,
    )
    const trigger = screen.getByRole('button', { name: 'Letter: Alpha, modified' })
    expect(trigger).toHaveTextContent('AlphaModified')
    expect(within(trigger).getByText('Alpha')).toHaveClass('truncate')
  })

  it('omits the detail when it is empty', () => {
    render(<SingleSelectDropdown label="Pick" ariaLabel="Letter" ariaLabelDetail="" options={OPTIONS} selected="a" onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Letter: Alpha' })).toBeInTheDocument()
  })

  it('shows a non-interactive header and runs an action without calling onChange', async () => {
    const onChange = vi.fn()
    const onSelect = vi.fn()
    render(
      <SingleSelectDropdown
        label="Pick" options={OPTIONS} selected="a" onChange={onChange}
        menuHeader={<span>Changed: two things</span>}
        menuActions={[{ key: 'reset', label: 'Reset', onSelect }]}
      />,
    )
    const trigger = screen.getByRole('button', { name: 'Alpha' })
    await userEvent.click(trigger)
    expect(screen.getByText('Changed: two things')).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Reset', 'AlphaFirst letter', 'Beta'])
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reset' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('roves Up/Down/Home/End across actions and options together', async () => {
    const user = userEvent.setup()
    render(
      <SingleSelectDropdown
        label="Pick" options={OPTIONS} selected={null} onChange={vi.fn()}
        menuActions={[{ key: 'reset', label: 'Reset', onSelect: vi.fn() }]}
      />,
    )
    screen.getByRole('button', { name: 'Pick' }).focus()
    await user.keyboard('{Enter}{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Reset' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: /^Alpha/ })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: 'Beta' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Beta' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('menuitem', { name: 'Reset' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('exposes the selection with menuitemradio + aria-checked when asked', async () => {
    render(<SingleSelectDropdown label="Pick" options={OPTIONS} selected="b" onChange={vi.fn()} optionRole="menuitemradio" />)
    await userEvent.click(screen.getByRole('button', { name: 'Beta' }))
    expect(screen.getByRole('menuitemradio', { name: 'Beta' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: /^Alpha/ })).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
  })

  it('describes the menu with its header', async () => {
    render(<SingleSelectDropdown label="Pick" options={OPTIONS} selected={null} onChange={vi.fn()} menuHeader="Two changes" />)
    await userEvent.click(screen.getByRole('button', { name: 'Pick' }))
    expect(screen.getByRole('menu')).toHaveAccessibleDescription('Two changes')
  })

  it('leaves callers without the new props unchanged', async () => {
    render(<SingleSelectDropdown label="Pick" options={[{ value: 'a', label: 'Alpha' }]} selected={null} onChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Pick' })
    // The text node sits directly in the button, not in a wrapper span.
    expect(Array.from(trigger.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent === 'Pick')).toBe(true)
    await userEvent.click(trigger)
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    expect(screen.getByRole('menuitem')).not.toHaveAttribute('aria-checked')
    expect(screen.getByRole('menu')).not.toHaveAttribute('aria-describedby')
  })
})
