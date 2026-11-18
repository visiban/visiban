import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConnectionStatus from '../components/Common/ConnectionStatus'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-04-23T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ConnectionStatus', () => {
  it('is quiet when connected — only a dot and the Live label at lg+', () => {
    render(<ConnectionStatus status="connected" lastEventAt={Date.now()} />)
    const trigger = screen.getByRole('button', { name: 'Real-time updates active' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('pulses degraded dots with a reduced-motion opt-out, never the healthy or offline dot (#199)', () => {
    const dotOf = (status: 'connected' | 'connecting' | 'reconnecting' | 'failed') => {
      const { container, unmount } = render(<ConnectionStatus status={status} lastEventAt={null} />)
      const cls = container.querySelector('button span[aria-hidden="true"]')!.className
      unmount()
      return cls
    }
    expect(dotOf('connecting')).toMatch(/animate-pulse motion-reduce:animate-none/)
    expect(dotOf('reconnecting')).toMatch(/animate-pulse motion-reduce:animate-none/)
    expect(dotOf('connected')).not.toMatch(/animate-pulse/)
    expect(dotOf('failed')).not.toMatch(/animate-pulse/)
  })

  it('shows a visible "Connecting…" label while connecting', () => {
    render(<ConnectionStatus status="connecting" lastEventAt={null} />)
    const trigger = screen.getByRole('button', { name: /Connecting to real-time updates/i })
    expect(trigger).toHaveTextContent(/Connecting/)
  })

  it('reads "Offline" while reconnecting, matching the board banner (#2325)', () => {
    render(<ConnectionStatus status="reconnecting" lastEventAt={null} reconnectAttempt={3} reconnectingLabel="Offline" />)
    const trigger = screen.getByRole('button', { name: 'Offline, reconnecting to real-time updates' })
    expect(trigger).toHaveTextContent('Offline')
    expect(trigger).not.toHaveTextContent(/Reconnecting…/)
  })

  it('reads "Reconnecting…" by default and takes a reconnectingLabel override', () => {
    const { rerender } = render(<ConnectionStatus status="reconnecting" lastEventAt={null} />)
    expect(screen.getByRole('button', { name: /reconnecting to real-time updates/i })).toHaveTextContent('Reconnecting…')
    rerender(<ConnectionStatus status="reconnecting" lastEventAt={null} reconnectingLabel="Offline" />)
    expect(screen.getByRole('button', { name: /reconnecting to real-time updates/i })).toHaveTextContent('Offline')
  })

  it('popover text has no literal unicode escape', () => {
    const { rerender } = render(<ConnectionStatus status="connecting" lastEventAt={null} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('dialog')).toHaveTextContent('Establishing real-time connection…')
    expect(screen.getByRole('dialog').textContent).not.toContain('\\')
    rerender(<ConnectionStatus status="reconnecting" lastEventAt={null} reconnectAttempt={3} />)
    expect(screen.getByRole('dialog')).toHaveTextContent('Reconnecting… attempt 3.')
    expect(screen.getByRole('dialog').textContent).not.toContain('\\')
  })

  it('shows an "Offline" badge when failed', () => {
    render(<ConnectionStatus status="failed" lastEventAt={null} />)
    const trigger = screen.getByRole('button', { name: /Offline, real-time updates unavailable/i })
    expect(trigger).toHaveTextContent(/Offline/)
    // #2342: AA text on the danger tint (plain text-danger was 2.98:1 on light surface)
    expect(trigger.className).toContain('text-danger-on-tint')
    expect(trigger.className).not.toMatch(/(^|\s)text-danger(\s|$)/)
  })

  it('shows a Stale badge when connected but no events for > 60 s', () => {
    const { rerender } = render(
      <ConnectionStatus status="connected" lastEventAt={Date.now() - 30_000} />,
    )
    expect(screen.getByRole('button')).toHaveAccessibleName(/Real-time updates active/i)

    rerender(<ConnectionStatus status="connected" lastEventAt={Date.now() - 90_000} />)
    expect(screen.getByRole('button')).toHaveAccessibleName(/Real-time updates delayed/i)
    expect(screen.getByRole('button')).toHaveTextContent(/Stale/)
  })

  it('opens the popover on click with connected copy + Refresh button', async () => {
    const onRefresh = vi.fn()
    vi.useRealTimers()
    const user = userEvent.setup()
    render(<ConnectionStatus status="connected" lastEventAt={Date.now()} onRefresh={onRefresh} />)
    await user.click(screen.getByRole('button', { name: /Real-time updates active/i }))

    const dialog = await screen.findByRole('dialog', { name: 'Connection status' })
    expect(dialog).toHaveTextContent(/Real-time updates active/i)

    await user.click(screen.getByRole('button', { name: 'Refresh board' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('shows the attempt count in the reconnecting popover', async () => {
    vi.useRealTimers()
    const user = userEvent.setup()
    render(<ConnectionStatus status="reconnecting" lastEventAt={null} reconnectAttempt={5} />)
    await user.click(screen.getByRole('button'))

    const dialog = await screen.findByRole('dialog', { name: 'Connection status' })
    expect(dialog).toHaveTextContent(/attempt 5/)
  })

  it('failed state popover shows Reload page — calls the injected reload impl', async () => {
    vi.useRealTimers()
    const user = userEvent.setup()
    const onReloadPage = vi.fn()
    render(
      <ConnectionStatus status="failed" lastEventAt={null} onReloadPage={onReloadPage} />,
    )
    await user.click(screen.getByRole('button', { name: /Offline, real-time updates unavailable/i }))

    const reload = await screen.findByRole('button', { name: 'Reload page' })
    await user.click(reload)
    expect(onReloadPage).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape and refocuses the trigger', async () => {
    vi.useRealTimers()
    const user = userEvent.setup()
    render(<ConnectionStatus status="connected" lastEventAt={Date.now()} />)
    const trigger = screen.getByRole('button', { name: /Real-time updates active/i })
    await user.click(trigger)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes when clicking outside', async () => {
    vi.useRealTimers()
    const user = userEvent.setup()
    render(
      <div>
        <ConnectionStatus status="connected" lastEventAt={Date.now()} />
        <div data-testid="outside">outside</div>
      </div>,
    )
    await user.click(screen.getByRole('button', { name: /Real-time updates active/i }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await user.click(screen.getByTestId('outside'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('propagates tourStep onto the trigger (onboarding tour anchor)', () => {
    render(
      <ConnectionStatus status="connected" lastEventAt={Date.now()} tourStep="live-indicator" />,
    )
    expect(screen.getByRole('button')).toHaveAttribute('data-tour-step', 'live-indicator')
  })
})

// #1171: the panel is anchored once at click time, so it closes on window resize
// and on a scroll outside it rather than staying behind a trigger that moved.
describe('ConnectionStatus viewport dismissals (#1171)', () => {
  const openPanel = async () => {
    vi.useRealTimers()
    render(<ConnectionStatus status="connected" lastEventAt={Date.now()} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /Real-time updates active/i }))
    expect(await screen.findByRole('dialog', { name: 'Connection status' })).toBeInTheDocument()
  }

  it('closes on window resize', async () => {
    await openPanel()
    fireEvent(window, new Event('resize'))
    expect(screen.queryByRole('dialog', { name: 'Connection status' })).not.toBeInTheDocument()
  })

  it('closes on a scroll outside the panel, not on one inside it', async () => {
    await openPanel()
    fireEvent.scroll(screen.getByRole('dialog', { name: 'Connection status' }))
    expect(screen.getByRole('dialog', { name: 'Connection status' })).toBeInTheDocument()
    fireEvent.scroll(document)
    expect(screen.queryByRole('dialog', { name: 'Connection status' })).not.toBeInTheDocument()
  })
})

describe('ConnectionStatus on phones (#2348)', () => {
  it('hides only the healthy dot below 640px when asked', () => {
    const { rerender } = render(<ConnectionStatus status="connected" lastEventAt={Date.now()} hideWhenHealthyOnPhone />)
    expect(screen.getByRole('button', { name: 'Real-time updates active', hidden: true })).toHaveClass('max-sm:hidden')
    rerender(<ConnectionStatus status="reconnecting" lastEventAt={null} hideWhenHealthyOnPhone />)
    expect(screen.getByRole('button', { name: /Offline, reconnecting/ })).not.toHaveClass('max-sm:hidden')
    rerender(<ConnectionStatus status="connected" lastEventAt={Date.now()} />)
    expect(screen.getByRole('button', { name: 'Real-time updates active' })).not.toHaveClass('max-sm:hidden')
  })

  it('lifts the details panel buttons to 44px below 640px (#2350)', () => {
    // The panel is portaled to document.body, out of reach of any toolbar rule, so its root carries the rule.
    // Not swept in board-phone.spec.ts: a phone only shows the dot when unhealthy, and the e2e stub cannot hold
    // a stale or failed state long enough to open it.
    render(<ConnectionStatus status="failed" lastEventAt={null} onReloadPage={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Offline, real-time updates unavailable' }))
    const panel = screen.getByRole('dialog', { name: 'Connection status' })
    expect(panel).toHaveClass('max-sm:[&_button]:min-h-11')
    expect(panel.parentElement).toBe(document.body)
  })

  it('keeps its live region mounted outside the trigger so a hidden healthy dot still announces a change', () => {
    const { rerender } = render(<ConnectionStatus status="connected" lastEventAt={Date.now()} hideWhenHealthyOnPhone />)
    const region = screen.getByRole('status', { hidden: true })
    expect(region.closest('button')).toBeNull()
    rerender(<ConnectionStatus status="failed" lastEventAt={null} hideWhenHealthyOnPhone />)
    expect(screen.getByRole('status')).toHaveTextContent('Offline, real-time updates unavailable')
  })
})
