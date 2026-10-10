import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import JoinedNotice from '../components/Common/JoinedNotice'

// #1444 — the joined strip shared by GroupDetail and the board.
describe('JoinedNotice', () => {
  it('renders its message in the success strip and dismisses on click', async () => {
    const onDismiss = vi.fn()
    render(<JoinedNotice onDismiss={onDismiss}>You've joined <strong>Platform</strong>. Welcome!</JoinedNotice>)
    expect(screen.getByText(/You've joined/)).toHaveTextContent("You've joined Platform. Welcome!")
    expect(screen.getByText(/You've joined/).parentElement).toHaveClass('bg-success/20', 'text-success-on-tint')
    expect(screen.getByRole('status')).toHaveTextContent("You've joined Platform. Welcome!")
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does not dismiss itself', () => {
    vi.useFakeTimers()
    render(<JoinedNotice onDismiss={vi.fn()}>Joined</JoinedNotice>)
    vi.advanceTimersByTime(60_000)
    expect(screen.getByText('Joined')).toBeInTheDocument()
    vi.useRealTimers()
  })
})
