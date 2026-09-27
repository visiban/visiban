/**
 * DemoModeBar + useDemoCountdown (#1179), on a fake clock: normal state, the
 * 5-minute warning (on time, not a tick late), and rollover across midnight.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import DemoModeBar from '../components/Common/DemoModeBar'
import { formatClockTime } from '../utils/date'

const RESET = '2026-09-27T13:00:00Z'
const at = (iso: string) => vi.setSystemTime(new Date(iso))

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('DemoModeBar', () => {
  it('normal state: mode tone, reset time, minutes remaining, no warning glyph', () => {
    at('2026-09-27T12:30:00Z')
    render(<DemoModeBar nextResetAt={RESET} />)
    const bar = screen.getByTestId('demo-mode-bar')
    expect(bar).toHaveAttribute('data-state', 'normal')
    expect(bar.className).toContain('bg-primary/15')
    expect(bar).toHaveTextContent('Shared demo')
    expect(bar).toHaveTextContent(`Resets at ${formatClockTime(RESET)} (in 30 min) · your changes and session will be cleared`)
    expect(bar).not.toHaveTextContent('⚠')
  })

  it('refreshes the minute label as time passes', () => {
    at('2026-09-27T12:30:00Z')
    render(<DemoModeBar nextResetAt={RESET} />)
    act(() => { vi.advanceTimersByTime(10 * 60_000) })
    expect(screen.getByTestId('demo-mode-bar')).toHaveTextContent('(in 20 min)')
  })

  it('flips to the amber warning exactly 5 minutes before the reset, and stays there', () => {
    at('2026-09-27T12:54:50Z')
    render(<DemoModeBar nextResetAt={RESET} />)
    expect(screen.getByTestId('demo-mode-bar')).toHaveAttribute('data-state', 'normal')
    // 10s later is the threshold — well inside one 30s tick, so this proves
    // the boundary timer, not the interval, drives the flip.
    act(() => { vi.advanceTimersByTime(10_000) })
    const bar = screen.getByTestId('demo-mode-bar')
    expect(bar).toHaveAttribute('data-state', 'warning')
    expect(bar.className).toContain('bg-warning/10')
    expect(bar).toHaveTextContent("⚠Demo resets in 5 minutes — you'll be signed out")
    expect(bar).not.toHaveTextContent('min)')
    act(() => { vi.advanceTimersByTime(4 * 60_000) })
    expect(screen.getByTestId('demo-mode-bar')).toHaveAttribute('data-state', 'warning')
  })

  it('announces transitions only, through the sr-only status region', () => {
    at('2026-09-27T12:30:00Z')
    render(<DemoModeBar nextResetAt={RESET} />)
    const status = screen.getByRole('status')
    expect(status.className).toContain('sr-only')
    const initial = status.textContent
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByRole('status').textContent).toBe(initial)
    act(() => { vi.advanceTimersByTime(24 * 60_000) })
    expect(screen.getByRole('status')).toHaveTextContent("Demo resets in 5 minutes — you'll be signed out")
  })

  it('rolls over midnight: a 00:00 reset seen from 23:40 the day before', () => {
    at('2026-09-27T23:40:00Z')
    const midnight = '2026-09-28T00:00:00Z'
    render(<DemoModeBar nextResetAt={midnight} />)
    expect(screen.getByTestId('demo-mode-bar')).toHaveTextContent(`Resets at ${formatClockTime(midnight)} (in 20 min)`)
  })

  it('shows hours for a longer (nightly) cadence', () => {
    at('2026-09-27T10:55:00Z')
    render(<DemoModeBar nextResetAt="2026-09-28T00:00:00Z" />)
    expect(screen.getByTestId('demo-mode-bar')).toHaveTextContent('(in 13 h 5 min)')
  })

  it('starts in the warning state when mounted inside the window', () => {
    at('2026-09-27T12:58:00Z')
    render(<DemoModeBar nextResetAt={RESET} />)
    expect(screen.getByTestId('demo-mode-bar')).toHaveAttribute('data-state', 'warning')
  })
})
