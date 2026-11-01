import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import CardItem from '../components/Card/CardItem'
import AgingCue from '../components/Card/AgingCue'
import type { Card, CardDensity } from '../types'

// #1843 — non-color age cue (AgingCue stage glyph) wherever the `Stale · Nd`
// badge is not on the card face, so a stale tint is never color-only.
// #1863 — the yellow warning stage gets the same meter with a hollow
// shortest bar, so it is not color-only either.

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
}))

vi.mock('../components/Common/Avatar', () => ({
  default: ({ user }: { user: { display_name: string } }) => <span data-testid="avatar">{user.display_name}</span>,
}))

const DAY = 86_400_000
const daysAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString()

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Aging cue card',
    description: '', priority: 'low', assignee: null, labels: [],
    due_date: null, weight: 1, position: 0,
    created_by: { id: 1, username: 'u', display_name: 'U', avatar_url: '' },
    // Relative to now: a never-moved card ages from created_at (#1841).
    created_at: daysAgo(1), updated_at: daysAgo(1),
    last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
    is_stale: false, custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    archived_at: null, version: 1,
    ...overrides,
  }
}

interface RenderOpts { density?: CardDensity; compact?: boolean; inDoneColumn?: boolean; threshold?: number }

/** Renders a card idle `idle` days against a 14-day threshold (unless overridden). */
function renderAged(idle: number, cardOverrides: Partial<Card> = {}, opts: RenderOpts = {}) {
  const { density = 'dense', compact = true, inDoneColumn = false, threshold = 14 } = opts
  return render(
    <CardItem
      card={makeCard({ last_moved_at: daysAgo(idle), is_stale: idle >= threshold, ...cardOverrides })}
      density={density}
      compact={compact}
      inDoneColumn={inDoneColumn}
      staleness_threshold_days={threshold}
      stale_warning_pct={50}
    />,
  )
}

const cue = (container: HTMLElement) => container.querySelector('svg[data-aging-cue]')
const solidBars = (svg: Element) => svg.querySelectorAll('rect[fill="currentColor"]:not([opacity])').length
const hollowBars = (svg: Element) => svg.querySelectorAll('rect[fill="none"][stroke="currentColor"]')

describe('AgingCue on cards without a visible Stale badge (#1843)', () => {
  it.each([
    [15.5, 'stale', 1, 'text-warning-on-tint', 'Idle 15 days, past the stale threshold'],
    [30.5, 'stale2x', 2, 'text-danger-on-tint', 'Idle 30 days, at least 2 times the stale threshold'],
    [45.5, 'stale3x', 3, 'text-danger-on-tint', 'Idle 45 days, at least 3 times the stale threshold'],
  ])('compact dense card idle %sd shows the %s meter', (idle, stage, bars, tone, label) => {
    const { container } = renderAged(idle)
    const svg = screen.getByRole('img', { name: label })
    expect(svg).toHaveAttribute('data-aging-cue', stage)
    expect(solidBars(svg)).toBe(bars)
    expect(svg.querySelectorAll('rect')).toHaveLength(3)
    expect(svg.getAttribute('class')).toContain(tone)
    // First child of the title paragraph: shares the title's line box.
    const title = screen.getByText('Aging cue card')
    expect(title.tagName).toBe('P')
    expect(title.firstElementChild).toBe(svg)
    expect(cue(container)).toBe(svg)
  })

  it.each<CardDensity>(['comfortable', 'standard'])('compact %s stale card shows the cue (no badge in compact)', (density) => {
    renderAged(30.5, {}, { density })
    expect(screen.getByRole('img', { name: /^Idle 30 days, at least 2 times/ })).toBeInTheDocument()
    expect(screen.queryByText(/^Stale · /)).not.toBeInTheDocument()
  })

  it('non-compact dense stale card shows the cue (dense has no badge)', () => {
    renderAged(45.5, {}, { compact: false })
    expect(screen.getByRole('img', { name: /at least 3 times/ })).toBeInTheDocument()
  })

  it('non-compact comfortable card with the Stale badge visible has no cue', () => {
    const { container } = renderAged(30.5, {}, { density: 'comfortable', compact: false })
    expect(screen.getByText('Stale · 30d')).toBeInTheDocument()
    expect(cue(container)).toBeNull()
  })

  it('non-compact comfortable card whose Stale badge is preempted by overdue shows the cue', () => {
    renderAged(30.5, { due_date: daysAgo(3).slice(0, 10) }, { density: 'comfortable', compact: false })
    expect(screen.queryByText(/^Stale · /)).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: /at least 2 times/ })).toBeInTheDocument()
  })

  it('client-stale card the server does not yet call stale shows the cue (no badge)', () => {
    renderAged(15.5, { is_stale: false }, { density: 'comfortable', compact: false })
    expect(screen.queryByText(/^Stale · /)).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Idle 15 days, past the stale threshold' })).toBeInTheDocument()
  })

  it('fresh card (below the warning point) has no cue', () => {
    const { container } = renderAged(3)
    expect(cue(container)).toBeNull()
  })

  it('a card in a done column never shows the cue, however old', () => {
    const { container } = renderAged(60, { is_stale: true }, { inDoneColumn: true })
    expect(cue(container)).toBeNull()
  })

  it('uses the singular for one idle day', () => {
    renderAged(1.5, {}, { threshold: 1 })
    expect(screen.getByRole('img', { name: 'Idle 1 day, past the stale threshold' })).toBeInTheDocument()
  })

  it('has no title attribute (the card aging tooltip covers hover)', () => {
    const { container } = renderAged(30.5)
    expect(cue(container)).not.toHaveAttribute('title')
  })

  it('a title-only compact stale card renders no empty metadata row (no height change)', () => {
    // Before #1843 hasMetadataRow counted the urgency badge even in compact,
    // where it never renders, adding an empty mt-1.5 row to a stale card.
    const { container } = renderAged(30.5, {}, { density: 'comfortable' })
    expect(container.querySelector('.mt-1\\.5')).toBeNull()
  })

  // hasMetadataRow must not count anything the compact branch never renders
  // (frontend/CLAUDE.md § Card aging ramp): each of these used to add an
  // empty mt-1.5 row to a compact card.
  it.each<[string, number, Partial<Card>, CardDensity]>([
    ['moved-ago text on a dense stale card', 30.5, {}, 'dense'],
    ['a label', 2, { labels: [{ id: 100, uid: 'lbluid001', name: 'backend', color: '#10B981' }] }, 'comfortable'],
    ['checklist progress', 2, { checklist_total: 3, checklist_done: 1 }, 'comfortable'],
    ['a description', 2, { description: 'Has one' }, 'dense'],
    ['attachments and weight', 2, { attachment_count: 2, weight: 5 }, 'dense'],
  ])('a compact card with %s renders no empty metadata row', (_name, idle, overrides, density) => {
    const { container } = renderAged(idle, overrides, { density })
    expect(container.querySelector('.mt-1\\.5')).toBeNull()
  })

  it('a compact card keeps its metadata row for what compact does render (blocked glyph)', () => {
    const { container } = renderAged(2, { blocker_count: 1 })
    expect(container.querySelector('.mt-1\\.5')).not.toBeNull()
    expect(screen.getByRole('img', { name: 'Blocked by 1 card' })).toBeInTheDocument()
  })
})

