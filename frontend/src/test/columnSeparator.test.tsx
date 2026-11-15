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

function setupClickOnly(isAdmin = true) {
  const onOpenAdd = vi.fn()
  const { container } = render(
    <ColumnSeparator isAdmin={isAdmin} onOpenAdd={onOpenAdd} sepIndex={0} hoveredSepIndex={null} onSepHoverChange={vi.fn()} />,
  )
  return { sep: container.firstElementChild as HTMLElement, onOpenAdd }
}

// #1990, #2300: a click inserts a column; a drag resizes the column to the left,
// which under the shared grid template changes that column's track weight.
describe('ColumnSeparator (#1990, #2300)', () => {
  it('resizes while dragging past the threshold and does not open the add modal', () => {
    const { sep, onOpenAdd, setWidth } = setup(true)
    fireEvent.mouseDown(sep, { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 130 })
    // jsdom has no layout, so the track is unmeasured: the drag adds to the saved width.
    expect(setWidth).toHaveBeenLastCalledWith(230)
    fireEvent.mouseUp(window)
    expect(onOpenAdd).not.toHaveBeenCalled()
    // Listeners are removed on release: further movement is ignored.
    setWidth.mockClear()
    fireEvent.mouseMove(window, { clientX: 300 })
    expect(setWidth).not.toHaveBeenCalled()
  })

  it('keeps the dragged edge under the pointer when the track can be measured', () => {
    const { sep, setWidth } = setup(true)
    sep.parentElement!.style.gridTemplateColumns = '16px minmax(0, 1fr) 8px minmax(0, 3fr) 16px'
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => (
      el === sep.parentElement
        ? ({ display: 'grid', gridTemplateColumns: '16px 100px 8px 300px 16px' } as CSSStyleDeclaration)
        : ({ display: 'block', gridTemplateColumns: 'none' } as CSSStyleDeclaration)
    ))
    fireEvent.mouseDown(sep, { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 150 })
    fireEvent.mouseUp(window)
    spy.mockRestore()
    // 1fr of 4 renders at 100 of the 400px fr space. To render at 150 it needs
    // 400 * f / (3 + f) = 150, so f = 1.8: the saved 200 becomes 360. Scaling by
    // the track alone (300) would leave the edge 15px behind the pointer.
    expect(setWidth).toHaveBeenLastCalledWith(360)
  })

  it('a non-admin can still drag to resize', () => {
    const { sep, setWidth } = setup(false)
    fireEvent.mouseDown(sep, { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 80 })
    expect(setWidth).toHaveBeenLastCalledWith(180)
    fireEvent.mouseUp(window)
  })

  it('a tiny drag on a resizable separator still inserts, and does not resize', () => {
    const { sep, onOpenAdd, setWidth } = setup(true)
    fireEvent.mouseDown(sep, { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 103 })
    fireEvent.mouseUp(window)
    expect(onOpenAdd).toHaveBeenCalledTimes(1)
    expect(setWidth).not.toHaveBeenCalled()
  })

  it('a separator with no setWidth is click-only: no resize cursor, a drag does not throw', () => {
    const { sep, onOpenAdd } = setupClickOnly()
    expect(sep.className).not.toContain('cursor-col-resize')
    expect(sep.className).toContain('cursor-pointer')
    fireEvent.mouseDown(sep, { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 150 })
    fireEvent.mouseUp(window)
    expect(onOpenAdd).not.toHaveBeenCalled()
  })

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

  it('has a resize cursor and no fixed width: it fills its grid track', () => {
    const { sep } = setup(true)
    expect(sep.className).toContain('cursor-col-resize')
    expect(sep.style.width).toBe('')
  })
})
