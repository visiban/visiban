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

    it('renders an overdue status line: flag, "Overdue <month day>", danger text (#2272)', () => {
      const { container } = render(<CardItem card={makeCard({ due_date: FIVE_DAYS_AGO })} density="comfortable" />)
      const line = container.querySelector('[data-testid="card-status-line"]') as HTMLElement
      expect(line.textContent).toMatch(/^Overdue [A-Z][a-z]{2} \d{1,2}$/)
      expect(line.className).toContain('text-danger')
      expect(line.textContent).not.toMatch(/⚑/)
      const glyph = line.querySelector('svg[data-testid="urgency-glyph-overdue"]')
      expect(glyph).not.toBeNull()
      expect(glyph?.getAttribute('aria-hidden')).toBe('true')
      // The status line sits on its own row under the metadata at Comfortable.
      expect(container.querySelector('[data-testid="card-status-row"]')).toContainElement(line)
    })

    it('renders a due-soon status line: flag, relative date, secondary text, no color (#2272)', () => {
      const { container } = render(<CardItem card={makeCard({ due_date: TWO_DAYS_FROM_NOW })} density="comfortable" />)
      const line = container.querySelector('[data-testid="card-status-line"]') as HTMLElement
      expect(line.textContent).toMatch(/^Due /)
      expect(line.textContent).not.toBe('Due soon')
      expect(line.className).toContain('text-fg-secondary')
      expect(line.querySelector('svg[data-testid="urgency-glyph-due-soon-flag"]')?.getAttribute('aria-hidden')).toBe('true')
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

  describe('a closed card carries no overdue signal on its due pill (#2313)', () => {
    it.each([
      ['standard', 'done column', { inDoneColumn: true }, {}],
      ['standard', 'archived', {}, { archived_at: '2026-01-01T00:00:00Z' }],
      ['dense', 'done column', { inDoneColumn: true }, {}],
      ['dense', 'archived', {}, { archived_at: '2026-01-01T00:00:00Z' }],
    ] as const)('%s density, %s', (density, _why, props, cardExtra) => {
      const { container } = render(
        <CardItem card={makeCard({ due_date: FIVE_DAYS_AGO, ...cardExtra })} density={density} {...props} />,
      )
      expect(container.textContent).not.toContain('Overdue')
      expect(container.querySelector('[data-testid="urgency-glyph-overdue"]')).toBeNull()
      expect(container.querySelector('.text-danger')).toBeNull()
    })
  })

  describe('density="dense"', () => {
    it('shows a short status instead of the urgency badge and the due pill (#2272)', () => {
      render(<CardItem card={makeCard({ due_date: FIVE_DAYS_AGO })} density="dense" />)
      const line = screen.getByTitle(`Due ${FIVE_DAYS_AGO}`)
      expect(line.textContent).toBe('Overdue')
      expect(line.className).toContain('text-danger')
      expect(line.querySelector('svg[data-testid="urgency-glyph-overdue"]')?.getAttribute('aria-hidden')).toBe('true')
    })

    it('shows a short due-soon status in secondary text (#2272)', () => {
      render(<CardItem card={makeCard({ due_date: TWO_DAYS_FROM_NOW })} density="dense" />)
      const line = screen.getByTitle(`Due ${TWO_DAYS_FROM_NOW}`)
      expect(line.textContent).toBe('Due soon')
      expect(line.className).toContain('text-fg-secondary')
      expect(line.querySelector('svg[data-testid="urgency-glyph-due-soon-flag"]')).not.toBeNull()
    })

    it('shows stale as bare days with the word for screen readers (#2272)', () => {
      const { container } = render(
        <CardItem card={makeCard({ is_stale: true, last_moved_at: '2026-01-01T00:00:00Z' })} density="dense" />,
      )
      const line = container.querySelector('[data-testid="card-status-line"]') as HTMLElement
      expect(line.textContent).toMatch(/^Stale \d+d$/)
      expect(line.querySelector('.sr-only')?.textContent).toBe('Stale ')
      expect(line.querySelector('svg[data-testid="urgency-glyph-stale"]')).not.toBeNull()
    })

    describe('due-today pill (#871, #2313)', () => {
      afterEach(() => { vi.useRealTimers() })

      it('renders a due-today card as due soon, not overdue, in the short status', () => {
        // 15:00 UTC on 2026-06-15: the due date is today in the instance zone
        // (UTC by default), so the overdue rule (#2313) does not apply until
        // midnight. Before #2313 the classifier parsed the date as UTC midnight
        // and called it overdue all day.
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-06-15T15:00:00Z'))
        render(
          <CardItem
            card={makeCard({ due_date: '2026-06-15', created_at: '2026-06-14T00:00:00Z' })}
            density="dense"
            userTimezone="UTC"
          />,
        )
        expect(screen.getByTitle('Due 2026-06-15').textContent).not.toBe('Overdue')
        expect(screen.getByTitle('Due 2026-06-15').textContent).toBe('Due soon')
      })

      it('applies the on-tint tone class to the pill on a tinted card', () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-06-15T15:00:00Z'))
        // Never moved, created 30 days ago against the 14-day default: stale 2x tint.
        // Due yesterday, so overdue under the #2313 rule.
        render(
          <CardItem
            card={makeCard({ due_date: '2026-06-14', created_at: '2026-05-16T00:00:00Z' })}
            density="dense"
            userTimezone="UTC"
          />,
        )
        const pill = screen.getByTitle('Due 2026-06-14')
        expect(pill.className).toContain('text-danger-on-tint')
        expect(pill.className).not.toMatch(/text-(danger|warning)(?!-on-tint)/)
      })
    })

    it('is one row: title, short status, first pinned field, avatar; the rest moves to the peek (#2272)', () => {
      const FAR = new Date(TODAY.getTime() + 14 * 86_400_000).toISOString().slice(0, 10)
      const def = (id: number, name: string, position: number) => ({
        id, uid: `cf${id}`, name, field_type: 'text' as const, choices: [], position, show_on_card: true,
        is_required: false, help_text: '', number_prefix: '', number_suffix: '', number_decimals: null,
        choice_colors: {}, threshold_direction: '' as const, threshold_warn: null, threshold_alert: null,
        threshold_warn_days: null, threshold_alert_days: null, created_at: '2026-01-01T00:00:00Z',
      })
      const { container } = render(
        <CardItem
          card={makeCard({
            due_date: FIVE_DAYS_AGO, priority: 'high', weight: 5, attachment_count: 2, checklist_total: 3,
            checklist_done: 1, last_moved_at: TWELVE_HOURS_AGO, description: 'x',
            custom_field_values: [{ field_definition: 2, value: 'Acme' }, { field_definition: 3, value: 'Other' }],
          })}
          customFieldDefinitions={[def(2, 'Account', 0), def(3, 'Region', 1)]}
          density="dense"
        />,
      )
      const row = container.querySelector('[data-testid="card-dense-row"]') as HTMLElement
      expect(row).not.toBeNull()
      expect(row.querySelector('p')).not.toBeNull()
      expect(row.querySelector('[data-testid="card-status-line"]')?.textContent).toBe('Overdue')
      expect(screen.getByTitle('Account: Acme')).toBeInTheDocument()
      expect(screen.queryByTitle('Region: Other')).toBeNull()
      expect(screen.getByTestId('avatar')).toBeInTheDocument()
      // Everything else is off the face (the priority stays in the accessible name).
      expect(screen.queryByText('backend')).toBeNull()
      expect(screen.queryByTitle('Priority: high')).toBeNull()
      expect(screen.queryByTitle('Weight: 5')).toBeNull()
      expect(screen.queryByTitle('2 attachment(s)')).toBeNull()
      expect(screen.queryByTitle('1/3 checklist items')).toBeNull()
      expect(container.querySelector('[title="Recently moved"]')).toBeNull()
      expect(screen.queryByTitle(`Due ${FAR}`)).toBeNull()
    })

    it('renders no second row for a dense card with only a title', () => {
      const { container } = render(<CardItem card={makeCard({ labels: [], assignee: null })} density="dense" />)
      expect(container.querySelector('[data-testid="card-metadata-row"]')).toBeNull()
      expect(container.querySelector('[data-testid="card-status-row"]')).toBeNull()
    })
  })

  describe('assignee avatar placement (#2272)', () => {
    it('sits at the end of the label row on the calm face, not absolutely positioned', () => {
      const { container } = render(<CardItem card={makeCard()} density="standard" />)
      const avatar = screen.getByTestId('avatar')
      expect(avatar.closest('[data-testid="card-metadata-row"]')).toBeNull()
      expect(avatar.previousElementSibling).toBe(container.querySelector('[data-testid="card-metadata-row"]'))
      expect(avatar.className).not.toContain('absolute')
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
        <CardItem card={makeCard({ blocker_count: 2 })} density="standard" />,
      )
      const row = container.querySelector('[data-testid="card-metadata-row"]')
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
