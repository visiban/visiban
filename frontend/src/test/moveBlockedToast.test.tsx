import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import { ToastProvider } from '../contexts/ToastContext'
import userEvent from '@testing-library/user-event'
import MoveBlockedToast from '../components/Board/MoveBlockedToast'
import type { ReactNode } from 'react'

// The toast renders in the shared region (#2060), so tests mount the provider
// and query inside the visible toast, never the sr-only announcer beside it.
const wrap = (ui: ReactNode) => <ToastProvider>{ui}</ToastProvider>
const renderToast = (ui: ReactNode) => {
  const utils = render(wrap(ui))
  return { ...utils, rerender: (next: ReactNode) => utils.rerender(wrap(next)) }
}
const toast = () => within(screen.getByTestId('move-blocked-toast'))
import type { MoveBlockedError } from '../hooks/useBoard'
import { hardLimitContainer, isHardLimit, limitBlockedMessage, limitCounts, limitRefusal } from '../components/Board/moveBlockedMessages'
import type { LimitRefusal } from '../components/Board/moveBlockedMessages'

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
  it('has an explicit width so it does not shrink-wrap at narrow viewports (#1439)', () => {
    renderToast(<MoveBlockedToast error={wipError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />)
    // The shared region carries the width now (#2060).
    const region = screen.getByRole('region', { name: 'Notifications' })
    expect(region.className).toContain('w-max')
    expect(region.className).toContain('max-w-[min(24rem,calc(100%-2rem))]')
    expect(region.className).not.toContain('max-w-sm')
  })

  it('words the version-conflict body for both drag and detail-panel moves (#1773)', () => {
    renderToast(
      <MoveBlockedToast error={{ code: 'version_conflict', detail: 'x', current_version: 2 }} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(toast().getByText(/This card was modified by another user\. The board has been refreshed\./)).toBeInTheDocument()
    expect(toast().queryByText(/dragging/)).not.toBeInTheDocument()
  })

  it('renders WIP limit title and body', () => {
    renderToast(
      <MoveBlockedToast error={wipError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(toast().getByText(/WIP limit reached/)).toBeInTheDocument()
    expect(toast().getByText(/"In Progress" is at its limit of 3 cards/)).toBeInTheDocument()
  })

  it('renders weight limit title and body', () => {
    renderToast(
      <MoveBlockedToast error={weightError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(toast().getByText(/Weight limit reached/)).toBeInTheDocument()
    expect(toast().getByText(/"Review" has 8 weight/)).toBeInTheDocument()
  })

  it('shows admin override button when isAdmin=true', () => {
    renderToast(
      <MoveBlockedToast error={wipError} isAdmin={true} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(toast().getByText(/Move anyway/)).toBeInTheDocument()
  })

  it('hides admin override button when isAdmin=false', () => {
    renderToast(
      <MoveBlockedToast error={wipError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(toast().queryByText(/Move anyway/)).not.toBeInTheDocument()
  })

  it('calls onForce when admin override is clicked', async () => {
    const onForce = vi.fn()
    renderToast(
      <MoveBlockedToast error={wipError} isAdmin={true} onForce={onForce} onDismiss={vi.fn()} />
    )
    await userEvent.click(toast().getByText(/Move anyway/))
    expect(onForce).toHaveBeenCalledOnce()
  })

  it('calls onDismiss when dismiss button is clicked', async () => {
    const onDismiss = vi.fn()
    renderToast(
      <MoveBlockedToast error={wipError} isAdmin={false} onForce={vi.fn()} onDismiss={onDismiss} />
    )
    await userEvent.click(toast().getByRole('button', { name: 'Dismiss notification' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('uses singular "card" when wip_limit is 1', () => {
    const singleLimit: MoveBlockedError = { ...wipError, wip_limit: 1, current_count: 1 }
    renderToast(
      <MoveBlockedToast error={singleLimit} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(toast().getByText(/limit of 1 card \(/)).toBeInTheDocument()
  })

  it('shows proposed weight in weight limit body', () => {
    // current_weight=8 + card_weight=5 = proposed 13, limit 10
    renderToast(
      <MoveBlockedToast error={weightError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(toast().getByText(/would reach 13 of 10/)).toBeInTheDocument()
  })

  it('is announced assertively through the shared alert region, and persists', async () => {
    vi.useFakeTimers()
    try {
      renderToast(
        <MoveBlockedToast error={wipError} isAdmin={true} onForce={vi.fn()} onDismiss={vi.fn()} />
      )
      act(() => { vi.advanceTimersByTime(0) })
      const alert = screen.getByRole('alert')
      expect(alert).toHaveTextContent('WIP limit reached. "In Progress" is at its limit of 3 cards')
      expect(alert).toHaveTextContent('Move anyway (admin override) available.')
      expect(screen.getByTestId('move-blocked-toast')).toHaveAttribute('data-variant', 'blocked')
      act(() => { vi.advanceTimersByTime(10 * 60 * 1000) })
      expect(screen.getByTestId('move-blocked-toast')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('is only a visible mirror while an aria-modal surface is open (the Move popover reports inline)', () => {
    vi.useFakeTimers()
    try {
      const sheet = document.createElement('div')
      sheet.setAttribute('aria-modal', 'true')
      document.body.appendChild(sheet)
      renderToast(
        <MoveBlockedToast error={wipError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
      )
      act(() => { vi.advanceTimersByTime(0) })
      expect(screen.getByTestId('move-blocked-toast')).toBeInTheDocument()
      expect(screen.getByTestId('toast-announcer-assertive')).toHaveTextContent('')
      sheet.remove()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the override as pending while the forced move is in flight', async () => {
    let resolve: () => void = () => {}
    const onForce = vi.fn(() => new Promise<void>((r) => { resolve = r }))
    renderToast(
      <MoveBlockedToast error={wipError} isAdmin={true} onForce={onForce} onDismiss={vi.fn()} />
    )
    await userEvent.click(toast().getByRole('button', { name: 'Move anyway (admin override)' }))
    expect(toast().getByRole('button', { name: 'Moving anyway…' })).toHaveAttribute('aria-disabled', 'true')
    await act(async () => { resolve() })
    expect(toast().getByRole('button', { name: 'Move anyway (admin override)' })).not.toHaveAttribute('aria-disabled')
  })

  it('leaves the region when the board clears the error', () => {
    const { rerender } = renderToast(
      <MoveBlockedToast error={wipError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.getByTestId('move-blocked-toast')).toBeInTheDocument()
    rerender(null)
    expect(screen.queryByTestId('move-blocked-toast')).toBeNull()
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
    const { container } = renderToast(
      <MoveBlockedToast error={hardBlockError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(container.textContent).toContain('⛔')
    expect(container.textContent).not.toContain('⚠')
  })

  it('renders hard-block title "Column at capacity — no exceptions"', () => {
    renderToast(
      <MoveBlockedToast error={hardBlockError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(toast().getByText(/Column at capacity — no exceptions/)).toBeInTheDocument()
  })

  it('does NOT show admin override link for hard-blocked moves, even when isAdmin=true', () => {
    renderToast(
      <MoveBlockedToast error={hardBlockError} isAdmin={true} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(toast().queryByText(/Move anyway/)).not.toBeInTheDocument()
  })

  it('shows resolution copy for hard-blocked moves', () => {
    renderToast(
      <MoveBlockedToast error={hardBlockError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(toast().getByText(/To unblock, move a card out of/)).toBeInTheDocument()
    expect(toast().getByText(/ask an admin to raise the WIP limit/)).toBeInTheDocument()
  })

  it('toast stays amber (border-warning) for hard-blocked moves', () => {
    const { container } = renderToast(
      <MoveBlockedToast error={hardBlockError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(container.querySelector('[data-testid="move-blocked-toast"] .border-warning')).not.toBeNull()
  })
})

// ─── Permission-denied variant ─────────────────────────────────────────────

const permissionDeniedError: MoveBlockedError = {
  code: 'permission_denied',
  detail: 'Moving a card assigned to another member requires Moderator or Admin access — ask a board admin.',
}

describe('MoveBlockedToast — permission_denied variant', () => {
  it('renders title "Cannot move this card"', () => {
    renderToast(
      <MoveBlockedToast error={permissionDeniedError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(toast().getByText(/Cannot move this card/)).toBeInTheDocument()
  })

  it('renders the detail string from the error as the body', () => {
    renderToast(
      <MoveBlockedToast error={permissionDeniedError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(
      toast().getByText(/Moderator or Admin access — ask a board admin/)
    ).toBeInTheDocument()
  })

  it('does NOT show a "Move anyway" button — permission_denied is a hard block', () => {
    renderToast(
      <MoveBlockedToast error={permissionDeniedError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(toast().queryByText(/Move anyway/)).not.toBeInTheDocument()
  })

  it('does NOT show "Move anyway" even when isAdmin=true', () => {
    // The gate is a role/ownership check, not a WIP limit the admin can bypass.
    renderToast(
      <MoveBlockedToast error={permissionDeniedError} isAdmin={true} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(toast().queryByText(/Move anyway/)).not.toBeInTheDocument()
  })

  it('calls onDismiss when the dismiss button is clicked', async () => {
    const onDismiss = vi.fn()
    renderToast(
      <MoveBlockedToast error={permissionDeniedError} isAdmin={false} onForce={vi.fn()} onDismiss={onDismiss} />
    )
    await userEvent.click(toast().getByRole('button', { name: 'Dismiss notification' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('is a persistent blocked toast', () => {
    renderToast(
      <MoveBlockedToast error={permissionDeniedError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.getByTestId('move-blocked-toast')).toHaveAttribute('data-variant', 'blocked')
  })

  it('renders ⛔ icon (treated as hard block, same as wip_hard_blocked)', () => {
    const { container } = renderToast(
      <MoveBlockedToast error={permissionDeniedError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(container.textContent).toContain('⛔')
    expect(container.textContent).not.toContain('⚠')
  })

  it('toast retains amber border (permission_denied uses same styling as other blocks)', () => {
    const { container } = renderToast(
      <MoveBlockedToast error={permissionDeniedError} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(container.querySelector('[data-testid="move-blocked-toast"] .border-warning')).not.toBeNull()
  })
})

describe('MoveBlockedToast — maintenance mode (#783)', () => {
  const maintenanceError: MoveBlockedError = {
    code: 'maintenance_mode',
    detail: 'Upgrading to v1.3 — back by 3:00 PM UTC.',
  }

  it('shows the operator notice verbatim', () => {
    renderToast(
      <MoveBlockedToast
        error={maintenanceError}
        isAdmin={false}
        onForce={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    expect(toast().getByText(/The instance is temporarily read-only/)).toBeInTheDocument()
    expect(
      toast().getByText(/Upgrading to v1\.3 — back by 3:00 PM UTC\./)
    ).toBeInTheDocument()
  })

  it('leads with a fixed, non-admin-authored sentence distinguishing it from a personal permission error (#1127)', () => {
    // The operator's free-text detail can be terse or generic; the fixed
    // lead sentence is the structural cue that this is systemic, not
    // personal — it must appear even though it's not part of `detail`.
    renderToast(
      <MoveBlockedToast
        error={maintenanceError}
        isAdmin={false}
        onForce={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    expect(toast().getByText(/The instance is temporarily read-only/)).toBeInTheDocument()
    expect(toast().queryByText(/Cannot move this card/)).not.toBeInTheDocument()
  })

  it('uses a different title than permission_denied, even though both are no-override hard blocks', () => {
    const { rerender } = renderToast(
      <MoveBlockedToast
        error={maintenanceError}
        isAdmin={false}
        onForce={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    expect(toast().getByText(/The instance is temporarily read-only/)).toBeInTheDocument()

    rerender(
      <MoveBlockedToast
        error={{ code: 'permission_denied', detail: 'You lack permission.' }}
        isAdmin={false}
        onForce={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    expect(toast().getByText(/Cannot move this card/)).toBeInTheDocument()
    expect(toast().queryByText(/The instance is temporarily read-only/)).not.toBeInTheDocument()
  })

  it('offers no admin override — there is nothing to override', () => {
    // Unlike a WIP limit, maintenance mode has no force-through path for any
    // role, so the override link must be absent even when isAdmin is true.
    renderToast(
      <MoveBlockedToast
        error={maintenanceError}
        isAdmin
        onForce={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    expect(toast().queryByText(/Move anyway/)).not.toBeInTheDocument()
  })

  it('keeps the warning glyph rather than the hard-block glyph', () => {
    // frontend/CLAUDE.md reserves ⛔ for wip_hard_blocked alone.
    const { container } = renderToast(
      <MoveBlockedToast
        error={maintenanceError}
        isAdmin={false}
        onForce={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    expect(container.textContent).toContain('⚠')
    expect(container.textContent).not.toContain('⛔')
  })

  it('is still dismissible', () => {
    const onDismiss = vi.fn()
    renderToast(
      <MoveBlockedToast
        error={maintenanceError}
        isAdmin={false}
        onForce={vi.fn()}
        onDismiss={onDismiss}
      />
    )
    expect(toast().getByRole('button', { name: 'Dismiss notification' })).toBeInTheDocument()
  })

  it('renders the generic move_failed variant with no override (#1761)', () => {
    const error: MoveBlockedError = { code: 'move_failed', detail: 'A network error occurred.' }
    renderToast(<MoveBlockedToast error={error} isAdmin={true} onForce={vi.fn()} onDismiss={vi.fn()} />)
    expect(toast().getByText('Move failed')).toBeInTheDocument()
    expect(toast().getByText(/A network error occurred\./)).toBeInTheDocument()
    expect(toast().queryByText(/Move anyway/)).not.toBeInTheDocument()
  })
})

// Shared by the toast copy, the inline create/restore surfaces and CardDetail's
// Move popover (#1428, #1772).
describe('moveBlockedMessages limit helpers (#1772)', () => {
  const wip = { code: 'wip_limit_exceeded', column_name: 'In Progress', current_count: 3, wip_limit: 3 } as const
  const hard = { code: 'wip_hard_blocked', column_name: 'In Progress', current_count: 1, wip_limit: 1 } as const
  const weight = { code: 'weight_limit_exceeded', column_name: 'In Progress', current_weight: 8, card_weight: 3, weight_limit: 10 } as const
  const fail = (status: number, data: unknown) => ({ response: { status, data } })

  it.each([wip, hard, weight])('limitRefusal returns the typed body for $code', (body) => {
    expect(limitRefusal(fail(409, body))).toEqual(body)
  })

  it.each([
    ['another 409 code', fail(409, { code: 'version_conflict', detail: 'x', current_version: 2 })],
    ['a limit body on a non-409', fail(400, wip)],
    ['a 409 with no body', fail(409, undefined)],
    ['a network error', new Error('Network Error')],
    ['null', null],
  ])('limitRefusal returns null for %s', (_label, err) => {
    expect(limitRefusal(err)).toBeNull()
  })

  it('limitCounts gives the WIP numbers, plural', () => {
    expect(limitCounts(wip as LimitRefusal)).toBe('Limit 3 cards, 3 active.')
  })

  it('limitCounts uses the singular for a limit of 1, hard block included', () => {
    expect(limitCounts(hard as LimitRefusal)).toBe('Limit 1 card, 1 active.')
  })

  it('limitCounts gives the weight numbers without the column name', () => {
    const text = limitCounts(weight as LimitRefusal)
    expect(text).toBe('Weight would reach 11 of 10 (this card +3).')
    expect(text).not.toContain('In Progress')
  })

  it('limitBlockedMessage is unchanged: toast title and body for limit codes, null otherwise', () => {
    expect(limitBlockedMessage(fail(409, wip))).toBe('WIP limit reached: "In Progress" is at its limit of 3 cards (3 active).')
    expect(limitBlockedMessage(fail(409, hard))).toBe('Column at capacity — no exceptions: "In Progress" is at its limit of 1 card (1 active).')
    expect(limitBlockedMessage(fail(409, weight))).toBe('Weight limit reached: "In Progress" has 8 weight — adding this card (+3) would reach 11 of 10.')
    expect(limitBlockedMessage(fail(409, { code: 'version_conflict' }))).toBeNull()
    expect(limitBlockedMessage(new Error('x'))).toBeNull()
  })
})

describe('MoveBlockedToast — swimlane limits (#1150)', () => {
  const laneSoft: MoveBlockedError = {
    code: 'swimlane_wip_limit_exceeded', column_name: 'Ready', swimlane_name: 'Payouts',
    current_count: 5, wip_limit: 5,
  }
  const laneHard: MoveBlockedError = {
    code: 'swimlane_wip_hard_blocked', column_name: 'Ready', swimlane_name: 'Identity',
    current_count: 1, wip_limit: 1,
  }
  const laneWeight: MoveBlockedError = {
    code: 'swimlane_weight_limit_exceeded', column_name: 'Ready', swimlane_name: 'Payouts',
    current_weight: 8, weight_limit: 10, card_weight: 3,
  }

  it('names the row in a soft block and offers the admin override', async () => {
    const onForce = vi.fn()
    renderToast(<MoveBlockedToast error={laneSoft} isAdmin onForce={onForce} onDismiss={vi.fn()} />)
    expect(toast().getByText(/WIP limit reached/)).toBeInTheDocument()
    expect(toast().getByText(/Swimlane "Payouts" is at its limit of 5 cards \(5 active\)\./)).toBeInTheDocument()
    expect(toast().getByText('⚠')).toBeInTheDocument()
    await userEvent.click(toast().getByRole('button', { name: /Move anyway/ }))
    expect(onForce).toHaveBeenCalledOnce()
  })

  it('treats a hard row block like a hard column block: ⛔, no override, a row hint', () => {
    renderToast(<MoveBlockedToast error={laneHard} isAdmin onForce={vi.fn()} onDismiss={vi.fn()} />)
    expect(toast().getByText('⛔')).toBeInTheDocument()
    expect(toast().getByText(/Swimlane at capacity — no exceptions/)).toBeInTheDocument()
    expect(toast().queryByRole('button', { name: /Move anyway/ })).not.toBeInTheDocument()
    expect(toast().getByText('To unblock, move a card out of Identity, or ask an admin to raise the WIP limit.')).toBeInTheDocument()
  })

  it('words the row weight block', () => {
    renderToast(<MoveBlockedToast error={laneWeight} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />)
    expect(toast().getByText(/Weight limit reached/)).toBeInTheDocument()
    expect(toast().getByText(/Swimlane "Payouts" has 8 weight — adding this card \(\+3\) would reach 11 of 10\./)).toBeInTheDocument()
  })

  it('names the other tripped limit on a second line when both tripped', () => {
    renderToast(
      <MoveBlockedToast
        error={{ ...laneHard, also: ['Column "Ready" is at its WIP limit (3/3), admins can override.'] }}
        isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()}
      />,
    )
    expect(toast().getByText('Also: Column "Ready" is at its WIP limit (3/3), admins can override.')).toBeInTheDocument()
  })

  it('shows no second line when only one limit tripped', () => {
    renderToast(<MoveBlockedToast error={laneSoft} isAdmin={false} onForce={vi.fn()} onDismiss={vi.fn()} />)
    expect(toast().queryByText(/^Also:/)).not.toBeInTheDocument()
  })
})

describe('moveBlockedMessages swimlane helpers (#1150)', () => {
  const fail = (status: number, data: unknown) => ({ response: { status, data } })
  const soft = { code: 'swimlane_wip_limit_exceeded', column_name: 'Ready', swimlane_name: 'Payouts', current_count: 2, wip_limit: 2 } as const
  const hard = { code: 'swimlane_wip_hard_blocked', column_name: 'Ready', swimlane_name: 'Payouts', current_count: 1, wip_limit: 1 } as const
  const weight = { code: 'swimlane_weight_limit_exceeded', column_name: 'Ready', swimlane_name: 'Payouts', current_weight: 4, card_weight: 2, weight_limit: 5 } as const

  it.each([soft, hard, weight])('limitRefusal returns the typed body for $code', (body) => {
    expect(limitRefusal(fail(409, body))).toEqual(body)
  })

  it('limitCounts names the row, since the popover names only the column', () => {
    expect(limitCounts(soft as LimitRefusal)).toBe('Swimlane "Payouts": limit 2 cards, 2 active.')
    expect(limitCounts(hard as LimitRefusal)).toBe('Swimlane "Payouts": limit 1 card, 1 active.')
    expect(limitCounts(weight as LimitRefusal)).toBe('Swimlane "Payouts": weight would reach 6 of 5 (this card +2).')
  })

  it('limitBlockedMessage gives the inline create/restore copy', () => {
    expect(limitBlockedMessage(fail(409, soft))).toBe('WIP limit reached: Swimlane "Payouts" is at its limit of 2 cards (2 active).')
    expect(limitBlockedMessage(fail(409, hard))).toBe('Swimlane at capacity — no exceptions: Swimlane "Payouts" is at its limit of 1 card (1 active).')
  })

  it('isHardLimit and hardLimitContainer cover both hard codes', () => {
    expect(isHardLimit('wip_hard_blocked')).toBe(true)
    expect(isHardLimit('swimlane_wip_hard_blocked')).toBe(true)
    expect(isHardLimit('swimlane_wip_limit_exceeded')).toBe(false)
    expect(hardLimitContainer(hard)).toBe('Payouts')
    expect(hardLimitContainer({ code: 'wip_hard_blocked', column_name: 'Ready', current_count: 1, wip_limit: 1 })).toBe('Ready')
    expect(hardLimitContainer(soft)).toBeNull()
  })
})
