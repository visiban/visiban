import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import BoardGroupPath from '../components/Group/BoardGroupPath'

describe('BoardGroupPath', () => {
  // The current group is elided from the displayed path — users are already
  // on its page, so repeating the name is noise (#845 architect spec).
  it('renders direct parent only when board is one level below the current group', () => {
    render(
      <BoardGroupPath
        ancestors={[{ id: 1, name: 'Root' }]}
        currentGroupId={1}
        directGroupName="Frontend"
      />,
    )
    expect(screen.getByText('Frontend')).toBeInTheDocument()
  })

  it('joins ancestors and direct parent with plain " / " separators', () => {
    render(
      <BoardGroupPath
        ancestors={[
          { id: 1, name: 'Root' },
          { id: 2, name: 'Alpha' },
          { id: 3, name: 'Beta' },
        ]}
        currentGroupId={1}
        directGroupName="Gamma"
      />,
    )
    // Jordan VoC: must be copy-paste friendly — a single text node with
    // plain slashes, not per-segment spans that break text selection.
    expect(screen.getByText('Alpha / Beta / Gamma')).toBeInTheDocument()
  })

  it('applies middle-ellipsis when path exceeds 3 segments', () => {
    render(
      <BoardGroupPath
        ancestors={[
          { id: 1, name: 'Root' },
          { id: 2, name: 'Alpha' },
          { id: 3, name: 'Beta' },
          { id: 4, name: 'Delta' },
        ]}
        currentGroupId={1}
        directGroupName="Epsilon"
      />,
    )
    // Always preserve the first and the board's direct parent — the middle
    // collapses to a single ellipsis (Maya VoC: deep hierarchies must truncate
    // gracefully while keeping the most meaningful segment visible).
    expect(screen.getByText('Alpha / … / Epsilon')).toBeInTheDocument()
  })

  it('exposes the full untruncated path via the title attribute', () => {
    render(
      <BoardGroupPath
        ancestors={[
          { id: 1, name: 'Root' },
          { id: 2, name: 'Alpha' },
          { id: 3, name: 'Beta' },
          { id: 4, name: 'Delta' },
        ]}
        currentGroupId={1}
        directGroupName="Epsilon"
      />,
    )
    const el = screen.getByText('Alpha / … / Epsilon')
    expect(el).toHaveAttribute('title', 'Alpha / Beta / Delta / Epsilon')
  })

  it('uses subdued metadata styling — not equal weight to board name (Sam VoC blocker)', () => {
    render(
      <BoardGroupPath
        ancestors={[{ id: 1, name: 'Root' }]}
        currentGroupId={1}
        directGroupName="Frontend"
      />,
    )
    const el = screen.getByText('Frontend')
    expect(el.className).toContain('text-xs')
    expect(el.className).toContain('text-fg-muted')
    expect(el.className).toContain('truncate')
    expect(el.className).toContain('min-w-0')
  })

  it('falls back to direct parent only when the current group is missing from ancestors', () => {
    // Edge case: depth-cap truncation could clip the current group out of the
    // returned chain. Rather than render a misleading partial path, show only
    // the direct parent — the pre-#845 behaviour.
    render(
      <BoardGroupPath
        ancestors={[
          { id: 99, name: 'Unrelated' },
          { id: 100, name: 'Other' },
        ]}
        currentGroupId={1}
        directGroupName="Frontend"
      />,
    )
    expect(screen.getByText('Frontend')).toBeInTheDocument()
    expect(screen.queryByText('Unrelated')).not.toBeInTheDocument()
    expect(screen.queryByText('Other')).not.toBeInTheDocument()
  })
})
