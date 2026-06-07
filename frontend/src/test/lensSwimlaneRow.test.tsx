import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LensSwimlaneRow from '../components/Board/Lens/LensSwimlaneRow'
import type { LensAxis, NormalizedIssue } from '../types'

const columns: LensAxis[] = [
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' },
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
      swimlane={{ key: 'v1', label: 'v1.2' }}
      columns={columns}
      sidebarWidth={200}
      colWidth={280}
      issues={[issue(1, 'open'), issue(2, 'closed')]}
      collapsed={false}
      onToggleCollapse={onToggleCollapse}
      isFocused={false}
      onFocus={onFocus}
      onExitFocus={onExitFocus}
      density="comfortable"
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

  it('collapse chevron toggles and is labeled by state', async () => {
    const user = userEvent.setup()
    const { onToggleCollapse } = setup()
    await user.click(screen.getByRole('button', { name: 'Collapse v1.2' }))
    expect(onToggleCollapse).toHaveBeenCalled()
  })
})
