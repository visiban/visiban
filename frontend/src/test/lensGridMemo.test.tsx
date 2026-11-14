import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useCallback, useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import type { LensData, NormalizedIssue } from '../types'

// Count LensIssueCard renders per issue: a lane re-filters its cells and
// re-renders its cards exactly when LensSwimlaneRow re-renders (#1088).
const cardRenders = new Map<number, number>()
vi.mock('../components/Board/Lens/LensIssueCard', () => ({
  default: ({ issue }: { issue: NormalizedIssue }) => {
    cardRenders.set(issue.number, (cardRenders.get(issue.number) ?? 0) + 1)
    return <div>card-{issue.number}</div>
  },
}))

import LensGrid from '../components/Board/Lens/LensGrid'

const axis = (key: string, label: string) => ({ key, label, is_current: false })
const issue = (number: number, lane: string): NormalizedIssue => ({
  number, title: `Issue ${number}`, url: `https://x/${number}`, state: 'open',
  labels: [], assignees: [], milestone: null, milestone_due: null, milestone_state: null,
  column_keys: ['open'], swimlane_keys: [lane], has_branch: false, has_open_pr: false,
  pipeline_evidence: null,
})

const data: LensData = {
  columns: [axis('open', 'Open')],
  swimlanes: [axis('a', 'Lane A'), axis('b', 'Lane B'), axis('c', 'Lane C')],
  issues: [issue(1, 'a'), issue(2, 'b'), issue(3, 'c')],
  fetched_at: '2026-06-07T00:00:00Z',
  source: { provider: 'gitlab', repo: 'g/p', url: 'https://gitlab.com/g/p' },
  truncated: false,
  total_count: 3,
  available_milestones: [],
}

// Module-level so the grid's colWidths memo holds, as useLensViewPrefs state does.
const COLUMN_WIDTHS: Record<string, number> = {}

function Harness() {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [focus, setFocus] = useState<string | null>(null)
  // Stable identities, as LensView provides (#1088).
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  const exitFocus = useCallback(() => setFocus(null), [])
  return (
    <LensGrid
      data={data}
      collapsedKeys={collapsed}
      focusKey={focus}
      onToggleCollapse={toggle}
      onFocus={setFocus}
      onExitFocus={exitFocus}
      compact={false}
      sidebarWidth={200}
      columnWidths={COLUMN_WIDTHS}
      onResizeSidebar={vi.fn()}
      onResizeColumn={vi.fn()}
    />
  )
}

describe('LensSwimlaneRow memoization (#1088)', () => {
  beforeEach(() => cardRenders.clear())

  it('toggling one lane does not re-render the other lanes', () => {
    render(<Harness />)
    expect(cardRenders.get(1)).toBe(1)
    expect(cardRenders.get(2)).toBe(1)
    expect(cardRenders.get(3)).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Lane A' }))

    expect(screen.getByRole('button', { name: 'Expand Lane A' })).toBeInTheDocument()
    // Lane A collapsed (its cards unmount); B and C must not have re-rendered.
    expect(cardRenders.get(2)).toBe(1)
    expect(cardRenders.get(3)).toBe(1)
  })

  it('still collapses the right lane with the shared callback', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Lane B' }))
    expect(screen.getByRole('button', { name: 'Expand Lane B' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse Lane C' })).toBeInTheDocument()
  })
})
