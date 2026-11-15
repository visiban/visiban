import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import CardItem from '../components/Card/CardItem'
import type { Card } from '../types'

// Enter or Space on the focused card opens it (#2273): the card is a div role=button, so the browser never turns the key into a click.

const dnd = vi.hoisted(() => ({ isDragging: false }))
vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({ attributes: { role: 'button', tabIndex: 0 }, listeners: {}, setNodeRef: () => {}, isDragging: dnd.isDragging }),
}))

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 7, uid: 'carduid00007', column: 10, swimlane: 20, title: 'Fix payout rounding',
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

const face = (container: HTMLElement) => container.querySelector('[data-card-id="7"]') as HTMLElement

describe('CardItem keyboard open (#2273)', () => {
  it.each(['Enter', ' '])('%j on the focused card calls onClick', (key) => {
    const onClick = vi.fn()
    const { container } = render(<CardItem card={makeCard()} onClick={onClick} />)
    const notCanceled = fireEvent.keyDown(face(container), { key })
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(notCanceled).toBe(false)
  })

  it('ignores other keys, a key from a child control, and a read-only card', () => {
    const onClick = vi.fn()
    const { container, rerender } = render(<CardItem card={makeCard()} onClick={onClick} onSelect={() => {}} />)
    fireEvent.keyDown(face(container), { key: 'a' })
    const inner = face(container).querySelector('button, input') as HTMLElement | null
    if (inner) fireEvent.keyDown(inner, { key: 'Enter' })
    expect(onClick).not.toHaveBeenCalled()
    rerender(<CardItem card={makeCard()} onClick={onClick} readOnly />)
    fireEvent.keyDown(face(container), { key: 'Enter' })
    expect(onClick).not.toHaveBeenCalled()
  })
})
