/**
 * BoardViewMenu (#2269): the toolbar's View button and panel.
 * Covers open/close, every control's callback, disabled no-ops, and the
 * dismissal paths (Escape, outside press, resize) that return focus correctly.
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardViewMenu from '../components/Board/BoardViewMenu'

function setup(overrides: Partial<React.ComponentProps<typeof BoardViewMenu>> = {}) {
  const props: React.ComponentProps<typeof BoardViewMenu> = {
    presetPicker: <button type="button">Preset picker</button>,
    overlayPicker: <button type="button">Overlay picker</button>,
    density: 'standard',
    onDensityChange: vi.fn(),
    cardLayout: 'expanded',
    onCardLayoutChange: vi.fn(),
    allSwimlanesCollapsed: false,
    allSwimlanesExpanded: true,
    allColumnsCollapsed: false,
    allColumnsExpanded: true,
    onCollapseSwimlanes: vi.fn(),
    onExpandSwimlanes: vi.fn(),
    onCollapseColumns: vi.fn(),
    onExpandColumns: vi.fn(),
    showArchived: false,
    onToggleArchived: vi.fn(),
    ...overrides,
  }
  render(<BoardViewMenu {...props} />)
  return props
}

const trigger = () => screen.getByRole('button', { name: 'View' })
const panel = () => within(screen.getByRole('dialog', { name: 'View options' }))

describe('BoardViewMenu', () => {
  it('is closed at rest and exposes aria-expanded on its button', async () => {
    setup()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
    await userEvent.setup().click(trigger())
    expect(trigger()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('dialog', { name: 'View options' })).toBeInTheDocument()
  })

  it('renders the pickers passed in and toggles closed on a second click', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(trigger())
    expect(panel().getByText('Preset picker')).toBeInTheDocument()
    expect(panel().getByText('Overlay picker')).toBeInTheDocument()
    await user.click(trigger())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('marks the active density and reports a change', async () => {
    const props = setup()
    const user = userEvent.setup()
    await user.click(trigger())
    const group = within(screen.getByRole('group', { name: 'Card density' }))
    expect(group.getByRole('button', { name: 'Standard' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(group.getByRole('button', { name: 'Standard' })).getByTestId('active-mark')).toBeInTheDocument()
    await user.click(group.getByRole('button', { name: 'Dense' }))
    expect(props.onDensityChange).toHaveBeenCalledWith('dense')
  })

  it('reports card layout changes', async () => {
    const props = setup()
    const user = userEvent.setup()
    await user.click(trigger())
    await user.click(panel().getByRole('button', { name: /Compact/ }))
    expect(props.onCardLayoutChange).toHaveBeenCalledWith('compact')
  })

  it('disables the no-op half of the swimlane and column pairs', async () => {
    const props = setup()
    const user = userEvent.setup()
    await user.click(trigger())
    expect(panel().getByRole('button', { name: 'Expand all' })).toBeDisabled()
    expect(panel().getByRole('button', { name: 'Show all' })).toBeDisabled()
    await user.click(panel().getByRole('button', { name: 'Collapse all' }))
    await user.click(panel().getByRole('button', { name: 'Hide all' }))
    expect(props.onCollapseSwimlanes).toHaveBeenCalledTimes(1)
    expect(props.onCollapseColumns).toHaveBeenCalledTimes(1)
  })

  it('enables Expand and Show when everything is collapsed', async () => {
    const props = setup({ allSwimlanesCollapsed: true, allSwimlanesExpanded: false, allColumnsCollapsed: true, allColumnsExpanded: false })
    const user = userEvent.setup()
    await user.click(trigger())
    expect(panel().getByRole('button', { name: 'Collapse all' })).toBeDisabled()
    await user.click(panel().getByRole('button', { name: 'Expand all' }))
    await user.click(panel().getByRole('button', { name: 'Show all' }))
    expect(props.onExpandSwimlanes).toHaveBeenCalledTimes(1)
    expect(props.onExpandColumns).toHaveBeenCalledTimes(1)
  })

  it('toggles archived cards and labels the current state', async () => {
    const props = setup({ showArchived: true })
    const user = userEvent.setup()
    await user.click(trigger())
    const btn = panel().getByRole('button', { name: 'Hide archived cards' })
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(btn).toHaveAttribute('aria-keyshortcuts', 'Y')
    await user.click(btn)
    expect(props.onToggleArchived).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape and returns focus to the View button', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(trigger())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger()).toHaveFocus()
  })

  it('closes on an outside press but not on a press inside the panel or a nested menu', async () => {
    setup({ presetPicker: <div role="menu" aria-label="Nested"><button type="button">Nested item</button></div> })
    const user = userEvent.setup()
    await user.click(trigger())
    await user.click(panel().getByText('Card density'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByText('Nested item'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes on resize and on a scroll outside the panel, not inside it', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(trigger())
    fireEvent.scroll(screen.getByRole('dialog'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.scroll(document.body)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(trigger())
    fireEvent(window, new Event('resize'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps every control reachable by Tab (no custom key traps)', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(trigger())
    await user.tab()
    expect(panel().getByText('Preset picker')).toHaveFocus()
    await user.tab()
    expect(panel().getByText('Overlay picker')).not.toHaveFocus()
  })
})
