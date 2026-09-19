import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LensFilterBar from '../components/Board/Lens/LensFilterBar'

function setup(overrides: Partial<React.ComponentProps<typeof LensFilterBar>> = {}) {
  const props: React.ComponentProps<typeof LensFilterBar> = {
    state: 'all',
    milestone: '',
    labels: [],
    assignee: '',
    q: '',
    availableMilestones: ['1.2', '0.3'],
    availableLabels: ['backend', 'bug'],
    availableAssignees: ['alice', 'bob'],
    activeCount: 0,
    onStateChange: vi.fn(),
    onMilestoneChange: vi.fn(),
    onLabelsChange: vi.fn(),
    onAssigneeChange: vi.fn(),
    onQChange: vi.fn(),
    onClear: vi.fn(),
    ...overrides,
  }
  render(<LensFilterBar {...props} />)
  return props
}

describe('LensFilterBar', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders state, milestone, label, assignee, and text controls', () => {
    setup()
    expect(screen.getByText('State: All')).toBeInTheDocument()
    expect(screen.getByLabelText('Filter by milestone')).toBeInTheDocument()
    expect(screen.getByText('Label')).toBeInTheDocument()
    expect(screen.getByLabelText('Filter by assignee')).toBeInTheDocument()
    expect(screen.getByLabelText('Filter issues by title or number')).toBeInTheDocument()
  })

  it('offers "(no milestone)" as an explicit milestone option', () => {
    setup()
    const opts = document.querySelectorAll('#lens-milestone-options option')
    // Leads the list — "no milestone" is a first-class choice, not a discovery.
    expect((opts[0] as HTMLOptionElement).value).toBe('(no milestone)')
  })

  it('maps the "(no milestone)" option to the __none__ sentinel', () => {
    vi.useFakeTimers()
    const props = setup()
    act(() => {
      fireEvent.change(screen.getByLabelText('Filter by milestone'), {
        target: { value: '(no milestone)' },
      })
      vi.advanceTimersByTime(400)
    })
    expect(props.onMilestoneChange).toHaveBeenCalledWith('__none__')
  })

  it('shows the friendly label when the __none__ sentinel is active', () => {
    setup({ milestone: '__none__' })
    expect(screen.getByLabelText('Filter by milestone')).toHaveValue('(no milestone)')
  })

  it('lists available labels and assignees as options', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: /Label/ }))
    expect(screen.getByLabelText('backend')).toBeInTheDocument()
    expect(screen.getByLabelText('bug')).toBeInTheDocument()

    const assigneeOpts = document.querySelectorAll('#lens-assignee-options option')
    expect(Array.from(assigneeOpts).map((o) => (o as HTMLOptionElement).value)).toEqual([
      'alice',
      'bob',
    ])
  })

  it('calls onLabelsChange when a label is ticked', async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(screen.getByRole('button', { name: /Label/ }))
    await user.click(screen.getByLabelText('bug'))
    expect(props.onLabelsChange).toHaveBeenCalledWith(['bug'])
  })

  it('surfaces the label cap once the maximum is selected', () => {
    setup({ labels: ['a', 'b', 'c', 'd', 'e'], availableLabels: ['a', 'b', 'c', 'd', 'e', 'f'] })
    expect(screen.getByText('max 5 labels')).toBeInTheDocument()
  })

  it('does not show the label cap hint below the maximum', () => {
    setup({ labels: ['a'] })
    expect(screen.queryByText(/max 5/)).not.toBeInTheDocument()
  })

  it('refuses a label past the cap instead of silently dropping another one', async () => {
    // The serializer sorts and slices, so letting a sixth click through would
    // evict whichever label sorts last — routinely one the user never touched,
    // with the click appearing to have succeeded. Refuse it at the click instead.
    const user = userEvent.setup()
    const props = setup({
      labels: ['a', 'b', 'c', 'd', 'e'],
      availableLabels: ['a', 'b', 'c', 'd', 'e', 'zebra'],
    })
    await user.click(screen.getByRole('button', { name: /Label/ }))
    await user.click(screen.getByLabelText('zebra'))
    expect(props.onLabelsChange).not.toHaveBeenCalled()
  })

  it('still allows deselecting at the cap, so the control is never a dead end', async () => {
    const user = userEvent.setup()
    const props = setup({
      labels: ['a', 'b', 'c', 'd', 'e'],
      availableLabels: ['a', 'b', 'c', 'd', 'e', 'zebra'],
    })
    await user.click(screen.getByRole('button', { name: /Label/ }))
    await user.click(screen.getByLabelText('a'))
    expect(props.onLabelsChange).toHaveBeenCalledWith(['b', 'c', 'd', 'e'])
  })

  it('announces the cap in a live region rather than a bare hint', () => {
    setup({ labels: ['a', 'b', 'c', 'd', 'e'] })
    // The cap makes further clicks do nothing, so a screen-reader user has to be
    // told it was reached — a sibling span with no role conveys nothing.
    expect(screen.getByRole('status')).toHaveTextContent('max 5 labels')
  })

  it('clears the milestone and assignee inputs on Escape', async () => {
    const user = userEvent.setup()
    setup({ milestone: '1.2', assignee: 'alice' })
    const milestone = screen.getByLabelText('Filter by milestone')
    await user.click(milestone)
    await user.keyboard('{Escape}')
    expect(milestone).toHaveValue('')

    const assignee = screen.getByLabelText('Filter by assignee')
    await user.click(assignee)
    await user.keyboard('{Escape}')
    expect(assignee).toHaveValue('')
  })

  it('debounces the assignee commit (does not fetch per keystroke)', () => {
    vi.useFakeTimers()
    const props = setup()
    act(() => {
      fireEvent.change(screen.getByLabelText('Filter by assignee'), {
        target: { value: 'alice' },
      })
    })
    expect(props.onAssigneeChange).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(props.onAssigneeChange).toHaveBeenCalledWith('alice')
  })

  it('lists available milestones as datalist options', () => {
    setup()
    const opts = document.querySelectorAll('#lens-milestone-options option')
    // The "(no milestone)" sentinel leads; the fetched titles follow in order.
    expect(Array.from(opts).map((o) => (o as HTMLOptionElement).value)).toEqual([
      '(no milestone)',
      '1.2',
      '0.3',
    ])
  })

  it('calls onQChange on text input', async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.type(screen.getByLabelText('Filter issues by title or number'), 'x')
    expect(props.onQChange).toHaveBeenCalledWith('x')
  })

  it('debounces the milestone commit (does not fetch per keystroke)', () => {
    vi.useFakeTimers()
    const props = setup()
    const input = screen.getByLabelText('Filter by milestone')
    act(() => {
      fireEvent.change(input, { target: { value: '0.3' } })
    })
    expect(props.onMilestoneChange).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(props.onMilestoneChange).toHaveBeenCalledWith('0.3')
  })

  it('shows Clear only when filters are active and calls onClear', async () => {
    const user = userEvent.setup()
    const props = setup({ activeCount: 2 })
    const clear = screen.getByRole('button', { name: 'Clear' })
    await user.click(clear)
    expect(props.onClear).toHaveBeenCalled()
  })

  it('hides Clear when no filters are active', () => {
    setup({ activeCount: 0 })
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
  })
})
