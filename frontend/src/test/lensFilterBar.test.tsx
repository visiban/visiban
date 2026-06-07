import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LensFilterBar from '../components/Board/Lens/LensFilterBar'

function setup(overrides: Partial<React.ComponentProps<typeof LensFilterBar>> = {}) {
  const props: React.ComponentProps<typeof LensFilterBar> = {
    state: 'all',
    milestone: '',
    q: '',
    availableMilestones: ['1.2', '0.3'],
    activeCount: 0,
    onStateChange: vi.fn(),
    onMilestoneChange: vi.fn(),
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

  it('renders state, milestone, and text controls', () => {
    setup()
    expect(screen.getByText('State: All')).toBeInTheDocument()
    expect(screen.getByLabelText('Filter by milestone')).toBeInTheDocument()
    expect(screen.getByLabelText('Filter issues by title or number')).toBeInTheDocument()
  })

  it('lists available milestones as datalist options', () => {
    setup()
    const opts = document.querySelectorAll('#lens-milestone-options option')
    expect(Array.from(opts).map((o) => (o as HTMLOptionElement).value)).toEqual(['1.2', '0.3'])
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
