import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SplitButton from '../components/Common/SplitButton'

afterEach(() => {
  cleanup()
})

function Menu({ onSelect }: { onSelect: (label: string) => void }) {
  return (
    <>
      <button type="button" role="menuitem" onClick={() => onSelect('one')}>Item one</button>
      <button type="button" role="menuitem" onClick={() => onSelect('two')}>Item two</button>
    </>
  )
}

describe('SplitButton', () => {
  it('renders two distinct buttons — primary and chevron', () => {
    render(
      <SplitButton
        primaryLabel="Collapse"
        onPrimary={() => {}}
        renderMenu={() => <button role="menuitem">x</button>}
      />,
    )
    const primary = screen.getByRole('button', { name: 'Collapse' })
    const chevron = screen.getByRole('button', { name: 'Collapse menu' })
    expect(primary).not.toBe(chevron)
    expect(primary.getAttribute('aria-haspopup')).toBeNull()
    expect(chevron.getAttribute('aria-haspopup')).toBe('menu')
  })

  it('primary click fires onPrimary and does not open the menu', async () => {
    const onPrimary = vi.fn()
    render(
      <SplitButton
        primaryLabel="Collapse"
        onPrimary={onPrimary}
        renderMenu={() => <button role="menuitem">x</button>}
      />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Collapse' }))
    expect(onPrimary).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('chevron click opens the menu and does not fire onPrimary', async () => {
    const onPrimary = vi.fn()
    render(
      <SplitButton
        primaryLabel="Collapse"
        onPrimary={onPrimary}
        renderMenu={() => <button role="menuitem">Item one</button>}
      />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Collapse menu' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByText('Item one')).toBeInTheDocument()
    expect(onPrimary).not.toHaveBeenCalled()
  })

  it('Escape closes the open menu and returns focus to the chevron', async () => {
    render(
      <SplitButton
        primaryLabel="Collapse"
        onPrimary={() => {}}
        renderMenu={() => <button role="menuitem">Item one</button>}
      />,
    )
    const chevron = screen.getByRole('button', { name: 'Collapse menu' })
    await userEvent.setup().click(chevron)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(chevron)
  })

  it('outside click closes the menu', async () => {
    render(
      <div>
        <SplitButton
          primaryLabel="Collapse"
          onPrimary={() => {}}
          renderMenu={() => <button role="menuitem">Item one</button>}
        />
        <button type="button">Outside</button>
      </div>,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Collapse menu' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('primary segment carries a custom aria-label when provided', () => {
    render(
      <SplitButton
        primaryLabel="Collapse"
        primaryAriaLabel="Hide all swimlanes and columns"
        onPrimary={() => {}}
        renderMenu={() => <button role="menuitem">x</button>}
      />,
    )
    expect(screen.getByLabelText('Hide all swimlanes and columns')).toBeInTheDocument()
  })

  it('chevron has its own focus ring — two tab stops, not one', async () => {
    render(
      <SplitButton
        primaryLabel="Collapse"
        onPrimary={() => {}}
        renderMenu={() => <button role="menuitem">x</button>}
      />,
    )
    const primary = screen.getByRole('button', { name: 'Collapse' })
    const chevron = screen.getByRole('button', { name: 'Collapse menu' })
    primary.focus()
    expect(document.activeElement).toBe(primary)
    await userEvent.setup().tab()
    expect(document.activeElement).toBe(chevron)
  })

  it('ArrowDown on the closed chevron opens the menu', () => {
    render(
      <SplitButton
        primaryLabel="Collapse"
        onPrimary={() => {}}
        renderMenu={() => <button role="menuitem">Item one</button>}
      />,
    )
    const chevron = screen.getByRole('button', { name: 'Collapse menu' })
    chevron.focus()
    fireEvent.keyDown(chevron, { key: 'ArrowDown' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('Enter on the closed chevron opens the menu', () => {
    render(
      <SplitButton
        primaryLabel="Collapse"
        onPrimary={() => {}}
        renderMenu={() => <button role="menuitem">Item one</button>}
      />,
    )
    const chevron = screen.getByRole('button', { name: 'Collapse menu' })
    chevron.focus()
    fireEvent.keyDown(chevron, { key: 'Enter' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('menu items receive a close() callback via renderMenu', async () => {
    let closeCallback: (() => void) | null = null
    render(
      <SplitButton
        primaryLabel="Collapse"
        onPrimary={() => {}}
        renderMenu={({ close }) => {
          closeCallback = close
          return (
            <button
              role="menuitem"
              onClick={() => close()}
            >
              Close me
            </button>
          )
        }}
      />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Collapse menu' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(closeCallback).not.toBeNull()
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Close me' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('chevron renders open-state classes when the menu is open', async () => {
    const onSelect = vi.fn()
    render(
      <SplitButton
        primaryLabel="Collapse"
        onPrimary={() => {}}
        renderMenu={() => <Menu onSelect={onSelect} />}
      />,
    )
    const chevron = screen.getByRole('button', { name: 'Collapse menu' })
    expect(chevron.className).not.toMatch(/bg-info\/10/)
    await userEvent.setup().click(chevron)
    expect(chevron.className).toMatch(/text-info/)
    expect(chevron.className).toMatch(/bg-info\/10/)
  })

  it('chevron uses border-line-strong for the visual bisection', () => {
    render(
      <SplitButton
        primaryLabel="Collapse"
        onPrimary={() => {}}
        renderMenu={() => <button role="menuitem">x</button>}
      />,
    )
    const chevron = screen.getByRole('button', { name: 'Collapse menu' })
    expect(chevron.className).toMatch(/border-line-strong/)
  })

  it('primary and chevron each expose their own focus ring classes', () => {
    render(
      <SplitButton
        primaryLabel="Collapse"
        onPrimary={() => {}}
        renderMenu={() => <button role="menuitem">x</button>}
      />,
    )
    const primary = screen.getByRole('button', { name: 'Collapse' })
    const chevron = screen.getByRole('button', { name: 'Collapse menu' })
    expect(primary.className).toMatch(/focus:ring-2/)
    expect(primary.className).toMatch(/rounded-l/)
    expect(chevron.className).toMatch(/focus:ring-2/)
    expect(chevron.className).toMatch(/rounded-r/)
  })

  it('per-half disabled props gate each segment independently', async () => {
    const onPrimary = vi.fn()
    render(
      <SplitButton
        primaryLabel="Collapse"
        onPrimary={onPrimary}
        primaryDisabled
        renderMenu={() => <button role="menuitem">Item one</button>}
      />,
    )
    const primary = screen.getByRole('button', { name: 'Collapse' })
    expect(primary).toBeDisabled()
    const chevron = screen.getByRole('button', { name: 'Collapse menu' })
    expect(chevron).not.toBeDisabled()
    await userEvent.setup().click(primary)
    expect(onPrimary).not.toHaveBeenCalled()
    await userEvent.setup().click(chevron)
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })
})
