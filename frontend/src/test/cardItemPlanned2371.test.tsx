import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import CardItem from '../components/Card/CardItem'
import { publishActivePreset } from '../boardPresets/activePresetStore'
import type { Card } from '../types'

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
}))

const PAST = '2020-01-02'

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid02371', column: 10, swimlane: 20, title: 'Proposal workshop',
    description: '', priority: 'medium', assignee: null, labels: [],
    due_date: null, weight: 1, position: 0,
    created_by: { id: 1, username: 'alice', display_name: 'Alice', avatar_url: '' },
    created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), updated_at: '2026-01-01T00:00:00Z',
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
    is_stale: false, archived_at: null, version: 1, custom_field_values: [],
    blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    ...overrides,
  }
}

// #2371: the planned-child status line on the card face (the planned branch of CardItem).
describe('CardItem — planned child status line (#2371)', () => {
  beforeEach(() => act(() => publishActivePreset({ boardId: 7, activePresetId: 'default', modified: false })))
  afterEach(() => act(() => publishActivePreset(null)))

  it('standard shows the full line, truncating, with the full text in title', () => {
    render(<CardItem card={makeCard({ planned: true, needed_at_column_name: 'Proposal' })} density="standard" />)
    const line = screen.getByTestId('card-status-line')
    expect(line).toHaveAttribute('data-status-kind', 'planned')
    expect(line).toHaveTextContent('Planned for Proposal')
    expect(line).toHaveAttribute('title', 'Planned for Proposal')
    expect(line.className).toContain('truncate')
    expect(line.className).toContain('min-w-0')
    expect(line.className).not.toContain('shrink-0')
  })

  it('dense shows the short form and keeps the full text in title', () => {
    render(<CardItem card={makeCard({ planned: true, needed_at_column_name: 'Proposal', due_date: '2099-12-04' })} density="dense" />)
    const line = screen.getByTestId('card-status-line')
    expect(line).toHaveTextContent(/^Planned · Proposal$/)
    expect(line.getAttribute('title')).toMatch(/^Planned for Proposal · Dec 4, counts once needed$/)
  })

  it('comfortable renders the line in its own row', () => {
    render(<CardItem card={makeCard({ planned: true, needed_at_column_name: null })} density="comfortable" />)
    expect(screen.getByTestId('card-status-line')).toHaveTextContent('Planned for a later stage')
  })

  it('a planned child with a passed date is never overdue: the warning line replaces it', () => {
    render(<CardItem card={makeCard({ planned: true, due_date: PAST })} density="standard" />)
    const line = screen.getByTestId('card-status-line')
    expect(line).toHaveAttribute('data-status-kind', 'planned-passed')
    expect(line).toHaveTextContent('Jan 2 passed while planned')
  })

  it('a released child in To do reads needed now; an ordinary card has no planned line', () => {
    const { unmount } = render(<CardItem card={makeCard({ planned: false, needed_now: true })} density="standard" />)
    expect(screen.getByTestId('card-status-line')).toHaveTextContent(/^Needed now$/)
    unmount()
    render(<CardItem card={makeCard()} density="standard" />)
    expect(screen.queryByTestId('card-status-line')).toBeNull()
  })
})
