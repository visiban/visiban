import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HealthStatusControl from '../components/Common/HealthStatusControl'
import HealthStatusPill from '../components/Common/HealthStatusPill'
import HealthOffTrackInput, { parseHealthOffTrack } from '../components/Common/HealthOffTrackInput'
import {
  applyHealthRecompute, getHealthDisplay, healthAutoTitle, healthComputedWhen, healthCountsLine,
  healthOriginSuffix, healthRecomputeErrorMessage, healthReviewCue, laneHealthAuto, laneHealthFields,
  pickBoardHealth, pickLaneHealth, boardHealthAuto, BOARD_HEALTH_FIELDS, LANE_HEALTH_FIELDS,
  type HealthAutoInfo,
} from '../utils/healthStatus'
import type { Board, BoardFull, HealthHistory, Swimlane } from '../types'

// Auto health status (#2245): origin on the pill, the computed block in the
// popover, Recompute now, and the shared merge helpers.

const NOW = new Date('2026-11-15T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString()
const COUNTS = { open: 12, overdue: 1, stale: 2, blocked: 0, flagged: 3 }
const AUTO: HealthAutoInfo = { computed: 'at_risk', computedAt: hoursAgo(3), counts: COUNTS }
const NEVER: HealthAutoInfo = { computed: null, computedAt: null, counts: null }
const EMPTY: HealthAutoInfo = { computed: null, computedAt: hoursAgo(1), counts: { open: 0, overdue: 0, stale: 0, blocked: 0, flagged: 0 } }

const computedFields = { health_status: null, effective_health_status: 'at_risk' as const, health_status_source: null, health_status_origin: 'computed' as const }
const pinnedFields = { health_status: 'off_track' as const, effective_health_status: 'off_track' as const, health_status_source: null, health_status_origin: 'manual' as const }

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(NOW) })
afterEach(() => { vi.useRealTimers() })

