import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LensSwimlaneRow from '../components/Board/Lens/LensSwimlaneRow'
import type { LensAxis, NormalizedIssue } from '../types'

const columns: LensAxis[] = [
  { key: 'open', label: 'Open', is_current: false },
  { key: 'closed', label: 'Closed', is_current: false },
]

function issue(number: number, columnKey: string): NormalizedIssue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://x/${number}`,
    state: columnKey === 'closed' ? 'closed' : 'open',
    labels: [],
    assignees: [],
    milestone: null,
    milestone_due: null,
    milestone_state: null,
    column_keys: [columnKey],
    swimlane_keys: ['v1'],
    has_branch: false,
    has_open_pr: false,
    pipeline_evidence: null,
  }
}

function setup(overrides: Partial<React.ComponentProps<typeof LensSwimlaneRow>> = {}) {
  const onToggleCollapse = vi.fn()
  const onFocus = vi.fn()
  const onExitFocus = vi.fn()
  render(
    <LensSwimlaneRow
      swimlane={{ key: 'v1', label: 'v1.2', is_current: false }}
      columns={columns}
      sidebarWidth={200}
      colWidths={new Map([['open', 280], ['closed', 280]])}
      issues={[issue(1, 'open'), issue(2, 'closed')]}
      collapsed={false}
      onToggleCollapse={onToggleCollapse}
      isFocused={false}
      onFocus={onFocus}
      onExitFocus={onExitFocus}
      compact={false}
      {...overrides}
    />,
  )
  return { onToggleCollapse, onFocus, onExitFocus }
}

describe('LensSwimlaneRow', () => {
  it('renders cells with issue cards when expanded', () => {
    setup()
    expect(screen.getByText('Issue 1')).toBeInTheDocument()
    expect(screen.getByText('Issue 2')).toBeInTheDocument()
  })

  it('renders a count stub (not cells) when collapsed', () => {
    setup({ collapsed: true })
    expect(screen.queryByText('Issue 1')).not.toBeInTheDocument()
    expect(screen.getByText('2 issues')).toBeInTheDocument()
  })

  it('focus crosshair exposes aria-pressed and calls onFocus with the lane key', async () => {
    const user = userEvent.setup()
    const { onFocus } = setup()
    const crosshair = screen.getByRole('button', { name: 'Focus on v1.2' })
    expect(crosshair).toHaveAttribute('aria-pressed', 'false')
    await user.click(crosshair)
    expect(onFocus).toHaveBeenCalledWith('v1')
  })

  it('when focused, the crosshair exits focus', async () => {
    const user = userEvent.setup()
    const { onExitFocus } = setup({ isFocused: true })
    const crosshair = screen.getByRole('button', { name: 'Exit focus' })
    expect(crosshair).toHaveAttribute('aria-pressed', 'true')
    await user.click(crosshair)
    expect(onExitFocus).toHaveBeenCalled()
  })

  it('renders a "Current" badge when the milestone is current', () => {
    setup({ swimlane: { key: 'v1', label: 'v1.2', is_current: true } })
    expect(screen.getByText('Current')).toBeInTheDocument()
  })

  it('renders no "Current" badge when the milestone is not current', () => {
    setup()
    expect(screen.queryByText('Current')).not.toBeInTheDocument()
  })

  it('collapse chevron toggles and is labeled by state', async () => {
    const user = userEvent.setup()
    const { onToggleCollapse } = setup()
    await user.click(screen.getByRole('button', { name: 'Collapse v1.2' }))
    expect(onToggleCollapse).toHaveBeenCalled()
  })

  // --- Resizing (#1065) ---

  it('renders each cell at its resolved colWidths entry', () => {
    setup({ colWidths: new Map([['open', 400], ['closed', 280]]) })
    const openCell = screen.getByText('Issue 1').closest('[style]') as HTMLElement
    expect(openCell.style.width).toBe('400px')
  })

  it('falls back to the default column width for a key missing from colWidths', () => {
    setup({ colWidths: new Map() })
    const openCell = screen.getByText('Issue 1').closest('[style]') as HTMLElement
    expect(openCell.style.width).toBe('280px')
  })

  it('sidebarWidth drives the label panel width', () => {
    setup({ sidebarWidth: 320 })
    const label = screen.getByText('v1.2').closest('[style]') as HTMLElement
    expect(label.style.width).toBe('320px')
  })

  it('compact cells lay out with auto-fill/minmax rather than a fixed 2-column grid', () => {
    setup({ compact: true })
    const grid = screen.getByText('Issue 1').closest('.grid') as HTMLElement
    expect(grid.className).toContain('grid-cols-[repeat(auto-fill,minmax(120px,1fr))]')
    expect(grid.className).not.toContain('grid-cols-2')
  })
})
