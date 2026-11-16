import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, within, act, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FilterBar, { EMPTY_FILTER, countActiveFilters, type FilterState } from '../components/Board/FilterBar'
import type { BoardFull, Swimlane, SwimlaneCustomFieldDefinition, User } from '../types'
import type { LaneFilter } from '../utils/laneFilter'

// #2205 — the Lanes trigger, popover rule builder, and lane chips in FilterBar.

const fakeUser: User = {
  id: 1, username: 'jdoe', email: 'j@example.com', first_name: 'Jane',
  last_name: 'Doe', avatar_url: '', display_name: 'Jane Doe',
  is_site_admin: false, must_change_password: false, must_change_username: false,
}

const def = (id: number, name: string, field_type: SwimlaneCustomFieldDefinition['field_type'], extra: Partial<SwimlaneCustomFieldDefinition> = {}): SwimlaneCustomFieldDefinition => ({
  id, uid: `slf${id}`, name, field_type, choices: [], position: id, show_on_row: false, is_admin_only: false,
  is_required: false, help_text: '', number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {},
  created_at: '', ...extra,
})
const AE = def(1, 'AE', 'dropdown', { choices: ['Priya', 'Sam'] })
const DEAL = def(2, 'Deal value', 'number')
const MARGIN = def(3, 'Margin', 'number', { is_admin_only: true })
const NOTES = def(4, 'Notes', 'text')
const SIGNED = def(5, 'Signed', 'checkbox')
const SITE = def(6, 'Site', 'url')

const swimlane = (id: number, vals: Record<number, string>): Swimlane => ({
  id, uid: `sl${id}`, name: `Lane ${id}`, position: id, color: '', is_collapsed: false, created_at: '',
  wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null,
  custom_field_values: Object.entries(vals).map(([k, v]) => ({ field_definition: Number(k), value: v })),
} as Swimlane)
const withLanes = (board: BoardFull, lanes: Swimlane[]): BoardFull => ({ ...board, swimlanes: lanes })

function makeBoard(defs: SwimlaneCustomFieldDefinition[] = [AE, DEAL, MARGIN], role: BoardFull['current_user_role'] = 'admin'): BoardFull {
  return {
    health_status: null, effective_health_status: null, health_status_source: null, health_status_changed_at: null, health_status_changed_by: null, health_status_note: null, health_review_days: null, health_review_due_at: null, health_auto_enabled: false, health_off_track_cards: 3, computed_health_status: null, health_computed_at: null, health_computed_counts: null, health_status_origin: null, default_preset: null,
    swimlane_rollup_field: null,
    id: 1, uid: 'boarduid0001', name: 'Test Board', description: '', group: null, group_name: null,
    archived_card_count: 0, columns: [], swimlanes: [], cards: [], labels: [],
    members: [{ id: 1, user: fakeUser, role: 'admin', is_moderator: false, joined_at: '' }],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false,
    show_row_chip_field_names: true, export_min_role: 'viewer', card_density: 'comfortable', is_starred: false,
    created_at: '', updated_at: '', current_user_role: role, owner: fakeUser, capabilities: { movement_export: false },
    share_token: null, share_token_expires_at: null, share_link_active: false,
    custom_field_definitions: [], swimlane_custom_field_definitions: defs,
  }
}

const rule = (id: number, field: number | null, op: 'is' | 'is_not' | 'between' | 'contains', extra: Record<string, unknown> = {}) =>
  ({ kind: 'rule' as const, id, join: 'and' as const, field, op, ...extra })

function Harness({ initial, board = makeBoard(), onState }: { initial?: LaneFilter; board?: BoardFull; onState?: (f: FilterState) => void }) {
  const [filters, setFilters] = useState<FilterState>(initial ? { ...EMPTY_FILTER, laneFilter: initial } : EMPTY_FILTER)
  return (
    <FilterBar
      board={board}
      filters={filters}
      onChange={(f) => { setFilters(f); onState?.(f) }}
      hiddenLaneCount={2}
      hiddenCount={3}
    />
  )
}

