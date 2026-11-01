import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import CardItem from '../components/Card/CardItem'
import type { Card } from '../types'

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
}))

vi.mock('../components/Common/Avatar', () => ({
  default: ({ user }: { user: { display_name: string } }) => <span data-testid="avatar">{user.display_name}</span>,
}))

const NOW = new Date('2026-10-04T05:00:00Z')

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Blocked card',
    description: '', priority: 'low', assignee: null, labels: [],
    due_date: null, weight: 1, position: 0,
    created_by: { id: 1, username: 'alice', display_name: 'Alice', avatar_url: '' },
    created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:00Z',
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
    is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0,
    external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    ...overrides,
  }
}

const manual = { is_blocked: true, blocked_at: '2026-10-01T00:00:00Z', blocked_reason: 'Waiting on customer' }

describe('CardItem — blocked indicator (#1149)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the glyph with elapsed time and names the reason', () => {
    render(<CardItem card={makeCard(manual)} density="standard" />)
    const indicator = screen.getByRole('img', { name: 'Blocked 3d 5h: Waiting on customer' })
    expect(indicator).toHaveTextContent('3d')
    expect(indicator).toHaveAttribute('title', 'Blocked 3d 5h: Waiting on customer')
    expect(indicator).toHaveClass('text-danger')
  })

  it.each(['comfortable', 'standard', 'dense'] as const)('renders at %s density', (density) => {
    render(<CardItem card={makeCard(manual)} density={density} />)
    expect(screen.getByTestId('card-blocked-indicator')).toHaveTextContent('3d')
  })

  it('renders in the compact layout too', () => {
    render(<CardItem card={makeCard(manual)} density="standard" compact />)
    expect(screen.getByTestId('card-blocked-indicator')).toHaveTextContent('3d')
  })

  it('keeps the relation-only form unchanged: icon, numeral from 2, no duration', () => {
    const { rerender } = render(<CardItem card={makeCard({ blocker_count: 1, is_blocked: true })} density="standard" />)
    const one = screen.getByRole('img', { name: 'Blocked by 1 card' })
    expect(one.textContent).toBe('')
    rerender(<CardItem card={makeCard({ blocker_count: 2, is_blocked: true })} density="standard" />)
    expect(screen.getByRole('img', { name: 'Blocked by 2 cards' })).toHaveTextContent('2')
  })

  it('shows the duration and keeps the relation count in the name when both apply', () => {
    render(<CardItem card={makeCard({ ...manual, blocker_count: 2 })} density="standard" />)
    const indicator = screen.getByRole('img', { name: 'Blocked 3d 5h: Waiting on customer. Also blocked by 2 cards' })
    expect(indicator).toHaveTextContent('3d')
    expect(indicator).not.toHaveTextContent('2')
  })

  it('renders nothing for an unblocked card', () => {
    render(<CardItem card={makeCard()} density="standard" />)
    expect(screen.queryByTestId('card-blocked-indicator')).not.toBeInTheDocument()
  })

  it('takes the danger border only for a manual block', () => {
    const { container, rerender } = render(<CardItem card={makeCard(manual)} density="standard" />)
    const bordered = () => container.querySelector<HTMLElement>('[style*="border-color"]')
    expect(bordered()?.style.borderColor).toBe('rgb(var(--danger-emphasis))')
    rerender(<CardItem card={makeCard({ blocker_count: 1, is_blocked: true })} density="standard" />)
    // Relation-only keeps the priority border (#449 unchanged): low = blue-500.
    expect(bordered()?.style.borderColor).toBe('rgb(59, 130, 246)')
  })

  it('re-renders when only the block state changes', () => {
    const { rerender } = render(<CardItem card={makeCard()} density="standard" />)
    rerender(<CardItem card={makeCard(manual)} density="standard" />)
    expect(screen.getByTestId('card-blocked-indicator')).toBeInTheDocument()
    rerender(<CardItem card={makeCard({ ...manual, blocked_reason: 'Vendor' })} density="standard" />)
    expect(screen.getByRole('img', { name: 'Blocked 3d 5h: Vendor' })).toBeInTheDocument()
  })
})
