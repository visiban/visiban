import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OverflowMenu, { type OverflowItem } from '../components/Layout/OverflowMenu'

afterEach(() => {
  cleanup()
})

function item(
  id: string,
  label: string,
  overrides: Partial<OverflowItem> = {},
): OverflowItem {
  return {
    id,
    label,
    onSelect: vi.fn(),
    ...overrides,
  }
}

describe('OverflowMenu', () => {
  it('renders the kebab trigger with the correct aria-label', () => {
    render(
      <OverflowMenu
        items={[item('a', 'Alpha')]}
        showDot={false}
        onDismissDot={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'More board actions' })).toBeInTheDocument()
  })

  it('does not render at all when the items array is empty', () => {
    const { container } = render(
      <OverflowMenu items={[]} showDot={false} onDismissDot={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('clicking the trigger opens the menu and lists items', async () => {
    render(
      <OverflowMenu
        items={[item('a', 'Alpha'), item('b', 'Beta')]}
        showDot={false}
        onDismissDot={() => {}}
      />,
    )
    await userEvent.setup().click(
      screen.getByRole('button', { name: 'More board actions' }),
    )
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Beta' })).toBeInTheDocument()
  })

  it('item click fires onSelect and closes the menu', async () => {
    const onSelect = vi.fn()
    render(
      <OverflowMenu
        items={[item('a', 'Alpha', { onSelect })]}
        showDot={false}
        onDismissDot={() => {}}
      />,
    )
    await userEvent.setup().click(
      screen.getByRole('button', { name: 'More board actions' }),
    )
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('first-encounter dot renders only when showDot is true', () => {
    const { rerender, container } = render(
      <OverflowMenu
        items={[item('a', 'Alpha')]}
        showDot={false}
        onDismissDot={() => {}}
      />,
    )
    expect(container.querySelector('.bg-primary-emphasis')).toBeNull()

    rerender(
      <OverflowMenu
        items={[item('a', 'Alpha')]}
        showDot={true}
        onDismissDot={() => {}}
      />,
    )
    const dot = container.querySelector('.bg-primary-emphasis')
    expect(dot).not.toBeNull()
    expect(dot?.className).toMatch(/pointer-events-none/)
  })

  it('intentional kebab click fires onDismissDot', async () => {
    const onDismissDot = vi.fn()
    render(
      <OverflowMenu
        items={[item('a', 'Alpha')]}
        showDot={true}
        onDismissDot={onDismissDot}
      />,
    )
    await userEvent.setup().click(
      screen.getByRole('button', { name: 'More board actions' }),
    )
    expect(onDismissDot).toHaveBeenCalledOnce()
  })

  it('opening via externalOpen does NOT fire onDismissDot', () => {
    const onDismissDot = vi.fn()
    const { rerender } = render(
      <OverflowMenu
        items={[item('a', 'Alpha')]}
        showDot={true}
        onDismissDot={onDismissDot}
        externalOpen={false}
        onExternalOpenChange={() => {}}
      />,
    )
    rerender(
      <OverflowMenu
        items={[item('a', 'Alpha')]}
        showDot={true}
        onDismissDot={onDismissDot}
        externalOpen={true}
        onExternalOpenChange={() => {}}
      />,
    )
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(onDismissDot).not.toHaveBeenCalled()
  })

  it('Escape closes the menu and returns focus to the kebab', async () => {
    render(
      <OverflowMenu
        items={[item('a', 'Alpha')]}
        showDot={false}
        onDismissDot={() => {}}
      />,
    )
    const trigger = screen.getByRole('button', { name: 'More board actions' })
    await userEvent.setup().click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)
  })

  it('outside click closes the menu', async () => {
    render(
      <div>
        <OverflowMenu
          items={[item('a', 'Alpha')]}
          showDot={false}
          onDismissDot={() => {}}
        />
        <button type="button">Outside</button>
      </div>,
    )
    await userEvent.setup().click(
      screen.getByRole('button', { name: 'More board actions' }),
    )
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('renders shortcut hints as <kbd> elements when provided', async () => {
    render(
      <OverflowMenu
        items={[
          item('export', 'Export board', { shortcut: '⌘⇧E' }),
          item('shortcuts', 'Keyboard shortcuts', { shortcut: '?' }),
          item('tour', 'Replay onboarding tour'),
        ]}
        showDot={false}
        onDismissDot={() => {}}
      />,
    )
    await userEvent.setup().click(
      screen.getByRole('button', { name: 'More board actions' }),
    )
    const kbds = screen.getAllByText(/⌘⇧E|\?/)
    const kbdEls = kbds.filter((el) => el.tagName === 'KBD')
    expect(kbdEls.length).toBe(2)
  })

  it('renders separator before items that request separatorBefore', async () => {
    render(
      <OverflowMenu
        items={[
          item('a', 'Alpha'),
          item('b', 'Beta', { separatorBefore: true }),
        ]}
        showDot={false}
        onDismissDot={() => {}}
      />,
    )
    await userEvent.setup().click(
      screen.getByRole('button', { name: 'More board actions' }),
    )
    const separators = screen.getAllByRole('separator')
    expect(separators.length).toBe(1)
  })

  it('disabled item does not fire onSelect on click', async () => {
    const onSelect = vi.fn()
    render(
      <OverflowMenu
        items={[
          item('a', 'Alpha', {
            onSelect,
            disabled: true,
            disabledReason: 'Export is not available for this board',
          }),
        ]}
        showDot={false}
        onDismissDot={() => {}}
      />,
    )
    await userEvent.setup().click(
      screen.getByRole('button', { name: 'More board actions' }),
    )
    const menuItem = screen.getByRole('menuitem', { name: /Alpha/ })
    expect(menuItem).toBeDisabled()
    expect(menuItem.getAttribute('title')).toBe('Export is not available for this board')
    await userEvent.setup().click(menuItem)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('controlled mode: onExternalOpenChange reports state changes', async () => {
    const onExternalOpenChange = vi.fn()
    render(
      <OverflowMenu
        items={[item('a', 'Alpha')]}
        showDot={false}
        onDismissDot={() => {}}
        externalOpen={false}
        onExternalOpenChange={onExternalOpenChange}
      />,
    )
    await userEvent.setup().click(
      screen.getByRole('button', { name: 'More board actions' }),
    )
    expect(onExternalOpenChange).toHaveBeenCalledWith(true)
  })
})

describe('OverflowMenu — keyboard navigation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('auto-focuses the first enabled item when opened', async () => {
    render(
      <OverflowMenu
        items={[
          item('a', 'Alpha', { disabled: true, disabledReason: 'x' }),
          item('b', 'Beta'),
          item('c', 'Gamma'),
        ]}
        showDot={false}
        onDismissDot={() => {}}
      />,
    )
    const trigger = screen.getByRole('button', { name: 'More board actions' })
    fireEvent.click(trigger)
    // The autofocus runs on a setTimeout(0) tick
    vi.runAllTimers()
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Beta' }))
  })

  it('ArrowDown moves focus to the next enabled item (skipping disabled)', () => {
    render(
      <OverflowMenu
        items={[
          item('a', 'Alpha'),
          item('b', 'Beta', { disabled: true, disabledReason: 'x' }),
          item('c', 'Gamma'),
        ]}
        showDot={false}
        onDismissDot={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'More board actions' }))
    vi.runAllTimers()
    const alpha = screen.getByRole('menuitem', { name: 'Alpha' })
    alpha.focus()
    fireEvent.keyDown(alpha, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Gamma' }))
  })

  it('ArrowUp wraps from the first enabled item to the last enabled item', () => {
    render(
      <OverflowMenu
        items={[item('a', 'Alpha'), item('b', 'Beta'), item('c', 'Gamma')]}
        showDot={false}
        onDismissDot={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'More board actions' }))
    vi.runAllTimers()
    const alpha = screen.getByRole('menuitem', { name: 'Alpha' })
    alpha.focus()
    fireEvent.keyDown(alpha, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Gamma' }))
  })
})
