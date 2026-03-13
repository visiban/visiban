import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import BoardMembersModal from '../components/Board/BoardMembersModal'
import type { BoardFull, User } from '../types'

vi.mock('../api/boards', () => ({
  setBoardMember: vi.fn(),
  removeBoardMember: vi.fn(),
}))

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false,
}

const fakeBoard: BoardFull = {
  id: 1, name: 'Test', description: '', group: null, group_name: null,
  columns: [], swimlanes: [], cards: [], labels: [],
  members: [
    { id: 1, user: fakeUser, role: 'admin', joined_at: '' },
    { id: 2, user: { ...fakeUser, id: 2, username: 'bob', display_name: 'Bob Smith', email: 'bob@test.com' }, role: 'member', joined_at: '' },
  ],
  staleness_threshold_days: 7, close_editor_on_enter: false, allowed_priorities: [],
  is_starred: false, created_at: '', updated_at: '', current_user_role: 'admin',
}

describe('BoardMembersModal', () => {
  it('renders member list', () => {
    render(<BoardMembersModal board={fakeBoard} onClose={vi.fn()} onMembersChanged={vi.fn()} />)
    expect(screen.getByText('Board Members')).toBeInTheDocument()
    expect(screen.getByText('Jane Doe')).toBeInTheDocument()
    expect(screen.getByText('Bob Smith')).toBeInTheDocument()
  })

  it('shows role legend', () => {
    render(<BoardMembersModal board={fakeBoard} onClose={vi.fn()} onMembersChanged={vi.fn()} />)
    expect(screen.getByText(/Full access/)).toBeInTheDocument()
    expect(screen.getByText(/Read-only access/)).toBeInTheDocument()
  })

  it('renders role dropdowns', () => {
    render(<BoardMembersModal board={fakeBoard} onClose={vi.fn()} onMembersChanged={vi.fn()} />)
    // Custom dropdown triggers show the current role label
    expect(screen.getByRole('button', { name: 'Admin' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Member' })).toBeInTheDocument()
  })
})
