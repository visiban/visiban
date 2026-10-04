import { describe, it, expect, vi, afterEach } from 'vitest'
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
    // bg-primary-emphasis/20 (not bg-info/20) so the active fill tracks the
    // theme in dark mode, where --info and --primary diverge (#1336)
    expect(active.className).toContain('bg-primary-emphasis/20')
    expect(active.className).not.toContain('bg-info/20')
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

  describe('viewport fit (#1457)', () => {
    afterEach(() => { vi.restoreAllMocks() })

    function mount(top: number) {
      return render(
        <MemoryRouter>
          <CollapsedFlyout
            title="Boards"
            sections={defaultSections}
            anchor={{ top, left: 48 }}
            onClose={vi.fn()}
            onNavigate={vi.fn()}
          />
        </MemoryRouter>,
      )
    }
    const panel = () => screen.getByTestId('collapsed-flyout')

    it('aligns with the trigger top when the measured height fits', () => {
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
      mount(100)
      expect(panel().style.top).toBe('100px')
      expect(panel().style.visibility).toBe('')
    })

    it('slides up to stay on screen when the trigger is near the bottom', () => {
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
      mount(window.innerHeight - 50)
      expect(panel().style.top).toBe(`${window.innerHeight - 8 - 200}px`)
    })

    it('pins to the top margin when taller than the viewport allows', () => {
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(window.innerHeight + 100)
      mount(100)
      expect(panel().style.top).toBe('8px')
    })

    it('caps the panel at the viewport rather than a fixed height', () => {
      mount(100)
      expect(panel().style.maxHeight).toBe('calc(100vh - 16px)')
    })

    it('closes on window resize', () => {
      const onClose = vi.fn()
      render(
        <MemoryRouter>
          <CollapsedFlyout title="Boards" sections={defaultSections} anchor={{ top: 100, left: 48 }} onClose={onClose} onNavigate={vi.fn()} />
        </MemoryRouter>,
      )
      fireEvent(window, new Event('resize'))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('exposes a keyboard-focusable, labeled menu as the scroll region', () => {
      mount(100)
      const menu = screen.getByRole('menu', { name: 'Boards' })
      expect(menu).toHaveAttribute('tabindex', '0')
    })

    it('focuses the list only when it overflows, and only after placement', () => {
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500)
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
      let visibilityAtFocus: string | undefined
      const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement) {
        visibilityAtFocus = (this.closest("[data-testid='collapsed-flyout']") as HTMLElement).style.visibility
      })
      mount(100)
      expect(focusSpy).toHaveBeenCalledTimes(1)
      expect(visibilityAtFocus).toBe('')
    })

    it('does not move focus when the list fits', () => {
      const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')
      mount(100)
      expect(focusSpy).not.toHaveBeenCalled()
    })

    it('shows the overflow fade only while more is below the fold', () => {
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500)
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
      mount(100)
      expect(screen.getByTestId('collapsed-flyout-more-below')).toBeInTheDocument()
      const menu = screen.getByRole('menu')
      menu.scrollTop = 300
      fireEvent.scroll(menu)
      expect(screen.queryByTestId('collapsed-flyout-more-below')).not.toBeInTheDocument()
    })
  })
})
