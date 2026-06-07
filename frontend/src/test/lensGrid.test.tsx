import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import LensGrid from '../components/Board/Lens/LensGrid'
import type { LensData } from '../types'

function axis(key: string, label: string, is_current = false) {
  return { key, label, is_current }
}

const data: LensData = {
  columns: [axis('open', 'Open')],
  // Deliberately unsorted; the current lane must hoist to the top, none stays last.
  swimlanes: [axis('v1.0', 'v1.0'), axis('v1.2', 'v1.2', true), axis('v0.9', 'v0.9'), axis('__none__', '(no milestone)')],
  issues: [
    {
      number: 1, title: 'Issue 1', url: 'https://x/1', state: 'open',
      labels: [], assignees: [], milestone: null, milestone_due: null, milestone_state: null,
      column_keys: ['open'], swimlane_keys: ['v1.0'], has_branch: false, has_open_pr: false,
      pipeline_evidence: null,
    },
  ],
  fetched_at: '2026-06-07T00:00:00Z',
  source: { provider: 'gitlab', repo: 'g/p', url: 'https://gitlab.com/g/p' },
  truncated: false,
  total_count: 1,
  available_milestones: ['v1.0', 'v1.2', 'v0.9'],
}

describe('LensGrid swimlane ordering', () => {
  it('hoists the current milestone first, keeps "(none)" last', () => {
    render(
      <LensGrid
        data={data}
        collapsedKeys={new Set()}
        focusKey={null}
        onToggleCollapse={vi.fn()}
        onFocus={vi.fn()}
        onExitFocus={vi.fn()}
        compact={false}
      />,
    )
    const labels = screen.getAllByText(/^(v1\.0|v1\.2|v0\.9|\(no milestone\))$/)
    expect(labels.map((l) => l.textContent)).toEqual(['v1.2', 'v1.0', 'v0.9', '(no milestone)'])
  })
})
