import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FilterChip from '../components/Board/FilterChip'
import type { User } from '../types'

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false,
}

describe('FilterChip', () => {
  it('renders label text', () => {
    render(<FilterChip label="Bug" onDismiss={vi.fn()} />)
    expect(screen.getByText('Bug')).toBeInTheDocument()
  })

  it('calls onDismiss on × button click', async () => {
    const onDismiss = vi.fn()
    const { container } = render(<FilterChip label="Bug" onDismiss={onDismiss} />)
    // The dismiss button is the <button> element (not the <span role="button">)
    const dismissBtn = container.querySelector('button') as HTMLButtonElement
    await userEvent.setup().click(dismissBtn)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('calls onDismiss on Delete key', async () => {
    const onDismiss = vi.fn()
    const { container } = render(<FilterChip label="Bug" onDismiss={onDismiss} />)
    const chip = container.querySelector('[role="button"]') as HTMLElement
    chip.focus()
    await userEvent.setup().keyboard('{Delete}')
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('calls onDismiss on Backspace key', async () => {
    const onDismiss = vi.fn()
    const { container } = render(<FilterChip label="Bug" onDismiss={onDismiss} />)
    const chip = container.querySelector('[role="button"]') as HTMLElement
    chip.focus()
    await userEvent.setup().keyboard('{Backspace}')
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('calls onDismiss on Enter key', async () => {
    const onDismiss = vi.fn()
    const { container } = render(<FilterChip label="Bug" onDismiss={onDismiss} />)
    const chip = container.querySelector('[role="button"]') as HTMLElement
    chip.focus()
    await userEvent.setup().keyboard('{Enter}')
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('renders color dot when colorDot provided', () => {
    const { container } = render(<FilterChip label="Bug" colorDot="#EF4444" onDismiss={vi.fn()} />)
    const dot = container.querySelector('.rounded-full.w-2.h-2') as HTMLElement
    expect(dot).toBeInTheDocument()
    expect(dot.style.backgroundColor).toBe('rgb(239, 68, 68)')
  })

  it('renders avatar when avatarUser provided', () => {
    const { container } = render(<FilterChip label="Jane Doe" avatarUser={fakeUser} onDismiss={vi.fn()} />)
    // Avatar renders initials or img — check it rendered inside the chip
    expect(container.querySelector('.rounded-full')).toBeInTheDocument()
  })
})
