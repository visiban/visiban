/** The info notice after a board preset is applied or reset (#1146). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import PresetNoticeToast, { PRESET_LINK_NOTICE_MS, PRESET_NOTICE_MS } from '../components/Board/PresetNoticeToast'

describe('PresetNoticeToast', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function renderToast(overrides: Partial<React.ComponentProps<typeof PresetNoticeToast>> = {}) {
    const props = { noticeId: 1, message: 'Reset to “Default”', onUndo: vi.fn(), onDismiss: vi.fn(), ...overrides }
    return { ...render(<PresetNoticeToast {...props} />), props }
  }

  it('shows the message with Undo and a dismiss button', () => {
    const { props } = renderToast()
    expect(screen.getByTestId('preset-notice')).toHaveTextContent('Reset to “Default”')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(props.onUndo).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(props.onDismiss).toHaveBeenCalledTimes(1)
  })

  it('returns focus to the originating control after Undo or dismiss', () => {
    const onReturnFocus = vi.fn()
    renderToast({ onReturnFocus })
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(onReturnFocus).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(onReturnFocus).toHaveBeenCalledTimes(2)
  })

  it('announces through a status region that mounts empty', () => {
    renderToast()
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('')
    act(() => { vi.advanceTimersByTime(0) })
    expect(status).toHaveTextContent('Reset to “Default”. Undo is also in the Preset menu.')
  })

  it('auto-dismisses after the delay', () => {
    const { props } = renderToast()
    act(() => { vi.advanceTimersByTime(PRESET_NOTICE_MS - 1) })
    expect(props.onDismiss).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(props.onDismiss).toHaveBeenCalledTimes(1)
  })

  it('honors a longer delay, used for a link-applied preset', () => {
    const { props } = renderToast({ durationMs: PRESET_LINK_NOTICE_MS })
    act(() => { vi.advanceTimersByTime(PRESET_NOTICE_MS) })
    expect(props.onDismiss).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(PRESET_LINK_NOTICE_MS - PRESET_NOTICE_MS) })
    expect(props.onDismiss).toHaveBeenCalledTimes(1)
  })

  it('pauses while hovered and restarts the full delay after', () => {
    const { props } = renderToast()
    const notice = screen.getByTestId('preset-notice')
    fireEvent.mouseEnter(notice)
    act(() => { vi.advanceTimersByTime(PRESET_NOTICE_MS * 2) })
    expect(props.onDismiss).not.toHaveBeenCalled()
    fireEvent.mouseLeave(notice)
    act(() => { vi.advanceTimersByTime(PRESET_NOTICE_MS - 1) })
    expect(props.onDismiss).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(props.onDismiss).toHaveBeenCalledTimes(1)
  })

  it('pauses while it holds keyboard focus', () => {
    const { props } = renderToast()
    const undo = screen.getByRole('button', { name: 'Undo' })
    fireEvent.focus(undo)
    act(() => { vi.advanceTimersByTime(PRESET_NOTICE_MS * 2) })
    expect(props.onDismiss).not.toHaveBeenCalled()
    // Moving focus between its own buttons keeps it paused.
    fireEvent.blur(undo, { relatedTarget: screen.getByRole('button', { name: 'Dismiss notification' }) })
    act(() => { vi.advanceTimersByTime(PRESET_NOTICE_MS * 2) })
    expect(props.onDismiss).not.toHaveBeenCalled()
    fireEvent.blur(undo, { relatedTarget: document.body })
    act(() => { vi.advanceTimersByTime(PRESET_NOTICE_MS) })
    expect(props.onDismiss).toHaveBeenCalledTimes(1)
  })

  it('restarts the timer when a new notice replaces it', () => {
    const { props, rerender } = renderToast()
    act(() => { vi.advanceTimersByTime(PRESET_NOTICE_MS - 100) })
    rerender(<PresetNoticeToast {...props} noticeId={2} message={'Applied “Classic”'} />)
    act(() => { vi.advanceTimersByTime(PRESET_NOTICE_MS - 100) })
    expect(props.onDismiss).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(100) })
    expect(props.onDismiss).toHaveBeenCalledTimes(1)
  })
})
