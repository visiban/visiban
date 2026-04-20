import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { useRef } from 'react'
import { useDropdownEscape } from '../hooks/useDropdownEscape'
import { useEscapeStack } from '../hooks/useEscapeStack'

afterEach(() => {
  cleanup()
})

describe('useDropdownEscape', () => {
  it('calls onClose and returns focus to trigger when Escape is pressed and dropdown is open', () => {
    const onClose = vi.fn()
    const triggerEl = document.createElement('button')
    const focusSpy = vi.spyOn(triggerEl, 'focus')

    renderHook(() => {
      const ref = { current: triggerEl }
      useDropdownEscape(true, onClose, ref)
    })

    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })

    expect(onClose).toHaveBeenCalledOnce()
    expect(focusSpy).toHaveBeenCalledOnce()
  })

  it('does not call onClose when dropdown is closed (returns false to pass through)', () => {
    const onClose = vi.fn()
    const triggerEl = document.createElement('button')

    renderHook(() => {
      const ref = { current: triggerEl }
      useDropdownEscape(false, onClose, ref)
    })

    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not fire onClose for non-Escape keys', () => {
    const onClose = vi.fn()
    const triggerEl = document.createElement('button')

    renderHook(() => {
      const ref = { current: triggerEl }
      useDropdownEscape(true, onClose, ref)
    })

    act(() => { fireEvent.keyDown(document, { key: 'Enter' }) })
    act(() => { fireEvent.keyDown(document, { key: 'Tab' }) })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('dropdown (priority 25) is closed before a lower-priority handler fires', () => {
    const callOrder: string[] = []
    const onClose = vi.fn(() => { callOrder.push('dropdown') })
    const lowPriorityHandler = vi.fn(() => { callOrder.push('low') })
    const triggerEl = document.createElement('button')

    // Register both: dropdown at priority 25 (via useDropdownEscape), low at 0
    renderHook(() => {
      const ref = { current: triggerEl }
      useDropdownEscape(true, onClose, ref)
    })
    renderHook(() => useEscapeStack(lowPriorityHandler, 0))

    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })

    // Dropdown fires first and consumes the event — low handler must not fire
    expect(callOrder).toEqual(['dropdown'])
    expect(lowPriorityHandler).not.toHaveBeenCalled()
  })

  it('lower-priority handler fires when dropdown is closed (does not consume the event)', () => {
    const callOrder: string[] = []
    const onClose = vi.fn(() => { callOrder.push('dropdown') })
    const lowPriorityHandler = vi.fn(() => { callOrder.push('low') })
    const triggerEl = document.createElement('button')

    // Dropdown is closed — returns false, so lower handler should fire
    renderHook(() => {
      const ref = { current: triggerEl }
      useDropdownEscape(false, onClose, ref)
    })
    renderHook(() => useEscapeStack(lowPriorityHandler, 0))

    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })

    expect(onClose).not.toHaveBeenCalled()
    expect(callOrder).toEqual(['low'])
  })

  it('higher-priority handler (e.g. modal at 40) fires before dropdown', () => {
    const callOrder: string[] = []
    const onClose = vi.fn(() => { callOrder.push('dropdown') })
    const modalHandler = vi.fn(() => { callOrder.push('modal') })
    const triggerEl = document.createElement('button')

    renderHook(() => {
      const ref = { current: triggerEl }
      useDropdownEscape(true, onClose, ref)
    })
    // Modal at priority 40 — above dropdown's 25
    renderHook(() => useEscapeStack(modalHandler, 40))

    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })

    // Modal consumes first; dropdown never fires
    expect(callOrder).toEqual(['modal'])
    expect(onClose).not.toHaveBeenCalled()
  })

  it('deregisters handler on unmount so Escape no longer triggers onClose', () => {
    const onClose = vi.fn()
    const triggerEl = document.createElement('button')

    const { unmount } = renderHook(() => {
      const ref = { current: triggerEl }
      useDropdownEscape(true, onClose, ref)
    })

    unmount()
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })

    expect(onClose).not.toHaveBeenCalled()
  })
})
