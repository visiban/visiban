import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ShareBoardHeader from '../components/Board/ShareBoardHeader'

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
