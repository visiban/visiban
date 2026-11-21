/** #2480: the shared board's cut-down public header. */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ShareBoardHeader from '../components/Board/ShareBoardHeader'

function renderHeader(name = 'Roadmap') {
  return render(<MemoryRouter><ShareBoardHeader boardName={name} /></MemoryRouter>)
}

describe('ShareBoardHeader (#2480)', () => {
  it('shows the logo tile (not a button), the board name as the h1 with its full-name title, and the read-only pill', () => {
    renderHeader('A very long board name')
    expect(screen.getByRole('img', { name: 'Visiban' })).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    const h1 = screen.getByRole('heading', { level: 1, name: 'A very long board name' })
    expect(h1).toHaveAttribute('title', 'A very long board name')
    expect(screen.getByText('Shared view, read-only')).toBeInTheDocument()
  })

  it('always offers Sign in, linking to an existing route (/), not a nonexistent /login', () => {
    renderHeader()
    const link = screen.getByRole('link', { name: 'Sign in' })
    expect(link).toHaveAttribute('href', '/')
    expect(link.className).toContain('border-line-strong')
  })

  it('has no edit controls', () => {
    renderHeader()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })
})
