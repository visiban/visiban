/** The invite-join confirmation as a persistent success toast (#998, #1444, #2107). */
import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ToastProvider } from '../contexts/ToastContext'
import { useJoinedToast } from '../components/Common/useJoinedToast'

function Harness({ title }: { title: string | null }) {
  useJoinedToast(title)
  return null
}

describe('useJoinedToast', () => {
  it('raises a success toast and dismisses on click', () => {
    render(<ToastProvider><Harness title="You've joined Platform. Welcome!" /></ToastProvider>)
    const toast = screen.getByTestId('joined-notice')
    expect(toast).toHaveTextContent("You've joined Platform. Welcome!")
    expect(toast).toHaveAttribute('data-variant', 'success')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByTestId('joined-notice')).not.toBeInTheDocument()
  })

  it('never dismisses itself', () => {
    vi.useFakeTimers()
    try {
      render(<ToastProvider><Harness title="Joined" /></ToastProvider>)
      act(() => { vi.advanceTimersByTime(10 * 60_000) })
      expect(screen.getByTestId('joined-notice')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('raises nothing without a title, and leaves with the page', () => {
    const { unmount } = render(<ToastProvider><Harness title={null} /></ToastProvider>)
    expect(screen.queryByTestId('joined-notice')).not.toBeInTheDocument()
    const second = render(<ToastProvider><Harness title="Joined" /></ToastProvider>)
    expect(screen.getByTestId('joined-notice')).toBeInTheDocument()
    second.unmount()
    unmount()
    expect(screen.queryByTestId('joined-notice')).not.toBeInTheDocument()
  })
})