describe('healthStatus utils (#2245)', () => {
  it('maps origin for pin, computed, inherited and none', () => {
    expect(getHealthDisplay(pinnedFields).origin).toBe('manual')
    expect(getHealthDisplay(computedFields).origin).toBe('computed')
    expect(getHealthDisplay(computedFields).inheritedFrom).toBeNull()
    expect(getHealthDisplay({
      health_status: null, effective_health_status: 'on_track',
      health_status_source: { id: 1, name: 'Eng', changed_at: null },
    }).origin).toBe('inherited')
    expect(getHealthDisplay({ health_status: null, effective_health_status: null, health_status_source: null }).origin).toBeNull()
  })

  it('has no review cue for a computed status, but keeps it for a pin on an auto board', () => {
    const due = hoursAgo(24)
    expect(healthReviewCue({ ...computedFields, health_review_due_at: due, health_status_changed_at: hoursAgo(500) })).toBeNull()
    expect(healthReviewCue({ ...pinnedFields, health_review_due_at: due, health_status_changed_at: hoursAgo(500) })?.text).toBe('Not reviewed in 20 days')
  })

  it('words the computed time, counts and titles', () => {
    expect(healthComputedWhen(null)).toBe('Never computed')
    expect(healthComputedWhen(hoursAgo(3))).toBe('Computed 3h ago')
    expect(healthCountsLine(COUNTS)).toBe('12 open · 1 overdue · 2 stale · 3 flagged')
    expect(healthCountsLine({ open: 0, overdue: 0, stale: 0, blocked: 0, flagged: 0 })).toBe('0 open')
    expect(healthCountsLine(null)).toBe('')
    expect(healthAutoTitle(getHealthDisplay(computedFields), AUTO)).toBe('At risk: calculated automatically. 1 overdue, 2 stale. Computed 3h ago.')
    expect(healthAutoTitle(getHealthDisplay(pinnedFields), AUTO)).toBe('Off track: set by hand. The rule computed At risk.')
    expect(healthAutoTitle(getHealthDisplay(pinnedFields), NEVER)).toBe('Off track: set by hand. Never computed.')
    const none = getHealthDisplay({ health_status: null, effective_health_status: null, health_status_source: null })
    expect(healthAutoTitle(none, EMPTY)).toBe('No open cards. Computed 1h ago.')
    expect(healthOriginSuffix(none, EMPTY)).toBe(', no open cards')
    expect(healthOriginSuffix(getHealthDisplay(pinnedFields), null)).toBe('')
  })

  it('maps Recompute errors', () => {
    expect(healthRecomputeErrorMessage({ response: { status: 409, data: { code: 'health_auto_disabled' } } })).toBe('Automatic health status is turned off for this board.')
    expect(healthRecomputeErrorMessage({ response: { status: 429 } })).toBe('Recompute is limited to 30 times per hour. Try again later.')
    expect(healthRecomputeErrorMessage(new Error('x'))).toBe("Couldn't recompute. Try again.")
  })

  it('builds lane fields and auto info, with pre-#2245 fallbacks', () => {
    expect(laneHealthFields({ health_status: 'at_risk' })).toEqual({ health_status: 'at_risk', effective_health_status: 'at_risk', health_status_source: null, health_status_origin: 'manual' })
    expect(laneHealthFields({ health_status: null, effective_health_status: 'off_track', health_status_origin: 'computed' }).effective_health_status).toBe('off_track')
    expect(laneHealthAuto({ computed_health_status: 'at_risk' }, false)).toBeNull()
    expect(laneHealthAuto({ computed_health_status: 'at_risk', health_computed_at: null }, true)).toEqual({ computed: 'at_risk', computedAt: null, counts: null })
    expect(boardHealthAuto({ health_auto_enabled: false })).toBeNull()
    expect(boardHealthAuto({ health_auto_enabled: true, computed_health_status: 'on_track', health_computed_at: 'x', health_computed_counts: null })).toEqual({ computed: 'on_track', computedAt: 'x', counts: null })
  })

  it('picks every board and lane health field, and merges a recompute by lane id', () => {
    const board = Object.fromEntries(BOARD_HEALTH_FIELDS.map((k) => [k, `v-${k}`])) as unknown as Board
    const picked = pickBoardHealth({ ...board, name: 'ignored' } as Board)
    expect(Object.keys(picked).sort()).toEqual([...BOARD_HEALTH_FIELDS].sort())
    expect(picked).toMatchObject({ health_auto_enabled: 'v-health_auto_enabled', health_status_origin: 'v-health_status_origin', health_computed_counts: 'v-health_computed_counts' })
    const lane = Object.fromEntries(LANE_HEALTH_FIELDS.map((k) => [k, `l-${k}`])) as unknown as Swimlane
    expect(Object.keys(pickLaneHealth({ ...lane, name: 'x' } as Swimlane)).sort()).toEqual([...LANE_HEALTH_FIELDS].sort())

    const merge = vi.fn()
    const resolvers: Array<(b: BoardFull) => Swimlane> = []
    const prior = { id: 7, name: 'Acme', contact_email: 'kept@x.test', health_status: null } as unknown as Swimlane
    const incoming = { id: 7, name: 'Acme', contact_email: '', health_status: null, effective_health_status: 'at_risk', health_status_origin: 'computed', computed_health_status: 'at_risk', health_computed_at: 'now', health_computed_counts: COUNTS } as unknown as Swimlane
    const stray = { id: 9, name: 'New' } as unknown as Swimlane
    applyHealthRecompute({ board: board, swimlanes: [incoming, stray] }, merge, (r) => resolvers.push(r))
    expect(merge).toHaveBeenCalledWith(pickBoardHealth(board))
    const state = { swimlanes: [prior] } as unknown as BoardFull
    expect(resolvers[0](state)).toMatchObject({ contact_email: 'kept@x.test', computed_health_status: 'at_risk', health_computed_at: 'now' })
    expect(resolvers[1](state)).toBe(stray)
  })
})

