import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { ToastProvider, ToastRegionSlot } from '../contexts/ToastContext'
import { useToast } from '../contexts/useToast'
import type { ToastApi } from '../contexts/useToast'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { usePublishedHeight } from '../hooks/usePublishedHeight'

const holder: { api: ToastApi | null } = { api: null }
function Capture() {
  const toast = useToast()
  useEffect(() => { holder.api = toast }, [toast])
  return null
}
const api: ToastApi = {
  notify: (input) => holder.api!.notify(input),
  dismiss: (keyOrId) => holder.api!.dismiss(keyOrId),
}

function setup(extra?: React.ReactNode) {
  return render(
    <ToastProvider>
      <button type="button">outside</button>
      <Capture />
      {extra}
    </ToastProvider>,
  )
}

const region = () => screen.getByRole('region', { name: 'Notifications' })
const polite = () => screen.getByTestId('toast-announcer-polite')
const assertive = () => screen.getByTestId('toast-announcer-assertive')
const tick = () => act(() => { vi.advanceTimersByTime(0) })
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('ToastProvider — region and announcements (#2060)', () => {
  it('renders no region until a toast is raised, then one labelled region', () => {
    setup()
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull()
    act(() => { api.notify({ variant: 'success', title: 'Unblocked "Payment flow" after 3d 5h' }) })
    expect(region()).toHaveAttribute('data-keeps-card-sheet-open')
    expect(region().className).toContain('z-[55]')
    expect(within(region()).getByText('Unblocked "Payment flow" after 3d 5h')).toBeInTheDocument()
  })

  it('keeps both live regions mounted, fills them one tick later, never makes the toast itself live', () => {
    setup()
    expect(polite()).toHaveAttribute('aria-live', 'polite')
    expect(polite()).toHaveAttribute('role', 'status')
    expect(assertive()).toHaveAttribute('role', 'alert')
    expect(polite().className).toContain('sr-only')
    act(() => { api.notify({ variant: 'info', title: 'Board imported', action: { label: 'Undo', onAction: () => {} } }) })
    expect(polite()).toHaveTextContent('')
    tick()
    expect(polite()).toHaveTextContent('Board imported. Undo available.')
    expect(assertive()).toHaveTextContent('')
    expect(region().querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull()
  })

  it('announces blocked and danger assertively', () => {
    setup()
    act(() => { api.notify({ variant: 'danger', title: "Couldn't delete the board", message: 'Try again.' }) })
    tick()
    expect(assertive()).toHaveTextContent("Couldn't delete the board. Try again.")
    expect(polite()).toHaveTextContent('')
  })

  it('announce: false shows the toast without announcing it', () => {
    setup()
    act(() => { api.notify({ variant: 'success', title: 'Mirror only', announce: false }) })
    tick()
    expect(within(region()).getByText('Mirror only')).toBeInTheDocument()
    expect(polite()).toHaveTextContent('')
  })

  it('coalescing by key re-announces only when the text changed', () => {
    setup()
    act(() => { api.notify({ key: 'move', variant: 'blocked', title: 'WIP limit reached' }) })
    tick()
    expect(assertive()).toHaveTextContent('WIP limit reached.')
    act(() => { api.notify({ key: 'move', variant: 'blocked', title: 'WIP limit reached' }) })
    tick()
    expect(assertive()).toHaveTextContent('WIP limit reached.')
    expect(within(region()).getAllByText('WIP limit reached')).toHaveLength(1)
    act(() => { api.notify({ key: 'move', variant: 'blocked', title: 'Move failed' }) })
    expect(assertive()).toHaveTextContent('')
    tick()
    expect(assertive()).toHaveTextContent('Move failed.')
    expect(within(region()).queryByText('WIP limit reached')).toBeNull()
  })

  it('shows a +N waiting line when every slot is protected', () => {
    setup()
    act(() => {
      api.notify({ variant: 'blocked', title: 'a' })
      api.notify({ variant: 'danger', title: 'b' })
      api.notify({ variant: 'blocked', title: 'c' })
      api.notify({ variant: 'success', title: 'd' })
    })
    expect(within(region()).getByTestId('toast-waiting')).toHaveTextContent('+1 waiting')
    tick()
    // The waiting line is not live, so the queue growing is announced.
    expect(polite()).toHaveTextContent('1 more notification waiting.')
    expect(within(region()).queryByText('d')).toBeNull()
    // Dismissing one lets the waiting toast in.
    fireEvent.click(within(region()).getAllByRole('button', { name: 'Dismiss notification' })[0])
    expect(within(region()).getByText('d')).toBeInTheDocument()
    expect(within(region()).queryByTestId('toast-waiting')).toBeNull()
  })

  it('stacks the highest priority nearest the anchor (first in the DOM)', () => {
    setup()
    act(() => {
      api.notify({ variant: 'success', title: 'ok', testId: 'ok' })
      api.notify({ variant: 'danger', title: 'fail', testId: 'fail' })
      api.notify({ variant: 'warning', title: 'warn', testId: 'warn' })
    })
    const ids = Array.from(region().querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid'))
    expect(ids).toEqual(['fail', 'warn', 'ok'])
    expect(region().className).toContain('flex-col-reverse')
  })

  it('renders in a ToastRegionSlot when one is mounted', () => {
    setup(<div data-testid="slot-host"><ToastRegionSlot /></div>)
    act(() => { api.notify({ variant: 'info', title: 'x' }) })
    expect(within(screen.getByTestId('slot-host')).getByRole('region', { name: 'Notifications' })).toBeInTheDocument()
  })

  it('outside a provider useToast is a no-op', () => {
    const { result } = renderHook(() => useToast())
    expect(result.current.notify({ variant: 'info', title: 'x' })).toBe(-1)
    expect(() => result.current.dismiss('x')).not.toThrow()
  })
})

describe('ToastProvider — timing (#2060)', () => {
  it('auto-dismisses success after 4 s and reports the timeout', () => {
    const onDismiss = vi.fn()
    setup()
    act(() => { api.notify({ variant: 'success', title: 'done', onDismiss }) })
    advance(3999)
    expect(within(region()).getByText('done')).toBeInTheDocument()
    advance(1)
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull()
    expect(onDismiss).toHaveBeenCalledWith('timeout')
  })

  it('keeps blocked and danger until dismissed', () => {
    setup()
    act(() => { api.notify({ variant: 'blocked', title: 'stay' }) })
    advance(10 * 60 * 1000)
    expect(within(region()).getByText('stay')).toBeInTheDocument()
  })

  it('pauses on hover and restarts the full delay after', () => {
    setup()
    act(() => { api.notify({ variant: 'info', title: 'read me' }) })
    advance(5000)
    fireEvent.pointerEnter(region(), { pointerType: 'mouse' })
    advance(60000)
    expect(within(region()).getByText('read me')).toBeInTheDocument()
    fireEvent.pointerLeave(region(), { pointerType: 'mouse' })
    advance(5999)
    expect(within(region()).getByText('read me')).toBeInTheDocument()
    advance(1)
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull()
  })

  it('a touch or pen pointer never pauses the stack', () => {
    setup()
    act(() => { api.notify({ variant: 'success', title: 'tapped' }) })
    fireEvent.pointerEnter(region(), { pointerType: 'touch' })
    advance(4000)
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull()
  })

  it('dismissing the focused toast resumes the timers of the others', () => {
    setup()
    act(() => {
      api.notify({ variant: 'blocked', title: 'stay', testId: 'stay' })
      api.notify({ variant: 'success', title: 'timed', testId: 'timed' })
    })
    const outside = screen.getByRole('button', { name: 'outside' })
    act(() => { outside.focus() })
    const close = within(screen.getByTestId('stay')).getByRole('button', { name: 'Dismiss notification' })
    act(() => { close.focus() })
    fireEvent.click(close)
    expect(outside).toHaveFocus()
    advance(4000)
    expect(screen.queryByTestId('timed')).toBeNull()
  })

  it('an evicted toast that held focus hands focus back', () => {
    setup()
    act(() => {
      api.notify({ variant: 'success', title: 'a', testId: 'a' })
      api.notify({ variant: 'success', title: 'b' })
      api.notify({ variant: 'success', title: 'c' })
    })
    const outside = screen.getByRole('button', { name: 'outside' })
    act(() => { outside.focus() })
    act(() => { within(screen.getByTestId('a')).getByRole('button', { name: 'Dismiss notification' }).focus() })
    act(() => { api.notify({ variant: 'warning', title: 'd' }) })
    expect(screen.queryByTestId('a')).toBeNull()
    expect(outside).toHaveFocus()
  })

  it('pauses while focus is inside the region', () => {
    setup()
    act(() => { api.notify({ variant: 'success', title: 'focus me' }) })
    const close = within(region()).getByRole('button', { name: 'Dismiss notification' })
    act(() => { close.focus() })
    advance(60000)
    expect(within(region()).getByText('focus me')).toBeInTheDocument()
    act(() => { screen.getByRole('button', { name: 'outside' }).focus() })
    advance(4000)
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull()
  })

  it('pauses while the tab is hidden', () => {
    setup()
    act(() => { api.notify({ variant: 'success', title: 'hidden tab' }) })
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    advance(60000)
    expect(within(region()).getByText('hidden tab')).toBeInTheDocument()
    hidden.mockReturnValue(false)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    advance(4000)
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull()
    hidden.mockRestore()
  })

  it('freezes the timer while an action is pending and shows its progress label', async () => {
    setup()
    let resolve: () => void = () => {}
    const onAction = vi.fn(() => new Promise<void>((r) => { resolve = r }))
    act(() => { api.notify({ variant: 'warning', title: 'Over limit', action: { label: 'Undo', pendingLabel: 'Undoing…', onAction } }) })
    fireEvent.click(within(region()).getByRole('button', { name: 'Undo' }))
    const pending = within(region()).getByRole('button', { name: 'Undoing…' })
    expect(pending).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(pending)
    expect(onAction).toHaveBeenCalledTimes(1)
    advance(60000)
    expect(within(region()).getByText('Over limit')).toBeInTheDocument()
    await act(async () => { resolve() })
    expect(within(region()).getByRole('button', { name: 'Undo' })).not.toHaveAttribute('aria-disabled')
    advance(8000)
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull()
  })

  it('dismiss(key) removes the toast without calling onDismiss', () => {
    const onDismiss = vi.fn()
    setup()
    act(() => { api.notify({ key: 'k', variant: 'blocked', title: 'owned', onDismiss }) })
    act(() => { api.dismiss('k') })
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull()
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('reports an eviction to the evicted toast', () => {
    const onDismiss = vi.fn()
    setup()
    act(() => {
      api.notify({ variant: 'success', title: 'old', onDismiss })
      api.notify({ variant: 'success', title: 'b' })
      api.notify({ variant: 'success', title: 'c' })
      api.notify({ variant: 'success', title: 'd' })
    })
    expect(onDismiss).toHaveBeenCalledWith('evicted')
    expect(within(region()).queryByText('old')).toBeNull()
  })
})

describe('ToastProvider — dismissal, Escape and the Undo guard (#2060)', () => {
  it('× dismisses, reports it, and returns focus to where the user was', () => {
    const onDismiss = vi.fn()
    setup()
    act(() => { api.notify({ variant: 'blocked', title: 'refused', onDismiss }) })
    const outside = screen.getByRole('button', { name: 'outside' })
    act(() => { outside.focus() })
    const close = within(region()).getByRole('button', { name: 'Dismiss notification' })
    act(() => { close.focus() })
    fireEvent.click(close)
    expect(onDismiss).toHaveBeenCalledWith('user')
    expect(outside).toHaveFocus()
  })

  it('the × is a 24px target on desktop and 44px at <= 1024px', () => {
    setup()
    act(() => { api.notify({ variant: 'info', title: 'x' }) })
    const cls = within(region()).getByRole('button', { name: 'Dismiss notification' }).className
    expect(cls).toContain('w-6 h-6')
    expect(cls).toContain('max-[1024px]:w-11')
    expect(cls).toContain('max-[1024px]:h-11')
  })

  it('Escape at 61 dismisses only the focused toast and outranks the palette (60)', () => {
    const palette = vi.fn()
    function Palette() {
      useEscapeStack(() => { palette() }, 60)
      return null
    }
    setup(<Palette />)
    act(() => {
      api.notify({ variant: 'blocked', title: 'one', testId: 'one' })
      api.notify({ variant: 'blocked', title: 'two', testId: 'two' })
    })
    act(() => { within(screen.getByTestId('one')).getByRole('button', { name: 'Dismiss notification' }).focus() })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('one')).toBeNull()
    expect(screen.getByTestId('two')).toBeInTheDocument()
    expect(palette).not.toHaveBeenCalled()
  })

  it('Escape falls through when no toast is focused', () => {
    const lower = vi.fn()
    function Lower() {
      useEscapeStack(() => { lower() }, 30)
      return null
    }
    setup(<Lower />)
    act(() => { api.notify({ variant: 'blocked', title: 'stay' }) })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(lower).toHaveBeenCalledTimes(1)
    expect(within(region()).getByText('stay')).toBeInTheDocument()
  })

  it('an Undo toast cannot be dismissed for 5 s, then can; it lasts 12 s', () => {
    setup()
    act(() => { api.notify({ variant: 'warning', title: 'Over swimlane limit', action: { label: 'Undo', onAction: () => {}, undo: true } }) })
    const close = within(region()).getByRole('button', { name: 'Dismiss notification' })
    expect(close).toHaveAttribute('aria-disabled', 'true')
    expect(close).toHaveAccessibleDescription('Available in a few seconds')
    fireEvent.click(close)
    act(() => { close.focus() })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(within(region()).getByText('Over swimlane limit')).toBeInTheDocument()
    act(() => { screen.getByRole('button', { name: 'outside' }).focus() })
    advance(5000)
    expect(close).not.toHaveAttribute('aria-disabled')
    advance(6999)
    expect(within(region()).getByText('Over swimlane limit')).toBeInTheDocument()
    advance(1)
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull()
  })
})

describe('usePublishedHeight (#2060)', () => {
  it('publishes the element height as a CSS variable while mounted', () => {
    function Bar() {
      const ref = useRef<HTMLDivElement>(null)
      usePublishedHeight(ref, '--bulk-toolbar-h')
      useEffect(() => {}, [])
      return <div ref={ref} />
    }
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(48)
    const { unmount } = render(<Bar />)
    expect(document.documentElement.style.getPropertyValue('--bulk-toolbar-h')).toBe('48px')
    unmount()
    expect(document.documentElement.style.getPropertyValue('--bulk-toolbar-h')).toBe('')
    vi.restoreAllMocks()
  })

  it('the region floats above the toolbar through that variable', () => {
    setup()
    act(() => { api.notify({ variant: 'info', title: 'x' }) })
    expect(region().style.bottom).toBe('calc(1.5rem + var(--bulk-toolbar-h, -0.5rem))')
  })
})
