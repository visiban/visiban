import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import LensColumnHeader from '../components/Board/Lens/LensColumnHeader'
import type { LensAxis } from '../types'

const column: LensAxis = { key: 'in_review', label: 'In review', is_current: false }

describe('LensColumnHeader (#1065 resize)', () => {
  it('renders at the given width and carries a resize handle named for the column', () => {
    render(<LensColumnHeader column={column} count={3} width={280} onResize={vi.fn()} />)
    const header = screen.getByText('In review').closest('[style]') as HTMLElement
    expect(header.style.width).toBe('280px')
    expect(screen.getByRole('separator', { name: 'Resize In review column' })).toBeInTheDocument()
  })

  it('dragging the resize handle calls onResize with the dragged width', () => {
    const onResize = vi.fn()
    render(<LensColumnHeader column={column} count={3} width={280} onResize={onResize} />)
    const handle = screen.getByRole('separator', { name: 'Resize In review column' })
    fireEvent.mouseDown(handle, { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 150 })
    expect(onResize).toHaveBeenCalledWith(330)
    fireEvent.mouseUp(window)
  })
})
