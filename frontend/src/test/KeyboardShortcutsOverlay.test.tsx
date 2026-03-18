import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import KeyboardShortcutsOverlay from '../components/Board/KeyboardShortcutsOverlay'

describe('KeyboardShortcutsOverlay', () => {
  it('renders all four shortcuts', () => {
    render(<KeyboardShortcutsOverlay onClose={() => {}} />)
    expect(screen.getByText('Toggle filter bar')).toBeInTheDocument()
    expect(screen.getByText('Open filters and focus search')).toBeInTheDocument()
    expect(screen.getByText('Show this help')).toBeInTheDocument()
    expect(screen.getByText('Close card or dialog; go back when nothing is open')).toBeInTheDocument()
  })

  it('calls onClose when the × button is clicked', () => {
    const onClose = vi.fn()
    render(<KeyboardShortcutsOverlay onClose={onClose} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when the backdrop is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(<KeyboardShortcutsOverlay onClose={onClose} />)
    // The outer div is the backdrop
    const backdrop = container.firstChild as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not call onClose when clicking inside the card', () => {
    const onClose = vi.fn()
    render(<KeyboardShortcutsOverlay onClose={onClose} />)
    fireEvent.click(screen.getByText('Keyboard shortcuts'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose when the Escape key is pressed', () => {
    const onClose = vi.fn()
    render(<KeyboardShortcutsOverlay onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('renders all shortcut keys as <kbd> elements', () => {
    const { container } = render(<KeyboardShortcutsOverlay onClose={() => {}} />)
    const kbds = container.querySelectorAll('kbd')
    const keys = Array.from(kbds).map((el) => el.textContent)
    expect(keys).toContain('f')
    expect(keys).toContain('/')
    expect(keys).toContain('?')
    expect(keys).toContain('Esc')
  })

  it('renders in a fixed overlay container', () => {
    const { container } = render(<KeyboardShortcutsOverlay onClose={() => {}} />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain('fixed')
    expect(root.className).toContain('inset-0')
  })

  it('contains a heading for screen readers', () => {
    render(<KeyboardShortcutsOverlay onClose={() => {}} />)
    const heading = screen.getByText('Keyboard shortcuts')
    expect(heading.tagName.toLowerCase()).toBe('h3')
  })
})
