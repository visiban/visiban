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
})