const openPopover = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /^Lanes(, \d+ active)?$/ }))
  return screen.findByRole('dialog', { name: 'Lane filters' })
}

describe('Lanes trigger', () => {
  it('is hidden when the viewer has no dropdown/number/date/text/url swimlane field', () => {
    render(<Harness board={makeBoard([SIGNED, MARGIN], 'member')} />)
    expect(screen.queryByRole('button', { name: /^Lanes(, \d+ active)?$/ })).not.toBeInTheDocument()
  })

  // #2336 — the built-ins are always rulable, so the gate is laneFilterAvailable.
  it('is shown without custom fields once the board has two lanes or a lane filter', () => {
    const { unmount } = render(<Harness board={withLanes(makeBoard([], 'member'), [swimlane(1, {})])} />)
    expect(screen.queryByRole('button', { name: /^Lanes(, \d+ active)?$/ })).not.toBeInTheDocument()
    unmount()
    const two = render(<Harness board={withLanes(makeBoard([], 'member'), [swimlane(1, {}), swimlane(2, {})])} />)
    expect(screen.getByRole('button', { name: 'Lanes' })).toBeInTheDocument()
    two.unmount()
    const lf: LaneFilter = { items: [{ kind: 'rule', id: 1, join: 'and', field: 'name', op: 'is', value: 'Lane 1' }] }
    render(<Harness initial={lf} board={withLanes(makeBoard([], 'member'), [swimlane(1, {})])} />)
    expect(screen.getByRole('button', { name: 'Lanes, 1 active' })).toBeInTheDocument()
  })

  it('names the active rule count and counts lane rules as one filter dimension', () => {
    const lf: LaneFilter = { items: [rule(1, 1, 'is', { value: 'Priya' }), rule(2, 2, 'between', { min: '5' }), rule(3, null, 'is')] }
    render(<Harness initial={lf} />)
    const trigger = screen.getByRole('button', { name: 'Lanes, 2 active' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(countActiveFilters({ ...EMPTY_FILTER, laneFilter: lf })).toBe(1)
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument()
  })

  it('shows lane and card counts in the always-mounted status', () => {
    render(<Harness />)
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('2 lanes hidden · 3 cards hidden')
  })
})

describe('LaneFilterPopover', () => {
  it('opens on the empty state with focus on + Add filter, and Escape closes to the trigger', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const dialog = await openPopover(user)
    expect(within(dialog).getByText('No lane filters yet.')).toBeInTheDocument()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '+ Add filter' })).toHaveFocus())
    expect(screen.getByText('Reads as: all lanes shown')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Lanes(, \d+ active)?$/ })).toHaveFocus()
  })

  it('builds a rule from the keyboard; it applies live and the Reads-as line follows', async () => {
    const user = userEvent.setup()
    const onState = vi.fn()
    render(<Harness onState={onState} />)
    const dialog = await openPopover(user)
    await user.click(within(dialog).getByRole('button', { name: '+ Add filter' }))
    const fieldTrigger = within(dialog).getByRole('button', { name: /^Filter 1 field/ })
    await waitFor(() => expect(fieldTrigger).toHaveFocus())
    expect(screen.getByText('Reads as: all lanes shown · 1 incomplete filter ignored')).toBeInTheDocument()
    await user.click(fieldTrigger)
    // Admin sees the admin-only field, marked with the padlock.
    const margin = within(dialog).getByRole('menuitem', { name: /Margin/ })
    expect(within(margin).getByRole('img', { name: 'Admin-only field' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('menuitem', { name: 'AE' }))
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 value/ }))
    await user.click(within(dialog).getByRole('menuitem', { name: 'Priya' }))
    expect(screen.getByText('Reads as: AE is Priya')).toBeInTheDocument()
    expect(onState.mock.calls.at(-1)![0].laneFilter.items[0]).toMatchObject({ field: 1, op: 'is', value: 'Priya' })
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 operator/ }))
    await user.click(within(dialog).getByRole('menuitem', { name: 'is not' }))
    expect(screen.getByText('Reads as: AE is not Priya')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Lanes, 1 active' })).toHaveFocus()
  })

  it('does not offer admin-only fields to a non-admin', async () => {
    const user = userEvent.setup()
    render(<Harness board={makeBoard([AE, MARGIN], 'member')} />)
    const dialog = await openPopover(user)
    await user.click(within(dialog).getByRole('button', { name: '+ Add filter' }))
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 field/ }))
    expect(within(dialog).getByRole('menuitem', { name: 'AE' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('menuitem', { name: /Margin/ })).not.toBeInTheDocument()
  })

  it('And/Or connectors are pressed buttons named for the pair they join', async () => {
    const user = userEvent.setup()
    const lf: LaneFilter = { items: [rule(1, 1, 'is', { value: 'Priya' }), rule(2, 2, 'between', { min: '50000' }), { kind: 'group', id: 3, join: 'or', rules: [rule(4, 1, 'is', { value: 'Sam' })] }] }
    render(<Harness initial={lf} />)
    const dialog = await openPopover(user)
    const first = within(dialog).getByRole('group', { name: 'Join filter 1 and filter 2' })
    expect(within(first).getByRole('button', { name: 'And' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(first).getByRole('button', { name: 'Or' })).toHaveAttribute('aria-pressed', 'false')
    expect(within(dialog).getByRole('group', { name: 'Join filter 2 and group 1' })).toBeInTheDocument()
    expect(screen.getByText('Reads as: (AE is Priya and Deal value 50,000 or more) or (AE is Sam)')).toBeInTheDocument()
    await user.click(within(first).getByRole('button', { name: 'Or' }))
    expect(within(first).getByRole('button', { name: 'Or' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Reads as: AE is Priya or Deal value 50,000 or more or (AE is Sam)')).toBeInTheDocument()
  })

  it('removing a rule focuses the next row, then the previous, then + Add filter', async () => {
    const user = userEvent.setup()
    const lf: LaneFilter = { items: [rule(1, 1, 'is', { value: 'Priya' }), rule(2, 2, 'between', { min: '5' })] }
    render(<Harness initial={lf} />)
    const dialog = await openPopover(user)
    await user.click(within(dialog).getByRole('button', { name: 'Remove filter 1: AE is Priya' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /^Filter 1 field/ })).toHaveFocus())
    await user.click(within(dialog).getByRole('button', { name: 'Remove filter 1: Deal value 5 or more' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '+ Add filter' })).toHaveFocus())
    expect(within(dialog).getByText('No lane filters yet.')).toBeInTheDocument()
  })

  it('adds a group, a filter to it, and removes the group', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const dialog = await openPopover(user)
    await user.click(within(dialog).getByRole('button', { name: '+ Add group' }))
    expect(within(dialog).getByText('Group 1')).toBeInTheDocument()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /^Filter 1 field/ })).toHaveFocus())
    await user.click(within(dialog).getByRole('button', { name: '+ Add filter to group' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /^Filter 2 field/ })).toHaveFocus())
    expect(within(dialog).getByRole('group', { name: 'Join filter 1 and filter 2' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Remove group 1' }))
    expect(within(dialog).queryByText('Group 1')).not.toBeInTheDocument()
  })

  it('edits a number range with Any placeholders', async () => {
    const user = userEvent.setup()
    render(<Harness initial={{ items: [rule(1, 2, 'between')] }} />)
    const dialog = await openPopover(user)
    const from = within(dialog).getByRole('spinbutton', { name: 'Filter 1 Deal value from' })
    expect(from).toHaveAttribute('placeholder', 'Any')
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Filter 1 Deal value to' }), '900')
    expect(screen.getByText('Reads as: Deal value up to 900')).toBeInTheDocument()
  })

  it('text field: is offers the lanes\' values sorted, is not and contains follow (#2226)', async () => {
    const user = userEvent.setup()
    const onState = vi.fn()
    const board = withLanes(makeBoard([AE, NOTES]), [
      swimlane(1, { 4: 'Olivia Grant' }), swimlane(2, { 4: ' Ethan Ross ' }), swimlane(3, { 4: 'ethan ross' }), swimlane(4, {}),
    ])
    render(<Harness board={board} onState={onState} />)
    const dialog = await openPopover(user)
    await user.click(within(dialog).getByRole('button', { name: '+ Add filter' }))
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 field/ }))
    await user.click(within(dialog).getByRole('menuitem', { name: 'Notes' }))
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 value/ }))
    const menu = within(dialog).getAllByRole('menuitem').map((m) => m.textContent)
    expect(menu).toEqual(['Ethan Ross', 'Olivia Grant'])
    await user.click(within(dialog).getByRole('menuitem', { name: 'Ethan Ross' }))
    expect(screen.getByText('Reads as: Notes is Ethan Ross')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 operator/ }))
    expect(within(dialog).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['is', 'is not', 'contains', 'does not contain', 'matches wildcard'])
    await user.click(within(dialog).getByRole('menuitem', { name: 'is not' }))
    expect(screen.getByText('Reads as: Notes is not Ethan Ross')).toBeInTheDocument()
    // Switching to contains carries the value into the text box.
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 operator/ }))
    await user.click(within(dialog).getByRole('menuitem', { name: 'contains' }))
    const box = within(dialog).getByRole('textbox', { name: 'Filter 1 Notes contains' })
    expect(box).toHaveValue('Ethan Ross')
    expect(box).toHaveAttribute('maxLength', '500')
    await user.clear(box)
    expect(screen.getByText('Reads as: all lanes shown · 1 incomplete filter ignored')).toBeInTheDocument()
    await user.type(box, 'ross')
    expect(screen.getByText('Reads as: Notes contains ross')).toBeInTheDocument()
    expect(onState.mock.calls.at(-1)![0].laneFilter.items[0]).toMatchObject({ field: 4, op: 'contains', value: 'ross' })
    // #2227: the typed operators share the input; wildcard adds a hint.
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 operator/ }))
    await user.click(within(dialog).getByRole('menuitem', { name: 'matches wildcard' }))
    const wbox = within(dialog).getByRole('textbox', { name: 'Filter 1 Notes matches wildcard' })
    expect(wbox).toHaveValue('ross')
    expect(wbox).toHaveAccessibleDescription(/for any text.*matches any part of the value/)
    expect(screen.getByText('Reads as: Notes matches wildcard ross')).toBeInTheDocument()
    expect(onState.mock.calls.at(-1)![0].laneFilter.items[0]).toMatchObject({ op: 'wildcard', value: 'ross' })
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 operator/ }))
    await user.click(within(dialog).getByRole('menuitem', { name: 'does not contain' }))
    expect(screen.getByText('Reads as: Notes does not contain ross')).toBeInTheDocument()
    expect(within(dialog).queryByText(/for any text/)).not.toBeInTheDocument()
    // Back to is: typed text that names no lane value is dropped.
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 operator/ }))
    await user.click(within(dialog).getByRole('menuitem', { name: 'is' }))
    expect(onState.mock.calls.at(-1)![0].laneFilter.items[0].value).toBeUndefined()
    expect(within(dialog).getByRole('button', { name: /^Filter 1 value/ })).toHaveTextContent('Choose a value')
  })

  it('contains back to is keeps typed text that names a lane value, in its spelling', async () => {
    const user = userEvent.setup()
    const onState = vi.fn()
    const board = withLanes(makeBoard([SITE]), [swimlane(1, { 6: 'https://A.example' })])
    render(<Harness board={board} onState={onState} initial={{ items: [rule(1, 6, 'contains', { value: ' https://a.example' })] }} />)
    const dialog = await openPopover(user)
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 operator/ }))
    await user.click(within(dialog).getByRole('menuitem', { name: 'is not' }))
    expect(onState.mock.calls.at(-1)![0].laneFilter.items[0]).toMatchObject({ op: 'is_not', value: 'https://A.example' })
    expect(screen.getByText('Reads as: Site is not https://A.example')).toBeInTheDocument()
  })

  it('a stored text value no lane carries stays selectable; no values at all says so', async () => {
    const user = userEvent.setup()
    const board = withLanes(makeBoard([NOTES]), [swimlane(1, { 4: 'Olivia Grant' })])
    const { unmount } = render(<Harness board={board} initial={{ items: [rule(1, 4, 'is', { value: 'Zed' })] }} />)
    let dialog = await openPopover(user)
    const value = within(dialog).getByRole('button', { name: /^Filter 1 value/ })
    expect(value).toHaveTextContent('Zed (no lane has this)')
    await user.click(value)
    expect(within(dialog).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Olivia Grant', 'Zed (no lane has this)'])
    unmount()
    render(<Harness board={makeBoard([NOTES])} initial={{ items: [rule(1, 4, 'is')] }} />)
    dialog = await openPopover(user)
    expect(within(dialog).getByText('No lane has a value yet. Use contains or matches wildcard to match text.')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /^Filter 1 value/ })).not.toBeInTheDocument()
  })

  it('Escape inside an open inner menu closes only that menu', async () => {
    const user = userEvent.setup()
    render(<Harness initial={{ items: [rule(1, null, 'is')] }} />)
    const dialog = await openPopover(user)
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 field/ }))
    expect(within(dialog).getByRole('menuitem', { name: 'AE' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(within(dialog).queryByRole('menuitem', { name: 'AE' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Lane filters' })).toBeInTheDocument()
  })

  // #2231 — inner menus are in-flow, so an open one needs room in the scrolling list.
  describe('reserves room for an open inner menu (#2231)', () => {
    const listOf = (dialog: HTMLElement) => dialog.querySelector('.overflow-y-auto') as HTMLElement

    it('field menu on a short list: reserved min-height while open, dropped on close', async () => {
      const user = userEvent.setup()
      render(<Harness initial={{ items: [rule(1, 1, 'is', { value: 'Priya' }), rule(2, null, 'is')] }} />)
      const dialog = await openPopover(user)
      expect(listOf(dialog).style.minHeight).toBe('')
      await user.click(within(dialog).getByRole('button', { name: /^Filter 2 field/ }))
      expect(listOf(dialog).style.minHeight).toMatch(/^min\(\d+px, /)
      await user.keyboard('{Escape}')
      expect(listOf(dialog).style.minHeight).toBe('')
    })

    it('covers the operator and value menus, and rows inside a group', async () => {
      const user = userEvent.setup()
      const lf: LaneFilter = { items: [{ kind: 'group' as const, id: 9, join: 'and' as const, rules: [rule(1, 1, 'is', { value: 'Priya' })] }] }
      render(<Harness initial={lf} />)
      const dialog = await openPopover(user)
      for (const name of [/^Filter 1 operator/, /^Filter 1 value/, /^Filter 1 field/]) {
        await user.click(within(dialog).getByRole('button', { name }))
        expect(listOf(dialog).style.minHeight).toMatch(/^min\(\d+px, /)
        await user.keyboard('{Escape}')
        expect(listOf(dialog).style.minHeight).toBe('')
      }
    })

    it('stays reserved until the last of two open menus closes', async () => {
      const user = userEvent.setup()
      render(<Harness initial={{ items: [rule(1, 1, 'is', { value: 'Priya' }), rule(2, null, 'is')] }} />)
      const dialog = await openPopover(user)
      await user.click(within(dialog).getByRole('button', { name: /^Filter 2 field/ }))
      // fireEvent skips the mousedown a real click sends, so the first menu stays open.
      fireEvent.click(within(dialog).getByRole('button', { name: /^Filter 1 value/ }))
      expect(listOf(dialog).style.minHeight).toMatch(/^min\(\d+px, /)
      await user.keyboard('{Escape}')
      expect(listOf(dialog).style.minHeight).toMatch(/^min\(\d+px, /)
      await user.keyboard('{Escape}')
      expect(listOf(dialog).style.minHeight).toBe('')
    })

    it('does not stay reserved when the row of an open menu is removed', async () => {
      const user = userEvent.setup()
      render(<Harness initial={{ items: [rule(1, 1, 'is', { value: 'Priya' }), rule(2, null, 'is')] }} />)
      const dialog = await openPopover(user)
      await user.click(within(dialog).getByRole('button', { name: /^Filter 2 field/ }))
      expect(listOf(dialog).style.minHeight).toMatch(/^min\(\d+px, /)
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove filter 2: incomplete' }))
      await waitFor(() => expect(within(dialog).queryByRole('button', { name: /^Filter 2 field/ })).not.toBeInTheDocument())
      expect(listOf(dialog).style.minHeight).toBe('')
    })
  })

  it('stops single-key board shortcuts from firing inside the dialog', async () => {
    const user = userEvent.setup()
    const docKey = vi.fn()
    document.addEventListener('keydown', docKey)
    render(<Harness />)
    await openPopover(user)
    await waitFor(() => expect(screen.getByRole('button', { name: '+ Add filter' })).toHaveFocus())
    await user.keyboard('f')
    expect(docKey).not.toHaveBeenCalled()
    document.removeEventListener('keydown', docKey)
  })

  it('clears every lane rule from the footer', async () => {
    const user = userEvent.setup()
    const onState = vi.fn()
    render(<Harness initial={{ items: [rule(1, 1, 'is', { value: 'Priya' })] }} onState={onState} />)
    const dialog = await openPopover(user)
    await user.click(within(dialog).getByRole('button', { name: 'Clear lane filters' }))
    expect(onState.mock.calls.at(-1)![0]).not.toHaveProperty('laneFilter')
  })

  it('an outside click closes without moving focus to the trigger', async () => {
    const user = userEvent.setup()
    render(<><Harness /><button>elsewhere</button></>)
    await openPopover(user)
    await user.click(screen.getByRole('button', { name: 'elsewhere' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Lanes(, \d+ active)?$/ })).not.toHaveFocus()
  })
})

describe('lane chips', () => {
  it('render after card chips with a Lanes tag, join words, and the "{label}, remove" name', () => {
    const lf: LaneFilter = { items: [rule(1, 1, 'is', { value: 'Priya' }), { kind: 'group', id: 2, join: 'or', rules: [rule(3, 1, 'is', { value: 'Sam' })] }] }
    render(<Harness initial={lf} />)
    const group = screen.getByRole('group', { name: 'Active filters' })
    expect(within(group).getAllByRole('button', { name: 'Lanes: AE is Priya, remove' }).length).toBeGreaterThan(0)
    expect(within(group).getAllByRole('button', { name: 'Lanes: (AE is Sam), remove' }).length).toBeGreaterThan(0)
    expect(within(group).getByText('or')).toBeInTheDocument()
  })

  it('dismissing a chip removes that item and moves focus to the next chip, else the trigger', async () => {
    const user = userEvent.setup()
    const lf: LaneFilter = { items: [rule(1, 1, 'is', { value: 'Priya' }), rule(2, 2, 'between', { min: '5' })] }
    render(<Harness initial={lf} />)
    const chip = () => screen.getAllByRole('button', { name: /^Lanes: / })[0]
    act(() => chip().focus())
    await user.keyboard('{Delete}')
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Lanes: Deal value 5 or more, remove'))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(screen.getByRole('button', { name: /^Lanes(, \d+ active)?$/ })).toHaveFocus())
    expect(screen.queryByRole('group', { name: 'Active filters' })).not.toBeInTheDocument()
  })
})

describe('LaneFilterPopover — built-in fields (#2336)', () => {
  const LANES = [
    { ...swimlane(1, { 4: 'gold' }), name: 'Acme Corp', contact_email: 'pat@acme.com' },
    { ...swimlane(2, {}), name: 'Globex', contact_email: '' },
  ] as Swimlane[]
  const fieldMenu = async (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) => {
    await user.click(within(dialog).getByRole('button', { name: '+ Add filter' }))
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 field/ }))
    return within(dialog).getByRole('menu')
  }

  it('lists Lane name and Contact email under Built-in, then custom fields, for an admin', async () => {
    const user = userEvent.setup()
    render(<Harness board={withLanes(makeBoard([NOTES, MARGIN]), LANES)} />)
    const menu = await fieldMenu(user, await openPopover(user))
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Lane name', 'Contact email', 'Margin', 'Notes'].map((n) => expect.stringContaining(n)))
    const builtIn = within(menu).getByRole('group', { name: 'Built-in' })
    expect(within(builtIn).getAllByRole('menuitem')).toHaveLength(2)
    expect(within(menu).getByRole('group', { name: 'Custom fields' })).toBeInTheDocument()
    expect(within(within(menu).getByRole('menuitem', { name: /Contact email/ })).getByRole('img', { name: 'Admin-only field' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Contact email Admin-only field' })).toBeInTheDocument()
  })

  it('shows no headings and no Contact email to a member without custom fields', async () => {
    const user = userEvent.setup()
    render(<Harness board={withLanes(makeBoard([], 'member'), LANES)} />)
    const menu = await fieldMenu(user, await openPopover(user))
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual([expect.stringContaining('Lane name')])
    expect(within(menu).queryByRole('group')).not.toBeInTheDocument()
    expect(within(menu).queryByText('Built-in')).not.toBeInTheDocument()
  })

  it('picking a built-in starts at is; Contact email typed ops use the @acme.com placeholder', async () => {
    const user = userEvent.setup()
    const onState = vi.fn()
    render(<Harness board={withLanes(makeBoard([NOTES]), LANES)} onState={onState} />)
    const dialog = await openPopover(user)
    const menu = await fieldMenu(user, dialog)
    await user.click(within(menu).getByRole('menuitem', { name: /Contact email/ }))
    expect(onState.mock.calls.at(-1)![0].laneFilter.items[0]).toMatchObject({ field: 'contact_email', op: 'is' })
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 value/ }))
    await user.click(within(dialog).getByRole('menuitem', { name: 'pat@acme.com' }))
    expect(screen.getByText('Reads as: Contact email is pat@acme.com')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 operator/ }))
    await user.click(within(dialog).getByRole('menuitem', { name: 'contains' }))
    const input = within(dialog).getByRole('textbox', { name: 'Filter 1 Contact email contains' })
    expect(input).toHaveAttribute('placeholder', 'e.g. @acme.com')
    // Lane name keeps the generic placeholder.
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 field/ }))
    await user.click(within(dialog).getByRole('menuitem', { name: 'Lane name' }))
    await user.click(within(dialog).getByRole('button', { name: /^Filter 1 operator/ }))
    await user.click(within(dialog).getByRole('menuitem', { name: 'contains' }))
    expect(within(dialog).getByRole('textbox', { name: 'Filter 1 Lane name contains' })).toHaveAttribute('placeholder', 'Text to match')
  })

  it('suffixes a built-in whose name a custom field shares, in the picker, trigger, chip and Reads as', async () => {
    const user = userEvent.setup()
    const CLASH = def(7, 'Lane Name', 'text')
    const lf: LaneFilter = { items: [{ kind: 'rule', id: 1, join: 'and', field: 'name', op: 'is', value: 'Globex' }] }
    render(<Harness initial={lf} board={withLanes(makeBoard([CLASH]), LANES)} />)
    expect(within(screen.getByRole('group', { name: 'Active filters' })).getAllByRole('button', { name: 'Lanes: Lane name (built-in) is Globex, remove' }).length).toBeGreaterThan(0)
    const dialog = await openPopover(user)
    expect(within(dialog).getByText('Reads as: Lane name (built-in) is Globex')).toBeInTheDocument()
    const trigger = within(dialog).getByRole('button', { name: /^Filter 1 field/ })
    expect(trigger).toHaveTextContent('Lane name (built-in)')
    // The w-40 trigger truncates, so the full name is on the title (#2336).
    expect(trigger).toHaveAttribute('title', 'Lane name (built-in)')
    await user.click(trigger)
    expect(within(dialog).getByRole('menuitem', { name: 'Lane Name' })).toBeInTheDocument()
  })
})

