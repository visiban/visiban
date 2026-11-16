import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ShowChips from '../components/Board/ShowChips'

const counts = { all: 3, overdue: 1, stale: 1, due_soon: 0 }

function setup(props: Partial<React.ComponentProps<typeof ShowChips>> = {}) {
  const onToggleLanes = vi.fn()
  render(
    <ShowChips
      active="all"
      counts={counts}
      onChange={() => {}}
      columnCount={3}
      laneCount={2}
      cardCount={3}
      onToggleLanes={onToggleLanes}
      {...props}
    />,
  )
  return { onToggleLanes }
}

describe('ShowChips Collapse all lanes button (#2308)', () => {
  it('reads "Collapse all lanes" while any lane is expanded and fires the toggle', async () => {
    const user = userEvent.setup()
    const { onToggleLanes } = setup()
    await user.click(screen.getByRole('button', { name: 'Collapse all lanes' }))
    expect(onToggleLanes).toHaveBeenCalledTimes(1)
  })

  it('reads "Expand all lanes" once every lane is collapsed', () => {
    setup({ allLanesCollapsed: true })
    expect(screen.getByRole('button', { name: 'Expand all lanes' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Collapse all lanes' })).not.toBeInTheDocument()
  })

  it('is keyboard operable', async () => {
    const user = userEvent.setup()
    const { onToggleLanes } = setup()
    screen.getByRole('button', { name: 'Collapse all lanes' }).focus()
    await user.keyboard('{Enter}')
    expect(onToggleLanes).toHaveBeenCalledTimes(1)
  })

  it('is hidden with no lanes or no handler', () => {
    setup({ laneCount: 0 })
    expect(screen.queryByTestId('show-chips-toggle-lanes')).not.toBeInTheDocument()
  })

  it('is hidden without a handler', () => {
    setup({ onToggleLanes: undefined })
    expect(screen.queryByTestId('show-chips-toggle-lanes')).not.toBeInTheDocument()
  })

  it('announces the action in a live region after Collapse all / Expand all (#2321)', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <ShowChips active="all" counts={counts} onChange={() => {}} columnCount={3} laneCount={2} cardCount={3} onToggleLanes={() => {}} />,
    )
    const region = screen.getByTestId('show-chip-lanes-status')
    expect(region).toHaveAttribute('role', 'status')
    expect(region).toHaveTextContent('')
    await user.click(screen.getByRole('button', { name: 'Collapse all lanes' }))
    await waitFor(() => expect(region).toHaveTextContent('Collapsed all 2 lanes'))
    rerender(
      <ShowChips active="all" counts={counts} onChange={() => {}} columnCount={3} laneCount={2} cardCount={3} allLanesCollapsed onToggleLanes={() => {}} />,
    )
    await user.click(screen.getByRole('button', { name: 'Expand all lanes' }))
    await waitFor(() => expect(region).toHaveTextContent('Expanded all 2 lanes'))
  })

  it('uses the singular for a one-lane board (#2321)', async () => {
    const user = userEvent.setup()
    setup({ laneCount: 1 })
    await user.click(screen.getByRole('button', { name: 'Collapse all lanes' }))
    await waitFor(() => expect(screen.getByTestId('show-chip-lanes-status')).toHaveTextContent('Collapsed all 1 lane'))
  })

  it('re-announces an identical repeat: collapse all, change back outside the button, collapse all again (#2321)', () => {
    vi.useFakeTimers()
    try {
      const props = { active: 'all' as const, counts, onChange: () => {}, columnCount: 3, laneCount: 2, cardCount: 3, onToggleLanes: () => {} }
      const { rerender } = render(<ShowChips {...props} />)
      const region = screen.getByTestId('show-chip-lanes-status')
      fireEvent.click(screen.getByRole('button', { name: 'Collapse all lanes' }))
      act(() => { vi.advanceTimersByTime(100) })
      expect(region).toHaveTextContent('Collapsed all 2 lanes')
      // Everything collapsed, then one lane expanded by hand: the label is back to "Collapse all lanes".
      rerender(<ShowChips {...props} allLanesCollapsed />)
      rerender(<ShowChips {...props} />)
      fireEvent.click(screen.getByRole('button', { name: 'Collapse all lanes' }))
      // The region is cleared first, so setting the same text again is a real DOM change.
      expect(region).toHaveTextContent('')
      act(() => { vi.advanceTimersByTime(100) })
      expect(region).toHaveTextContent('Collapsed all 2 lanes')
    } finally {
      vi.useRealTimers()
    }
  })
})
