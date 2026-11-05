/** The preset notice raised as an info toast in the shared region (#1146, #2107). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { ToastProvider } from '../contexts/ToastContext'
import {
  usePresetNoticeToast,
  PRESET_LINK_NOTICE_MS,
  PRESET_NOTICE_MS,
  PRESET_NOTICE_UNDO_HINT,
} from '../components/Board/usePresetNoticeToast'

type Notice = { id: number; message: string; reason?: string } | null

function Harness(props: { notice: Notice; onUndo: () => void; onDismiss: () => void; onReturnFocus?: () => void }) {
  usePresetNoticeToast(props)
  return null
}

describe('usePresetNoticeToast', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(notice: Notice = { id: 1, message: 'Reset to “Default”' }) {
    const props = { onUndo: vi.fn(), onDismiss: vi.fn(), onReturnFocus: vi.fn() }
    const ui = (n: Notice) => <ToastProvider><Harness notice={n} {...props} /></ToastProvider>
    const utils = render(ui(notice))
    return { ...utils, props, rerenderNotice: (n: Notice) => utils.rerender(ui(n)) }
  }

  it('raises an info toast with Undo and a dismiss button in the shared region', () => {
    const { props } = setup()
    const toast = screen.getByTestId('preset-notice')
    expect(toast).toHaveAttribute('data-variant', 'info')
    expect(toast).toHaveTextContent('Reset to “Default”')
    expect(screen.getByRole('region', { name: 'Notifications' })).toContainElement(toast)
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }))
    expect(props.onUndo).toHaveBeenCalledTimes(1)
    expect(props.onReturnFocus).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('preset-notice')).not.toBeInTheDocument()
  })

  it('reports a user dismissal and returns focus to the picker', () => {
    const { props } = setup()
    fireEvent.click(within(screen.getByTestId('preset-notice')).getByRole('button', { name: 'Dismiss notification' }))
    expect(props.onDismiss).toHaveBeenCalledTimes(1)
    expect(props.onReturnFocus).toHaveBeenCalledTimes(1)
    expect(props.onUndo).not.toHaveBeenCalled()
  })

  it('announces the message with the Undo hint', () => {
    setup()
    act(() => { vi.advanceTimersByTime(0) })
    expect(screen.getAllByRole('status').some((r) => r.textContent === `Reset to “Default”. ${PRESET_NOTICE_UNDO_HINT}`)).toBe(true)
  })

  it('auto-dismisses after 8 s and tells the owner', () => {
    const { props } = setup()
    act(() => { vi.advanceTimersByTime(PRESET_NOTICE_MS - 1) })
    expect(props.onDismiss).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(props.onDismiss).toHaveBeenCalledTimes(1)
    expect(props.onReturnFocus).not.toHaveBeenCalled()
    expect(screen.queryByTestId('preset-notice')).not.toBeInTheDocument()
  })

  it('keeps a link-applied preset for 20 s', () => {
    const { props } = setup({ id: 1, message: 'Applied “Default” from the link', reason: 'link' })
    act(() => { vi.advanceTimersByTime(PRESET_NOTICE_MS) })
    expect(props.onDismiss).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(PRESET_LINK_NOTICE_MS - PRESET_NOTICE_MS) })
    expect(props.onDismiss).toHaveBeenCalledTimes(1)
  })

  it('restarts the timer when a new notice replaces it, in place', () => {
    const { props, rerenderNotice } = setup()
    act(() => { vi.advanceTimersByTime(PRESET_NOTICE_MS - 100) })
    rerenderNotice({ id: 2, message: 'Applied “Classic”' })
    expect(screen.getAllByTestId('preset-notice')).toHaveLength(1)
    expect(screen.getByTestId('preset-notice')).toHaveTextContent('Applied “Classic”')
    act(() => { vi.advanceTimersByTime(PRESET_NOTICE_MS - 100) })
    expect(props.onDismiss).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(100) })
    expect(props.onDismiss).toHaveBeenCalledTimes(1)
  })

  it('removes the toast when the owner clears the notice, without calling onDismiss', () => {
    const { props, rerenderNotice } = setup()
    rerenderNotice(null)
    expect(screen.queryByTestId('preset-notice')).not.toBeInTheDocument()
    expect(props.onDismiss).not.toHaveBeenCalled()
  })

  it('pauses while the region is hovered', () => {
    const { props } = setup()
    const region = screen.getByRole('region', { name: 'Notifications' })
    fireEvent.pointerEnter(region, { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(PRESET_NOTICE_MS * 2) })
    expect(props.onDismiss).not.toHaveBeenCalled()
  })

  it('removes the toast on unmount', () => {
    const { unmount } = setup()
    unmount()
    expect(screen.queryByTestId('preset-notice')).not.toBeInTheDocument()
  })
})
