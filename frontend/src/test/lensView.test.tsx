import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
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

function setup(url: string, showFilters = false, laneKeys = ['v1', 'v2', 'v3'], data?: unknown) {
  mockUseLensData.mockReturnValue({
    data: data ?? lensData(laneKeys), error: null, loading: false, refetching: false, refresh,
  })
  return render(
    <MemoryRouter initialEntries={[url]}>
      <LensView boardId={5} connection={conn} cardLayout="expanded" showFilters={showFilters} />
    </MemoryRouter>,
  )
}

/** Fixture whose single issue carries labels and assignees, for the suggestion tests. */
function labelledData() {
  const base = lensData(['v1'])
  base.issues[0].labels = [
    { name: 'bug', color: 'd73a4a' },
    { name: 'backend', color: '0075ca' },
  ] as never
  base.issues[0].assignees = [{ username: 'alice', avatar_url: '' }] as never
  return base
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

  it('passes the server-side filters from the URL into the fetch', () => {
    setup('/?state=open&milestone=1.2&labels=bug,backend&assignee=alice', true)
    expect(mockUseLensData).toHaveBeenCalledWith(5, {
      columnDim: 'status',
      swimlaneDim: 'milestone',
      filters: {
        state: 'open',
        milestone: '1.2',
        // Canonicalized on read so a hand-edited or reordered shared link lands on
        // the same server cache key the UI would have produced.
        labels: ['backend', 'bug'],
        assignee: 'alice',
      },
    })
  })

  it('derives label and assignee suggestions from the fetched issues', async () => {
    const user = userEvent.setup()
    setup('/', true, ['v1'], labelledData())
    await user.click(screen.getByRole('button', { name: /Label/ }))
    expect(screen.getByLabelText('backend')).toBeInTheDocument()
    expect(screen.getByLabelText('bug')).toBeInTheDocument()

    const opts = document.querySelectorAll('#lens-assignee-options option')
    expect(Array.from(opts).map((o) => (o as HTMLOptionElement).value)).toEqual(['alice'])
  })

  it('keeps an active label in the suggestion list even when nothing in the response carries it', async () => {
    // Label filtering is SERVER-SIDE, so a filtered response only contains issues
    // that match. Deriving the menu from the current response alone would collapse
    // it to the selection and make a second label unaddable.
    const user = userEvent.setup()
    setup('/?labels=from-a-shared-link', true, ['v1'])
    await user.click(screen.getByRole('button', { name: /Label/ }))
    expect(screen.getByLabelText('from-a-shared-link')).toBeInTheDocument()
  })

  it('counts every active filter dimension and clears them all', async () => {
    const user = userEvent.setup()
    setup('/?state=open&milestone=1.2&labels=bug&assignee=alice&q=pag', true)
    expect(screen.getByText(/5 filters/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.queryByText(/filters ·/)).not.toBeInTheDocument()
  })

  it('writes a label selection to the URL, canonicalized, and re-fetches', async () => {
    // Read-direction (URL -> fetch filters) is covered above; this is the write
    // direction — LensFilterBar's onLabelsChange must flow through setLabels's
    // serializeLensLabels canonicalization and back out through the URL-read path
    // on the next render, landing on the exact same filters shape a shared link
    // carrying ?labels=bug would produce.
    const user = userEvent.setup()
    setup('/', true, ['v1'], labelledData())
    mockUseLensData.mockClear()
    await user.click(screen.getByRole('button', { name: /Label/ }))
    await user.click(screen.getByLabelText('bug'))
    expect(mockUseLensData).toHaveBeenLastCalledWith(
      5,
      expect.objectContaining({
        filters: expect.objectContaining({ labels: ['bug'] }),
      }),
    )
  })

  it('writes a debounced, trimmed assignee filter to the URL and re-fetches', () => {
    vi.useFakeTimers()
    setup('/', true, ['v1'])
    mockUseLensData.mockClear()
    const input = screen.getByLabelText('Filter by assignee')
    act(() => {
      fireEvent.change(input, { target: { value: '  alice  ' } })
      vi.advanceTimersByTime(400)
    })
    expect(mockUseLensData).toHaveBeenLastCalledWith(
      5,
      expect.objectContaining({
        filters: expect.objectContaining({ assignee: 'alice' }),
      }),
    )
    vi.useRealTimers()
  })
})
