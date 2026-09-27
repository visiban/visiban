import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import DemoWriteBlockedToast, { DEMO_TOAST_MS } from '../components/Board/DemoWriteBlockedToast'

const fire = (message: string) =>
  act(() => { window.dispatchEvent(new CustomEvent('auth:demoWriteBlocked', { detail: { message } })) })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('DemoWriteBlockedToast (#1179 safety net)', () => {
  it('renders nothing until a refusal arrives', () => {
    render(<DemoWriteBlockedToast />)
    expect(screen.queryByTestId('demo-write-blocked-toast')).not.toBeInTheDocument()
  })

  it('shows the fixed title with the server detail, politely, then clears itself', () => {
    render(<DemoWriteBlockedToast />)
    fire("This is a shared demo — this change can't be saved here.")
    const toast = screen.getByTestId('demo-write-blocked-toast')
    expect(toast).toHaveAttribute('role', 'status')
    expect(toast).toHaveAttribute('aria-live', 'polite')
    // The lead clause is not doubled when the server detail already carries it.
    expect(toast).toHaveTextContent("This is a shared demo — this change can't be saved here.")
    expect(toast.textContent?.match(/This is a shared demo/g)).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(DEMO_TOAST_MS) })
    expect(screen.queryByTestId('demo-write-blocked-toast')).not.toBeInTheDocument()
  })
})
