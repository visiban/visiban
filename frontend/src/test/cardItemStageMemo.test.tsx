import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import CardItem from '../components/Card/CardItem'
import type { Card, CustomFieldDefinition } from '../types'
import type { CardTrackState } from '../utils/stages'

// #2278: the memo comparator must not swallow track or sub-column changes.
vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({ attributes: { role: 'button', tabIndex: 0 }, listeners: {}, setNodeRef: () => {}, isDragging: false }),
}))

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Stage card', description: '',
    assignee: null, labels: [], position: 0, priority: 'none', due_date: null, weight: 1,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', last_moved_at: null,
    custom_field_values: [], version: 1, gates_passed: 0,
    ...overrides,
  } as Card
}

const open: CardTrackState[] = [{ id: 7, name: 'Technical', state: 'open', fromLane: false }]
const done: CardTrackState[] = [{ id: 7, name: 'Technical', state: 'done', fromLane: false }]

describe('CardItem memo and stage props (#2278)', () => {
  it('repaints track chips when trackStates change with the same card', () => {
    const card = makeCard()
    const { rerender } = render(<CardItem card={card} trackStates={open} />)
    expect(screen.getByText('Technical: open')).toBeInTheDocument()
    rerender(<CardItem card={card} trackStates={done} />)
    expect(screen.getByText('Technical: done')).toBeInTheDocument()
    expect(screen.queryByText('Technical: open')).not.toBeInTheDocument()
  })

  it('keeps track states and the where-to-set cue in the card name (#2542)', () => {
    render(<CardItem card={makeCard()} trackStates={done} />)
    // The card is role=button; a child aria-label would replace the chips' text in its computed name.
    expect(screen.getByRole('button', { name: /Technical: done/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /set in the card's Custom fields/ })).toBeInTheDocument()
  })

  it('repaints the progress bar when gateProgress changes', () => {
    const card = makeCard()
    const names = ['Doing', 'Ready']
    const { rerender } = render(<CardItem card={card} gateProgress={{ index: 0, names }} />)
    expect(screen.getByRole('img', { name: 'Sub-column 1 of 2: Doing' })).toBeInTheDocument()
    rerender(<CardItem card={makeCard({ gates_passed: 1, version: 2 })} gateProgress={{ index: 1, names: [...names] }} />)
    expect(screen.getByRole('img', { name: 'Sub-column 2 of 2: Ready' })).toBeInTheDocument()
  })

  it('switches to spelled-out chips when trackStatesSpelledOut flips', () => {
    const card = makeCard()
    const { rerender, container } = render(<CardItem card={card} trackStates={open} />)
    expect(container.querySelector('[data-track-state="open"] [aria-hidden="true"]:last-child')?.textContent).toBe('Technical')
    rerender(<CardItem card={card} trackStates={[...open]} trackStatesSpelledOut />)
    expect(container.querySelector('[data-track-state="open"] [aria-hidden="true"]:last-child')?.textContent).toBe('Technical: open')
  })
})

// #1922: "N need attention" reads dimension_plans; the memo comparator must
// repaint when another client changes a plan, even if updated_at is unchanged.
describe('CardItem memo and dimension plans (#1922)', () => {
  const security = {
    id: 7, uid: 'cfuid0000007', name: 'Security', field_type: 'dropdown', choices: ['Pending', 'Approved'],
    position: 0, is_dimension: true, show_on_card: true, choice_resolutions: { Approved: 'satisfied' },
  } as unknown as CustomFieldDefinition
  const plan = (target_date: string | null, updated_at: string) =>
    ({ field_id: 7, owner: null, next_action: '', target_date, updated_at })
  // One array across rerenders: a new definitions array would itself defeat the memo.
  const defs = [security]

  it('repaints the attention count when a plan changes with the same updated_at', () => {
    const before = makeCard({ dimension_plans: [plan('2099-01-01', '2026-11-01T00:00:00Z')] })
    const { rerender } = render(<CardItem card={before} customFieldDefinitions={defs} />)
    expect(screen.queryByTestId('card-dimension-attention')).not.toBeInTheDocument()
    // Same card updated_at and version: only the plan moved into the past.
    rerender(<CardItem card={makeCard({ dimension_plans: [plan('2000-01-01', '2026-11-02T00:00:00Z')] })} customFieldDefinitions={defs} />)
    expect(screen.getByTestId('card-dimension-attention')).toHaveTextContent('1 needs attention')
  })

  it('repaints when a plan is added', () => {
    const { rerender } = render(<CardItem card={makeCard()} customFieldDefinitions={defs} />)
    expect(screen.queryByTestId('card-dimension-attention')).not.toBeInTheDocument()
    rerender(<CardItem card={makeCard({ dimension_plans: [plan('2000-01-01', '2026-11-02T00:00:00Z')] })} customFieldDefinitions={defs} />)
    expect(screen.getByTestId('card-dimension-attention')).toHaveTextContent('1 needs attention')
  })
})
