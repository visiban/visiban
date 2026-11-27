import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useSearchParams } from 'react-router-dom'
import type { Swimlane, SwimlaneCustomFieldDefinition } from '../types'
import LaneOrderControl, { LaneSortBandSlot } from '../components/Board/LaneOrderControl'
import { useLaneSort } from '../hooks/useLaneSort'
import client from '../api/client'

// #2698 — the Lanes control and the Lane order popover.

const lane = (id: number, name: string, extra: Partial<Swimlane> = {}): Swimlane =>
  ({ id, name, position: id, custom_field_values: [], wip_limit: null, limit_column_ids: null, effective_health_status: null, ...extra }) as Swimlane
const field = (id: number, name: string, field_type = 'dropdown', choices = ['Critical', 'High', 'Low']) =>
  ({ id, name, field_type, choices, is_admin_only: false }) as SwimlaneCustomFieldDefinition

const lanes = [
  lane(1, 'Alpha', { custom_field_values: [{ field_definition: 7, value: 'Low' }] }),
  lane(2, 'Bravo', { custom_field_values: [{ field_definition: 7, value: 'Critical' }] }),
  lane(3, 'Charlie'),
]

function Probe() {
  const loc = useLocation()
  return <span data-testid="search">{loc.search}</span>
}

function Harness({ defs = [field(7, 'Priority')], isAdmin = false, hidden = 0 }: { defs?: SwimlaneCustomFieldDefinition[]; isAdmin?: boolean; hidden?: number }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const state = useLaneSort({ swimlanes: lanes, laneFieldDefs: defs, cardFieldDefs: [], isAdmin, cards: [], columns: [], shownCardIds: null, searchParams, setSearchParams })
  return (
    <>
      <LaneOrderControl state={state} lanes={lanes} isAdmin={isAdmin} hiddenLaneCount={hidden} />
      <ol aria-label="order">{state.ordered.map((l) => <li key={l.id}>{l.name}</li>)}</ol>
      {state.sort && <LaneSortBandSlot lane={lanes[2]} value={null} pinned={state.sort.pins.includes(3)} onTogglePin={() => state.togglePin(lanes[2])} />}
      <Probe />
    </>
  )
}

const renderAt = (url: string, props: Parameters<typeof Harness>[0] = {}) =>
  render(<MemoryRouter initialEntries={[url]}><Harness {...props} /></MemoryRouter>)
const order = () => within(screen.getByRole('list', { name: 'order' })).getAllByRole('listitem').map((li) => li.textContent)
const search = () => screen.getByTestId('search').textContent

