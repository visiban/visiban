import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAutosaveStatus } from '../hooks/useAutosaveStatus'

describe('useAutosaveStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('moves saved -> fading out -> idle on its own timers', async () => {
    const { result } = renderHook(() => useAutosaveStatus())

    await act(async () => {
      await result.current.runSave(Promise.resolve())
    })
    expect(result.current.status).toBe('saved')
    expect(result.current.fadingOut).toBe(false)

    act(() => { vi.advanceTimersByTime(1700) })
    expect(result.current.fadingOut).toBe(true)

    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.status).toBe('idle')
    expect(result.current.fadingOut).toBe(false)
  })

  // Regression guard (#1305): the "saved" -> fade -> idle sequence is driven
  // by two setTimeout timers (fadeTimer/resetTimer) that outlive the save
  // itself. Unmounting a consumer (CardDetail, CustomFieldEditRow,
  // SwimlaneFieldEditRow) while either is pending must clear them, not fire
  // setStatus/setFadingOut against a torn-down hook instance.
  it('clears the pending fade/reset timers on unmount, without throwing', async () => {
    const { result, unmount } = renderHook(() => useAutosaveStatus())

    await act(async () => {
      await result.current.runSave(Promise.resolve())
    })
    expect(result.current.status).toBe('saved')

    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => unmount()).not.toThrow()
    expect(clearSpy).toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    // Advancing timers past both delays after unmount must not throw or warn
    // (there is nothing left to update, but a leaked timer would still fire).
    expect(() => act(() => { vi.advanceTimersByTime(2000) })).not.toThrow()
    expect(errorSpy).not.toHaveBeenCalled()

    clearSpy.mockRestore()
    errorSpy.mockRestore()
  })
})
