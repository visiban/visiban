import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BoardSkeleton, BoardEmptyState, BoardNoMatchState, BoardOfflineBanner, BoardLoadError, ViewOnlyNotice } from '../components/Board/BoardStates'
import { emptyBoardSentence, noMatchLine } from '../components/Board/boardStateCopy'

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

  it('offline banner reads Offline and says moves are paused (#2325, spec § States)', () => {
    render(<BoardOfflineBanner />)
    expect(screen.getByRole('status')).toHaveTextContent('Offline. Reconnecting. Moves are paused until the board is live again.')
  })

  it('offline banner says live updates are off and moves are paused when the socket failed', () => {
    render(<BoardOfflineBanner failed />)
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('Offline. Live updates are off and moves are paused. Reload the page to reconnect.')
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

describe('board states (#2324)', () => {
  it.each([
    [true, true, 'Add the first card to Prospect, or import cards from a file.'],
    [true, false, 'Add the first card to Prospect.'],
    [false, true, 'Import cards from a file to get started.'],
    [false, false, 'Cards added to this board will show up here.'],
  ])('sentence for add=%s import=%s', (add, imp, text) => {
    expect(emptyBoardSentence('Prospect', add, imp)).toBe(text)
  })

  it('Import cards is a link to the group import flow, after Add a card', () => {
    render(<MemoryRouter><BoardEmptyState firstColumnName="Prospect" onAddCard={vi.fn()} importHref="/groups/5?import=1" /></MemoryRouter>)
    const link = screen.getByRole('link', { name: 'Import cards' })
    expect(link).toHaveAttribute('href', '/groups/5?import=1')
    expect(screen.getByRole('button', { name: 'Add a card' }).compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('Add the first card to Prospect, or import cards from a file.')).toBeInTheDocument()
  })

  it.each([
    ['overdue', null, 'No cards are overdue'],
    ['stale', 3, 'No cards are stale'],
    ['due_soon', null, 'No cards are due soon'],
    ['due_soon', 0, 'No cards match the active filters'],
    ['all', 0, 'No cards match the active filters'],
  ] as const)('no-match line for chip %s, panel matches %s', (chip, n, line) => {
    expect(noMatchLine(chip, n)).toBe(line)
  })

  it('the no-match panel shows its line and Show all cards', async () => {
    const onShowAll = vi.fn()
    render(<BoardNoMatchState line="No cards are due soon" onShowAll={onShowAll} />)
    expect(screen.getByRole('status')).toHaveTextContent('No cards are due soon')
    await userEvent.click(screen.getByRole('button', { name: 'Show all cards' }))
    expect(onShowAll).toHaveBeenCalledOnce()
  })
})
