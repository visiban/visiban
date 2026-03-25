import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { useBoardPan } from '../hooks/useBoardPan'

afterEach(() => {
  cleanup()
})

function makeScrollEl() {
  const el = document.createElement('div')
  // jsdom doesn't support real scroll, but we can write scrollLeft/scrollTop
  Object.defineProperty(el, 'scrollLeft', { writable: true, value: 0 })
  Object.defineProperty(el, 'scrollTop', { writable: true, value: 0 })
  document.body.appendChild(el)
  return el
}

function renderPan(el: HTMLDivElement) {
  return renderHook(() => {
    useBoardPan(el)
  })
}

describe('useBoardPan', () => {
  it('sets cursor grab on the scroll container when Space is held', () => {
    const el = makeScrollEl()
    renderPan(el)
    act(() => { fireEvent.keyDown(document, { code: 'Space' }) })
    expect(el.style.cursor).toBe('grab')
  })

  it('clears cursor when Space is released', () => {
    const el = makeScrollEl()
    renderPan(el)
    act(() => { fireEvent.keyDown(document, { code: 'Space' }) })
    act(() => { fireEvent.keyUp(document, { code: 'Space' }) })
    expect(el.style.cursor).toBe('')
  })

  it('does not arm pan when focus is inside an input', () => {
    const el = makeScrollEl()
    renderPan(el)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    act(() => { fireEvent.keyDown(document, { code: 'Space' }) })
    expect(el.style.cursor).toBe('')
    input.remove()
  })

  it('does not arm pan when focus is inside a textarea', () => {
    const el = makeScrollEl()
    renderPan(el)
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    act(() => { fireEvent.keyDown(document, { code: 'Space' }) })
    expect(el.style.cursor).toBe('')
    textarea.remove()
  })

  it('calls preventDefault on Space keydown to suppress browser scroll', () => {
    const el = makeScrollEl()
    renderPan(el)
    let prevented = false
    act(() => {
      const ev = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true })
      Object.defineProperty(ev, 'preventDefault', { value: () => { prevented = true } })
      document.dispatchEvent(ev)
    })
    expect(prevented).toBe(true)
  })

  it('does not arm pan on key repeat', () => {
    const el = makeScrollEl()
    renderPan(el)
    act(() => { fireEvent.keyDown(document, { code: 'Space', repeat: true }) })
    expect(el.style.cursor).toBe('')
  })

  it('sets cursor grabbing on mousedown while pan is armed', () => {
    const el = makeScrollEl()
    renderPan(el)
    act(() => { fireEvent.keyDown(document, { code: 'Space' }) })
    act(() => {
      fireEvent.mouseDown(el, { button: 0, clientX: 100, clientY: 50 })
    })
    expect(el.style.cursor).toBe('grabbing')
  })

  it('does not activate pan on non-primary button', () => {
    const el = makeScrollEl()
    renderPan(el)
    act(() => { fireEvent.keyDown(document, { code: 'Space' }) })
    act(() => { fireEvent.mouseDown(el, { button: 2, clientX: 100, clientY: 50 }) })
    expect(el.style.cursor).toBe('grab')
  })

  it('does not activate pan when mousedown target has data-no-pan', () => {
    const el = makeScrollEl()
    renderPan(el)
    const card = document.createElement('div')
    card.setAttribute('data-no-pan', '')
    el.appendChild(card)
    act(() => { fireEvent.keyDown(document, { code: 'Space' }) })
    act(() => { fireEvent.mouseDown(card, { button: 0, clientX: 100, clientY: 50 }) })
    expect(el.style.cursor).toBe('grab')
    card.remove()
  })

  it('translates mousemove into scrollLeft/scrollTop delta', () => {
    const el = makeScrollEl()
    ;(el as unknown as { scrollLeft: number }).scrollLeft = 200
    ;(el as unknown as { scrollTop: number }).scrollTop = 100
    renderPan(el)
    act(() => { fireEvent.keyDown(document, { code: 'Space' }) })
    act(() => { fireEvent.mouseDown(el, { button: 0, clientX: 50, clientY: 30 }) })
    act(() => { fireEvent.mouseMove(document, { clientX: 70, clientY: 50 }) })
    // dx=20, dy=20; new scrollLeft = 200-20=180, scrollTop=100-20=80
    expect((el as unknown as { scrollLeft: number }).scrollLeft).toBe(180)
    expect((el as unknown as { scrollTop: number }).scrollTop).toBe(80)
  })

  it('mousemove has no effect when pan is not active', () => {
    const el = makeScrollEl()
    ;(el as unknown as { scrollLeft: number }).scrollLeft = 100
    renderPan(el)
    act(() => { fireEvent.mouseMove(document, { clientX: 50, clientY: 50 }) })
    expect((el as unknown as { scrollLeft: number }).scrollLeft).toBe(100)
  })

  it('reverts cursor to grab after mouseup while Space is still held', () => {
    const el = makeScrollEl()
    renderPan(el)
    act(() => { fireEvent.keyDown(document, { code: 'Space' }) })
    act(() => { fireEvent.mouseDown(el, { button: 0, clientX: 0, clientY: 0 }) })
    act(() => { fireEvent.mouseUp(document) })
    expect(el.style.cursor).toBe('grab')
  })

  it('clears cursor completely on mouseup if Space was released mid-drag', () => {
    const el = makeScrollEl()
    renderPan(el)
    act(() => { fireEvent.keyDown(document, { code: 'Space' }) })
    act(() => { fireEvent.mouseDown(el, { button: 0, clientX: 0, clientY: 0 }) })
    act(() => { fireEvent.keyUp(document, { code: 'Space' }) })
    act(() => { fireEvent.mouseUp(document) })
    expect(el.style.cursor).toBe('')
  })

  it('disarms pan on window blur', () => {
    const el = makeScrollEl()
    renderPan(el)
    act(() => { fireEvent.keyDown(document, { code: 'Space' }) })
    expect(el.style.cursor).toBe('grab')
    act(() => { fireEvent.blur(window) })
    expect(el.style.cursor).toBe('')
  })

  it('clears cursor on unmount', () => {
    const el = makeScrollEl()
    const { unmount } = renderPan(el)
    act(() => { fireEvent.keyDown(document, { code: 'Space' }) })
    unmount()
    expect(el.style.cursor).toBe('')
  })

  it('does not move scroll after unmount', () => {
    const el = makeScrollEl()
    ;(el as unknown as { scrollLeft: number }).scrollLeft = 100
    const { unmount } = renderPan(el)
    act(() => { fireEvent.keyDown(document, { code: 'Space' }) })
    act(() => { fireEvent.mouseDown(el, { button: 0, clientX: 0, clientY: 0 }) })
    unmount()
    act(() => { fireEvent.mouseMove(document, { clientX: 50, clientY: 0 }) })
    expect((el as unknown as { scrollLeft: number }).scrollLeft).toBe(100)
  })
})
