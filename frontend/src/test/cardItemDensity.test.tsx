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

describe('CardItem — card_density (#961)', () => {
  beforeEach(() => publishPreset('default'))
  afterEach(() => act(() => publishActivePreset(null)))

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

    it('renders the urgency badge with the formatted relative date for overdue cards', () => {
      // The badge label is the formatted date (e.g. "5d late"), not the
      // generic word "Overdue", so the date isn't lost when the standalone
      // date pill is suppressed at lower densities.
      const { container } = render(<CardItem card={makeCard({ due_date: FIVE_DAYS_AGO })} density="comfortable" />)
      const badge = container.querySelector('.text-danger') as HTMLElement
      // #871: an SVG flag, not the ⚑ text character; the text keeps the date.
      expect(badge.textContent).not.toMatch(/⚑/)
      expect(badge.textContent).toMatch(/^Overdue: Due \S/)
      expect(badge.textContent).not.toBe('Overdue')
      const glyph = badge.querySelector('svg[data-testid="urgency-glyph-overdue"]')
      expect(glyph).not.toBeNull()
      expect(glyph?.getAttribute('aria-hidden')).toBe('true')
      expect(glyph?.getAttribute('fill')).toBe('none')
      expect(glyph?.getAttribute('stroke')).toBe('currentColor')
      expect(glyph?.getAttribute('class')).toContain('w-3 h-3')
      // The screen-reader word is visually hidden, so sighted copy is unchanged.
      expect(badge.querySelector('.sr-only')?.textContent).toBe('Overdue: ')
    })

    it('renders the urgency badge with the formatted date for due-soon cards', () => {
      const { container } = render(<CardItem card={makeCard({ due_date: TWO_DAYS_FROM_NOW })} density="comfortable" />)
      const badge = container.querySelector('.text-warning-on-tint') as HTMLElement
      // #871: plain text-warning is 3.56:1 on a white card, so the untinted badge uses warning-on-tint.
      expect(container.querySelector('.text-warning')).toBeNull()
      expect(badge.textContent).not.toMatch(/⏱/)
      expect(badge.textContent).toMatch(/^Due /)
      // Should not be the generic "Due soon" — must include date label
      expect(badge.textContent).not.toBe('Due soon')
      const glyph = badge.querySelector('svg[data-testid="urgency-glyph-due-soon"]')
      expect(glyph?.getAttribute('aria-hidden')).toBe('true')
      expect(badge.querySelector('.sr-only')).toBeNull()
    })

    it('renders the urgency badge "Stale" with the full warning on-tint tone (not text-fg-secondary)', () => {
      render(<CardItem card={makeCard({ is_stale: true })} density="comfortable" />)
      const badge = screen.getByText(/^Stale/)
      expect(badge).toBeInTheDocument()
      // Stale tone bumped from warning-soft → warning per VoC panel feedback —
      // text-fg-secondary read as too quiet next to a calm card. Since #1841 the
      // badge sits on the aging tint, so it uses the on-tint token (#1550).
      expect(badge.className).toContain('text-warning-on-tint')
      expect(badge.className).not.toContain('text-fg-secondary')
    })

    it('does not render the standalone due-date pill at comfortable when urgency is null', () => {
      // A card due 2 weeks out has no urgency → at Comfortable the date moves
      // entirely off the card face into the peek (matches design intent).
      const FAR_FUTURE = new Date(TODAY.getTime() + 14 * 86_400_000).toISOString().slice(0, 10)
      render(<CardItem card={makeCard({ due_date: FAR_FUTURE })} density="comfortable" />)
      expect(screen.queryByTitle(`Due ${FAR_FUTURE}`)).not.toBeInTheDocument()
    })

    it('keeps the assignee avatar and checklist on the face', () => {
      render(<CardItem card={makeCard()} density="comfortable" />)
      expect(screen.getByTestId('avatar')).toBeInTheDocument()
      expect(screen.getByText('✓2/5')).toBeInTheDocument()
    })
  })

  // ---- compact: middle ground ----

  describe('density="standard" (the middle tier — formerly named "compact")', () => {
    it('renders up to two labels + overflow pill', () => {
      render(<CardItem card={makeCard()} density="standard" />)
      expect(screen.getByText('backend')).toBeInTheDocument()
      expect(screen.getByText('security')).toBeInTheDocument()
      expect(screen.queryByText('q2-goal')).not.toBeInTheDocument()
      expect(screen.getByText('+1')).toBeInTheDocument()
    })

    it('shows attachment count and weight pill on the face', () => {
      render(<CardItem card={makeCard()} density="standard" />)
      expect(screen.getByText(/📎3/)).toBeInTheDocument()
      expect(screen.getByTitle('Weight: 5')).toBeInTheDocument()
    })

    it('still suppresses the priority badge — colored border owns priority', () => {
      render(<CardItem card={makeCard({ priority: 'high' })} density="standard" />)
      expect(screen.queryByTitle('Priority: high')).not.toBeInTheDocument()
    })

    it('still hides the recently-moved dot when urgency=recent fires', () => {
      const { container } = render(
        <CardItem card={makeCard({ last_moved_at: TWELVE_HOURS_AGO })} density="standard" />,
      )
      expect(container.querySelector('[title="Recently moved"]')).not.toBeInTheDocument()
    })

    it('shows standalone due-date pill at standard density when due_date is far out (no urgency)', () => {
      const FAR_FUTURE = new Date(TODAY.getTime() + 14 * 86_400_000).toISOString().slice(0, 10)
      render(<CardItem card={makeCard({ due_date: FAR_FUTURE })} density="standard" />)
      // urgency is null (>72h, not overdue), so the standalone date pill renders
      expect(screen.getByTitle(`Due ${FAR_FUTURE}`)).toBeInTheDocument()
    })
  })

  // ---- dense: today's full layout — no urgency badge added ----

  describe('density="dense"', () => {
    it('does NOT render the urgency badge — preserves the pre-1.1 visual', () => {
      render(<CardItem card={makeCard({ due_date: FIVE_DAYS_AGO })} density="dense" />)
      // The dense layout still uses the standalone overdue-styled due date pill,
      // not the new badge — no "Overdue" text label.
      expect(screen.queryByText(/^Overdue$/)).not.toBeInTheDocument()
    })

    it('puts the SVG flag + word on an overdue due pill, with the on-tint danger tone (#871)', () => {
      render(<CardItem card={makeCard({ due_date: FIVE_DAYS_AGO })} density="dense" />)
      const pill = screen.getByTitle(`Due ${FIVE_DAYS_AGO}`)
      expect(pill.className).toContain('text-danger')
      expect(pill.textContent).toMatch(/^Overdue: Due /)
      expect(pill.textContent).not.toMatch(/⚑/)
      const glyph = pill.querySelector('svg[data-testid="urgency-glyph-overdue"]')
      expect(glyph?.getAttribute('aria-hidden')).toBe('true')
    })

    it('puts the SVG stopwatch + word on a due-soon due pill, in the warning on-tint tone (#871)', () => {
      render(<CardItem card={makeCard({ due_date: TWO_DAYS_FROM_NOW })} density="dense" />)
      const pill = screen.getByTitle(`Due ${TWO_DAYS_FROM_NOW}`)
      expect(pill.className).toContain('text-warning-on-tint')
      expect(pill.className).not.toMatch(/text-warning(?!-on-tint)/)
      expect(pill.textContent).toMatch(/^Due /)
      expect(pill.querySelector('svg[data-testid="urgency-glyph-due-soon"]')?.getAttribute('aria-hidden')).toBe('true')
    })

    describe('due-today pill (user-timezone vs UTC-midnight classifier divergence, #871)', () => {
      afterEach(() => { vi.useRealTimers() })

      it('renders a due-today pill as due soon, not overdue, when the classifier already calls it overdue', () => {
        // 15:00 UTC on 2026-06-15: in the user's (UTC) timezone the date is today,
        // so formatDueDate says not overdue, while the classifier parses the date as
        // UTC midnight, which is already past, so it says overdue.
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-06-15T15:00:00Z'))
        render(
          <CardItem
            card={makeCard({ due_date: '2026-06-15', created_at: '2026-06-14T00:00:00Z' })}
            density="dense"
            userTimezone="UTC"
          />,
        )
        const pill = screen.getByTitle('Due 2026-06-15')
        expect(pill.textContent).toMatch(/^Due today/)
        expect(pill.textContent).not.toMatch(/Overdue/)
        expect(pill.querySelector('svg[data-testid="urgency-glyph-due-soon"]')).not.toBeNull()
        expect(pill.querySelector('svg[data-testid="urgency-glyph-overdue"]')).toBeNull()
        expect(pill.className).toContain('text-warning-on-tint')
      })

      it('applies the on-tint tone class to the pill on a tinted card', () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-06-15T15:00:00Z'))
        // Never moved, created 30 days ago against the 14-day default: stale 2x tint.
        render(
          <CardItem
            card={makeCard({ due_date: '2026-06-15', created_at: '2026-05-16T00:00:00Z' })}
            density="dense"
            userTimezone="UTC"
          />,
        )
        const pill = screen.getByTitle('Due 2026-06-15')
        expect(pill.className).toContain('text-danger-on-tint')
        expect(pill.className).not.toMatch(/text-(danger|warning)(?!-on-tint)/)
      })
    })

    it('leaves a far-out due pill plain: no glyph, fg-tertiary', () => {
      const FAR = new Date(TODAY.getTime() + 14 * 86_400_000).toISOString().slice(0, 10)
      render(<CardItem card={makeCard({ due_date: FAR })} density="dense" />)
      const pill = screen.getByTitle(`Due ${FAR}`)
      expect(pill.className).toContain('text-fg-tertiary')
      expect(pill.querySelector('svg')).toBeNull()
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

  // ---- blocked indicator (#449) ----

  describe('blocked indicator', () => {
    it.each(['comfortable', 'standard', 'dense'] as const)(
      'renders at %s density — blocked-ness is never density-gated',
      (density) => {
        render(<CardItem card={makeCard({ blocker_count: 1 })} density={density} />)
        expect(screen.getByLabelText('Blocked by 1 card')).toBeInTheDocument()
      },
    )

    it('is absent when the card has no blockers', () => {
      render(<CardItem card={makeCard({ blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '' })} density="dense" />)
      expect(screen.queryByLabelText(/^Blocked by/)).not.toBeInTheDocument()
    })

    it('shows no numeral at a single blocker', () => {
      render(<CardItem card={makeCard({ blocker_count: 1 })} density="dense" />)
      expect(screen.getByLabelText('Blocked by 1 card')).toHaveTextContent('')
    })

    it('shows the count above one, and pluralizes without "(s)"', () => {
      render(<CardItem card={makeCard({ blocker_count: 3 })} density="dense" />)
      const badge = screen.getByLabelText('Blocked by 3 cards')
      expect(badge).toHaveTextContent('3')
    })

    it('uses the danger token, not a raw hex', () => {
      render(<CardItem card={makeCard({ blocker_count: 2 })} density="dense" />)
      expect(screen.getByLabelText('Blocked by 2 cards')).toHaveClass('text-danger')
    })

    it('renders the metadata row for a card whose only metadata is being blocked', () => {
      // hasMetadata gates the whole row; without blocker_count in it the badge
      // would vanish on exactly the sparse cards that most need it.
      render(
        <CardItem
          card={makeCard({
            blocker_count: 1, labels: [], assignee: null, checklist_total: 0,
            checklist_done: 0, attachment_count: 0, weight: 1, description: '',
          })}
          density="comfortable"
        />,
      )
      expect(screen.getByLabelText('Blocked by 1 card')).toBeInTheDocument()
    })

    it('is the first element in the metadata row so it cannot be clipped', () => {
      const { container } = render(
        <CardItem card={makeCard({ blocker_count: 2 })} density="dense" />,
      )
      const row = container.querySelector('.flex.items-center.gap-1.mt-1\\.5')
      expect(row?.firstElementChild).toHaveAttribute('aria-label', 'Blocked by 2 cards')
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

// #871 gate (#1146): Classic keeps the pre-#871 face byte for byte, and so does a board
// with no preset (Classic equals it) and a card rendered outside any board view.
describe('CardItem — Classic keeps the pre-#871 urgency face (#871 gate)', () => {
  afterEach(() => act(() => publishActivePreset(null)))

  const cases: Array<[string, () => void]> = [
    ['Classic preset', () => publishPreset('classic')],
    ['no preset active', () => publishPreset(null)],
    ['no board view (nothing published)', () => {}],
    ['a non-Classic preset on another board', () => publishPreset('default', 99)],
  ]

  it.each(cases)('%s: the overdue badge is "⚑ <date>" in text-danger, with no SVG', (_name, setup) => {
    setup()
    render(<CardItem card={makeCard({ due_date: FIVE_DAYS_AGO })} density="comfortable" boardId={7} />)
    const badge = screen.getByTitle(`Due ${FIVE_DAYS_AGO}`)
    expect(badge.className).toBe('text-xs font-semibold shrink-0 text-danger')
    expect(badge.textContent).toMatch(/^⚑ Due \S/)
    expect(badge.children).toHaveLength(0)
  })

  it.each(cases)('%s: the due-soon badge is "⏱ <date>" in plain text-warning, with no SVG', (_name, setup) => {
    setup()
    render(<CardItem card={makeCard({ due_date: TWO_DAYS_FROM_NOW })} density="comfortable" boardId={7} />)
    const badge = screen.getByTitle(`Due ${TWO_DAYS_FROM_NOW}`)
    expect(badge.className).toBe('text-xs font-semibold shrink-0 text-warning')
    expect(badge.textContent).toMatch(/^⏱ Due /)
    expect(badge.children).toHaveLength(0)
  })

  it.each(cases)('%s: the dense due pill keeps its hue-only tone and plain label', (_name, setup) => {
    setup()
    const { unmount } = render(<CardItem card={makeCard({ due_date: FIVE_DAYS_AGO })} density="dense" boardId={7} />)
    const overdue = screen.getByTitle(`Due ${FIVE_DAYS_AGO}`)
    expect(overdue.className).toBe('text-xs font-medium shrink-0 text-danger')
    expect(overdue.children).toHaveLength(0)
    expect(overdue.textContent).toMatch(/^Due /)
    unmount()
    render(<CardItem card={makeCard({ due_date: TWO_DAYS_FROM_NOW })} density="dense" boardId={7} />)
    const soon = screen.getByTitle(`Due ${TWO_DAYS_FROM_NOW}`)
    expect(soon.className).toBe('text-xs font-medium shrink-0 text-fg-tertiary')
    expect(soon.children).toHaveLength(0)
  })

  it('switches to the redesigned face when the Default preset becomes active on its board, and back', () => {
    publishPreset('classic')
    render(<CardItem card={makeCard({ due_date: TWO_DAYS_FROM_NOW })} density="comfortable" boardId={7} />)
    const badge = () => screen.getByTitle(`Due ${TWO_DAYS_FROM_NOW}`)
    expect(badge().querySelector('svg')).toBeNull()
    publishPreset('default')
    expect(badge().className).toContain('text-warning-on-tint')
    expect(badge().querySelector('svg[data-testid="urgency-glyph-due-soon"]')).not.toBeNull()
    publishPreset('classic')
    expect(badge().textContent).toMatch(/^⏱ /)
  })
})
