import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    await userEvent.setup().type(screen.getByRole('combobox'), 'Hi')
    expect(onChange).toHaveBeenCalled()
  })

  it('shows mention suggestions when typing @', async () => {
    let currentValue = ''
    const onChange = (val: string) => { currentValue = val }
    const { rerender } = render(<MentionTextarea value={currentValue} onChange={onChange} members={members} />)
    const textarea = screen.getByRole('combobox')
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
    const textarea = screen.getByRole('combobox')
    await userEvent.setup().type(textarea, '{Enter}')
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('applies custom className', () => {
    render(<MentionTextarea value="" onChange={vi.fn()} members={members} className="custom-class" />)
    expect(screen.getByRole('combobox')).toHaveClass('custom-class')
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
    await user.type(screen.getByRole('combobox'), '@')
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
    const ta = screen.getByRole('combobox')
    await user.type(ta, '@')
    const list = screen.getByText('@jdoe').closest('div.z-\\[60\\]') as HTMLElement
    return { user, ta, list }
  }

  it('renders the list fixed, so a scroll region cannot clip it, and shows it once placed', async () => {
    const { ta, list } = await openList()
    expect(list.style.position).toBe('fixed')
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(rect(50, 90))
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
    const ta = screen.getByRole('combobox')
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
    const ta = screen.getByRole('combobox')
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
      user: { id, username, display_name: display, avatar_url: '' },
    })
    const twoLine = [mk(11, 'ab1', 'Alpha One'), mk(12, 'ab2', 'Alpha Two'), mk(13, 'ab3', 'Alpha Three')]
    const oneLine = [mk(21, 'ac1', 'ac1'), mk(22, 'ac2', 'ac2'), mk(23, 'ac3', 'ac3')]
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(480)
    function Host() {
      const [v, setV] = useState('')
      return <MentionTextarea value={v} onChange={setV} members={[...twoLine, ...oneLine]} />
    }
    render(<Host />)
    const ta = screen.getByRole('combobox')
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

describe('MentionTextarea placement hardening (#2092)', () => {
  const R = (top: number, bottom: number, left = 20) =>
    ({ top, bottom, left, right: left + 300, width: 300, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect

  async function open(rect: DOMRect, height: number, wrap?: (c: React.ReactNode) => React.ReactNode) {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(480)
    const user = userEvent.setup()
    const ui = <MentionTextarea value="" onChange={vi.fn()} members={members} />
    render(<>{wrap ? wrap(ui) : ui}</>)
    const ta = screen.getByRole('combobox')
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(rect)
    await user.type(ta, '@')
    const list = screen.getByText('@jdoe').closest('div.z-\\[60\\]') as HTMLElement
    let h = height
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (this !== list) return 0
      return this.style.maxHeight ? Math.min(h, parseFloat(this.style.maxHeight)) : h
    })
    return { ta, list, setH: (n: number) => { h = n }, user }
  }

  it('caps the list to the larger free side and never overlaps the textarea (anchored 480px sheet)', async () => {
    // Textarea 301-355 in a 480px viewport; a 314px list fits neither below (113) nor above (288).
    const { list } = await open(R(301, 355), 314)
    window.dispatchEvent(new Event('resize'))
    const top = parseFloat(list.style.top)
    const height = parseFloat(list.style.maxHeight)
    expect(height).toBe(289) // 301 - 4 - 8
    expect(top + height).toBeLessThanOrEqual(301) // ends above the textarea
    expect(top).toBeGreaterThanOrEqual(8)
    expect(list.style.visibility).toBe('')
  })

  it('caps below when below is the larger side, and drops the cap once the list fits (never stays pinned)', async () => {
    const { list, setH } = await open(R(20, 60), 600)
    window.dispatchEvent(new Event('resize'))
    expect(list.style.top).toBe('64px')
    expect(parseFloat(list.style.maxHeight)).toBe(480 - 8 - 64)
    setH(60)
    window.dispatchEvent(new Event('resize'))
    expect(list.style.maxHeight).toBe('')
    expect(list.style.top).toBe('64px')
  })

  it('keeps the side chosen earlier while the narrowed list still fits there', async () => {
    // Textarea 300-340: 150px fits above (288) but not below (128).
    const { list, setH } = await open(R(300, 340), 150)
    window.dispatchEvent(new Event('resize'))
    expect(list.style.top).toBe('146px')
    setH(90) // now fits below (128) too, but must not flip across the textarea
    window.dispatchEvent(new Event('resize'))
    expect(list.style.top).toBe('206px')
  })

  it('hides the list when the textarea is under the sheet header (outside its scroll region)', async () => {
    const { list } = await open(R(141, 195), 100, (c) => <div data-testid="scroller" style={{ overflowY: 'auto' }}>{c}</div>)
    vi.spyOn(screen.getByTestId('scroller'), 'getBoundingClientRect').mockReturnValue(R(231, 480, 0))
    window.dispatchEvent(new Event('resize'))
    expect(list.style.visibility).toBe('hidden')
  })

  it('follows the textarea when it moves with no scroll or resize event (sheet re-placement)', async () => {
    const { ta, list } = await open(R(50, 90), 100)
    window.dispatchEvent(new Event('resize'))
    expect(list.style.top).toBe('94px')
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(R(150, 190, 300))
    await waitFor(() => expect(list.style.top).toBe('194px'))
    expect(list.style.left).toBe('300px')
  })

  it('clamps the list inside the viewport horizontally', async () => {
    const { ta, list } = await open(R(50, 90, 1000), 100)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(224)
    window.dispatchEvent(new Event('resize'))
    expect(list.style.left).toBe(`${window.innerWidth - 224 - 8}px`)
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(R(50, 90, -50))
    window.dispatchEvent(new Event('resize'))
    expect(list.style.left).toBe('8px')
  })

  it('scrolls the active option into view as the selection moves', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const { user } = await open(R(50, 90), 100)
    scrollIntoView.mockClear()
    await user.keyboard('{ArrowDown}')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    // @ts-expect-error test cleanup of a jsdom-missing method
    delete Element.prototype.scrollIntoView
  })

  it('removes the scroll and resize listeners when the list closes', async () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { user } = await open(R(50, 90), 100)
    await user.keyboard('{Escape}')
    const types = remove.mock.calls.map((c) => c[0])
    expect(types).toContain('scroll')
    expect(types).toContain('resize')
  })

  it('prevents default on option mousedown so the textarea never loses focus', async () => {
    const { ta } = await open(R(50, 90), 100)
    const notPrevented = fireEvent.mouseDown(screen.getByText('@alice'))
    expect(notPrevented).toBe(false) // false = a handler called preventDefault
    expect(ta).toHaveFocus()
  })
})

describe('MentionTextarea combobox semantics (#2137)', () => {
  function Controlled({ initial = '' }: { initial?: string }) {
    const [v, setV] = useState(initial)
    return <MentionTextarea value={v} onChange={setV} members={members} />
  }

  it('is a collapsed combobox with no active descendant while the list is closed', () => {
    render(<Controlled />)
    const ta = screen.getByRole('combobox')
    expect(ta).toHaveAttribute('aria-expanded', 'false')
    expect(ta).toHaveAttribute('aria-autocomplete', 'list')
    expect(ta).toHaveAttribute('aria-haspopup', 'listbox')
    expect(ta).not.toHaveAttribute('aria-activedescendant')
    expect(ta).not.toHaveAttribute('aria-controls')
    expect(screen.queryByRole('listbox', { hidden: true })).not.toBeInTheDocument()
  })

  it('exposes the open list as a listbox of options wired to the textarea', async () => {
    const user = userEvent.setup()
    render(<Controlled />)
    const ta = screen.getByRole('combobox')
    await user.type(ta, '@')
    const list = screen.getByRole('listbox', { hidden: true })
    const options = screen.getAllByRole('option', { hidden: true })
    expect(options).toHaveLength(2)
    expect(ta).toHaveAttribute('aria-expanded', 'true')
    expect(ta).toHaveAttribute('aria-controls', list.id)
    expect(ta).toHaveAttribute('aria-activedescendant', options[0].id)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
    expect(ta).toHaveFocus()
  })

  it('moves aria-activedescendant and aria-selected with the arrow keys, focus staying in the textarea', async () => {
    const user = userEvent.setup()
    render(<Controlled />)
    const ta = screen.getByRole('combobox')
    await user.type(ta, '@')
    await user.keyboard('{ArrowDown}')
    const options = screen.getAllByRole('option', { hidden: true })
    expect(ta).toHaveAttribute('aria-activedescendant', options[1].id)
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
    expect(ta).toHaveFocus()
  })

  it('keeps multiline semantics and an accessible name', () => {
    render(<MentionTextarea value="" onChange={vi.fn()} members={members} placeholder="Add a comment" ariaLabel="Comment" />)
    const ta = screen.getByRole('combobox', { name: 'Comment' })
    expect(ta).toHaveAttribute('aria-multiline', 'true')
  })

  it('moves aria-activedescendant back up with ArrowUp and stops at the first option', async () => {
    const user = userEvent.setup()
    render(<Controlled />)
    const ta = screen.getByRole('combobox')
    await user.type(ta, '@')
    await user.keyboard('{ArrowDown}{ArrowUp}')
    const options = screen.getAllByRole('option', { hidden: true })
    expect(ta).toHaveAttribute('aria-activedescendant', options[0].id)
    await user.keyboard('{ArrowUp}')
    expect(ta).toHaveAttribute('aria-activedescendant', options[0].id)
  })

  it('never writes a dangling aria-activedescendant in the render where the list narrows', async () => {
    // selectedIndex is reset in an effect, so React commits one render with a stale index first. act()
    // flushes that effect before any assertion could run, so record every attribute write instead.
    const user = userEvent.setup()
    render(<Controlled />)
    const ta = screen.getByRole('combobox')
    await user.type(ta, '@')
    await user.keyboard('{ArrowDown}') // index 1 of 2
    const written: string[] = []
    const original = ta.setAttribute.bind(ta)
    const spy = vi.spyOn(ta, 'setAttribute').mockImplementation((name: string, value: string) => {
      if (name === 'aria-activedescendant') written.push(value)
      original(name, value)
    })
    fireEvent.change(ta, { target: { value: '@j', selectionStart: 2 } })
    spy.mockRestore()
    expect(written.length).toBeGreaterThan(0)
    for (const id of written) {
      expect(id).not.toContain('undefined')
      expect(document.getElementById(id)).not.toBeNull()
    }
  })

  it('collapses again on Escape', async () => {
    const user = userEvent.setup()
    render(<Controlled />)
    const ta = screen.getByRole('combobox')
    await user.type(ta, '@')
    await user.keyboard('{Escape}')
    expect(ta).toHaveAttribute('aria-expanded', 'false')
    expect(ta).not.toHaveAttribute('aria-activedescendant')
  })

  it('gives two instances distinct listbox and option ids', async () => {
    const user = userEvent.setup()
    render(<><Controlled /><Controlled /></>)
    const [a, b] = screen.getAllByRole('combobox')
    await user.type(a, '@')
    await user.type(b, '@')
    const ids = [
      ...screen.getAllByRole('listbox', { hidden: true }),
      ...screen.getAllByRole('option', { hidden: true }),
    ].map((e) => e.id)
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6)
    expect(a.getAttribute('aria-controls')).not.toBe(b.getAttribute('aria-controls'))
  })
})
