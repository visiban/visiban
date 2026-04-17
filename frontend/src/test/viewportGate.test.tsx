import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import ViewportGate from '../components/Layout/ViewportGate'

function makeMatchMedia(matches: boolean) {
  const listeners: Array<() => void> = []
  const mq = {
    matches,
    addEventListener: vi.fn((_event: string, handler: () => void) => {
      listeners.push(handler)
    }),
    removeEventListener: vi.fn((_event: string, handler: () => void) => {
      const idx = listeners.indexOf(handler)
      if (idx !== -1) listeners.splice(idx, 1)
    }),
    _trigger: (newMatches: boolean) => {
      mq.matches = newMatches
      listeners.forEach((h) => h())
    },
  }
  return mq
}

let mockMq: ReturnType<typeof makeMatchMedia>

function setupMatchMedia(matches: boolean) {
  mockMq = makeMatchMedia(matches)
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockReturnValue(mockMq),
  })
}

describe('ViewportGate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders children when viewport is >= 1024px', () => {
    setupMatchMedia(true)
    render(
      <ViewportGate>
        <div data-testid="workspace">Workspace</div>
      </ViewportGate>,
    )
    expect(screen.getByTestId('workspace')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('renders the notice when viewport is below 1024px', () => {
    setupMatchMedia(false)
    render(
      <ViewportGate>
        <div data-testid="workspace">Workspace</div>
      </ViewportGate>,
    )
    expect(screen.queryByTestId('workspace')).not.toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByText(/larger screen/i)).toBeInTheDocument()
  })

  it('the notice is labelled by the heading element for accessibility', () => {
    setupMatchMedia(false)
    render(<ViewportGate>child</ViewportGate>)
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby', 'viewport-gate-heading')
    expect(document.getElementById('viewport-gate-heading')).toBeInTheDocument()
  })

  it('queries the correct media query', () => {
    setupMatchMedia(true)
    render(
      <ViewportGate>
        <div>x</div>
      </ViewportGate>,
    )
    expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 1024px)')
  })

  it('switches from notice to children when viewport grows past the breakpoint', () => {
    setupMatchMedia(false)
    render(
      <ViewportGate>
        <div data-testid="workspace">Workspace</div>
      </ViewportGate>,
    )
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    act(() => {
      mockMq._trigger(true)
    })

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace')).toBeInTheDocument()
  })

  it('switches from children to notice when viewport shrinks below the breakpoint', () => {
    setupMatchMedia(true)
    render(
      <ViewportGate>
        <div data-testid="workspace">Workspace</div>
      </ViewportGate>,
    )
    expect(screen.getByTestId('workspace')).toBeInTheDocument()

    act(() => {
      mockMq._trigger(false)
    })

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace')).not.toBeInTheDocument()
  })

  it('removes the media query listener on unmount', () => {
    setupMatchMedia(true)
    const { unmount } = render(
      <ViewportGate>
        <div>x</div>
      </ViewportGate>,
    )
    unmount()
    expect(mockMq.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })
})
