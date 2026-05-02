import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import CardItem from '../components/Card/CardItem'
import type { Card } from '../types'

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
}))

vi.mock('../components/Common/Avatar', () => ({
  default: ({ user }: { user: { display_name: string } }) => (
    <span data-testid="avatar">{user.display_name}</span>
  ),
}))

const TODAY = new Date()
const TWO_DAYS_FROM_NOW = new Date(TODAY.getTime() + 2 * 86_400_000).toISOString().slice(0, 10)
const FIVE_DAYS_AGO = new Date(TODAY.getTime() - 5 * 86_400_000).toISOString().slice(0, 10)
const TWELVE_HOURS_AGO = new Date(TODAY.getTime() - 12 * 60 * 60 * 1000).toISOString()

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Density test',
    description: 'A description', priority: 'medium',
    assignee: { id: 1, username: 'alice', display_name: 'Alice', avatar_url: '' },
    labels: [
      { id: 100, uid: 'lbluid001', name: 'backend', color: '#10B981' },
      { id: 101, uid: 'lbluid002', name: 'security', color: '#8B5CF6' },
      { id: 102, uid: 'lbluid003', name: 'q2-goal', color: '#F59E0B' },
    ],
    due_date: null, weight: 5, position: 0,
    created_by: { id: 1, username: 'alice', display_name: 'Alice', avatar_url: '' },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    last_moved_at: null, attachment_count: 3, checklist_total: 5, checklist_done: 2,
    is_stale: false, archived_at: null, version: 1,
    ...overrides,
  }
}

