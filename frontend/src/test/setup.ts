import '@testing-library/jest-dom'

// jsdom does not implement PointerEvent.  Polyfill it as a MouseEvent subclass
// so tests that exercise real @dnd-kit/core sensors (which check event.isPrimary
// and event.button) can dispatch pointer events without mocking the library.
// Tests that mock @dnd-kit/core entirely are unaffected.
if (typeof window !== 'undefined' && !('PointerEvent' in window)) {
  class PointerEvent extends MouseEvent {
    readonly pointerId: number
    readonly isPrimary: boolean
    readonly pointerType: string

    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params)
      this.pointerId = params.pointerId ?? 0
      this.isPrimary = params.isPrimary ?? false
      this.pointerType = params.pointerType ?? 'mouse'
    }
  }
  Object.defineProperty(window, 'PointerEvent', { value: PointerEvent, writable: true })
}
