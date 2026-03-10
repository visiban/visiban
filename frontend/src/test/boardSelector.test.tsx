import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import BoardSelector from '../components/Layout/BoardSelector'
import type { User } from '../types'

vi.mock('../api/boards', () => ({
  listBoards: vi.fn(),
  createBoard: vi.fn(),
  deleteBoard: vi.fn(),
}))

import { listBoards } from '../api/boards'

const mockListBoards = listBoards as ReturnType<typeof vi.fn>

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false,
}

describe('BoardSelector', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows loading state', () => {
    mockListBoards.mockReturnValue(new Promise(() => {}))
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    expect(screen.getByText(/Loading/)).toBeInTheDocument()
  })

  it('shows boards when loaded', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, name: 'Board A', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, created_at: '', updated_at: '' },
    ])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    expect(await screen.findByText('Board A')).toBeInTheDocument()
  })

  it('shows empty state', async () => {
    mockListBoards.mockResolvedValue([])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    expect(await screen.findByText('No boards yet.')).toBeInTheDocument()
  })

  it('shows new board button', async () => {
    mockListBoards.mockResolvedValue([])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    expect(await screen.findByText('+ New board')).toBeInTheDocument()
  })
})
