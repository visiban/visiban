import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import LensResizeHandle from '../components/Board/Lens/LensResizeHandle'

describe('LensResizeHandle (#1065)', () => {
  it('exposes a vertical separator role with the given accessible name and current value', () => {
    render(<LensResizeHandle currentWidth={280} setWidth={vi.fn()} ariaLabel="Resize Doing column" />)
    const handle = screen.getByRole('separator', { name: 'Resize Doing column' })
    expect(handle).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle).toHaveAttribute('aria-valuenow', '280')
    expect(handle).toHaveAttribute('tabIndex', '0')
  })

  it('drags to a new width based on mouse movement, without a click-vs-drag threshold', () => {
    const setWidth = vi.fn()
    render(<LensResizeHandle currentWidth={280} setWidth={setWidth} ariaLabel="Resize Doing column" />)
    const handle = screen.getByRole('separator', { name: 'Resize Doing column' })

    fireEvent.mouseDown(handle, { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 130 })
    expect(setWidth).toHaveBeenCalledWith(310)

    fireEvent.mouseMove(window, { clientX: 90 })
    expect(setWidth).toHaveBeenLastCalledWith(270)

    fireEvent.mouseUp(window)
    // Movement after mouseup must not call setWidth again.
    setWidth.mockClear()
    fireEvent.mouseMove(window, { clientX: 500 })
    expect(setWidth).not.toHaveBeenCalled()
  })

  it('ArrowRight/ArrowLeft nudge the width by the step, Shift multiplies by 4', () => {
    const setWidth = vi.fn()
    render(<LensResizeHandle currentWidth={280} setWidth={setWidth} ariaLabel="Resize Doing column" step={8} />)
    const handle = screen.getByRole('separator', { name: 'Resize Doing column' })

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(setWidth).toHaveBeenLastCalledWith(288)

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(setWidth).toHaveBeenLastCalledWith(272)

    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
    expect(setWidth).toHaveBeenLastCalledWith(312)
  })

  it('ignores keys other than the arrow keys', () => {
    const setWidth = vi.fn()
    render(<LensResizeHandle currentWidth={280} setWidth={setWidth} ariaLabel="Resize Doing column" />)
    const handle = screen.getByRole('separator', { name: 'Resize Doing column' })
    fireEvent.keyDown(handle, { key: 'Enter' })
    fireEvent.keyDown(handle, { key: 'Tab' })
    expect(setWidth).not.toHaveBeenCalled()
  })
})
