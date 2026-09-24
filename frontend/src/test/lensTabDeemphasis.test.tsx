import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ViewToggle } from '../components/Board/BoardView'
import { isBoardTabDeemphasized, LENS_ONLY_BOARD_TOOLTIP } from '../components/Board/lensTabState'
import type { LensConnection } from '../types'

// #1063: the Board tab is muted (never disabled/hidden) exactly when a lens is
// configured AND the board has zero native swimlanes.

const conn = { id: 1, provider: 'gitlab', repo_slug: 'acme/widgets' } as unknown as LensConnection

describe('isBoardTabDeemphasized', () => {
  it('is true for a lens with zero native swimlanes', () => {
    expect(isBoardTabDeemphasized(conn, 0)).toBe(true)
  })
  it('is false once even one native swimlane exists', () => {
    expect(isBoardTabDeemphasized(conn, 1)).toBe(false)
    expect(isBoardTabDeemphasized(conn, 5)).toBe(false)
  })
  it('is false without a lens, even with zero swimlanes', () => {
    expect(isBoardTabDeemphasized(null, 0)).toBe(false)
  })
})

describe('ViewToggle Board tab', () => {
  it('is muted but enabled and one click away when deemphasized', async () => {
    const onChange = vi.fn()
    render(<ViewToggle view="lens" onChange={onChange} showLens deemphasizeBoard />)
    const board = screen.getByRole('button', { name: 'Board' })
    expect(board).toHaveAttribute('data-deemphasized', 'true')
    expect(board).not.toBeDisabled()
    expect(board.className).toContain('italic')
    expect(board.className).not.toContain('text-fg-muted') // fails AA on the bg-surface-hover track in dark mode
    expect(board.className).not.toContain('pointer-events-none')
    // Tooltip (300ms delay) explains the muted state on focus/hover.
    fireEvent.focus(board)
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(LENS_ONLY_BOARD_TOOLTIP))
    fireEvent.click(board)
    expect(onChange).toHaveBeenCalledWith('board')
  })

  it('renders at full weight when not deemphasized (native swimlane exists)', () => {
    render(<ViewToggle view="lens" onChange={vi.fn()} showLens deemphasizeBoard={false} />)
    const board = screen.getByRole('button', { name: 'Board' })
    expect(board).not.toHaveAttribute('data-deemphasized')
    expect(board.className).toContain('text-fg-tertiary')
  })

  it('never mutes when the lens tab is not shown', () => {
    render(<ViewToggle view="board" onChange={vi.fn()} deemphasizeBoard />)
    expect(screen.getByRole('button', { name: 'Board' })).not.toHaveAttribute('data-deemphasized')
  })

  it('keeps the active styling when Board is the selected tab', () => {
    render(<ViewToggle view="board" onChange={vi.fn()} showLens deemphasizeBoard />)
    expect(screen.getByRole('button', { name: 'Board' }).className).toContain('bg-primary')
  })
})