describe('HealthStatusPill origin (#2245)', () => {
  it('carries origin in sr text and a glyph, and the description outside the name', () => {
    render(<HealthStatusPill value="at_risk" origin="computed" srSuffix=", calculated automatically" description="Computed 3h ago" onClick={() => {}} />)
    const button = screen.getByRole('button')
    expect(button).toHaveAccessibleName(/^Health status: At risk ?, calculated automatically$/)
    expect(button).toHaveAccessibleDescription('Computed 3h ago')
    const glyph = button.querySelector('[data-health-origin-glyph="computed"]')
    expect(glyph).not.toBeNull()
    // currentColor only: the glyph takes the pill's on-tint text color.
    expect(glyph?.getAttribute('class')).not.toMatch(/text-/)
  })

  it('shows a pin glyph for a status set by hand', () => {
    const { container } = render(<HealthStatusPill value="off_track" origin="manual" srSuffix=", set by hand" />)
    expect(container.querySelector('[data-health-origin-glyph="manual"]')).not.toBeNull()
    expect(container).toHaveTextContent('set by hand')
  })
})

function renderControl(props: Partial<React.ComponentProps<typeof HealthStatusControl>> = {}) {
  const onSave = vi.fn().mockResolvedValue({ effective_health_status: 'at_risk' })
  const utils = render(
    <HealthStatusControl
      entityKind="board"
      entityName="Acme"
      parentName={null}
      canEdit
      mode="basic"
      onSave={onSave}
      auto={AUTO}
      {...computedFields}
      {...props}
    />,
  )
  return { ...utils, onSave }
}

