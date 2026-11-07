import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEscapeStack } from '../hooks/useEscapeStack'
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

describe('MentionTextarea Escape (#2036)', () => {
  function Host({ onClose }: { onClose: () => void }) {
    useEscapeStack(onClose, 30)
    return <MentionTextarea value="" onChange={vi.fn()} members={members} />
  }

  it('Escape closes the suggestion popup without reaching the host; the next Escape does', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<Host onClose={onClose} />)
    await user.type(screen.getByRole('textbox'), '@')
    expect(screen.getByText('@jdoe')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByText('@jdoe')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape with no popup open reaches the host', async () => {
    const onClose = vi.fn()
    render(<Host onClose={onClose} />)
    await userEvent.setup().keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('MentionTextarea suggestion list placement (#2092)', () => {
  function rect(top: number, bottom: number, left = 20): DOMRect {
    return { top, bottom, left, right: left + 300, width: 300, height: bottom - top, x: left, y: top, toJSON: () => ({}) } as DOMRect
  }

  async function openList() {
    const user = userEvent.setup()
    render(<MentionTextarea value="" onChange={vi.fn()} members={members} />)
    const ta = screen.getByRole('textbox')
    await user.type(ta, '@')
    const list = screen.getByText('@jdoe').closest('div.z-\\[60\\]') as HTMLElement
    return { user, ta, list }
  }

  it('renders the list fixed, so a scroll region cannot clip it, and shows it once placed', async () => {
    const { list } = await openList()
    expect(list.style.position).toBe('fixed')
    // jsdom measures no height, so placement leaves it hidden; give it one and re-place on resize.
    Object.defineProperty(list, 'offsetHeight', { configurable: true, value: 100 })
    window.dispatchEvent(new Event('resize'))
    expect(list.style.visibility).toBe('')
  })

  it('opens below the textarea when there is room, above it when there is not', async () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(480)
    const { ta, list } = await openList()
    Object.defineProperty(list, 'offsetHeight', { configurable: true, value: 100 })
    const spy = vi.spyOn(ta, 'getBoundingClientRect')
    spy.mockReturnValue(rect(50, 90))
    window.dispatchEvent(new Event('resize'))
    expect(list.style.top).toBe('94px')
  })

  it('flips above when the textarea sits near the bottom', async () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(480)
    const { ta, list } = await openList()
    Object.defineProperty(list, 'offsetHeight', { configurable: true, value: 100 })
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(rect(400, 440))
    window.dispatchEvent(new Event('resize'))
    expect(list.style.top).toBe('296px')
  })

  it('re-anchors on an outside scroll instead of closing, and keeps focus in the textarea', async () => {
    const { ta, list } = await openList()
    Object.defineProperty(list, 'offsetHeight', { configurable: true, value: 100 })
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(480)
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(rect(60, 100))
    const before = list.style.top
    window.dispatchEvent(new Event('scroll'))
    expect(list.style.top).toBe('104px')
    expect(list.style.top).not.toBe(before)
    expect(screen.getByText('@jdoe')).toBeInTheDocument()
    expect(ta).toHaveFocus()
  })

  it('mousedown on an option inserts the mention and leaves focus in the textarea', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MentionTextarea value="@" onChange={onChange} members={members} />)
    const ta = screen.getByRole('textbox')
    await user.type(ta, 'a')
    await user.click(screen.getByText('@alice'))
    expect(onChange).toHaveBeenLastCalledWith('@alice ')
    expect(ta).toHaveFocus()
  })
})

describe('MentionTextarea off-screen anchor (#2092)', () => {
  it('hides the list while the textarea is scrolled out of the viewport', async () => {
    const user = userEvent.setup()
    render(<MentionTextarea value="" onChange={vi.fn()} members={members} />)
    const ta = screen.getByRole('textbox')
    await user.type(ta, '@')
    const list = screen.getByText('@jdoe').closest('div.z-\\[60\\]') as HTMLElement
    Object.defineProperty(list, 'offsetHeight', { configurable: true, value: 100 })
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue({ top: -200, bottom: -150, left: 0, right: 300, width: 300, height: 50, x: 0, y: -200, toJSON: () => ({}) } as DOMRect)
    window.dispatchEvent(new Event('resize'))
    expect(list.style.visibility).toBe('hidden')
  })
})

describe('MentionTextarea re-measure on same-length list (#2092)', () => {
  it('re-places when the options change height but not count', async () => {
    const mk = (id: number, username: string, display: string): BoardMembership => ({
      id, role: 'member', is_moderator: false, joined_at: '',
      user: { ...fakeUser, id, username, display_name: display, first_name: display, last_name: '' },
    })
    const twoLine = [mk(11, 'ab1', 'Alpha One'), mk(12, 'ab2', 'Alpha Two'), mk(13, 'ab3', 'Alpha Three')]
    const oneLine = [mk(21, 'ac1', 'ac1'), mk(22, 'ac2', 'ac2'), mk(23, 'ac3', 'ac3')]
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(480)
    function Host() {
      const [v, setV] = useState('')
      return <MentionTextarea value={v} onChange={setV} members={[...twoLine, ...oneLine]} />
    }
    render(<Host />)
    const ta = screen.getByRole('textbox')
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue({ top: 400, bottom: 440, left: 20, right: 320, width: 300, height: 40, x: 20, y: 400, toJSON: () => ({}) } as DOMRect)
    // Height tracks the number of two-line options, as in a real layout.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('z-[60]')) return 0
      return this.querySelectorAll('span.text-xs').length ? 150 : 90
    })
    const user = userEvent.setup()
    await user.type(ta, '@ab')
    const list = () => screen.getByText('@ab1').closest('div.z-\\[60\\]') as HTMLElement
    expect(list().style.top).toBe('246px') // 400 - 4 - 150
    // Replace the whole value in one change so no intermediate list (of a different length) renders.
    fireEvent.change(ta, { target: { value: '@ac' } })
    const list2 = screen.getByText('@ac1').closest('div.z-\\[60\\]') as HTMLElement
    expect(list2.style.top).toBe('306px') // 400 - 4 - 90
  })
})
