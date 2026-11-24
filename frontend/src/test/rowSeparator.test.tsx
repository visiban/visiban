import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import RowSeparator from '../components/Board/RowSeparator'

// #1900 — write paths: click-to-insert vs drag-to-resize, and the hover overlay.
const root = (c: HTMLElement) => c.firstElementChild as HTMLElement

describe('RowSeparator', () => {
  it('admin without resize: mousedown inserts', () => {
    const onInsert = vi.fn()
    const { container } = render(<RowSeparator isAdmin onInsert={onInsert} />)
    fireEvent.mouseDown(root(container))
    expect(onInsert).toHaveBeenCalledTimes(1)
    expect(root(container).className).toContain('cursor-pointer')
  })

  it('non-admin without resize: mousedown does nothing', () => {
    const onInsert = vi.fn()
    const { container } = render(<RowSeparator isAdmin={false} onInsert={onInsert} />)
    fireEvent.mouseDown(root(container))
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('a click (no movement past the threshold) inserts on mouseup for an admin', () => {
    const onInsert = vi.fn(); const setHeight = vi.fn()
    const { container } = render(<RowSeparator isAdmin onInsert={onInsert} setHeight={setHeight} currentHeight={100} />)
    fireEvent.mouseDown(root(container), { clientY: 50 })
    fireEvent.mouseMove(window, { clientY: 52 })
    fireEvent.mouseUp(window)
    expect(onInsert).toHaveBeenCalledTimes(1)
    expect(setHeight).not.toHaveBeenCalled()
  })

  it('a click does not insert for a non-admin', () => {
    const onInsert = vi.fn()
    const { container } = render(<RowSeparator isAdmin={false} onInsert={onInsert} setHeight={vi.fn()} currentHeight={100} />)
    fireEvent.mouseDown(root(container), { clientY: 50 })
    fireEvent.mouseUp(window)
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('dragging resizes from the stored height and does not insert', () => {
    const onInsert = vi.fn(); const setHeight = vi.fn()
    const { container } = render(<RowSeparator isAdmin onInsert={onInsert} setHeight={setHeight} currentHeight={100} />)
    expect(root(container).className).toContain('cursor-row-resize')
    fireEvent.mouseDown(root(container), { clientY: 50 })
    fireEvent.mouseMove(window, { clientY: 70 })
    expect(setHeight).toHaveBeenLastCalledWith(120)
    fireEvent.mouseUp(window)
    expect(onInsert).not.toHaveBeenCalled()
    // listeners are removed after mouseup
    fireEvent.mouseMove(window, { clientY: 200 })
    expect(setHeight).toHaveBeenCalledTimes(1)
  })

  it('measures the previous row when no height is stored', () => {
    const setHeight = vi.fn()
    const { container } = render(<div><div data-testid="prev" /><RowSeparator isAdmin onInsert={vi.fn()} setHeight={setHeight} /></div>)
    const prev = screen.getByTestId('prev')
    prev.getBoundingClientRect = () => ({ height: 60 }) as DOMRect
    fireEvent.mouseDown(prev.nextElementSibling as HTMLElement, { clientY: 0 })
    fireEvent.mouseMove(window, { clientY: 10 })
    expect(setHeight).toHaveBeenLastCalledWith(70)
    fireEvent.mouseUp(window)
    expect(container).toBeTruthy()
  })

  it('shows one plus per column when an admin hovers, none for a non-admin', () => {
    const { container, rerender } = render(<RowSeparator isAdmin onInsert={vi.fn()} gridTemplate="1fr 1fr 1fr" columnCount={3} />)
    expect(container.querySelectorAll('.pointer-events-none > div')).toHaveLength(0)
    fireEvent.mouseEnter(root(container))
    expect(container.querySelectorAll('.pointer-events-none > div')).toHaveLength(3)
    fireEvent.mouseLeave(root(container))
    expect(container.querySelectorAll('.pointer-events-none')).toHaveLength(0)
    rerender(<RowSeparator isAdmin={false} onInsert={vi.fn()} gridTemplate="1fr 1fr 1fr" columnCount={3} />)
    fireEvent.mouseEnter(root(container))
    expect(container.querySelectorAll('.pointer-events-none')).toHaveLength(0)
  })

  it('continues the hovered column strip through the row', () => {
    render(<RowSeparator isAdmin={false} onInsert={vi.fn()} gridTemplate="1fr 1fr" columnCount={2} hoveredSepIndex={1} />)
    expect(screen.getByTestId('row-separator-column-strip')).toBeInTheDocument()
  })
})
