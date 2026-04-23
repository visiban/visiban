import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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

  it('shows a visible "Connecting…" label while connecting', () => {
    render(<ConnectionStatus status="connecting" lastEventAt={null} />)
    const trigger = screen.getByRole('button', { name: /Connecting to real-time updates/i })
    expect(trigger).toHaveTextContent(/Connecting/)
  })

  it('shows a visible "Reconnecting…" label while reconnecting', () => {
    render(<ConnectionStatus status="reconnecting" lastEventAt={null} reconnectAttempt={3} />)
    const trigger = screen.getByRole('button', { name: /Reconnecting to real-time updates/i })
    expect(trigger).toHaveTextContent(/Reconnecting/)
  })

  it('shows an "Offline" badge when failed', () => {
    render(<ConnectionStatus status="failed" lastEventAt={null} />)
    const trigger = screen.getByRole('button', { name: /Real-time updates unavailable/i })
    expect(trigger).toHaveTextContent(/Offline/)
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
    await user.click(screen.getByRole('button', { name: /Real-time updates unavailable/i }))

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
