import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import CardItem from '../components/Card/CardItem'
import { publishActivePreset } from '../boardPresets/activePresetStore'
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
    // Relative to now: a never-moved card ages from created_at (#1841), so an old
    // hardcoded date would tint the card and change badge tones and tooltips.
    created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), updated_at: '2026-01-01T00:00:00Z',
    last_moved_at: null, attachment_count: 3, checklist_total: 5, checklist_done: 2,
    is_stale: false, archived_at: null, version: 1,
    custom_field_values: [],
    blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    ...overrides,
  }
}

// #871 gate: the redesigned urgency face renders only under a non-Classic preset, which
// the app tells CardItem through the store `useBoardPreset` publishes. These tests cover
// the redesigned face, so they publish the Default preset exactly as BoardView would;
// the Classic / no-preset face is covered in its own describe below.
function publishPreset(activePresetId: 'classic' | 'default' | null, boardId = 7) {
  act(() => publishActivePreset({ boardId, activePresetId, modified: false }))
}

describe('CardItem — calm face (#2272)', () => {
  beforeEach(() => publishPreset('default'))
  afterEach(() => act(() => publishActivePreset(null)))
  const root = (c: HTMLElement) => c.querySelector('[data-card-id]') as HTMLElement

  it('splits "Company -- description" into a bold title and a subtitle at Comfortable', () => {
    const { container } = render(<CardItem card={makeCard({ title: 'Sakura Electronics -- 100-Seat Engineering Board' })} density="comfortable" />)
    expect(screen.getByText('Sakura Electronics').closest('p')).toHaveClass('font-semibold')
    expect(screen.getByTestId('card-subtitle')).toHaveTextContent('100-Seat Engineering Board')
    expect(container.querySelector('p.font-semibold')?.textContent).not.toContain('100-Seat')
  })

  it('keeps a title without the separator all bold and shows no subtitle', () => {
    render(<CardItem card={makeCard({ title: 'Plain title' })} density="comfortable" />)
    expect(screen.getByText('Plain title').closest('p')).toHaveClass('font-semibold')
    expect(screen.queryByTestId('card-subtitle')).toBeNull()
  })

  it('drops the subtitle at Standard and Dense, keeping the full title as a tooltip', () => {
    for (const density of ['standard', 'dense'] as const) {
      const { unmount } = render(<CardItem card={makeCard({ title: 'Acme -- Big Deal' })} density={density} />)
      expect(screen.queryByTestId('card-subtitle')).toBeNull()
      expect(screen.getByText('Acme').closest('p')).toHaveAttribute('title', 'Acme -- Big Deal')
      expect(screen.getByText('Acme').closest('p')).toHaveClass('line-clamp-1')
      unmount()
    }
  })

  it('treats a leading or trailing separator as part of the title', () => {
    render(<CardItem card={makeCard({ title: 'Trailing -- ' })} density="comfortable" />)
    expect(screen.queryByTestId('card-subtitle')).toBeNull()
  })

  it('gives only an overdue card a colored border', () => {
    const overdue = render(<CardItem card={makeCard({ due_date: FIVE_DAYS_AGO })} density="comfortable" />)
    expect(root(overdue.container).style.borderColor).toContain('--danger-emphasis')
    overdue.unmount()
    const cases: Partial<Card>[] = [
      { is_stale: true }, { due_date: TWO_DAYS_FROM_NOW }, { priority: 'high' }, { is_blocked: true, blocked_at: '2026-01-01T00:00:00Z', blocked_reason: 'x' }, {},
    ]
    for (const o of cases) {
      const { container, unmount } = render(<CardItem card={makeCard(o)} density="comfortable" />)
      expect(root(container).style.borderColor).toBe('')
      expect(root(container).className).toContain('border-line')
      unmount()
    }
  })

  it('says priority in the accessible name because the border no longer does', () => {
    const { container } = render(<CardItem card={makeCard({ priority: 'high' })} density="comfortable" />)
    expect(container.querySelector('[data-testid="card-priority-sr"]')?.textContent).toBe(', Priority: high')
  })

  it('renders a stale status line with a clock icon and words, in warning text', () => {
    const { container } = render(
      <CardItem card={makeCard({ is_stale: true, last_moved_at: new Date(Date.now() - 39 * 86_400_000).toISOString() })} density="comfortable" />,
    )
    const line = container.querySelector('[data-testid="card-status-line"]') as HTMLElement
    expect(line.textContent).toBe('Stale 39d')
    expect(line.querySelector('svg[data-testid="urgency-glyph-stale"]')).not.toBeNull()
    expect(line.className).toMatch(/text-warning|text-danger/)
    expect(line.className).not.toContain('border')
  })

  it('omits the status line when the card is on track, and for a done-column stale card', () => {
    const calm = render(<CardItem card={makeCard()} density="comfortable" />)
    expect(calm.container.querySelector('[data-testid="card-status-line"]')).toBeNull()
    calm.unmount()
    const done = render(<CardItem card={makeCard({ is_stale: true })} density="comfortable" inDoneColumn />)
    expect(done.container.querySelector('[data-testid="card-status-line"]')).toBeNull()
  })

  it('puts the status inline in the metadata row at Standard, and on its own row at Comfortable', () => {
    const std = render(<CardItem card={makeCard({ due_date: FIVE_DAYS_AGO })} density="standard" />)
    expect(std.container.querySelector('[data-testid="card-metadata-row"] [data-testid="card-status-line"]')).not.toBeNull()
    expect(std.container.querySelector('[data-testid="card-status-row"]')).toBeNull()
    std.unmount()
    const comfy = render(<CardItem card={makeCard({ due_date: FIVE_DAYS_AGO })} density="comfortable" />)
    expect(comfy.container.querySelector('[data-testid="card-metadata-row"] [data-testid="card-status-line"]')).toBeNull()
    expect(comfy.container.querySelector('[data-testid="card-status-row"] [data-testid="card-status-line"]')).not.toBeNull()
  })

  it('still shows the calm "Just moved" cue as a badge', () => {
    render(<CardItem card={makeCard({ last_moved_at: TWELVE_HOURS_AGO })} density="comfortable" />)
    expect(screen.getByText('Just moved')).toBeInTheDocument()
  })

  it('has no status line in the compact layout', () => {
    const { container } = render(<CardItem card={makeCard({ due_date: FIVE_DAYS_AGO })} density="comfortable" compact />)
    expect(container.querySelector('[data-testid="card-status-line"]')).toBeNull()
  })

  it('keeps the Classic border and title untouched', () => {
    publishPreset('classic')
    const { container } = render(<CardItem card={makeCard({ title: 'A -- B', priority: 'high' })} density="comfortable" />)
    expect(root(container).style.borderColor).not.toBe('')
    expect(screen.getByText('A -- B')).toBeInTheDocument()
    expect(screen.queryByTestId('card-subtitle')).toBeNull()
  })

  it('keeps an overdue compact card from resting on border color alone', () => {
    const { container } = render(<CardItem card={makeCard({ due_date: FIVE_DAYS_AGO })} density="comfortable" compact />)
    expect(container.querySelector('svg[data-testid="urgency-glyph-overdue"]')).not.toBeNull()
    expect(container.querySelector('p .sr-only')?.textContent).toBe('Overdue, ')
  })

  it('gives a one-line Standard title a tooltip with the full text', () => {
    render(<CardItem card={makeCard({ title: 'A fairly long plain title' })} density="standard" />)
    expect(screen.getByText('A fairly long plain title').closest('p')).toHaveAttribute('title', 'A fairly long plain title')
  })
})
