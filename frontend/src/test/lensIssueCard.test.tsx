import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LensIssueCard from '../components/Board/Lens/LensIssueCard'
import type { NormalizedIssue } from '../types'

function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    number: 42,
    title: 'Fix the flux capacitor',
    url: 'https://github.com/acme/widgets/issues/42',
    state: 'open',
    labels: [],
    assignees: [],
    milestone: null,
    column_keys: ['open'],
    swimlane_keys: ['__none__'],
    ...overrides,
  }
}

describe('LensIssueCard', () => {
  let openSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
  })
  afterEach(() => {
    openSpy.mockRestore()
  })

  it('renders an open issue with the Open state pill (no opacity dimming)', () => {
    render(<LensIssueCard issue={makeIssue({ state: 'open' })} />)
    expect(screen.getByText('Open')).toBeInTheDocument()
    expect(screen.getByText('#42')).toBeInTheDocument()
    const card = screen.getByRole('button')
    expect(card.className).not.toContain('opacity-70')
  })

  it('renders a closed issue dimmed with a Closed pill', () => {
    render(<LensIssueCard issue={makeIssue({ state: 'closed' })} />)
    expect(screen.getByText('Closed')).toBeInTheDocument()
    const card = screen.getByRole('button')
    expect(card.className).toContain('opacity-70')
  })

  it('shows the multi-lane indicator only when laneCount > 1', () => {
    const { rerender } = render(<LensIssueCard issue={makeIssue()} laneCount={1} />)
    expect(screen.queryByText(/×/)).not.toBeInTheDocument()

    rerender(<LensIssueCard issue={makeIssue()} laneCount={3} />)
    expect(screen.getByText('🔗 ×3')).toBeInTheDocument()
  })

  it('opens the issue url in a new tab with noopener,noreferrer on click', async () => {
    const user = userEvent.setup()
    render(<LensIssueCard issue={makeIssue()} />)
    await user.click(screen.getByRole('button'))
    expect(openSpy).toHaveBeenCalledWith(
      'https://github.com/acme/widgets/issues/42',
      '_blank',
      'noopener,noreferrer',
    )
  })

  it('tints label chips with the hex color (prepending #)', () => {
    render(<LensIssueCard issue={makeIssue({ labels: [{ name: 'bug', color: 'ff0000' }] })} />)
    const chip = screen.getByText('bug')
    expect(chip).toHaveStyle({ color: '#ff0000' })
  })

  it('renders the milestone with a flag glyph', () => {
    render(<LensIssueCard issue={makeIssue({ milestone: 'v2.0' })} />)
    expect(screen.getByText('v2.0')).toBeInTheDocument()
  })

  it('caps assignee avatars at 3 with a +N overflow', () => {
    const assignees = ['a', 'b', 'c', 'd', 'e'].map((u) => ({ username: u, avatar_url: '' }))
    render(<LensIssueCard issue={makeIssue({ assignees })} />)
    expect(screen.getByText('+2')).toBeInTheDocument()
  })
})
