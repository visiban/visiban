import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import DemoWriteBlockedToast, { DEMO_TOAST_MS } from '../components/Board/DemoWriteBlockedToast'
import { ToastProvider } from '../contexts/ToastContext'

const fire = (message: string) =>
  act(() => { window.dispatchEvent(new CustomEvent('auth:demoWriteBlocked', { detail: { message } })) })

const renderToast = () => render(<ToastProvider><DemoWriteBlockedToast /></ToastProvider>)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('DemoWriteBlockedToast (#1179 safety net)', () => {
  it('renders nothing until a refusal arrives', () => {
    renderToast()
    expect(screen.queryByTestId('demo-write-blocked-toast')).not.toBeInTheDocument()
  })

  it('shows the fixed title with the server detail, politely, then clears itself after 8 s', () => {
    renderToast()
    fire("This is a shared demo — this change can't be saved here.")
    const toast = screen.getByTestId('demo-write-blocked-toast')
    // A `warning` in the shared region (#2060); the announcement goes through the polite region.
    expect(toast).toHaveAttribute('data-variant', 'warning')
    // The lead clause is not doubled when the server detail already carries it.
    expect(toast).toHaveTextContent("This is a shared demo — this change can't be saved here.")
    expect(toast.textContent?.match(/This is a shared demo/g)).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(0) })
    const polite = screen.getByTestId('toast-announcer-polite')
    expect(polite).toHaveAttribute('aria-live', 'polite')
    expect(polite).toHaveTextContent("This is a shared demo — this change can't be saved here.")
    expect(screen.getByTestId('toast-announcer-assertive')).toHaveTextContent('')
    expect(DEMO_TOAST_MS).toBe(8000)
    act(() => { vi.advanceTimersByTime(DEMO_TOAST_MS - 1) })
    expect(screen.getByTestId('demo-write-blocked-toast')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByTestId('demo-write-blocked-toast')).not.toBeInTheDocument()
  })

  it('a second refusal replaces the first instead of stacking', () => {
    renderToast()
    fire('first')
    fire('second')
    expect(screen.getAllByTestId('demo-write-blocked-toast')).toHaveLength(1)
    expect(screen.getByTestId('demo-write-blocked-toast')).toHaveTextContent('second')
  })

  it('reads as the title alone when the server sends no detail', () => {
    renderToast()
    fire('')
    act(() => { vi.advanceTimersByTime(0) })
    expect(screen.getByTestId('toast-announcer-polite')).toHaveTextContent('This is a shared demo.')
  })

  it('sits in the shared region, which has an explicit width (#1439)', () => {
    renderToast()
    fire('x')
    const region = screen.getByRole('region', { name: 'Notifications' })
    expect(region).toContainElement(screen.getByTestId('demo-write-blocked-toast'))
    expect(region.className).toContain('w-max')
    expect(region.className).toContain('max-w-[min(24rem,calc(100%-2rem))]')
    expect(region.className).not.toContain('max-w-sm')
  })
})
