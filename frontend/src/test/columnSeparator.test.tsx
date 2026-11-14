import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import ColumnSeparator from '../components/Board/ColumnSeparator'

function setup(isAdmin: boolean) {
  const onOpenAdd = vi.fn()
  const setWidth = vi.fn()
  const { container } = render(
    <ColumnSeparator
      isAdmin={isAdmin}
      onOpenAdd={onOpenAdd}
      currentWidth={200}
      setWidth={setWidth}
      sepIndex={1}
      hoveredSepIndex={null}
      onSepHoverChange={vi.fn()}
    />,
  )
  return { sep: container.firstElementChild as HTMLElement, onOpenAdd, setWidth }
}

describe('ColumnSeparator (#1990)', () => {
  it('resizes while dragging past the threshold and does not open the add modal', () => {
    const { sep, onOpenAdd, setWidth } = setup(true)
    fireEvent.mouseDown(sep, { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 130 })
    expect(setWidth).toHaveBeenLastCalledWith(230)
    fireEvent.mouseUp(window)
    expect(onOpenAdd).not.toHaveBeenCalled()
    // Listeners are removed on release: further movement is ignored.
    setWidth.mockClear()
    fireEvent.mouseMove(window, { clientX: 300 })
    expect(setWidth).not.toHaveBeenCalled()
  })

  it('a click without a drag opens the add modal for an admin', () => {
    const { sep, onOpenAdd, setWidth } = setup(true)
    fireEvent.mouseDown(sep, { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 102 })
    fireEvent.mouseUp(window)
    expect(onOpenAdd).toHaveBeenCalledTimes(1)
    expect(setWidth).not.toHaveBeenCalled()
  })

  it('a click without a drag does nothing for a non-admin', () => {
    const { sep, onOpenAdd } = setup(false)
    fireEvent.mouseDown(sep, { clientX: 100 })
    fireEvent.mouseUp(window)
    expect(onOpenAdd).not.toHaveBeenCalled()
  })

  it('a non-admin can still drag to resize', () => {
    const { sep, setWidth } = setup(false)
    fireEvent.mouseDown(sep, { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 80 })
    expect(setWidth).toHaveBeenLastCalledWith(180)
    fireEvent.mouseUp(window)
  })
})