describe('AgingCue on warning-stage cards (#1863)', () => {
  it.each<[string, RenderOpts]>([
    ['compact dense', { compact: true, density: 'dense' }],
    ['compact comfortable', { compact: true, density: 'comfortable' }],
    ['non-compact dense', { compact: false, density: 'dense' }],
    ['non-compact comfortable', { compact: false, density: 'comfortable' }],
    ['non-compact standard', { compact: false, density: 'standard' }],
  ])('%s warning card shows the hollow-bar cue in the title', (_name, opts) => {
    const { container } = renderAged(9, {}, opts)
    const svg = screen.getByRole('img', { name: 'Idle 9 days, approaching the stale threshold' })
    expect(svg).toHaveAttribute('data-aging-cue', 'warning')
    expect(svg.getAttribute('class')).toContain('text-warning-on-tint')
    expect(screen.getByText('Aging cue card').firstElementChild).toBe(svg)
    expect(cue(container)).toBe(svg)
    // The warning stage never shows the Stale badge.
    expect(screen.queryByText(/^Stale/)).not.toBeInTheDocument()
  })

  it('a warning card in a done column has no cue', () => {
    const { container } = renderAged(9, {}, { inDoneColumn: true })
    expect(cue(container)).toBeNull()
  })

  it('no cue when the warning stage is turned off (stale_warning_pct 0)', () => {
    const { container } = render(
      <CardItem card={makeCard({ last_moved_at: daysAgo(9) })} compact density="dense" staleness_threshold_days={14} stale_warning_pct={0} />,
    )
    expect(cue(container)).toBeNull()
  })
})

describe('AgingCue component', () => {
  it('renders nothing for stage none', () => {
    const { container } = render(<AgingCue stage="none" idleDays={9} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('warning: hollow shortest bar at full opacity, no solid bars, two ghosts', () => {
    render(<AgingCue stage="warning" idleDays={9} />)
    const svg = screen.getByRole('img', { name: 'Idle 9 days, approaching the stale threshold' })
    expect(svg.querySelectorAll('rect')).toHaveLength(3)
    expect(solidBars(svg)).toBe(0)
    const hollow = hollowBars(svg)
    expect(hollow).toHaveLength(1)
    // The only stage-bearing mark must not be ghosted (WCAG 1.4.11 needs 3:1).
    expect(hollow[0]).not.toHaveAttribute('opacity')
    expect(hollow[0]).toHaveAttribute('stroke-width', '1')
    // Inset by half the stroke: the outline's outer edge is the filled bar's x 0–3, y 7–12.
    expect(hollow[0]).toHaveAttribute('x', '0.5')
    expect(hollow[0]).toHaveAttribute('y', '7.5')
    expect(hollow[0]).toHaveAttribute('width', '2')
    expect(hollow[0]).toHaveAttribute('height', '4')
    expect(svg.querySelectorAll('rect[fill="currentColor"][opacity="0.3"]')).toHaveLength(2)
  })

  it('warning uses the singular for one idle day', () => {
    render(<AgingCue stage="warning" idleDays={1} />)
    expect(screen.getByRole('img', { name: 'Idle 1 day, approaching the stale threshold' })).toBeInTheDocument()
  })

  it.each(['stale', 'stale2x', 'stale3x'] as const)('%s draws no hollow bar', (stage) => {
    render(<AgingCue stage={stage} idleDays={20} />)
    expect(hollowBars(screen.getByRole('img'))).toHaveLength(0)
  })
})
