import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ShortcutsHelpHost from '../components/Layout/ShortcutsHelpHost'

// `?` opens the one shortcuts help (#2473). It must yield to typing contexts,
// popovers that own their keys (#2301), and any open modal (CLAUDE.md "Guards").
describe('ShortcutsHelpHost (#2473)', () => {
  const press = (target: Element | Document = document.body) => fireEvent.keyDown(target, { key: '?' })

  it('opens on ? from the page body', () => {
    render(<ShortcutsHelpHost />)
    press()
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
  })

  it('does not open from a text field', () => {
    render(<><input aria-label="Field" /><ShortcutsHelpHost /></>)
    press(screen.getByRole('textbox', { name: 'Field' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not open from inside a popover scope', () => {
    render(<><div data-shortcut-scope="popover"><button>Inside</button></div><ShortcutsHelpHost /></>)
    press(screen.getByRole('button', { name: 'Inside' }))
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull()
  })

  it('does not open over another modal (a dialog or the open nav drawer)', () => {
    render(<><div role="dialog" aria-modal="true" aria-label="Other" /><ShortcutsHelpHost /></>)
    press()
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull()
  })

  it('the help dialog closes on Escape', () => {
    render(<ShortcutsHelpHost />)
    press()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull()
  })
})
