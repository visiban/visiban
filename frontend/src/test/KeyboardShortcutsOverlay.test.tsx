import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import KeyboardShortcutsOverlay from '../components/Board/KeyboardShortcutsOverlay'

describe('KeyboardShortcutsOverlay', () => {
  it('renders all four shortcuts', () => {
    render(<KeyboardShortcutsOverlay onClose={() => {}} />)
    expect(screen.getByText('Toggle filter bar')).toBeInTheDocument()
    expect(screen.getByText('Open filters and focus search')).toBeInTheDocument()
    expect(screen.getByText('Show this help')).toBeInTheDocument()
    expect(screen.getByText('Close card detail / dialogs')).toBeInTheDocument()
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
})
