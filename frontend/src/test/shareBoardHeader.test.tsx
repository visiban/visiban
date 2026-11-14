import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ShareBoardHeader from '../components/Board/ShareBoardHeader'

describe('ShareBoardHeader separator (#2012)', () => {
  it('hides the decorative "/" from assistive tech', () => {
    render(
      <MemoryRouter initialEntries={['/share/tok']}>
        <ShareBoardHeader boardName="B" />
      </MemoryRouter>,
    )
    expect(screen.getByText('/')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('ShareBoardHeader sign-in CTA (#1740)', () => {
  it('navigates to an existing route (/), not a nonexistent /login', async () => {
    render(
      <MemoryRouter initialEntries={['/share/tok']}>
        <Routes>
          <Route path="/share/:token" element={<ShareBoardHeader boardName="B" />} />
          <Route path="/" element={<div>home</div>} />
          <Route path="*" element={<div>nowhere</div>} />
        </Routes>
      </MemoryRouter>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Sign in to collaborate' }))
    expect(screen.getByText('home')).toBeInTheDocument()
  })
})

describe('ShareBoardHeader content (#1990)', () => {
  it('shows the wordmark, the board name (with a full-name title) and a View only badge, and no edit controls', () => {
    render(
      <MemoryRouter initialEntries={['/share/tok']}>
        <ShareBoardHeader boardName="A very long board name" />
      </MemoryRouter>,
    )
    expect(screen.getByRole('img', { name: 'Visiban' })).toBeInTheDocument()
    expect(screen.getByText('A very long board name')).toHaveAttribute('title', 'A very long board name')
    expect(screen.getByText('View only')).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})
