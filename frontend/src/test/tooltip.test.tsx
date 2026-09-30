import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import Tooltip from '../components/Common/Tooltip'

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not show the tooltip initially', () => {
    render(
      <Tooltip content="Hello">
        <button>Trigger</button>
      </Tooltip>,
    )
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('shows the tooltip after the delay on mouseenter', () => {
    render(
      <Tooltip content="Hello">
        <button>Trigger</button>
      </Tooltip>,
    )
    fireEvent.mouseEnter(screen.getByText('Trigger'))
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Hello')
  })

  it('hides the tooltip immediately on mouseleave', () => {
    render(
      <Tooltip content="Hello">
        <button>Trigger</button>
      </Tooltip>,
    )
    const trigger = screen.getByText('Trigger')
    fireEvent.mouseEnter(trigger)
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.mouseLeave(trigger)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  // Regression guard (#1305): the hover-delay show timer had no unmount
  // cleanup at all. Unmounting the trigger while the timer is still pending
  // (e.g. the parent removes it in response to a broadcast) must clear it,
  // not fire setVisible/setCoords against a torn-down component.
  it('clears the pending show timer on unmount, without throwing', () => {
    const { unmount } = render(
      <Tooltip content="Hello">
        <button>Trigger</button>
      </Tooltip>,
    )
    fireEvent.mouseEnter(screen.getByText('Trigger'))

    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => unmount()).not.toThrow()
    expect(clearSpy).toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    // Advancing past the original delay after unmount must not throw.
    expect(() => act(() => { vi.advanceTimersByTime(300) })).not.toThrow()
    expect(errorSpy).not.toHaveBeenCalled()

    clearSpy.mockRestore()
    errorSpy.mockRestore()
  })
})
