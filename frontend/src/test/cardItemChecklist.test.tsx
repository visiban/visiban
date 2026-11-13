import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import CardItem from '../components/Card/CardItem'
import { checklistFaceSuffix } from '../utils/checklistFaceSuffix'
import { classifyCardUrgency } from '../utils/cardUrgency'
import type { Card } from '../types'

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
}))

vi.mock('../components/Common/Avatar', () => ({
  default: ({ user }: { user: { display_name: string } }) => <span data-testid="avatar">{user.display_name}</span>,
}))

// 2026-11-13 in UTC (the tz the face falls back to when unset).
const NOW = new Date('2026-11-13T12:00:00Z')

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Card',
    description: '', priority: 'low', assignee: null, labels: [],
    due_date: null, weight: 1, position: 0,
    created_by: { id: 1, username: 'alice', display_name: 'Alice', avatar_url: '' },
    created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
    last_moved_at: null, attachment_count: 0, checklist_total: 7, checklist_done: 3,
    is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0,
    external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    checklist_open_due_dates: [], checklist_open_assignee_ids: [],
    ...overrides,
  }
}

describe('checklistFaceSuffix (#445)', () => {
  const today = '2026-11-13'
  it('prefers overdue items over mine', () => {
    expect(checklistFaceSuffix(
      { checklist_open_due_dates: ['2026-11-01', '2026-11-12', '2026-11-13'], checklist_open_assignee_ids: [5, 5] },
      today, 5,
    )).toEqual({ kind: 'overdue', count: 2 })
  })
  it('falls back to items assigned to the viewer', () => {
    expect(checklistFaceSuffix(
      { checklist_open_due_dates: ['2026-11-13'], checklist_open_assignee_ids: [5, 6, 5] }, today, 5,
    )).toEqual({ kind: 'mine', count: 2 })
  })
  it('shows nothing without a viewer, a match, or the fields', () => {
    expect(checklistFaceSuffix({ checklist_open_assignee_ids: [5] }, today, undefined)).toBeNull()
    expect(checklistFaceSuffix({ checklist_open_assignee_ids: [6] }, today, 5)).toBeNull()
    expect(checklistFaceSuffix({}, today, 5)).toBeNull()
  })
})

describe('CardItem checklist suffix (#445)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('renders the overdue suffix in danger tone', () => {
    render(<CardItem card={makeCard({ checklist_open_due_dates: ['2026-11-10'] })} density="standard" currentUserId={5} />)
    const suffix = screen.getByTestId('checklist-suffix')
    expect(suffix).toHaveTextContent('· ⚑ 1')
    expect(suffix).toHaveClass('text-danger')
    expect(suffix).toHaveAttribute('title', '1 overdue checklist item')
    expect(screen.getByText('✓3/7')).toBeInTheDocument()
  })

  it('renders the mine suffix when nothing is overdue', () => {
    render(<CardItem card={makeCard({ checklist_open_assignee_ids: [5, 5] })} density="comfortable" currentUserId={5} />)
    const suffix = screen.getByTestId('checklist-suffix')
    expect(suffix).toHaveTextContent('· mine 2')
    expect(suffix).toHaveClass('text-fg-tertiary')
  })

  it('renders no suffix for another viewer or a card without items', () => {
    const { rerender } = render(<CardItem card={makeCard({ checklist_open_assignee_ids: [6] })} density="standard" currentUserId={5} />)
    expect(screen.queryByTestId('checklist-suffix')).toBeNull()
    rerender(<CardItem card={makeCard({ checklist_total: 0, checklist_done: 0, checklist_open_due_dates: ['2026-11-01'] })} density="standard" currentUserId={5} />)
    expect(screen.queryByTestId('checklist-suffix')).toBeNull()
  })

  it('re-renders when a remote assign changes only the face fields (memo comparator)', () => {
    const { rerender } = render(<CardItem card={makeCard()} density="standard" currentUserId={5} />)
    expect(screen.queryByTestId('checklist-suffix')).toBeNull()
    rerender(<CardItem card={makeCard({ checklist_open_assignee_ids: [5] })} density="standard" currentUserId={5} />)
    expect(screen.getByTestId('checklist-suffix')).toHaveTextContent('· mine 1')
  })

  it('never feeds the card urgency (A-Q9)', () => {
    const card = makeCard({ checklist_open_due_dates: ['2026-01-01'] })
    expect(classifyCardUrgency(card, NOW.getTime())).toBeNull()
  })
})
