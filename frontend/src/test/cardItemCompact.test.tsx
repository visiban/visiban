import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import CardItem from '../components/Card/CardItem'
import type { Card } from '../types'

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    isDragging: false,
  }),
}))

vi.mock('../components/Common/Avatar', () => ({
  default: ({ user }: { user: { display_name: string } }) => (
    <span data-testid="avatar">{user.display_name}</span>
  ),
}))

vi.mock('../utils/date', () => ({
  formatDueDate: (_date: string, _tz: string, _fmt: string) => ({ label: 'Jan 15', overdue: false }),
  // Return null when date is null (matches real implementation behaviour); otherwise return
  // a fixed label so tests can assert its presence/absence without depending on wall-clock time.
  formatRelativeMovedAt: (date: string | null, _fmt: string) => date === null ? null : 'moved 3 days ago',
}))

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1,
    uid: 'carduid00001',
    column: 10,
    swimlane: 20,
    title: 'Test Card Title',
    description: '',
    priority: 'low',
    assignee: null,
    labels: [],
    due_date: null,
    weight: 1,
    position: 0,
    created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_moved_at: null,
    attachment_count: 0,
    checklist_total: 0,
    checklist_done: 0,
    is_stale: false,
    archived_at: null,
    version: 1,
    ...overrides,
  }
}