describe('CardItem — card_density (#961)', () => {
  // ---- comfortable: minimal layout ----

  describe('density="comfortable"', () => {
    it('renders only one primary label + overflow pill when multiple labels exist', () => {
      render(<CardItem card={makeCard()} density="comfortable" />)
      expect(screen.getByText('backend')).toBeInTheDocument()
      expect(screen.queryByText('security')).not.toBeInTheDocument()
      expect(screen.queryByText('q2-goal')).not.toBeInTheDocument()
      expect(screen.getByText('+2')).toBeInTheDocument()
    })

    it('hides the description indicator (icon)', () => {
      const { container } = render(<CardItem card={makeCard()} density="comfortable" />)
      // The icon carries an aria-label="Has description"; absence proves it was suppressed.
      expect(container.querySelector('[aria-label="Has description"]')).not.toBeInTheDocument()
    })

    it('hides attachment count', () => {
      render(<CardItem card={makeCard()} density="comfortable" />)
      expect(screen.queryByText(/^📎/)).not.toBeInTheDocument()
    })

    it('hides weight pill', () => {
      render(<CardItem card={makeCard({ weight: 5 })} density="comfortable" />)
      expect(screen.queryByTitle('Weight: 5')).not.toBeInTheDocument()
    })

    it('hides last-moved text label and recently-moved dot — urgency badge takes over', () => {
      const { container } = render(
        <CardItem card={makeCard({ last_moved_at: TWELVE_HOURS_AGO })} density="comfortable" />,
      )
      expect(container.querySelector('[title="Recently moved"]')).not.toBeInTheDocument()
    })

    it('hides the explicit priority badge — colored card border carries the signal', () => {
      render(<CardItem card={makeCard({ priority: 'high' })} density="comfortable" />)
      expect(screen.queryByTitle('Priority: high')).not.toBeInTheDocument()
    })

    it('renders the urgency badge "Overdue" when card is past its due date', () => {
      render(<CardItem card={makeCard({ due_date: FIVE_DAYS_AGO })} density="comfortable" />)
      expect(screen.getByText(/Overdue/)).toBeInTheDocument()
    })

    it('renders the urgency badge "Due soon" within 72h of due_date', () => {
      render(<CardItem card={makeCard({ due_date: TWO_DAYS_FROM_NOW })} density="comfortable" />)
      expect(screen.getByText(/Due soon/)).toBeInTheDocument()
    })

    it('renders the urgency badge "Stale" when is_stale=true and no due-date pressure', () => {
      render(<CardItem card={makeCard({ is_stale: true })} density="comfortable" />)
      expect(screen.getByText('Stale')).toBeInTheDocument()
    })

    it('keeps the assignee avatar and checklist on the face', () => {
      render(<CardItem card={makeCard()} density="comfortable" />)
      expect(screen.getByTestId('avatar')).toBeInTheDocument()
      expect(screen.getByText('✓2/5')).toBeInTheDocument()
    })
  })

  // ---- compact: middle ground ----

  describe('density="compact"', () => {
    it('renders up to two labels + overflow pill', () => {
      render(<CardItem card={makeCard()} density="compact" />)
      expect(screen.getByText('backend')).toBeInTheDocument()
      expect(screen.getByText('security')).toBeInTheDocument()
      expect(screen.queryByText('q2-goal')).not.toBeInTheDocument()
      expect(screen.getByText('+1')).toBeInTheDocument()
    })

    it('shows attachment count and weight pill on the face', () => {
      render(<CardItem card={makeCard()} density="compact" />)
      expect(screen.getByText(/📎3/)).toBeInTheDocument()
      expect(screen.getByTitle('Weight: 5')).toBeInTheDocument()
    })

    it('still suppresses the priority badge — colored border owns priority', () => {
      render(<CardItem card={makeCard({ priority: 'high' })} density="compact" />)
      expect(screen.queryByTitle('Priority: high')).not.toBeInTheDocument()
    })

    it('still hides the recently-moved dot when urgency=recent fires', () => {
      const { container } = render(
        <CardItem card={makeCard({ last_moved_at: TWELVE_HOURS_AGO })} density="compact" />,
      )
      expect(container.querySelector('[title="Recently moved"]')).not.toBeInTheDocument()
    })
  })

  // ---- dense: today's full layout — no urgency badge added ----

  describe('density="dense"', () => {
    it('does NOT render the urgency badge — preserves the pre-1.1 visual', () => {
      render(<CardItem card={makeCard({ due_date: FIVE_DAYS_AGO })} density="dense" />)
      // The dense layout still uses the standalone overdue-styled due date pill,
      // not the new badge — no "Overdue" text label.
      expect(screen.queryByText(/^Overdue$|^⚑ Overdue/)).not.toBeInTheDocument()
    })

    it('renders all three labels + overflow', () => {
      const card = makeCard({
        labels: [
          ...makeCard().labels,
          { id: 103, uid: 'lbluid004', name: 'extra', color: '#3B82F6' },
        ],
      })
      render(<CardItem card={card} density="dense" />)
      expect(screen.getByText('backend')).toBeInTheDocument()
      expect(screen.getByText('security')).toBeInTheDocument()
      expect(screen.getByText('q2-goal')).toBeInTheDocument()
      expect(screen.getByText('+1')).toBeInTheDocument()
    })

    it('shows priority badge for medium/high', () => {
      render(<CardItem card={makeCard({ priority: 'high' })} density="dense" />)
      expect(screen.getByTitle('Priority: high')).toBeInTheDocument()
    })

    it('shows the recently-moved dot at <24h', () => {
      const { container } = render(
        <CardItem card={makeCard({ last_moved_at: TWELVE_HOURS_AGO })} density="dense" />,
      )
      expect(container.querySelector('[title="Recently moved"]')).toBeInTheDocument()
    })
  })

  // ---- default + drag-overlay graceful fallback ----

  describe('default and overlay fallbacks', () => {
    it('defaults to comfortable when density prop is omitted (drag overlay etc.)', () => {
      render(<CardItem card={makeCard()} />)
      // Comfortable shows just the first label + overflow pill.
      expect(screen.getByText('backend')).toBeInTheDocument()
      expect(screen.queryByText('security')).not.toBeInTheDocument()
      expect(screen.getByText('+2')).toBeInTheDocument()
    })
  })
})