describe('Hide lanes with no matching cards (#2214) and ignored rules (#2337)', () => {
  function Harness2({ initial, cardFilterActive = false, ignored = 0, onState }: { initial?: LaneFilter; cardFilterActive?: boolean; ignored?: number; onState?: (f: FilterState) => void }) {
    const [filters, setFilters] = useState<FilterState>(initial ? { ...EMPTY_FILTER, laneFilter: initial } : EMPTY_FILTER)
    return (
      <FilterBar
        board={makeBoard()}
        filters={filters}
        onChange={(f) => { setFilters(f); onState?.(f) }}
        cardFilterActive={cardFilterActive}
        ignoredLaneRuleCount={ignored}
      />
    )
  }

  it('is off and disabled while no card filter or chip is active, with the reason', async () => {
    const user = userEvent.setup()
    render(<Harness2 />)
    const dialog = await openPopover(user)
    const box = within(dialog).getByRole('checkbox', { name: 'Hide lanes with no matching cards' })
    expect(box).not.toBeChecked()
    expect(box).toBeDisabled()
    expect(box).toHaveAccessibleDescription('While a card filter or Show chip is active.')
  })

  it('turns on as a setting, not a rule, and survives clearing the rules', async () => {
    const user = userEvent.setup()
    const onState = vi.fn()
    render(<Harness2 cardFilterActive initial={{ items: [rule(1, 1, 'is', { value: 'Priya' })] }} onState={onState} />)
    const dialog = await openPopover(user)
    await user.click(within(dialog).getByRole('checkbox', { name: 'Hide lanes with no matching cards' }))
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ laneFilter: { items: [expect.objectContaining({ id: 1 })], hideUnmatched: true } }))
    await user.click(within(dialog).getByRole('button', { name: 'Clear lane filters' }))
    expect(onState.mock.calls.at(-1)?.[0].laneFilter).toEqual({ items: [], hideUnmatched: true })
    expect(within(dialog).getByRole('checkbox', { name: 'Hide lanes with no matching cards' })).toBeChecked()
    await user.click(within(dialog).getByRole('checkbox', { name: 'Hide lanes with no matching cards' }))
    expect(onState.mock.calls.at(-1)?.[0].laneFilter).toBeUndefined()
  })

  it('says how many rules were ignored, in the popover and in Reads as', async () => {
    const user = userEvent.setup()
    render(<Harness2 ignored={2} />)
    const dialog = await openPopover(user)
    expect(within(dialog).getByTestId('lane-filter-ignored')).toHaveTextContent('2 filters ignored: you cannot use these fields')
    expect(within(dialog).getByRole('status')).toHaveTextContent('Reads as: all lanes shown · 2 filters ignored: you cannot use these fields')
  })

  it('shows no ignored line when nothing was ignored', async () => {
    const user = userEvent.setup()
    render(<Harness2 />)
    const dialog = await openPopover(user)
    expect(within(dialog).queryByTestId('lane-filter-ignored')).not.toBeInTheDocument()
  })
})
