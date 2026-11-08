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
      // bob's option should now have the selected (bg-surface-hover) style
      const bobBtn = screen.getByText('@bob').closest('[role="option"]')
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

describe('MentionList ARIA (#2137)', () => {
  // The TipTap suggestion keeps focus in the editor, which this list cannot label as a combobox, so
  // the list carries listbox/option semantics and the active row via aria-selected only.
  it('is a listbox of options with the first one selected', () => {
    render(<MentionList items={[alice, bob]} command={vi.fn()} />)
    expect(screen.getByRole('listbox', { name: 'Mention suggestions' })).toBeInTheDocument()
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
  })

  it('moves aria-selected with the arrow keys', () => {
    const ref = createRef<MentionListRef>()
    render(<MentionList ref={ref} items={[alice, bob]} command={vi.fn()} />)
    act(() => { ref.current!.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'ArrowDown' }) }) })
    const options = screen.getAllByRole('option')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
  })

  it('gives every option and each instance a unique id', () => {
    render(<><MentionList items={[alice, bob]} command={vi.fn()} /><MentionList items={[alice, bob]} command={vi.fn()} /></>)
    const ids = [...screen.getAllByRole('listbox'), ...screen.getAllByRole('option')].map((e) => e.id)
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(6)
  })

  it('reports the listbox id and the active option id as the selection moves (#2149)', () => {
    const onActiveChange = vi.fn()
    const ref = createRef<MentionListRef>()
    const { container } = render(<MentionList ref={ref} items={[alice, bob]} command={vi.fn()} onActiveChange={onActiveChange} />)
    const last = () => onActiveChange.mock.calls.at(-1)![0] as { listboxId: string; activeId: string }
    const options = container.querySelectorAll('[role="option"]')
    expect(last().activeId).toBe(options[0].id)
    expect(container.querySelector(`[id="${last().listboxId}"]`)).toHaveAttribute('role', 'listbox')
    act(() => { ref.current!.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'ArrowDown' }) }) })
    expect(last().activeId).toBe(options[1].id)
    expect(document.getElementById(last().activeId)).not.toBeNull()
  })

  it('reports null when there are no items (#2149)', () => {
    const onActiveChange = vi.fn()
    render(<MentionList items={[]} command={vi.fn()} onActiveChange={onActiveChange} />)
    expect(onActiveChange).toHaveBeenLastCalledWith(null)
  })
})
