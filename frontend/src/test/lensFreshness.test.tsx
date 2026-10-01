import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LensFreshness from '../components/Board/Lens/LensFreshness'

// LensFreshness had zero test coverage (#1350) despite real conditional logic: the
// Date.parse NaN-guard around fetched_at, the refetching-spinner vs. idle-"Synced X
// ago" branch, and the Refresh control's disabled/onRefresh wiring.

afterEach(() => {
  vi.useRealTimers()
})

describe('LensFreshness', () => {
  it('shows no Synced text for a malformed fetched_at, but Refresh still renders and works', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    render(<LensFreshness fetchedAt="not-a-real-date" refetching={false} onRefresh={onRefresh} />)

    expect(screen.queryByText(/Synced/)).not.toBeInTheDocument()

    const button = screen.getByRole('button', { name: 'Refresh' })
    expect(button).toBeEnabled()
    await user.click(button)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('shows no Synced text for a missing fetched_at, but Refresh still renders and works', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    // Simulates a lens payload where fetched_at came back empty/absent.
    render(<LensFreshness fetchedAt={undefined as unknown as string} refetching={false} onRefresh={onRefresh} />)

    expect(screen.queryByText(/Synced/)).not.toBeInTheDocument()

    const button = screen.getByRole('button', { name: 'Refresh' })
    expect(button).toBeEnabled()
    await user.click(button)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('shows "Synced X ago" for a valid fetched_at, with the clock pinned', () => {
    vi.useFakeTimers()
    const now = new Date('2026-10-01T12:00:00.000Z').getTime()
    vi.setSystemTime(now)
    const fetchedAt = new Date(now - 5 * 60_000).toISOString()

    render(<LensFreshness fetchedAt={fetchedAt} refetching={false} onRefresh={vi.fn()} />)

    expect(screen.getByText('Synced 5 m ago')).toBeInTheDocument()
  })

  it('shows the spinner and hides the idle text while refetching, and disables Refresh', () => {
    vi.useFakeTimers()
    const now = new Date('2026-10-01T12:00:00.000Z').getTime()
    vi.setSystemTime(now)
    const fetchedAt = new Date(now - 5 * 60_000).toISOString()

    render(<LensFreshness fetchedAt={fetchedAt} refetching onRefresh={vi.fn()} />)

    expect(screen.getByRole('status', { name: 'Refreshing' })).toBeInTheDocument()
    expect(screen.queryByText(/Synced/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
  })

  it('does not call onRefresh when the disabled Refresh button is clicked while refetching', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    render(<LensFreshness fetchedAt="not-a-real-date" refetching onRefresh={onRefresh} />)

    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(onRefresh).not.toHaveBeenCalled()
  })
})
