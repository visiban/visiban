import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LensProvenanceBanner from '../components/Board/Lens/LensProvenanceBanner'

// The freshness control ("Synced X ago · Refresh") was moved OFF the shared Row-2
// toolbar and into this banner (#1064): it is the one lens control that depends on
// fetched data, which lives next door in LensView. These tests pin that placement
// and the refresh affordance, which previously had no coverage at all.

const base = {
  provider: 'gitlab' as const,
  repo: 'acme/widgets',
  url: 'https://gitlab.com/acme/widgets',
  truncated: false,
  shownCount: 12,
  fetchedAt: new Date().toISOString(),
  refetching: false,
  onRefresh: vi.fn(),
}

describe('LensProvenanceBanner', () => {
  it('names the source repo and marks the view read-only', () => {
    render(<LensProvenanceBanner {...base} />)
    expect(screen.getByText(/acme\/widgets/)).toBeInTheDocument()
    expect(screen.getByText(/read-only lens/i)).toBeInTheDocument()
  })

  it('links to the upstream repo', () => {
    render(<LensProvenanceBanner {...base} />)
    const link = screen.getByRole('link', { name: /acme\/widgets/i })
    expect(link).toHaveAttribute('href', 'https://gitlab.com/acme/widgets')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('carries the freshness control, not the Row-2 toolbar', () => {
    render(<LensProvenanceBanner {...base} />)
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
  })

  it('Refresh calls onRefresh', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    render(<LensProvenanceBanner {...base} onRefresh={onRefresh} />)
    await user.click(screen.getByRole('button', { name: /refresh/i }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('disables Refresh while a refetch is in flight', () => {
    render(<LensProvenanceBanner {...base} refetching />)
    expect(screen.getByRole('button', { name: /refresh/i })).toBeDisabled()
  })

  it('warns when the provider truncated the result', () => {
    render(<LensProvenanceBanner {...base} truncated shownCount={300} />)
    expect(screen.getByText(/300/)).toBeInTheDocument()
  })

  // #1372 — the provider glyph used to be `provider === "github" ? "" : ""`: an
  // empty string in both branches, so no glyph ever rendered regardless of
  // provider. Per "No brand logos for external providers" in frontend/CLAUDE.md,
  // the fix is the SAME generic, decorative glyph for every provider (shared with
  // the card-face PR/MR badge) — not a per-provider brand logo. The provider
  // identity still reaches the user as text, via the repo link's title.
  it('renders the same generic, decorative glyph for every provider', () => {
    const { container: gitlabContainer } = render(<LensProvenanceBanner {...base} provider="gitlab" />)
    const gitlabSvg = gitlabContainer.querySelector('svg')
    expect(gitlabSvg).toBeInTheDocument()
    expect(gitlabSvg).toHaveAttribute('aria-hidden', 'true')

    const { container: githubContainer } = render(<LensProvenanceBanner {...base} provider="github" />)
    const githubSvg = githubContainer.querySelector('svg')
    expect(githubSvg).toBeInTheDocument()
    expect(githubSvg).toHaveAttribute('aria-hidden', 'true')

    // One generic glyph, not a per-provider brand logo.
    expect(githubSvg?.innerHTML).toEqual(gitlabSvg?.innerHTML)
  })

  it('still names the provider in text for each provider', () => {
    const { rerender } = render(<LensProvenanceBanner {...base} provider="gitlab" />)
    expect(screen.getByRole('link', { name: /acme\/widgets/i })).toHaveAttribute(
      'title',
      'Open acme/widgets on GitLab',
    )

    rerender(<LensProvenanceBanner {...base} provider="github" />)
    expect(screen.getByRole('link', { name: /acme\/widgets/i })).toHaveAttribute(
      'title',
      'Open acme/widgets on GitHub',
    )
  })
})
