import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import NotFoundPage from '../pages/NotFoundPage'
import UnavailablePage from '../pages/UnavailablePage'
import type { User } from '../types'

// The real Navbar renders here (app.test.tsx mocks it), so these tests see the shell's
// breadcrumb h1 next to the page body and prove the page has exactly one h1 (#2473 AC7).
vi.mock('../api/notifications', () => ({
  getUnreadCount: vi.fn().mockResolvedValue(0),
  listNotifications: vi.fn().mockResolvedValue([]),
  markAllRead: vi.fn(),
  markRead: vi.fn(),
}))
vi.mock('../api/auth', () => ({
  getVersion: vi.fn().mockResolvedValue('0.3.0'),
}))

const user = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane', last_name: 'Doe',
  avatar_url: '', display_name: 'Jane Doe', is_site_admin: false, must_change_password: false, must_change_username: false,
} as User

function renderPage(page: React.ReactElement) {
  return render(<MemoryRouter>{page}</MemoryRouter>)
}

describe('one h1 per page on the error pages (#2473)', () => {
  it('404: the breadcrumb owns the h1, the body heading is a focused h2', () => {
    renderPage(<NotFoundPage user={user} onLogout={vi.fn()} onUserUpdated={vi.fn()} />)
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
    expect(h1s[0]).toHaveTextContent('Page not found')
    expect(screen.getByRole('heading', { level: 2, name: 'Page not found' })).toHaveFocus()
  })

  it.each(['board', 'group'] as const)('%s unavailable: exactly one h1, body heading is a focused h2', (kind) => {
    renderPage(<UnavailablePage kind={kind} user={user} onLogout={vi.fn()} onUserUpdated={vi.fn()} />)
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
    expect(h1s[0]).toHaveTextContent('Not available')
    expect(screen.getByRole('heading', { level: 2, name: `This ${kind} isn't available` })).toHaveFocus()
  })
})
