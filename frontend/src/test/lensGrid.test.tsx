import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
        sidebarWidth={200}
        columnWidths={{}}
        onResizeSidebar={vi.fn()}
        onResizeColumn={vi.fn()}
      />,
    )
    const labels = screen.getAllByText(/^(v1\.0|v1\.2|v0\.9|\(no milestone\))$/)
    expect(labels.map((l) => l.textContent)).toEqual(['v1.2', 'v1.0', 'v0.9', '(no milestone)'])
  })
})

describe('LensGrid resizing (#1065)', () => {
  function renderGrid(overrides: Partial<React.ComponentProps<typeof LensGrid>> = {}) {
    const onResizeSidebar = vi.fn()
    const onResizeColumn = vi.fn()
    render(
      <LensGrid
        data={data}
        collapsedKeys={new Set()}
        focusKey={null}
        onToggleCollapse={vi.fn()}
        onFocus={vi.fn()}
        onExitFocus={vi.fn()}
        compact={false}
        sidebarWidth={200}
        columnWidths={{}}
        onResizeSidebar={onResizeSidebar}
        onResizeColumn={onResizeColumn}
        {...overrides}
      />,
    )
    return { onResizeSidebar, onResizeColumn }
  }

  it('renders the corner cell and column header at their prop widths', () => {
    renderGrid({ sidebarWidth: 240, columnWidths: { open: 350 } })
    const corner = screen.getByText('1 col').closest('[style]') as HTMLElement
    expect(corner.style.width).toBe('240px')
    const header = screen.getByTitle('Open').closest('[style]') as HTMLElement
    expect(header.style.width).toBe('350px')
  })

  it('a missing column key falls back to the default column width', () => {
    renderGrid({ columnWidths: {} })
    const header = screen.getByTitle('Open').closest('[style]') as HTMLElement
    expect(header.style.width).toBe('280px')
  })

  it('dragging the sidebar handle calls onResizeSidebar with the dragged width', () => {
    const { onResizeSidebar } = renderGrid({ sidebarWidth: 200 })
    const handle = screen.getByRole('separator', { name: 'Resize swimlane label width' })
    fireEvent.mouseDown(handle, { clientX: 0 })
    fireEvent.mouseMove(window, { clientX: 40 })
    expect(onResizeSidebar).toHaveBeenCalledWith(240)
    fireEvent.mouseUp(window)
  })

  it('dragging a column handle calls onResizeColumn with that column key and the dragged width', () => {
    const { onResizeColumn } = renderGrid({ columnWidths: { open: 280 } })
    const handle = screen.getByRole('separator', { name: 'Resize Open column' })
    fireEvent.mouseDown(handle, { clientX: 0 })
    fireEvent.mouseMove(window, { clientX: -30 })
    expect(onResizeColumn).toHaveBeenCalledWith('open', 250)
    fireEvent.mouseUp(window)
  })
})
