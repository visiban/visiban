import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import ColumnSeparator from '../components/Board/ColumnSeparator'

function setup(isAdmin: boolean) {
  const onOpenAdd = vi.fn()
  const { container } = render(
    <ColumnSeparator isAdmin={isAdmin} onOpenAdd={onOpenAdd} sepIndex={1} hoveredSepIndex={null} onSepHoverChange={vi.fn()} />,
  )
  return { sep: container.firstElementChild as HTMLElement, onOpenAdd }
}

// #1990, #2300: the separator inserts a column on click; columns share the grid
// template, so there is no drag-to-resize.
describe('ColumnSeparator (#1990, #2300)', () => {
  it('a click without a drag opens the add modal for an admin, on release', () => {
    const { sep, onOpenAdd } = setup(true)
    fireEvent.mouseDown(sep, { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 102 })
    expect(onOpenAdd).not.toHaveBeenCalled()
    fireEvent.mouseUp(window)
    expect(onOpenAdd).toHaveBeenCalledTimes(1)
    // Listeners are removed on release.
    fireEvent.mouseUp(window)
    expect(onOpenAdd).toHaveBeenCalledTimes(1)
  })

  it('a drag past the threshold is not a click and does not open the add modal', () => {
    const { sep, onOpenAdd } = setup(true)
    fireEvent.mouseDown(sep, { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 150 })
    fireEvent.mouseUp(window)
    expect(onOpenAdd).not.toHaveBeenCalled()
  })

  it('a click does nothing for a non-admin', () => {
    const { sep, onOpenAdd } = setup(false)
    fireEvent.mouseDown(sep, { clientX: 100 })
    fireEvent.mouseUp(window)
    expect(onOpenAdd).not.toHaveBeenCalled()
  })

  it('has no resize cursor and no fixed width: it fills its grid track', () => {
    const { sep } = setup(true)
    expect(sep.className).not.toContain('cursor-col-resize')
    expect(sep.className).toContain('cursor-pointer')
    expect(sep.style.width).toBe('')
  })
})
