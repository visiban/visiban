import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import LensView from '../components/Board/Lens/LensView'
import type { LensConnection } from '../types'

// LensView had no test file at all before this. The two behaviors pinned here are
// the ones the #1064 toolbar split moved or changed and that nothing else covers:
// the `showFilters` gate (the filter row's visibility now lives in BoardView and
// arrives as a prop) and the "*" collapse-all sentinel's resolution against the
// live lane set.

const refresh = vi.fn()
const mockUseLensData = vi.fn()
vi.mock('../hooks/useLensData', () => ({
  useLensData: (...args: unknown[]) => mockUseLensData(...args),
}))

const conn = {
  id: 1,
  provider: 'gitlab',
  repo_slug: 'acme/widgets',
  column_dim: 'status',
  swimlane_dim: 'milestone',
} as unknown as LensConnection

function lensData(laneKeys: string[]) {
  return {
    columns: [{ key: 'open', label: 'Open' }],
    swimlanes: laneKeys.map((k) => ({ key: k, label: k })),
    // One issue per lane: LensGrid renders a repo-level empty state when the
    // issue list is empty, so a lane-less fixture never reaches the swimlane rows.
    issues: laneKeys.map((k, i) => ({
      number: i + 1,
      title: `issue in ${k}`,
      url: `https://gitlab.com/acme/widgets/-/issues/${i + 1}`,
      state: 'open',
      labels: [],
      assignees: [],
      milestone: null,
      milestone_due: null,
      milestone_state: null,
      column_keys: ['open'],
      swimlane_keys: [k],
    })),
    fetched_at: new Date().toISOString(),
    source: { provider: 'gitlab', repo: 'acme/widgets', url: 'https://gitlab.com/acme/widgets' },
    truncated: false,
    available_milestones: [],
  }
}

function setup(url: string, showFilters = false, laneKeys = ['v1', 'v2', 'v3']) {
  mockUseLensData.mockReturnValue({
    data: lensData(laneKeys), error: null, loading: false, refetching: false, refresh,
  })
  return render(
    <MemoryRouter initialEntries={[url]}>
      <LensView boardId={5} connection={conn} cardLayout="expanded" showFilters={showFilters} />
    </MemoryRouter>,
  )
}

describe('LensView', () => {
  beforeEach(() => vi.clearAllMocks())

  it('hides the filter row unless showFilters is set', () => {
    setup('/')
    expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument()
  })

  it('renders every swimlane expanded by default', () => {
    setup('/')
    for (const k of ['v1', 'v2', 'v3']) {
      expect(screen.getByRole('button', { name: `Collapse ${k}` })).toBeInTheDocument()
    }
  })

  it('resolves the "*" collapse-all sentinel against the live lane set', () => {
    setup('/?lens_collapsed=*')
    for (const k of ['v1', 'v2', 'v3']) {
      expect(screen.getByRole('button', { name: `Expand ${k}` })).toBeInTheDocument()
    }
  })

  it('ignores collapsed keys for lanes that no longer exist', () => {
    // A re-pivot or a filter can shrink the lane set while stale keys linger in
    // the URL. They must not affect the lanes that are actually on screen.
    setup('/?lens_collapsed=gone-1,gone-2,v1')
    expect(screen.getByRole('button', { name: 'Expand v1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse v2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse v3' })).toBeInTheDocument()
  })

  it('collapsing one lane while stale keys linger does not collapse the board', async () => {
    // Regression guard: the write path used to build its working set from the raw
    // URL list without filtering against live lanes, so stale keys inflated the
    // count and tripped the ">= laneKeys.size" collapse-all normalization.
    const user = userEvent.setup()
    setup('/?lens_collapsed=gone-1,gone-2,v1')
    await user.click(screen.getByRole('button', { name: 'Collapse v2' }))
    expect(screen.getByRole('button', { name: 'Collapse v3' })).toBeInTheDocument()
  })

  it('drops a focus key that does not match a live lane', () => {
    setup('/?lens_focus=nonexistent')
    expect(screen.queryByRole('button', { name: 'Exit focus' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse v1' })).toBeInTheDocument()
  })
})
