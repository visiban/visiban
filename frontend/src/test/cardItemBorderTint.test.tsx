import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import CardItem from '../components/Card/CardItem'
import type { Card } from '../types'

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({ attributes: { role: 'button' }, listeners: {}, setNodeRef: () => {}, isDragging: false }),
}))

vi.mock('../components/Common/Avatar', () => ({
  default: ({ user }: { user: { display_name: string } }) => <span>{user.display_name}</span>,
}))

const NOW = new Date('2026-10-04T12:00:00Z')

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Tint card',
    description: '', priority: 'high', assignee: null, labels: [],
    due_date: null, weight: 1, position: 0,
    created_by: { id: 1, username: 'alice', display_name: 'Alice', avatar_url: '' },
    created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:00Z',
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
    is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0,
    external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    ...overrides,
  }
}

const OVERDUE = '2026-10-01T00:00:00Z'
const SOON = '2026-10-05T12:00:00Z'
const manual = { is_blocked: true, blocked_at: '2026-10-01T00:00:00Z', blocked_reason: 'Waiting' }

function face() {
  return screen.getByRole('button', { name: /Tint card/ })
}

describe('CardItem — urgency border tint (#977)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('overdue at comfortable: danger border, priority in the accessible name', () => {
    render(<CardItem card={makeCard({ due_date: OVERDUE, priority: 'medium' })} density="comfortable" />)
    expect(face().style.borderColor).toBe('rgb(var(--danger-emphasis))')
    expect(screen.getByTestId('card-priority-sr')).toHaveTextContent('Priority: medium')
    expect(face()).toHaveAccessibleName(/Tint card\s*, Priority: medium/)
  })

  it('due soon at comfortable: warning border', () => {
    render(<CardItem card={makeCard({ due_date: SOON })} density="comfortable" />)
    expect(face().style.borderColor).toBe('rgb(var(--warning-emphasis))')
    expect(screen.getByTestId('card-priority-sr')).toHaveTextContent('Priority: high')
  })

  it('low priority adds no accessible-name suffix', () => {
    render(<CardItem card={makeCard({ due_date: OVERDUE, priority: 'low' })} density="comfortable" />)
    expect(screen.queryByTestId('card-priority-sr')).toBeNull()
  })

  it('manual block beats overdue', () => {
    render(<CardItem card={makeCard({ due_date: OVERDUE, priority: 'low', ...manual })} density="comfortable" />)
    expect(face().style.borderColor).toBe('rgb(var(--danger-emphasis))')
    expect(screen.queryByTestId('card-priority-sr')).toBeNull()
  })

  it('stale alone keeps the priority border and adds no suffix', () => {
    render(<CardItem card={makeCard({ is_stale: true, priority: 'high' })} density="comfortable" />)
    expect(face().style.borderColor).not.toContain('--')
    expect(screen.queryByTestId('card-priority-sr')).toBeNull()
  })

  it.each(['standard', 'dense'] as const)('%s density is unchanged for an overdue card', (density) => {
    render(<CardItem card={makeCard({ due_date: OVERDUE })} density={density} />)
    expect(face().style.borderColor).not.toContain('--')
    expect(screen.queryByTestId('card-priority-sr')).toBeNull()
  })

  it('compact layout is not tinted', () => {
    render(<CardItem card={makeCard({ due_date: OVERDUE })} density="comfortable" compact />)
    expect(face().style.borderColor).not.toContain('--')
    expect(screen.queryByTestId('card-priority-sr')).toBeNull()
  })

  it('current card keeps its primary ring while the priority suffix is still emitted', () => {
    render(<CardItem card={makeCard({ due_date: OVERDUE, priority: 'medium' })} density="comfortable" current />)
    expect(face()).toHaveAttribute('aria-current', 'true')
    expect(face().className).toContain('border-primary-emphasis')
    expect(face().style.borderColor).toBe('')
    expect(screen.getByTestId('card-priority-sr')).toHaveTextContent('Priority: medium')
  })

  it('overdue card in a done column keeps the danger border (matches the badge)', () => {
    render(<CardItem card={makeCard({ due_date: OVERDUE })} density="comfortable" inDoneColumn />)
    expect(face().style.borderColor).toBe('rgb(var(--danger-emphasis))')
  })

  it('drag overlay copy of an overdue card keeps the danger border', () => {
    render(<CardItem card={makeCard({ due_date: OVERDUE })} density="comfortable" overlay />)
    expect(face().style.borderColor).toBe('rgb(var(--danger-emphasis))')
  })
})
