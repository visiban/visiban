import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import CollapsedFlyout, { type FlyoutSection } from '../components/Common/CollapsedFlyout'

const defaultSections: FlyoutSection[] = [
  {
    title: 'My Boards',
    items: [
      { id: 1, name: 'Sprint Board', href: '/boards/1', active: false },
      { id: 2, name: 'Roadmap', href: '/boards/2', active: true },
    ],
  },
]

function renderFlyout(
  sections = defaultSections,
  onClose = vi.fn(),
  onNavigate = vi.fn(),
) {
  return render(
    <MemoryRouter>
      <CollapsedFlyout
        title="Boards"
        sections={sections}
        anchor={{ top: 100, left: 48 }}
        onClose={onClose}
        onNavigate={onNavigate}
      />
    </MemoryRouter>,
  )
}

describe('CollapsedFlyout', () => {
  it('renders the flyout panel with title', () => {
    renderFlyout()
    expect(screen.getByTestId('collapsed-flyout')).toBeInTheDocument()
    expect(screen.getByText('Boards')).toBeInTheDocument()
  })

  it('renders all items', () => {
    renderFlyout()
    expect(screen.getByText('Sprint Board')).toBeInTheDocument()
    expect(screen.getByText('Roadmap')).toBeInTheDocument()
  })

  it('clicking an item calls onClose and onNavigate', () => {
    const onClose = vi.fn()
    const onNavigate = vi.fn()
    renderFlyout(defaultSections, onClose, onNavigate)
    fireEvent.click(screen.getByText('Sprint Board'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('closes on outside mousedown', () => {
    const onClose = vi.fn()
    renderFlyout(defaultSections, onClose)
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close on inside mousedown', () => {
    const onClose = vi.fn()
    renderFlyout(defaultSections, onClose)
    fireEvent.mouseDown(screen.getByTestId('collapsed-flyout'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('active item gets highlighted style', () => {
    renderFlyout()
    const active = screen.getByText('Roadmap').closest('a')!
    expect(active.className).toContain('text-info')
  })

  it('renders multiple sections with separate headings', () => {
    const sections: FlyoutSection[] = [
      { title: 'Favorites', items: [{ id: 1, name: 'Alpha', href: '/boards/1', active: false }] },
      { title: 'Recent', items: [{ id: 2, name: 'Beta', href: '/boards/2', active: false }] },
    ]
    renderFlyout(sections)
    expect(screen.getByText('Favorites')).toBeInTheDocument()
    expect(screen.getByText('Recent')).toBeInTheDocument()
  })

  it('positions the panel with the supplied anchor coordinates', () => {
    renderFlyout()
    const panel = screen.getByTestId('collapsed-flyout') as HTMLElement
    expect(panel.style.top).toBe('100px')
    expect(panel.style.left).toBe('52px') // anchor.left + 4
  })
})
