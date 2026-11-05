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

  it('raises nothing without a title', () => {
    render(<ToastProvider><Harness title={null} /></ToastProvider>)
    expect(screen.queryByTestId('joined-notice')).not.toBeInTheDocument()
  })

  it('leaves with the page: only the consumer unmounts, the provider stays', () => {
    const ui = (on: boolean) => <ToastProvider>{on && <Harness title="Joined" />}</ToastProvider>
    const { rerender } = render(ui(true))
    expect(screen.getByTestId('joined-notice')).toBeInTheDocument()
    rerender(ui(false))
    expect(screen.queryByTestId('joined-notice')).not.toBeInTheDocument()
  })

  it('survives the title staying the same across re-renders', () => {
    const ui = () => <ToastProvider><Harness title="Joined" /></ToastProvider>
    const { rerender } = render(ui())
    rerender(ui())
    expect(screen.getByTestId('joined-notice')).toBeInTheDocument()
  })
})
