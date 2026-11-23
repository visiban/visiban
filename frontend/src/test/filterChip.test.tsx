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
  it('gives the × button a phone-only 44px target (#2341)', () => {
    const { container } = render(<FilterChip label="Bug" onDismiss={vi.fn()} />)
    const btn = container.querySelector('button')!
    expect(btn.className).toContain('max-sm:min-w-11')
    expect(btn.className).toContain('max-sm:min-h-11')
  })

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

  it('renders avatar initials at the text-xs typography floor, not a sub-12px override (#1311)', () => {
    render(<FilterChip label="Jane Doe" avatarUser={fakeUser} onDismiss={vi.fn()} />)
    const avatar = screen.getByText('JD')
    expect(avatar.className).toMatch(/\btext-xs\b/)
    expect(avatar.className).not.toMatch(/text-\[(8|9|10|11)px\]/)
  })

  it('an assignee chip names its avatar initials so the name contains the visible text (#2467)', () => {
    const user = { username: 'jdoe', display_name: 'Jane Doe', avatar_url: '' } as never
    const { container } = render(<FilterChip label="Jane Doe" avatarUser={user} onDismiss={vi.fn()} />)
    expect(screen.getAllByRole('button', { name: 'Remove JD Jane Doe filter' }).length).toBeGreaterThan(0)
    // axe joins adjacent elements' text with no separator: without a real space the visible
    // text is the one word "JDJane", which no name can contain (WCAG 2.5.3).
    const chip = container.querySelector('[role="button"]') as HTMLElement
    expect(chip.textContent).toBe('JD Jane Doe×')
  })

  it('a tagged chip keeps a real space between its tag and label, and names both in order (#2467)', () => {
    const { container } = render(<FilterChip tag="Lanes" label="Tier is Gold" onDismiss={vi.fn()} />)
    expect(screen.getAllByRole('button', { name: 'Lanes: Tier is Gold, remove' }).length).toBeGreaterThan(0)
    const chip = container.querySelector('[role="button"]') as HTMLElement
    expect(chip.textContent).toBe('Lanes Tier is Gold×')
  })
})
