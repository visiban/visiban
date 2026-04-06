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

// ─── Hard-block variant (#341) ─────────────────────────────────────────────

const hardBlockError: MoveBlockedError = {
  code: 'wip_hard_blocked',
  column_name: 'In Progress',
  current_count: 3,
  wip_limit: 3,
}

describe('MoveBlockedToast — hard-block variant', () => {
  it('renders ⛔ icon (not ⚠) for hard-blocked moves', () => {
    const { container } = render(
      <MoveBlockedToast error={hardBlockError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(container.textContent).toContain('⛔')
    expect(container.textContent).not.toContain('⚠')
  })

  it('renders hard-block title "Column at capacity — no exceptions"', () => {
    render(
      <MoveBlockedToast error={hardBlockError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.getByText(/Column at capacity — no exceptions/)).toBeInTheDocument()
  })

  it('does NOT show admin override link for hard-blocked moves, even when isAdmin=true', () => {
    render(
      <MoveBlockedToast error={hardBlockError} isAdmin={true} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.queryByText(/Move anyway/)).not.toBeInTheDocument()
  })

  it('shows resolution copy for hard-blocked moves', () => {
    render(
      <MoveBlockedToast error={hardBlockError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.getByText(/To unblock, move a card out of/)).toBeInTheDocument()
    expect(screen.getByText(/ask an admin to raise the WIP limit/)).toBeInTheDocument()
  })

  it('toast stays amber (border-amber-600) for hard-blocked moves', () => {
    const { container } = render(
      <MoveBlockedToast error={hardBlockError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    const alert = container.querySelector('[role="alert"]') as HTMLElement
    expect(alert.className).toContain('border-amber-600')
  })
})

// ─── Permission-denied variant ─────────────────────────────────────────────

const permissionDeniedError: MoveBlockedError = {
  code: 'permission_denied',
  detail: 'Moving a card assigned to another member requires Moderator or Admin access — ask a board admin.',
}

describe('MoveBlockedToast — permission_denied variant', () => {
  it('renders title "Cannot move this card"', () => {
    render(
      <MoveBlockedToast error={permissionDeniedError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.getByText(/Cannot move this card/)).toBeInTheDocument()
  })

  it('renders the detail string from the error as the body', () => {
    render(
      <MoveBlockedToast error={permissionDeniedError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(
      screen.getByText(/Moderator or Admin access — ask a board admin/)
    ).toBeInTheDocument()
  })

  it('does NOT show a "Move anyway" button — permission_denied is a hard block', () => {
    render(
      <MoveBlockedToast error={permissionDeniedError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.queryByText(/Move anyway/)).not.toBeInTheDocument()
  })

  it('does NOT show "Move anyway" even when isAdmin=true', () => {
    // The gate is a role/ownership check, not a WIP limit the admin can bypass.
    render(
      <MoveBlockedToast error={permissionDeniedError} isAdmin={true} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.queryByText(/Move anyway/)).not.toBeInTheDocument()
  })

  it('calls onDismiss when the dismiss button is clicked', async () => {
    const onDismiss = vi.fn()
    render(
      <MoveBlockedToast error={permissionDeniedError} isAdmin={false} onForce={vi.fn()} onDismiss={onDismiss} />
    )
    await userEvent.click(screen.getByLabelText('Dismiss'))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('renders with role="alert" for accessibility', () => {
    render(
      <MoveBlockedToast error={permissionDeniedError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('renders ⛔ icon (treated as hard block, same as wip_hard_blocked)', () => {
    const { container } = render(
      <MoveBlockedToast error={permissionDeniedError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(container.textContent).toContain('⛔')
    expect(container.textContent).not.toContain('⚠')
  })

  it('toast retains amber border (permission_denied uses same styling as other blocks)', () => {
    const { container } = render(
      <MoveBlockedToast error={permissionDeniedError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    const alert = container.querySelector('[role="alert"]') as HTMLElement
    expect(alert.className).toContain('border-amber-600')
  })
})
