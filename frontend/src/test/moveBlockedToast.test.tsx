import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MoveBlockedToast from '../components/Board/MoveBlockedToast'
import type { MoveBlockedError } from '../hooks/useBoard'

const wipError: MoveBlockedError = {
  code: 'wip_limit_exceeded',
  column_name: 'In Progress',
  current_count: 3,
  wip_limit: 3,
}

const weightError: MoveBlockedError = {
  code: 'weight_limit_exceeded',
  column_name: 'Review',
  current_weight: 8,
  weight_limit: 10,
  card_weight: 5,
}

describe('MoveBlockedToast', () => {
  it('renders WIP limit title and body', () => {
    render(
      <MoveBlockedToast error={wipError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.getByText(/WIP limit reached/)).toBeInTheDocument()
    expect(screen.getByText(/"In Progress" is at its limit of 3 cards/)).toBeInTheDocument()
  })

  it('renders weight limit title and body', () => {
    render(
      <MoveBlockedToast error={weightError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.getByText(/Weight limit reached/)).toBeInTheDocument()
    expect(screen.getByText(/"Review" has 8 weight/)).toBeInTheDocument()
  })

  it('shows admin override button when isAdmin=true', () => {
    render(
      <MoveBlockedToast error={wipError} isAdmin={true} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.getByText(/Move anyway/)).toBeInTheDocument()
  })

  it('hides admin override button when isAdmin=false', () => {
    render(
      <MoveBlockedToast error={wipError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.queryByText(/Move anyway/)).not.toBeInTheDocument()
  })

  it('calls onForce when admin override is clicked', async () => {
    const onForce = vi.fn()
    render(
      <MoveBlockedToast error={wipError} isAdmin={true} onForce={onForce} onDismiss={vi.fn()} />
    )
    await userEvent.click(screen.getByText(/Move anyway/))
    expect(onForce).toHaveBeenCalledOnce()
  })

  it('calls onDismiss when dismiss button is clicked', async () => {
    const onDismiss = vi.fn()
    render(
      <MoveBlockedToast error={wipError} isAdmin={false} onForce={vi.fn()} onDismiss={onDismiss} />
    )
    await userEvent.click(screen.getByLabelText('Dismiss'))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('uses singular "card" when wip_limit is 1', () => {
    const singleLimit: MoveBlockedError = { ...wipError, wip_limit: 1, current_count: 1 }
    render(
      <MoveBlockedToast error={singleLimit} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.getByText(/limit of 1 card \(/)).toBeInTheDocument()
  })

  it('shows proposed weight in weight limit body', () => {
    // current_weight=8 + card_weight=5 = proposed 13, limit 10
    render(
      <MoveBlockedToast error={weightError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.getByText(/would reach 13 of 10/)).toBeInTheDocument()
  })

  it('has role="alert" for accessibility', () => {
    render(
      <MoveBlockedToast error={wipError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
