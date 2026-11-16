import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BoardSkeleton, BoardEmptyState, BoardOfflineBanner, BoardLoadError, ViewOnlyNotice } from '../components/Board/BoardStates'

describe('board states (#2276)', () => {
  it('skeleton announces Loading board and is busy; blocks stop pulsing for reduced motion', () => {
    const { container } = render(<BoardSkeleton />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText('Loading board')).toBeInTheDocument()
    const pulsing = container.querySelectorAll('.animate-pulse')
    expect(pulsing.length).toBeGreaterThan(0)
    pulsing.forEach((el) => expect(el.className).toContain('motion-reduce:animate-none'))
  })

  it('empty state names the first column and fires Add a card', async () => {
    const onAdd = vi.fn()
    render(<BoardEmptyState firstColumnName="Prospect" onAddCard={onAdd} />)
    expect(screen.getByText('No cards yet')).toBeInTheDocument()
    expect(screen.getByText('Add the first card to Prospect.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Add a card' }))
    expect(onAdd).toHaveBeenCalledOnce()
  })

  it('empty state drops the button when adding is not allowed', () => {
    render(<BoardEmptyState firstColumnName="Prospect" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('offline banner carries the spec copy', () => {
    render(<BoardOfflineBanner />)
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting. Moves are paused until the board is live again.')
  })

  it('offline banner says live updates are off when the socket failed', () => {
    render(<BoardOfflineBanner failed />)
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('Live updates are off')
    expect(banner).not.toHaveTextContent('Moves are paused')
  })

  it('load error offers Try again', async () => {
    const onRetry = vi.fn()
    render(<BoardLoadError onRetry={onRetry} />)
    expect(screen.getByRole('alert')).toHaveTextContent("The board didn't load.")
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('view-only notice renders', () => {
    render(<ViewOnlyNotice />)
    expect(screen.getByRole('note')).toHaveTextContent('View only.')
  })
})