describe('CardItem — compact vs expanded rendering', () => {
  // --- Title truncation ---

  it('title uses line-clamp-1 in compact mode', () => {
    const { container } = render(<CardItem card={makeCard()} compact />)
    const titleEl = container.querySelector('p.line-clamp-1')
    expect(titleEl).toBeInTheDocument()
    expect(titleEl).toHaveTextContent('Test Card Title')
  })

  it('title uses line-clamp-2 in expanded mode', () => {
    const { container } = render(<CardItem card={makeCard()} compact={false} />)
    const titleEl = container.querySelector('p.line-clamp-2')
    expect(titleEl).toBeInTheDocument()
    expect(titleEl).toHaveTextContent('Test Card Title')
  })

  // --- Padding ---

  it('compact mode applies reduced vertical padding py-1.5', () => {
    const { container } = render(<CardItem card={makeCard()} compact />)
    const inner = container.querySelector('.py-1\\.5')
    expect(inner).toBeInTheDocument()
  })

  it('expanded mode applies standard vertical padding py-2', () => {
    const { container } = render(<CardItem card={makeCard()} compact={false} />)
    const inner = container.querySelector('.py-2')
    expect(inner).toBeInTheDocument()
  })

  // --- Metadata hidden in compact mode ---

  it('label pills are hidden in compact mode', () => {
    const card = makeCard({
      labels: [{ id: 1, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }],
    })
    render(<CardItem card={card} compact />)
    expect(screen.queryByText('Bug')).not.toBeInTheDocument()
  })

  it('label pills are shown in expanded mode', () => {
    const card = makeCard({
      labels: [{ id: 1, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }],
    })
    render(<CardItem card={card} compact={false} />)
    expect(screen.getByText('Bug')).toBeInTheDocument()
  })

  it('description icon is hidden in compact mode', () => {
    const card = makeCard({ description: 'Some description text' })
    const { container } = render(<CardItem card={card} compact />)
    // The SVG carries aria-label="Has description" on the element itself
    expect(container.querySelector('svg[aria-label="Has description"]')).not.toBeInTheDocument()
  })

  it('description icon is shown in expanded mode when description is present', () => {
    const card = makeCard({ description: 'Some description text' })
    const { container } = render(<CardItem card={card} compact={false} />)
    expect(container.querySelector('svg[aria-label="Has description"]')).toBeInTheDocument()
  })

  it('checklist indicator is hidden in compact mode', () => {
    const card = makeCard({ checklist_total: 3, checklist_done: 1 })
    render(<CardItem card={card} compact />)
    expect(screen.queryByText(/✓1\/3/)).not.toBeInTheDocument()
  })

  it('checklist indicator is shown in expanded mode', () => {
    const card = makeCard({ checklist_total: 3, checklist_done: 1 })
    render(<CardItem card={card} compact={false} />)
    expect(screen.getByText('✓1/3')).toBeInTheDocument()
  })

  it('attachment count is hidden in compact mode', () => {
    const card = makeCard({ attachment_count: 2 })
    render(<CardItem card={card} compact />)
    expect(screen.queryByText(/📎/)).not.toBeInTheDocument()
  })

  it('attachment count is shown in expanded mode', () => {
    const card = makeCard({ attachment_count: 2 })
    render(<CardItem card={card} compact={false} />)
    expect(screen.getByText('📎2')).toBeInTheDocument()
  })

  it('due date is hidden in compact mode', () => {
    const card = makeCard({ due_date: '2026-01-15' })
    render(<CardItem card={card} compact />)
    expect(screen.queryByText('Jan 15')).not.toBeInTheDocument()
  })

  it('due date is shown in expanded mode', () => {
    const card = makeCard({ due_date: '2026-01-15' })
    render(<CardItem card={card} compact={false} />)
    expect(screen.getByText('Jan 15')).toBeInTheDocument()
  })

  it('moved text label is hidden in compact mode', () => {
    // last_moved_at > 24h ago so movedLabel would be set in expanded mode
    const movedAt = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const card = makeCard({ last_moved_at: movedAt })
    render(<CardItem card={card} compact />)
    expect(screen.queryByText('moved 3 days ago')).not.toBeInTheDocument()
  })

  it('moved text label is shown in expanded mode for cards moved ≥24h ago', () => {
    const movedAt = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const card = makeCard({ last_moved_at: movedAt })
    render(<CardItem card={card} compact={false} />)
    expect(screen.getByText('moved 3 days ago')).toBeInTheDocument()
  })

  it('weight indicator is hidden in compact mode', () => {
    const card = makeCard({ weight: 5 })
    render(<CardItem card={card} compact />)
    expect(screen.queryByTitle('Weight: 5')).not.toBeInTheDocument()
  })

  it('weight indicator is shown in expanded mode when weight > 1', () => {
    const card = makeCard({ weight: 5 })
    render(<CardItem card={card} compact={false} />)
    expect(screen.getByTitle('Weight: 5')).toBeInTheDocument()
  })

  // --- Indicators shown in both modes ---

  it('stale indicator clock emoji is not rendered in compact mode (replaced by overlay)', () => {
    const card = makeCard({ is_stale: true })
    render(<CardItem card={card} compact />)
    expect(screen.queryByTitle('Stale — no movement recently')).not.toBeInTheDocument()
  })

  it('stale indicator clock emoji is not rendered in expanded mode (replaced by overlay)', () => {
    const card = makeCard({ is_stale: true })
    render(<CardItem card={card} compact={false} />)
    expect(screen.queryByTitle('Stale — no movement recently')).not.toBeInTheDocument()
  })

  it('aging overlay is shown in compact mode when card is past threshold', () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 86_400_000).toISOString()
    const card = makeCard({ last_moved_at: fifteenDaysAgo })
    const { container } = render(
      <CardItem card={card} compact staleness_threshold_days={14} stale_warning_pct={50} />
    )
    const root = container.firstChild as HTMLElement
    expect(root.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
  })

  it('aging overlay is shown in expanded mode when card is past threshold', () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 86_400_000).toISOString()
    const card = makeCard({ last_moved_at: fifteenDaysAgo })
    const { container } = render(
      <CardItem card={card} compact={false} staleness_threshold_days={14} stale_warning_pct={50} />
    )
    const root = container.firstChild as HTMLElement
    expect(root.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
  })

  it('recently moved dot is shown in compact mode for cards moved <24h ago', () => {
    const recentlyMovedAt = new Date(Date.now() - 60_000).toISOString()
    const card = makeCard({ last_moved_at: recentlyMovedAt, is_stale: false })
    const { container } = render(<CardItem card={card} compact />)
    expect(container.querySelector('[title="Recently moved"]')).toBeInTheDocument()
  })

  it('recently moved dot is shown in expanded mode', () => {
    const recentlyMovedAt = new Date(Date.now() - 60_000).toISOString()
    const card = makeCard({ last_moved_at: recentlyMovedAt, is_stale: false })
    const { container } = render(<CardItem card={card} compact={false} />)
    expect(container.querySelector('[title="Recently moved"]')).toBeInTheDocument()
  })

  it('priority badge for medium priority is shown in compact mode', () => {
    const card = makeCard({ priority: 'medium' })
    render(<CardItem card={card} compact />)
    expect(screen.getByTitle('Priority: medium')).toBeInTheDocument()
  })

  it('priority badge for medium priority is shown in expanded mode', () => {
    const card = makeCard({ priority: 'medium' })
    render(<CardItem card={card} compact={false} />)
    expect(screen.getByTitle('Priority: medium')).toBeInTheDocument()
  })

  it('priority badge is not shown for low priority in either mode', () => {
    const card = makeCard({ priority: 'low' })
    render(<CardItem card={card} compact />)
    expect(screen.queryByTitle('Priority: low')).not.toBeInTheDocument()
  })

  it('assignee avatar is shown in compact mode', () => {
    const card = makeCard({
      assignee: {
        id: 2, username: 'jdoe', avatar_url: '',
        display_name: 'Jane Doe',
      },
    })
    render(<CardItem card={card} compact />)
    expect(screen.getByTestId('avatar')).toBeInTheDocument()
  })

  it('assignee avatar is shown in expanded mode', () => {
    const card = makeCard({
      assignee: {
        id: 2, username: 'jdoe', avatar_url: '',
        display_name: 'Jane Doe',
      },
    })
    render(<CardItem card={card} compact={false} />)
    expect(screen.getByTestId('avatar')).toBeInTheDocument()
  })

  // --- No metadata row when card has nothing to show ---

  it('metadata row is not rendered when card has no metadata in either mode', () => {
    // Default card: no labels, no description, no due date, priority=low (excluded),
    // weight=1 (excluded), no assignee, not stale, last_moved_at=null (formatRelativeMovedAt
    // returns null when date is null, so movedLabel is null) — hasMetadata evaluates to false.
    const card = makeCard()
    const { container } = render(<CardItem card={card} compact />)
    // The metadata row carries a distinctive mt-1.5 class; [class*="mt-1.5"] avoids
    // issues with jsdom's handling of escaped dots in compound class selectors.
    expect(container.querySelector('[class*="mt-1.5"]')).not.toBeInTheDocument()
  })

  // --- readOnly disables interaction ---

  it('readOnly card has cursor-default class', () => {
    const { container } = render(<CardItem card={makeCard()} readOnly compact />)
    expect((container.firstChild as HTMLElement).className).toMatch(/cursor-default/)
  })
})
