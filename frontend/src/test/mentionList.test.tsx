import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { createRef } from 'react'
import MentionList from '../components/Card/MentionList'
import type { MentionListRef } from '../components/Card/MentionList'
import type { User } from '../types'

const alice: User = {
  id: 1,
  username: 'alice',
  email: 'alice@example.com',
  first_name: 'Alice',
  last_name: 'Smith',
  avatar_url: '',
  display_name: 'Alice Smith',
  is_site_admin: false,
  must_change_password: false, must_change_username: false,
  has_usable_password: true,
}

const bob: User = {
  id: 2,
  username: 'bob',
  email: 'bob@example.com',
  first_name: 'Bob',
  last_name: 'Jones',
  avatar_url: '',
  display_name: '',
  is_site_admin: false,
  must_change_password: false, must_change_username: false,
  has_usable_password: true,
}

describe('MentionList', () => {
  it('renders usernames for each item', () => {
    render(<MentionList items={[alice, bob]} command={vi.fn()} />)
    expect(screen.getByText('@alice')).toBeInTheDocument()
    expect(screen.getByText('@bob')).toBeInTheDocument()
  })

  it('shows display name alongside username when different', () => {
    render(<MentionList items={[alice]} command={vi.fn()} />)
    expect(screen.getByText('Alice Smith')).toBeInTheDocument()
  })

  it('does not show display name when it matches username', () => {
    const user = { ...alice, display_name: 'alice' }
    render(<MentionList items={[user]} command={vi.fn()} />)
    // "alice" only appears once (as @alice username, not repeated as display_name)
    expect(screen.getAllByText(/alice/i)).toHaveLength(1)
  })

  it('renders nothing when items is empty', () => {
    const { container } = render(<MentionList items={[]} command={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('calls command with username when item is clicked', () => {
    const command = vi.fn()
    render(<MentionList items={[alice]} command={command} />)
    fireEvent.mouseDown(screen.getByText('@alice'))
    expect(command).toHaveBeenCalledWith({ id: 'alice', label: 'Alice Smith' })
  })

  describe('keyboard navigation via ref', () => {
    it('ArrowDown moves selection to next item', () => {
      const ref = createRef<MentionListRef>()
      render(<MentionList ref={ref} items={[alice, bob]} command={vi.fn()} />)
      // Initial selection is first item (index 0); ArrowDown moves to index 1
      act(() => {
        ref.current?.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'ArrowDown' }) })
      })
      // bob's button should now have the selected (bg-surface-hover) style
      const bobBtn = screen.getByText('@bob').closest('button')
      expect(bobBtn?.className).toMatch(/bg-surface-hover/)
    })

    it('Enter calls command for currently selected item', () => {
      const command = vi.fn()
      const ref = createRef<MentionListRef>()
      render(<MentionList ref={ref} items={[alice, bob]} command={command} />)
      ref.current?.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'Enter' }) })
      expect(command).toHaveBeenCalledWith({ id: 'alice', label: 'Alice Smith' })
    })

    it('returns false for unhandled keys', () => {
      const ref = createRef<MentionListRef>()
      render(<MentionList ref={ref} items={[alice]} command={vi.fn()} />)
      const result = ref.current?.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'Tab' }) })
      expect(result).toBe(false)
    })
  })
})
