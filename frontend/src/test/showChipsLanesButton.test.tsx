import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
})