describe('HealthStatusControl on an auto board (#2245)', () => {
  it('titles and describes a computed pill', () => {
    renderControl()
    const pill = screen.getByRole('button', { name: /Health status: At risk ?, calculated automatically/ })
    expect(pill).toHaveAttribute('title', 'Health status: At risk: calculated automatically. 1 overdue, 2 stale. Computed 3h ago. Click to change.')
    expect(pill).toHaveAccessibleDescription('Computed 3h ago. 12 open · 1 overdue · 2 stale · 3 flagged')
  })

  it('a pin shows what the rule computed, and Clear pin saves null', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { onSave } = renderControl({ ...pinnedFields })
    const pill = screen.getByRole('button', { name: /set by hand/ })
    expect(pill).toHaveAttribute('title', expect.stringContaining('The rule computed At risk.'))
    await user.click(pill)
    const dialog = await screen.findByRole('dialog')
    const block = within(dialog).getByTestId('health-computed-block')
    expect(block).toHaveTextContent('Calculated: At risk')
    expect(block).toHaveTextContent('Set by hand: Off track')
    expect(block).toHaveTextContent('Computed 3h ago')
    expect(block).toHaveTextContent('12 open · 1 overdue · 2 stale · 3 flagged')
    expect(within(dialog).getByText('Use calculated status (At risk)')).toBeInTheDocument()
    await user.click(within(block).getByRole('button', { name: 'Clear pin (use calculated)' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null))
  })

  it('says Never computed, and invites admins to Recompute now', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderControl({ ...pinnedFields, auto: NEVER, onRecompute: vi.fn().mockResolvedValue(undefined) })
    await user.click(screen.getByRole('button', { name: /set by hand/ }))
    const block = await screen.findByTestId('health-computed-block')
    expect(block).toHaveTextContent('Calculated: Never computed')
    expect(block).toHaveTextContent('Never computed. Run it with Recompute now.')
  })

  it('reads "No open cards" for an empty computed lane', () => {
    renderControl({
      entityKind: 'swimlane', health_status: null, effective_health_status: null, health_status_origin: null, auto: EMPTY,
    })
    const pill = screen.getByRole('button', { name: /no open cards/ })
    expect(pill).toHaveAttribute('title', expect.stringContaining('No open cards. Computed 1h ago.'))
  })

  it('non-admins get the read-only block, without Recompute', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderControl({ canEdit: false, onRecompute: vi.fn() })
    await user.click(screen.getByRole('button', { name: /calculated automatically/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByTestId('health-computed-block')).toHaveTextContent('Calculated: At risk')
    expect(within(dialog).queryByRole('button', { name: 'Recompute now' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('Recompute now: loading, success, 409, 429 and generic errors', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    let resolve!: () => void
    const onRecompute = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((r) => { resolve = r }))
      .mockRejectedValueOnce({ response: { status: 409, data: { code: 'health_auto_disabled' } } })
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockRejectedValueOnce(new Error('boom'))
    renderControl({ onRecompute })
    await user.click(screen.getByRole('button', { name: /calculated automatically/ }))
    const button = await screen.findByRole('button', { name: 'Recompute now' })
    await user.click(button)
    expect(screen.getByRole('button', { name: 'Recomputing…' })).toHaveAttribute('aria-busy', 'true')
    // The feedback slot is there before any result, so nothing shifts.
    expect(screen.getByTestId('health-recompute-feedback')).toBeEmptyDOMElement()
    resolve()
    await waitFor(() => expect(screen.getByText('Health status recomputed.')).toBeInTheDocument())
    expect(screen.getByTestId('health-recompute-feedback')).toHaveTextContent('Recomputed')
    await user.click(screen.getByRole('button', { name: 'Recompute now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Automatic health status is turned off for this board.')
    await user.click(screen.getByRole('button', { name: 'Recompute now' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Recompute is limited to 30 times per hour. Try again later.'))
    await user.click(screen.getByRole('button', { name: 'Recompute now' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't recompute. Try again."))
  })

  it('history: a computed row reads Automatic with its reason; a manual null user reads Removed account', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const history: HealthHistory = {
      results: [
        { from_status: 'on_track', to_status: 'at_risk', changed_by: null, changed_at: hoursAgo(5), note: null, kind: 'computed', reason: 'Auto: 1 overdue, 2 stale' },
        { from_status: null, to_status: 'on_track', changed_by: null, changed_at: hoursAgo(50), note: 'old', kind: 'manual', reason: null },
      ],
      has_more: false,
    }
    renderControl({ canEdit: false, mode: 'detailed', fetchHistory: vi.fn().mockResolvedValue(history) })
    await user.click(screen.getByRole('button', { name: /calculated automatically/ }))
    const items = await screen.findAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Automatic')
    expect(items[0]).toHaveTextContent('Auto: 1 overdue, 2 stale')
    expect(within(items[0]).queryByText('System')).not.toBeInTheDocument()
    expect(within(items[0]).queryByTitle('Removed account')).not.toBeInTheDocument()
    expect(within(items[1]).getByText('System')).toHaveAttribute('title', 'Removed account')
  })
})

describe('HealthOffTrackInput (#2245)', () => {
  it('validates 1..1000 and rejects blank', () => {
    expect(parseHealthOffTrack('3')).toBe(3)
    expect(parseHealthOffTrack('0')).toBeUndefined()
    expect(parseHealthOffTrack('1001')).toBeUndefined()
    expect(parseHealthOffTrack('')).toBeUndefined()
    expect(parseHealthOffTrack('2.5')).toBeUndefined()
  })

  it('saves on blur, shows the inline error, reverts on Escape and on failure', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onSave = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('x'))
    render(<HealthOffTrackInput value={3} onSave={onSave} />)
    const input = screen.getByLabelText('Off track at')
    await user.clear(input)
    await user.type(input, '0')
    await user.tab()
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number from 1 to 1000.')
    expect(onSave).not.toHaveBeenCalled()
    await user.clear(input)
    await user.type(input, '9{Escape}')
    expect(input).toHaveValue(3)
    await user.clear(input)
    await user.type(input, '5{Enter}')
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(5))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    await user.clear(input)
    await user.type(input, '7')
    await user.tab()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed to save the threshold.'))
    expect(input).toHaveValue(3)
  })

  it('is disabled with a hint while auto health is off', () => {
    render(<HealthOffTrackInput value={3} onSave={vi.fn()} disabled />)
    const input = screen.getByLabelText('Off track at')
    expect(input).toBeDisabled()
    expect(input).toHaveAccessibleDescription(/Turn on automatic health status to set this\./)
    // Only the input row dims; the hint saying why stays full opacity.
    const hint = screen.getByText('Turn on automatic health status to set this.')
    expect(hint.closest('.opacity-60')).toBeNull()
    expect(input.closest('.opacity-60')).not.toBeNull()
  })

  it('Enter then blur while the save is in flight sends one PATCH', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    let resolve!: () => void
    const onSave = vi.fn(() => new Promise<void>((r) => { resolve = r }))
    render(<HealthOffTrackInput value={3} onSave={onSave} />)
    const input = screen.getByLabelText('Off track at')
    await user.clear(input)
    await user.type(input, '6{Enter}')
    await user.tab()
    expect(onSave).toHaveBeenCalledTimes(1)
    resolve()
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })
})