describe('LaneOrderControl (#2698)', () => {
  it('shows the board order at rest and says everyone sees it', () => {
    renderAt('/b/1')
    expect(screen.getByRole('button', { name: 'Lanes: Board order. Change lane order' })).toHaveTextContent('Lanes: Board order')
    expect(screen.getByText('Everyone sees this order.')).toBeInTheDocument()
    expect(order()).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('applies a sort at once, writes only the URL, and resets to the board order', async () => {
    const post = vi.spyOn(client, 'post')
    const patch = vi.spyOn(client, 'patch')
    const user = userEvent.setup()
    renderAt('/b/1?view=board')
    await user.click(screen.getByRole('button', { name: /^Lanes: Board order/ }))
    const dialog = screen.getByRole('dialog', { name: 'Lane order' })
    expect(within(dialog).getByText('This is the board order. Everyone sees it. Pick a field to sort your own view.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: 'Priority' }))
    expect(order()).toEqual(['Bravo', 'Alpha', 'Charlie'])
    expect(search()).toBe('?view=board&lsort=f%3A7')
    expect(screen.getByRole('button', { name: /^Lanes: Sorted by Priority, Critical to Low\. Lanes with no value last\. Change lane order$/ })).toHaveTextContent('Lanes: Sorted by Priority ↓')
    expect(screen.getByText('Not saved as board order. Only you see this sort.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Lanes sorted by Priority, Critical → Low. Only you see this sort.'))

    await user.click(within(dialog).getByRole('radio', { name: 'Low → Critical' }))
    expect(search()).toContain('lsort_dir=r')
    expect(order()).toEqual(['Alpha', 'Bravo', 'Charlie'])

    await user.click(within(dialog).getByRole('radio', { name: 'First' }))
    expect(order()).toEqual(['Charlie', 'Alpha', 'Bravo'])
    expect(screen.getByRole('button', { name: /^Lanes: Sorted by/ })).toHaveTextContent('Lanes: Sorted by Priority ↑ +1')

    await user.click(screen.getByRole('button', { name: 'Reset to board order' }))
    expect(search()).toBe('?view=board')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Showing the board order.'))
    expect(order()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    expect(post).not.toHaveBeenCalled()
    expect(patch).not.toHaveBeenCalled()
  })

  it('restores the sort from the URL and pins from the chips and the band', async () => {
    const user = userEvent.setup()
    renderAt('/b/1?lsort=f:7')
    expect(order()).toEqual(['Bravo', 'Alpha', 'Charlie'])
    await user.click(screen.getByRole('button', { name: 'Pin Charlie to the top' }))
    expect(order()).toEqual(['Charlie', 'Bravo', 'Alpha'])
    expect(screen.getByText('Pinned')).toBeInTheDocument()
    expect(search()).toContain('lsort_pins=3')
    await user.click(screen.getByRole('button', { name: /^Lanes: Sorted by/ }))
    const chips = screen.getByRole('group', { name: 'Pinned to the top (1)' })
    await user.click(within(chips).getByRole('button', { name: 'Alpha' }))
    expect(order()).toEqual(['Alpha', 'Charlie', 'Bravo'])
  })

  it('shows the member footer, and no footer text for admins; no scope switch', async () => {
    const user = userEvent.setup()
    const { unmount } = renderAt('/b/1')
    await user.click(screen.getByRole('button', { name: /^Lanes:/ }))
    expect(screen.getByText('Only board admins can change the board order for everyone.')).toBeInTheDocument()
    expect(screen.queryByText(/Just for me/)).toBeNull()
    unmount()
    renderAt('/b/1', { isAdmin: true })
    await user.click(screen.getByRole('button', { name: /^Lanes:/ }))
    expect(screen.queryByText('Only board admins can change the board order for everyone.')).toBeNull()
  })

  it('closes on Escape and returns focus to the control', async () => {
    const user = userEvent.setup()
    renderAt('/b/1')
    const trigger = screen.getByRole('button', { name: /^Lanes:/ })
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Lane order' })).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('hints a field with no values and says why nothing moved', async () => {
    const user = userEvent.setup()
    renderAt('/b/1?lsort=f:8', { defs: [field(7, 'Priority'), field(8, 'Region', 'text', [])] })
    expect(screen.getByText('No lane has a Region yet, so lanes are in board order.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Choose another field' }))
    // The hint is part of the option's name, so it is heard as well as seen.
    expect(within(screen.getByRole('dialog', { name: 'Lane order' })).getByRole('radio', { name: 'Region No values yet' })).toBeChecked()
  })

  it('falls back to the board order for a field this viewer cannot use', () => {
    renderAt('/b/1?lsort=f:99')
    expect(screen.getByText("You can't use the field this link sorts by, so lanes are in board order.")).toBeInTheDocument()
    expect(search()).toBe('')
  })

  it('names a sort field deleted while the viewer is looking, and a deleted tie-breaker', () => {
    const view = renderAt('/b/1?lsort=f:7&lsort_then=f:8', { defs: [field(7, 'Priority'), field(8, 'Region', 'text', [])] })
    view.rerender(<MemoryRouter><Harness defs={[field(7, 'Priority')]} /></MemoryRouter>)
    // MemoryRouter keeps its history across a rerender.
    expect(screen.getByText('The field "Region" was deleted. Ties now follow the board order.')).toBeInTheDocument()
    view.rerender(<MemoryRouter><Harness defs={[]} /></MemoryRouter>)
    expect(screen.getByText('The field "Priority" was deleted, so your sort was turned off. Lanes are in board order.')).toBeInTheDocument()
    expect(order()).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('says how many lanes the lane filters hide', () => {
    renderAt('/b/1?lsort=name', { hidden: 1 })
    expect(screen.getByText('Sorting 2 of 3 lanes. 1 are hidden by lane filters.')).toBeInTheDocument()
  })

  it('collapses more than 8 fields into a keyboard-operable searchable picker', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 9 }, (_, i) => field(20 + i, `Field ${i + 1}`, 'text', []))
    renderAt('/b/1', { defs: many })
    await user.click(screen.getByRole('button', { name: /^Lanes:/ }))
    const box = screen.getByRole('combobox', { name: 'Sort lanes by' })
    await user.type(box, 'Field 1')
    expect(screen.getByText('1 of 14 fields match "Field 1". Arrow keys to move, Enter to choose.')).toBeInTheDocument()
    expect(box).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(search()).toBe('?lsort=f%3A20')
    await user.clear(box)
    await user.type(box, 'zzz')
    expect(screen.getByText('No field matches "zzz".')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(box).toHaveValue('')
    await user.click(box)
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}')
    expect(box.getAttribute('aria-activedescendant')).toMatch(/opt-name$/)
  })
})
