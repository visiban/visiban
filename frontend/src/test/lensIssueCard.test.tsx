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
    has_branch: false,
    has_open_pr: false,
    pipeline_evidence: null,
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
    expect(screen.getByText(/×3/)).toBeInTheDocument()
  })

  it('exposes the multi-lane indicator with an aria-label and hides the emoji from AT', () => {
    render(<LensIssueCard issue={makeIssue()} laneCount={3} />)
    const indicator = screen.getByLabelText('Appears in 3 lanes')
    expect(indicator).toBeInTheDocument()
    // The 🔗 glyph is decorative — it must not be part of the accessible name.
    const emoji = indicator.querySelector('[aria-hidden="true"]')
    expect(emoji).not.toBeNull()
    expect(emoji?.textContent).toBe('🔗')
  })

  it('gives the card button an accessible name describing the issue and new-tab behavior', () => {
    render(<LensIssueCard issue={makeIssue()} />)
    expect(
      screen.getByRole('button', {
        name: 'Open issue #42: Fix the flux capacitor (opens in new tab)',
      }),
    ).toBeInTheDocument()
  })

  it('uses the neutral rounded button radius (not rounded-md)', () => {
    render(<LensIssueCard issue={makeIssue()} />)
    const card = screen.getByRole('button')
    expect(card.className).toContain('rounded')
    expect(card.className).not.toContain('rounded-md')
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

  describe('pipeline evidence', () => {
    it('renders no branch/MR chips when pipeline_evidence is null', () => {
      render(<LensIssueCard issue={makeIssue()} />)
      expect(screen.queryByRole('link')).not.toBeInTheDocument()
      expect(screen.queryByText(/^!/)).not.toBeInTheDocument()
    })

    it('shows the linked branch name', () => {
      render(
        <LensIssueCard
          issue={makeIssue({
            has_branch: true,
            pipeline_evidence: { branch: 'feat/482-token-refresh', mr_number: null, mr_url: null, mr_closes: false },
          })}
        />,
      )
      expect(screen.getByText('feat/482-token-refresh')).toBeInTheDocument()
    })

    it('renders the MR chip as a new-tab link to mr_url', () => {
      render(
        <LensIssueCard
          issue={makeIssue({
            has_open_pr: true,
            pipeline_evidence: { branch: null, mr_number: 91, mr_url: 'https://gitlab.com/acme/widgets/-/merge_requests/91', mr_closes: true },
          })}
        />,
      )
      const link = screen.getByRole('link', { name: 'Open closing merge request !91 in new tab' })
      expect(link).toHaveAttribute('href', 'https://gitlab.com/acme/widgets/-/merge_requests/91')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
      expect(screen.getByText('!91')).toBeInTheDocument()
    })

    it('labels a referencing (non-closing) MR distinctly', () => {
      render(
        <LensIssueCard
          issue={makeIssue({
            has_open_pr: true,
            pipeline_evidence: { branch: null, mr_number: 7, mr_url: 'https://x/7', mr_closes: false },
          })}
        />,
      )
      expect(
        screen.getByRole('link', { name: 'Open referencing merge request !7 in new tab' }),
      ).toBeInTheDocument()
    })

    it('compact density drops labels/milestone/evidence but keeps number, pill, title', () => {
      render(
        <LensIssueCard
          density="compact"
          issue={makeIssue({
            labels: [{ name: 'bug', color: 'ff0000' }],
            milestone: 'v2.0',
            assignees: [{ username: 'alice', avatar_url: '' }],
            pipeline_evidence: { branch: 'feat/1-x', mr_number: 9, mr_url: 'https://x/9', mr_closes: true },
          })}
        />,
      )
      // Kept
      expect(screen.getByText('#42')).toBeInTheDocument()
      expect(screen.getByText('Open')).toBeInTheDocument()
      expect(screen.getByText('Fix the flux capacitor')).toBeInTheDocument()
      // Dropped
      expect(screen.queryByText('bug')).not.toBeInTheDocument()
      expect(screen.queryByText('v2.0')).not.toBeInTheDocument()
      expect(screen.queryByText('feat/1-x')).not.toBeInTheDocument()
      expect(screen.queryByRole('link')).not.toBeInTheDocument()
      const card = screen.getByRole('button')
      expect(card.className).toContain('p-1.5')
    })

    it('clicking the MR chip opens the MR, not the issue (stopPropagation)', async () => {
      const user = userEvent.setup()
      render(
        <LensIssueCard
          issue={makeIssue({
            pipeline_evidence: { branch: null, mr_number: 91, mr_url: 'https://x/91', mr_closes: true },
          })}
        />,
      )
      await user.click(screen.getByRole('link', { name: /merge request !91/ }))
      // The card's window.open(issue.url) must NOT fire — the click was isolated
      // to the nested link, which navigates natively (no window.open spy hit).
      expect(openSpy).not.toHaveBeenCalled()
    })
  })
})
