import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MentionTextarea from '../components/Card/MentionTextarea'
import type { BoardMembership, User } from '../types'

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false,
}

const fakeUser2: User = {
  id: 2, username: 'alice', email: 'a@example.com', first_name: 'Alice',
  last_name: 'Smith', avatar_url: '', display_name: 'Alice Smith',
  is_site_admin: false, must_change_password: false, must_change_username: false,
}

const members: BoardMembership[] = [
  { id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' },
  { id: 2, user: fakeUser2, role: 'member', is_moderator: false, joined_at: '' },
]

describe('MentionTextarea', () => {
  it('renders textarea with placeholder', () => {
    render(<MentionTextarea value="" onChange={vi.fn()} members={members} placeholder="Add a comment…" />)
    expect(screen.getByPlaceholderText('Add a comment…')).toBeInTheDocument()
  })

  it('renders with current value', () => {
    render(<MentionTextarea value="Hello" onChange={vi.fn()} members={members} />)
    expect(screen.getByDisplayValue('Hello')).toBeInTheDocument()
  })

  it('calls onChange when typing', async () => {
    const onChange = vi.fn()
    render(<MentionTextarea value="" onChange={onChange} members={members} />)
    await userEvent.setup().type(screen.getByRole('textbox'), 'Hi')
    expect(onChange).toHaveBeenCalled()
  })

  it('shows mention suggestions when typing @', async () => {
    let currentValue = ''
    const onChange = (val: string) => { currentValue = val }
    const { rerender } = render(<MentionTextarea value={currentValue} onChange={onChange} members={members} />)
    const textarea = screen.getByRole('textbox')
    await userEvent.setup().type(textarea, '@')
    // Re-render with new value since this is controlled
    rerender(<MentionTextarea value="@" onChange={onChange} members={members} />)
    // Check for suggestion dropdown
    expect(screen.getByText('@jdoe')).toBeInTheDocument()
    expect(screen.getByText('@alice')).toBeInTheDocument()
  })

  it('calls onSubmit on Enter without Shift', async () => {
    const onSubmit = vi.fn()
    render(<MentionTextarea value="Hello" onChange={vi.fn()} onSubmit={onSubmit} members={members} />)
    const textarea = screen.getByRole('textbox')
    await userEvent.setup().type(textarea, '{Enter}')
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('applies custom className', () => {
    render(<MentionTextarea value="" onChange={vi.fn()} members={members} className="custom-class" />)
    expect(screen.getByRole('textbox')).toHaveClass('custom-class')
  })
})
