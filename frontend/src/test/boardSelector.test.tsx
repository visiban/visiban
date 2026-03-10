import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  it('calls onSelect when board is clicked', async () => {
    const board = { id: 1, name: 'Board A', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, created_at: '', updated_at: '' }
    mockListBoards.mockResolvedValue([board])
    const onSelect = vi.fn()
    render(<BoardSelector user={fakeUser} onSelect={onSelect} />)
    const user = userEvent.setup()
    await screen.findByText('Board A')
    await user.click(screen.getByText('Board A'))
    expect(onSelect).toHaveBeenCalledWith(board)
  })

  it('shows delete button for owned boards', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, name: 'My Board', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, created_at: '', updated_at: '' },
    ])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    await screen.findByText('My Board')
    expect(screen.getByTitle('Delete board')).toBeInTheDocument()
  })

  it('shows delete confirmation dialog', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, name: 'My Board', description: '', owner: fakeUser, group: null, group_name: null, member_count: 1, created_at: '', updated_at: '' },
    ])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    const user = userEvent.setup()
    await screen.findByText('My Board')
    await user.click(screen.getByTitle('Delete board'))
    expect(screen.getByText('Delete board?')).toBeInTheDocument()
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument()
  })

  it('opens create modal when + New board is clicked', async () => {
    mockListBoards.mockResolvedValue([])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    const user = userEvent.setup()
    await screen.findByText('+ New board')
    await user.click(screen.getByText('+ New board'))
    expect(screen.getByText('New Board')).toBeInTheDocument()
  })

  it('shows board description when available', async () => {
    mockListBoards.mockResolvedValue([
      { id: 1, name: 'Board A', description: 'A test board', owner: fakeUser, group: null, group_name: null, member_count: 1, created_at: '', updated_at: '' },
    ])
    render(<BoardSelector user={fakeUser} onSelect={vi.fn()} />)
    expect(await screen.findByText('A test board')).toBeInTheDocument()
  })
})
