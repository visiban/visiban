import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import KeyboardShortcutsOverlay from '../components/Board/KeyboardShortcutsOverlay'

describe('KeyboardShortcutsOverlay', () => {
  beforeEach(() => {
    // Pin platform to Mac so chord glyphs are deterministic. A parallel
    // non-Mac branch is exercised via KeyboardShortcutsOverlay's usage of
    // formatShortcut, which has its own coverage in platform.test.ts.
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    Object.defineProperty(navigator, 'userAgentData', { value: undefined, configurable: true })
  })

  it('renders shortcuts grouped into four sections', () => {
    render(<KeyboardShortcutsOverlay onClose={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Navigation' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Board view' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Board actions' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Help' })).toBeInTheDocument()
  })

  it('lists the board view bindings (B / S / H / A) in the Board view section', () => {
    render(<KeyboardShortcutsOverlay onClose={() => {}} />)
    expect(screen.getByText('Switch to Board view')).toBeInTheDocument()
    expect(screen.getByText('Switch to Summary view')).toBeInTheDocument()
    expect(screen.getByText('Switch to History view')).toBeInTheDocument()
    expect(screen.getByText('Switch to Analytics view')).toBeInTheDocument()
  })

  it('lists the Collapse/expand (E), Archived (Y), and Layout (⌘⇧L) actions', () => {
    render(<KeyboardShortcutsOverlay onClose={() => {}} />)
    expect(screen.getByText('Collapse or expand everything')).toBeInTheDocument()
    expect(screen.getByText('Toggle the archived cards panel')).toBeInTheDocument()
    expect(screen.getByText('Switch card layout (compact / expanded)')).toBeInTheDocument()
  })

  it('surfaces the search shortcut with imperative copy', () => {
    render(<KeyboardShortcutsOverlay onClose={() => {}} />)
    expect(screen.getByText('Focus the search box')).toBeInTheDocument()
    expect(screen.getByText('Show this help')).toBeInTheDocument()
    expect(screen.getByText('Close card or dialog; go back when nothing is open')).toBeInTheDocument()
  })

  it('renders platform-aware chord glyphs on Mac (⌘K, ⌘⇧L)', () => {
    const { container } = render(<KeyboardShortcutsOverlay onClose={() => {}} />)
    const keys = Array.from(container.querySelectorAll('kbd')).map((el) => el.textContent)
    expect(keys).toContain('⌘K')
    expect(keys).toContain('⌘⇧L')
    // Bare-letter view bindings render uppercased and on their own.
    expect(keys).toContain('B')
    expect(keys).toContain('S')
    expect(keys).toContain('Y')
  })

  it('keeps the overflow-menu shortcut documented (#853)', () => {
    render(<KeyboardShortcutsOverlay onClose={() => {}} />)
    expect(screen.getByText('Open the overflow menu')).toBeInTheDocument()
  })

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn()
    render(<KeyboardShortcutsOverlay onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when the backdrop is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(<KeyboardShortcutsOverlay onClose={onClose} />)
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

  it('widens the key column to w-24 to fit multi-glyph chords', () => {
    const { container } = render(<KeyboardShortcutsOverlay onClose={() => {}} />)
    const firstKeyCell = container.querySelector('td.w-24')
    expect(firstKeyCell).not.toBeNull()
    // The old w-12 width would truncate ⌘⇧L / Ctrl+Shift+L — the audit
    // widened the column so the new longer chords don't clip.
    expect(container.querySelector('td.w-12')).toBeNull()
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
    expect(heading.tagName.toLowerCase()).toBe('h2')
  })
})
