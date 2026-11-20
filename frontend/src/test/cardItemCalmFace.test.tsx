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

// The card face does not depend on the preset: `classic` resolves to the redesigned board
// and there is no Classic-only face (#2279). These tests still publish the Default preset
// exactly as BoardView would, so the store path the app uses stays exercised.
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
    // #2434: the subtitle is one line; the full text stays in the peek.
    expect(screen.getByTestId('card-subtitle')).toHaveClass('line-clamp-1')
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

describe('CardItem — omitted metadata stays in the accessible name (#2279)', () => {
  it('Dense says labels, checklist, attachments, weight, due date and the reference in words, and nothing visible', () => {
    const { container } = render(
      <CardItem
        card={makeCard({
          due_date: '2099-01-15',
          external_ref: { provider: 'github', ref: 'acme/api#42', url: 'https://github.com/acme/api/pull/42' } as Card['external_ref'],
        })}
        density="dense"
      />,
    )
    const sr = container.querySelector('[data-testid="card-dense-sr"]') as HTMLElement
    expect(sr).toHaveClass('sr-only')
    expect(sr.textContent).toContain('Labels: backend, security, q2-goal')
    expect(sr.textContent).toContain('Checklist 2 of 5')
    expect(sr.textContent).toContain('3 attachments')
    expect(sr.textContent).toContain('Weight 5')
    expect(sr.textContent).toContain('Due ')
    expect(sr.textContent).toContain('acme/api#42')
    // The visible face stays one row with none of these drawn.
    expect(container.querySelectorAll('[data-testid="card-dense-row"]')).toHaveLength(1)
    expect(screen.queryByText('backend')).toBeNull()
    expect(screen.queryByText(/✓/)).toBeNull()
  })

  it('Dense keeps the due date in words on a stale card: only an overdue or due-soon status carries it', () => {
    const stale = render(
      <CardItem
        card={makeCard({ is_stale: true, due_date: '2099-01-15', last_moved_at: new Date(Date.now() - 39 * 86_400_000).toISOString() })}
        density="dense"
      />,
    )
    expect(stale.container.querySelector('[data-testid="card-status-line"]')?.getAttribute('data-status-kind')).toBe('stale')
    expect(stale.container.querySelector('[data-testid="card-dense-sr"]')?.textContent).toContain('Due ')
    stale.unmount()
    // The Dense status text is only "Overdue" (no date), so the date is spoken for an overdue card too.
    const overdue = render(<CardItem card={makeCard({ due_date: FIVE_DAYS_AGO })} density="dense" />)
    expect(overdue.container.querySelector('[data-testid="card-status-line"]')?.getAttribute('data-status-kind')).toBe('overdue')
    expect(overdue.container.querySelector('[data-testid="card-dense-sr"]')?.textContent ?? '').toContain('Due ')
  })

  it('Dense speaks the due date once, not "Due Due"', () => {
    const { container } = render(<CardItem card={makeCard({ due_date: '2099-01-15' })} density="dense" />)
    const sr = container.querySelector('[data-testid="card-dense-sr"]')?.textContent ?? ''
    expect(sr).toContain('Due 01/15/2099')
    expect(sr).not.toContain('Due Due')
  })

  it('Comfortable speaks an on-track due date the face does not draw (#2399)', () => {
    const { container } = render(<CardItem card={makeCard({ due_date: '2099-01-15' })} density="comfortable" />)
    const sr = container.querySelector('[data-testid="card-due-sr"]') as HTMLElement
    expect(sr).toHaveClass('sr-only')
    expect(sr.textContent).toBe(', Due 01/15/2099')
    // The face stays calm: no visible date and no status line.
    expect(container.querySelector('[data-testid="card-status-line"]')).toBeNull()
    expect(screen.queryByText('Due 01/15/2099')).toBeNull()
    // It precedes the priority suffix, which stays the last sr-only text.
    const priority = container.querySelector('[data-testid="card-priority-sr"]') as HTMLElement
    expect(sr.compareDocumentPosition(priority) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('Comfortable adds no due sr text when the status line carries the date, or there is no date', () => {
    for (const o of [{ due_date: FIVE_DAYS_AGO }, { due_date: TWO_DAYS_FROM_NOW }, { due_date: null }] as Partial<Card>[]) {
      const { container, unmount } = render(<CardItem card={makeCard(o)} density="comfortable" />)
      expect(container.querySelector('[data-testid="card-due-sr"]')).toBeNull()
      unmount()
    }
    // Standard draws the on-track date visibly, and Dense speaks it in card-dense-sr.
    for (const density of ['standard', 'dense'] as const) {
      const { container, unmount } = render(<CardItem card={makeCard({ due_date: '2099-01-15' })} density={density} />)
      expect(container.querySelector('[data-testid="card-due-sr"]')).toBeNull()
      unmount()
    }
  })

  it('Standard draws an on-track due date as a plain tertiary pill with no urgency glyph (#2393)', () => {
    render(<CardItem card={makeCard({ due_date: '2099-01-15' })} density="standard" />)
    const pill = screen.getByText('Due 01/15/2099')
    expect(pill).toHaveClass('text-fg-tertiary')
    expect(pill.querySelector('svg')).toBeNull()
  })

  it('Dense on a bare card adds no sr-only metadata text', () => {
    const { container } = render(
      <CardItem card={makeCard({ labels: [], weight: 1, attachment_count: 0, checklist_total: 0, checklist_done: 0 })} density="dense" />,
    )
    expect(container.querySelector('[data-testid="card-dense-sr"]')).toBeNull()
  })

  it('Standard gives the checklist and attachment emoji chips words, and hides the emoji from assistive tech', () => {
    const { container } = render(<CardItem card={makeCard()} density="standard" />)
    const checklist = container.querySelector('[title="2/5 checklist items"]') as HTMLElement
    expect(checklist.querySelector('[aria-hidden="true"]')?.textContent).toBe('✓2/5')
    expect(checklist.querySelector('.sr-only')?.textContent).toBe('Checklist 2 of 5')
    const attachments = container.querySelector('[title="3 attachment(s)"]') as HTMLElement
    expect(attachments.querySelector('[aria-hidden="true"]')?.textContent).toBe('📎3')
    expect(attachments.querySelector('.sr-only')?.textContent).toBe('3 attachments')
  })

  it('the priority suffix is the last sr-only text in the card, after the dense metadata words', () => {
    const { container } = render(<CardItem card={makeCard({ priority: 'high' })} density="dense" />)
    const dense = container.querySelector('[data-testid="card-dense-sr"]') as HTMLElement
    const priority = container.querySelector('[data-testid="card-priority-sr"]') as HTMLElement
    expect(dense.compareDocumentPosition(priority) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
