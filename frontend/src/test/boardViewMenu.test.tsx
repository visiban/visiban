/**
 * BoardViewMenu (#2269): the toolbar's View button and panel.
 * Covers open/close, every control's callback, disabled no-ops, and the
 * dismissal paths (Escape, outside press, resize) that return focus correctly.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BoardViewMenu from '../components/Board/BoardViewMenu'
import SingleSelectDropdown from '../components/Common/SingleSelectDropdown'

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
  it('is an icon button at phone width with a 44px target and its name kept (#2333)', () => {
    setup()
    // jsdom has no media queries, so pin the phone classes: the label collapses to sr-only
    // (still the accessible name), the chevron hides and the target is 44px.
    expect(screen.getByText('View')).toHaveClass('max-sm:sr-only')
    expect(trigger()).toHaveClass('max-sm:h-11', 'max-sm:min-w-11')
  })

  it('Escape closes an open picker menu first, then the View panel', async () => {
    setup({
      presetPicker: (
        <SingleSelectDropdown
          label="Preset"
          portalMenu
          escapePriority={26}
          options={[{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]}
          selected={null}
          onChange={vi.fn()}
        />
      ),
    })
    const user = userEvent.setup()
    await user.click(trigger())
    await user.click(screen.getByRole('button', { name: /Preset/ }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'View options' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

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

  it('shows the E hint on both the swimlane and column groups (E toggles both)', async () => {
    setup()
    await userEvent.setup().click(trigger())
    for (const group of ['Swimlanes', 'Columns']) {
      expect(within(panel().getByRole('group', { name: group })).getByText('E')).toBeInTheDocument()
    }
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

  it('moves focus into the panel on open, and Tab off the last control closes it', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(trigger())
    expect(panel().getByText('Preset picker')).toHaveFocus()
    // Tab through to the last enabled control (the archived toggle).
    panel().getByRole('button', { name: 'Show archived cards' }).focus()
    await user.tab()
    // Focus is handed to the button and the Tab then moves on from it, so only
    // the dismissal is asserted here.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Shift+Tab off the first control closes the panel and keeps focus on the button', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(trigger())
    await user.tab({ shift: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger()).toHaveFocus()
  })

  it('Tab from the open View button enters the panel', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(trigger())
    trigger().focus()
    await user.tab()
    expect(panel().getByText('Preset picker')).toHaveFocus()
  })

  it('hands focus to the other half of a pair when a press disables the focused button', async () => {
    function Harness() {
      const [collapsed, setCollapsed] = React.useState(false)
      return (
        <BoardViewMenu
          presetPicker={null} overlayPicker={null} density="standard" onDensityChange={() => {}}
          cardLayout="expanded" onCardLayoutChange={() => {}}
          allSwimlanesCollapsed={collapsed} allSwimlanesExpanded={!collapsed}
          allColumnsCollapsed={false} allColumnsExpanded
          onCollapseSwimlanes={() => setCollapsed(true)} onExpandSwimlanes={() => setCollapsed(false)}
          onCollapseColumns={() => {}} onExpandColumns={() => {}} showArchived={false} onToggleArchived={() => {}}
        />
      )
    }
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(trigger())
    await user.click(panel().getByRole('button', { name: 'Collapse all' }))
    expect(panel().getByRole('button', { name: 'Expand all' })).toHaveFocus()
  })
})

describe('BoardViewMenu lane announcements (#2323)', () => {
  const status = () => screen.getByTestId('view-menu-lanes-status')

  it('announces Collapse all and Expand all by mouse, with the lane count', async () => {
    const user = userEvent.setup()
    setup({ laneCount: 3, allSwimlanesExpanded: false })
    await user.click(trigger())
    await user.click(panel().getByRole('button', { name: 'Collapse all' }))
    await waitFor(() => expect(status()).toHaveTextContent('Collapsed all 3 lanes'))
    await user.click(panel().getByRole('button', { name: 'Expand all' }))
    await waitFor(() => expect(status()).toHaveTextContent('Expanded all 3 lanes'))
  })

  it('announces by keyboard, and re-announces an identical repeat', async () => {
    const user = userEvent.setup()
    setup({ laneCount: 1, allSwimlanesExpanded: false })
    await user.click(trigger())
    const collapse = panel().getByRole('button', { name: 'Collapse all' })
    collapse.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(status()).toHaveTextContent('Collapsed all 1 lane'))
    // The same message again must be cleared then re-set so a screen reader speaks it twice.
    const seen: string[] = []
    const obs = new MutationObserver(() => seen.push(status().textContent ?? ''))
    obs.observe(status(), { childList: true, characterData: true, subtree: true })
    collapse.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(status()).toHaveTextContent('Collapsed all 1 lane'))
    obs.disconnect()
    expect(seen).toContain('')
  })

  it('omits the count when unknown', async () => {
    const user = userEvent.setup()
    setup({ allSwimlanesExpanded: false })
    await user.click(trigger())
    await user.click(panel().getByRole('button', { name: 'Collapse all' }))
    await waitFor(() => expect(status()).toHaveTextContent('Collapsed all lanes'))
  })
})

describe('BoardViewMenu column announcements (#2338)', () => {
  const status = () => screen.getByTestId('view-menu-lanes-status')

  it('announces Hide all and Show all by mouse, with the column count', async () => {
    const user = userEvent.setup()
    setup({ columnCount: 4, allColumnsExpanded: false })
    await user.click(trigger())
    await user.click(panel().getByRole('button', { name: 'Hide all' }))
    await waitFor(() => expect(status()).toHaveTextContent('Hid all 4 columns'))
    await user.click(panel().getByRole('button', { name: 'Show all' }))
    await waitFor(() => expect(status()).toHaveTextContent('Showed all 4 columns'))
  })

  it('announces Hide all and Show all by keyboard, in the singular form', async () => {
    const user = userEvent.setup()
    setup({ columnCount: 1, allColumnsExpanded: false })
    await user.click(trigger())
    panel().getByRole('button', { name: 'Hide all' }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(status()).toHaveTextContent('Hid all 1 column'))
    panel().getByRole('button', { name: 'Show all' }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(status()).toHaveTextContent('Showed all 1 column'))
  })

  it('omits the count when unknown, for Hide all and Show all', async () => {
    const user = userEvent.setup()
    setup({ allColumnsExpanded: false })
    await user.click(trigger())
    await user.click(panel().getByRole('button', { name: 'Hide all' }))
    await waitFor(() => expect(status()).toHaveTextContent('Hid all columns'))
    await user.click(panel().getByRole('button', { name: 'Show all' }))
    await waitFor(() => expect(status()).toHaveTextContent('Showed all columns'))
  })
})
