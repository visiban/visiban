import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { createCard } from '../api/cards'
import PhoneBoard from '../components/Board/PhoneBoard'
import type { Card, Column, CustomFieldDefinition, Swimlane, SwimlaneCustomFieldDefinition } from '../types'
import { patchSwimlane } from '../api/boards'
import { stepOrder, cellOrderOf } from '../utils/phoneReorder'

vi.mock('../api/cards', () => ({ createCard: vi.fn() }))
vi.mock('../api/boards', () => ({ patchSwimlane: vi.fn() }))
// Stubs that expose the wiring: the real controls have their own suites.
vi.mock('../components/Common/HealthStatusControl', () => ({
  default: (p: { entityName: string; canEdit: boolean; trigger?: string; onSave: (v: string | null) => Promise<unknown>; onOpenChange?: (o: boolean) => void; className?: string }) => (
    <span data-testid="health-stub" data-can-edit={String(p.canEdit)} data-trigger={p.trigger} className={p.className}>
      {p.canEdit && <button onClick={() => { p.onOpenChange?.(true); void p.onSave('at_risk'); }}>set-health {p.entityName}</button>}
    </span>
  ),
}))
vi.mock('../components/Board/ColumnPolicyPopover', () => ({
  default: (p: { columnName: string; onEdit?: () => void; onDismiss: () => void }) => (
    <div role="dialog" aria-label={`Policy ${p.columnName}`}>
      {p.onEdit && <button onClick={p.onEdit}>edit-policy</button>}<button onClick={p.onDismiss}>dismiss-policy</button>
    </div>
  ),
}))
vi.mock('../components/Board/EditSwimlaneModal', () => ({
  default: (p: { swimlane: { name: string }; onUpdated: (s: unknown) => void; onDeleted: (id: number) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="Edit Swimlane"><span>{p.swimlane.name}</span>
      <button onClick={() => p.onUpdated({ id: 9 })}>save-lane</button><button onClick={() => p.onDeleted(1)}>delete-lane</button><button onClick={p.onClose}>close-lane</button></div>
  ),
}))
vi.mock('../components/Board/EditColumnModal', () => ({
  default: (p: { column: { name: string }; initialTab?: string; onUpdated: (c: unknown) => void; onRequestDelete: (c: unknown) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="Edit Column"><span>{p.column.name}</span><span data-testid="col-tab">{p.initialTab ?? 'settings'}</span>
      <button onClick={() => p.onUpdated({ id: 8 })}>save-col</button><button onClick={() => p.onRequestDelete(p.column)}>delete-col</button><button onClick={p.onClose}>close-col</button></div>
  ),
}))

const col = (id: number, name: string, extra: Partial<Column> = {}) =>
  ({ id, name, position: id, color: '#6B7280', wip_limit: null, weight_limit: null, is_done: false, allow_card_creation: true, policy: null, ...extra }) as unknown as Column
const lane = (id: number, name: string) => ({ id, name, color: '#3B82F6', position: id }) as unknown as Swimlane
const card = (id: number, column: number, swimlane: number, extra: Partial<Card> = {}) =>
  ({ id, title: `Card ${id}`, column, swimlane, position: id, labels: [], custom_field_values: [], weight: 1, priority: 'medium', due_date: null, is_stale: false, last_moved_at: null, column_entered_at: null, created_at: new Date().toISOString(), ...extra }) as unknown as Card

/** #2384: admin controls rest behind "Column actions" / "Lane actions"; open every closed one. */
async function openActions(user: ReturnType<typeof userEvent.setup>) {
  for (const t of screen.queryAllByRole('button', { name: /^(Column|Lane) actions for / })) {
    if (t.getAttribute('aria-expanded') === 'false') await user.click(t)
  }
}

function setup(props: Partial<React.ComponentProps<typeof PhoneBoard>> = {}) {
  const onToggleSwimlane = vi.fn()
  render(
    <PhoneBoard
      columns={[col(1, 'Prospect', { wip_limit: 1 }), col(2, 'Qualified')]}
      swimlanes={[lane(1, 'North'), lane(2, 'APAC')]}
      cards={[card(1, 1, 1), card(2, 1, 2), card(3, 1, 2), card(4, 2, 1)]}
      boardId={1}
      canEdit
      filteredCardIds={null}
      collapsedSwimlaneIds={new Set()}
      onToggleSwimlane={onToggleSwimlane}
      selectedCardIds={new Set()}
      onToggleCardSelection={() => {}}
      onCardClick={() => {}}
      {...props}
    />,
  )
  return { onToggleSwimlane }
}

describe('PhoneBoard (#2277)', () => {
  it('shows one column at a time with counts, and switches', async () => {
    const user = userEvent.setup()
    setup()
    expect(screen.getByRole('tab', { name: /Prospect/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Card 1')).toBeInTheDocument()
    expect(screen.queryByText('Card 4')).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Qualified/ }))
    expect(screen.getByText('Card 4')).toBeInTheDocument()
    expect(screen.queryByText('Card 1')).not.toBeInTheDocument()
  })

  it('shows the selected column limit line and an over-limit warning', () => {
    setup()
    const limit = screen.getByTestId('phone-column-limit')
    expect(within(limit).getByText(/3 of 1 limit \(over\)/)).toBeInTheDocument()
    expect(within(limit).getByRole('meter')).toHaveAttribute('aria-valuenow', '1')
  })

  it('omits the limit line when the column has none', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('tab', { name: /Qualified/ }))
    expect(screen.queryByTestId('phone-column-limit')).not.toBeInTheDocument()
  })

  it('stacks lanes with "N here" and toggles collapse', async () => {
    const user = userEvent.setup()
    const { onToggleSwimlane } = setup()
    expect(screen.getAllByTestId('phone-lane')).toHaveLength(2)
    expect(screen.getByText('2 here')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Collapse lane APAC/ }))
    expect(onToggleSwimlane).toHaveBeenCalledWith(2)
  })

  it('hides cards of a collapsed lane and respects the filter', () => {
    setup({ collapsedSwimlaneIds: new Set([2]), filteredCardIds: new Set([1, 2]) })
    expect(screen.getByText('Card 1')).toBeInTheDocument()
    expect(screen.queryByText('Card 2')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Expand lane APAC/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('reads "No matching cards in <column>." in an empty lane while a filter is active (#2345)', () => {
    setup({ filteredCardIds: new Set() })
    const notes = screen.getAllByTestId('phone-lane-empty')
    expect(notes.length).toBeGreaterThan(0)
    notes.forEach((n) => expect(n.textContent).toMatch(/^No matching cards in .+\.$/))
    expect(screen.queryByText('No cards here')).not.toBeInTheDocument()
  })

  it('keeps "No cards here" for an empty lane with no filter (#2345)', () => {
    setup({ cards: [] })
    expect(screen.getAllByText('No cards here').length).toBeGreaterThan(0)
  })

  it('counts overdue cards in the lane band', () => {
    setup({ cards: [card(1, 1, 1, { due_date: '2000-01-01' })] })
    expect(screen.getByText('1 overdue')).toBeInTheDocument()
  })

  it('says so without columns', () => {
    setup({ columns: [] })
    expect(screen.getByText('No visible columns')).toBeInTheDocument()
  })

  it('moves between column tabs with the arrow keys (roving tabindex)', async () => {
    const user = userEvent.setup()
    setup()
    const first = screen.getByRole('tab', { name: /Prospect/ })
    expect(first).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('tab', { name: /Qualified/ })).toHaveAttribute('tabindex', '-1')
    first.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: /Qualified/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: /Prospect/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: /Qualified/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('says so without swimlanes', () => {
    setup({ swimlanes: [] })
    expect(screen.getByText('No swimlanes')).toBeInTheDocument()
  })
})

describe('PhoneBoard editing controls (#2277)', () => {
  const edit = () => ({
    isAdmin: true,
    onCardAdded: vi.fn(),
    onColumnUpdated: vi.fn(),
    onRequestDeleteColumn: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onSwimlaneDeleted: vi.fn(),
    onAddColumn: vi.fn(),
    onAddSwimlane: vi.fn(),
    onFocusLane: vi.fn(),
    onExitFocus: vi.fn(),
  })

  it('adds a card to the chosen lane and reports it', async () => {
    const user = userEvent.setup()
    const cb = edit()
    vi.mocked(createCard).mockResolvedValue(card(50, 1, 2))
    setup(cb)
    await user.click(screen.getAllByRole('button', { name: /Add card/ })[1])
    await user.type(screen.getByLabelText(/New card title/), 'Hello{Enter}')
    expect(createCard).toHaveBeenCalledWith(1, { column: 1, swimlane: 2, title: 'Hello' })
    expect(cb.onCardAdded).toHaveBeenCalled()
    expect(screen.queryByTestId('phone-add-card')).not.toBeInTheDocument()
  })

  it('shows the failure text and keeps the input open; Cancel and Escape close it', async () => {
    const user = userEvent.setup()
    vi.mocked(createCard).mockRejectedValue(new Error('x'))
    setup(edit())
    await user.click(screen.getAllByRole('button', { name: /Add card/ })[0])
    await user.type(screen.getByLabelText(/New card title/), 'A')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Failed to add card.')).toBeInTheDocument()
    await user.click(screen.getByLabelText(/New card title/))
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('phone-add-card')).not.toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: /Add card/ })[0])
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('phone-add-card')).not.toBeInTheDocument()
  })

  it('ignores an empty title', async () => {
    const user = userEvent.setup()
    vi.mocked(createCard).mockClear()
    setup(edit())
    await user.click(screen.getAllByRole('button', { name: /Add card/ })[0])
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(createCard).not.toHaveBeenCalled()
  })

  it('opens an outside add request: selects the column, expands the lane, opens the input', () => {
    const onToggleSwimlane = vi.fn()
    setup({ ...edit(), onToggleSwimlane, collapsedSwimlaneIds: new Set([2]), addRequest: { columnId: 2, swimlaneId: 2, nonce: 1 } })
    expect(screen.getByRole('tab', { name: /Qualified/ })).toHaveAttribute('aria-selected', 'true')
    expect(onToggleSwimlane).toHaveBeenCalledWith(2)
  })

  it('opens the input for an outside add request on an expanded lane', () => {
    setup({ ...edit(), addRequest: { columnId: 2, swimlaneId: 2, nonce: 1 } })
    expect(screen.getByLabelText(/New card title in Qualified, APAC/)).toBeInTheDocument()
  })

  it('edits and deletes a swimlane through the existing modal', async () => {
    const user = userEvent.setup()
    const cb = edit()
    setup(cb)
    await openActions(user)
    await user.click(screen.getByRole('button', { name: 'Edit swimlane North' }))
    await user.click(screen.getByText('save-lane'))
    expect(cb.onSwimlaneUpdated).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Edit swimlane North' }))
    await user.click(screen.getByText('delete-lane'))
    expect(cb.onSwimlaneDeleted).toHaveBeenCalledWith(1)
    await user.click(screen.getByRole('button', { name: 'Edit swimlane North' }))
    await user.click(screen.getByText('close-lane'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('admins get a Field order button on each lane that calls the handler; non-admins do not (#2353)', async () => {
    const user = userEvent.setup()
    const onEditFieldOrder = vi.fn()
    setup({ ...edit(), onEditFieldOrder })
    await openActions(user)
    await user.click(screen.getAllByTestId('phone-lane-field-order')[0])
    expect(onEditFieldOrder).toHaveBeenCalledTimes(1)
  })

  it('hides Field order for non-admins and without a handler (#2353)', () => {
    setup({ ...edit(), isAdmin: false, onEditFieldOrder: vi.fn() })
    expect(screen.queryByTestId('phone-lane-field-order')).not.toBeInTheDocument()
  })

  it('edits and deletes the selected column', async () => {
    const user = userEvent.setup()
    const cb = edit()
    setup(cb)
    await openActions(user)
    await user.click(screen.getByTestId('phone-column-actions'))
    await user.click(screen.getByText('save-col'))
    expect(cb.onColumnUpdated).toHaveBeenCalled()
    await user.click(screen.getByTestId('phone-column-actions'))
    await user.click(screen.getByText('delete-col'))
    expect(cb.onRequestDeleteColumn).toHaveBeenCalled()
    await user.click(screen.getByText('close-col'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('adds a column or swimlane, and focuses or exits a lane', async () => {
    const user = userEvent.setup()
    const cb = edit()
    const { rerender } = { rerender: null }
    void rerender
    setup(cb)
    await openActions(user)
    await user.click(screen.getByRole('button', { name: '+ Add column' }))
    await user.click(screen.getByRole('button', { name: '+ Add swimlane' }))
    await user.click(screen.getByRole('button', { name: 'Focus on North' }))
    expect(cb.onAddColumn).toHaveBeenCalled()
    expect(cb.onAddSwimlane).toHaveBeenCalled()
    expect(cb.onFocusLane).toHaveBeenCalledWith(1)
  })

  it('shows Exit focus on the focused lane', async () => {
    const user = userEvent.setup()
    const cb = edit()
    setup({ ...cb, focusedSwimlaneId: 1 })
    await openActions(user)
    await user.click(screen.getByRole('button', { name: 'Exit focus' }))
    expect(cb.onExitFocus).toHaveBeenCalled()
  })

  it('withholds every admin control from a non-admin and Add card from a viewer', () => {
    setup({ ...edit(), isAdmin: false })
    expect(screen.queryByTestId('phone-column-actions')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Edit swimlane/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId('phone-add-structure')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Add card/ }).length).toBeGreaterThan(0)
  })

  it('shows no Add card for a viewer or a column that forbids creation', () => {
    setup({ ...edit(), isAdmin: false, canEdit: false })
    expect(screen.queryByRole('button', { name: /Add card/ })).not.toBeInTheDocument()
  })
})

describe('PhoneBoard controls kept from the grid (#2277 fix round)', () => {
  const edit = () => ({
    isAdmin: true,
    onCardAdded: vi.fn(),
    onColumnUpdated: vi.fn(),
    onRequestDeleteColumn: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onSwimlaneDeleted: vi.fn(),
    onAddColumn: vi.fn(),
    onAddSwimlane: vi.fn(),
    onFocusLane: vi.fn(),
    onExitFocus: vi.fn(),
  })

  const policy = { entry: [{ id: 'e1', text: 'Has owner', confirm: false }], done: [] }
  const lanes = [
    lane(1, 'North'),
    { ...lane(2, 'APAC'), health_status: 'on_track', effective_health_status: 'on_track' } as unknown as Swimlane,
  ]

  it('shows a viewer the policy and a set lane health read-only, and nothing for an unset lane', async () => {
    const user = userEvent.setup()
    setup({ columns: [col(1, 'Prospect', { policy } as unknown as Partial<Column>), col(2, 'Qualified')], swimlanes: lanes, canEdit: false })
    const stubs = screen.getAllByTestId('health-stub')
    expect(stubs).toHaveLength(1)
    expect(stubs[0]).toHaveAttribute('data-can-edit', 'false')
    expect(stubs[0].className).toContain('!min-h-11')
    await user.click(screen.getByRole('button', { name: /Column policy for Prospect: 1 entry criterion, 0 done criteria/ }))
    const dialog = screen.getByRole('dialog', { name: 'Policy Prospect' })
    expect(within(dialog).queryByText('edit-policy')).not.toBeInTheDocument()
    await user.click(within(dialog).getByText('dismiss-policy'))
    expect(screen.queryByRole('dialog', { name: 'Policy Prospect' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('phone-column-earlier')).not.toBeInTheDocument()
  })

  it('lets an admin set lane health and open the policy tab from the popover', async () => {
    const user = userEvent.setup()
    const onSwimlaneUpdated = vi.fn()
    vi.mocked(patchSwimlane).mockResolvedValue({ ...lanes[0], health_status: 'at_risk', effective_health_status: 'at_risk' } as unknown as Swimlane)
    setup({ isAdmin: true, onSwimlaneUpdated, onColumnUpdated: vi.fn(), onRequestDeleteColumn: vi.fn(), columns: [col(1, 'Prospect', { policy } as unknown as Partial<Column>)], swimlanes: lanes })
    const stubs = screen.getAllByTestId('health-stub')
    expect(stubs.map((s) => s.getAttribute('data-trigger'))).toEqual(['icon', 'pill'])
    await user.click(screen.getByText('set-health North'))
    expect(patchSwimlane).toHaveBeenCalledWith(1, 1, { health_status: 'at_risk' })
    expect(onSwimlaneUpdated).toHaveBeenCalled()
    await user.click(screen.getByTestId('phone-column-policy'))
    await user.click(screen.getByText('edit-policy'))
    expect(screen.getByTestId('col-tab')).toHaveTextContent('policy')
  })

  it('opens Stage settings straight from the column actions for admins only (#2368)', async () => {
    const user = userEvent.setup()
    setup({ isAdmin: true, onColumnUpdated: vi.fn(), onRequestDeleteColumn: vi.fn(), columns: [col(1, 'Prospect')], swimlanes: lanes })
    await user.click(screen.getByTestId('phone-column-actions-toggle'))
    const btn = screen.getByTestId('phone-column-stage-settings')
    expect(btn).toHaveAccessibleName('Stage settings for Prospect')
    expect(btn.className).toContain('min-h-11')
    await user.click(btn)
    expect(screen.getByTestId('col-tab')).toHaveTextContent('stage')
  })

  it('offers no Stage settings shortcut to non-admins (#2368)', () => {
    setup({ isAdmin: false, columns: [col(1, 'Prospect')], swimlanes: lanes })
    expect(screen.queryByTestId('phone-column-stage-settings')).not.toBeInTheDocument()
  })

  it('shows the weight budget when over it and the hard-limit glyph on an over hard limit', async () => {
    const user = userEvent.setup()
    setup({
      columns: [col(1, 'Prospect', { wip_limit: 1, weight_limit: 2 }), col(2, 'Qualified', { weight_limit: 0 })],
      cards: [card(1, 1, 1, { weight: 2 }), card(2, 1, 2, { weight: 3 }), card(4, 2, 1, { weight: 1 })],
      hardWipEnforced: true,
    })
    const limit = screen.getByTestId('phone-column-limit')
    expect(within(limit).getByText('Weight 5/2')).toBeInTheDocument()
    expect(within(limit).getByTestId('phone-hard-limit')).toBeInTheDocument()
    expect(within(limit).getByText(', hard limit')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Qualified/ }))
    // Weight over budget without a WIP limit still shows the line, without a meter.
    expect(within(screen.getByTestId('phone-column-limit')).getByText('Weight 1/0')).toBeInTheDocument()
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
  })

  it('shows no glyph on a soft limit', () => {
    setup()
    expect(screen.queryByTestId('phone-hard-limit')).not.toBeInTheDocument()
  })

  it('clears an outside add request once handled, so a remount does not reopen the input', () => {
    function Host({ show }: { show: boolean }) {
      const [req, setReq] = useState<{ columnId: number; swimlaneId: number; nonce: number } | null>({ columnId: 2, swimlaneId: 1, nonce: 7 })
      return show ? (
        <PhoneBoard columns={[col(1, 'Prospect'), col(2, 'Qualified')]} swimlanes={[lane(1, 'North')]} cards={[]} boardId={1} canEdit
          filteredCardIds={null} collapsedSwimlaneIds={new Set()} onToggleSwimlane={() => {}} selectedCardIds={new Set()}
          onToggleCardSelection={() => {}} onCardClick={() => {}} addRequest={req} onAddRequestHandled={() => setReq(null)} />
      ) : null
    }
    const { rerender } = render(<Host show />)
    expect(screen.getByTestId('phone-add-card')).toBeInTheDocument()
    rerender(<Host show={false} />)
    rerender(<Host show />)
    expect(screen.queryByTestId('phone-add-card')).not.toBeInTheDocument()
  })

  it('drops the add input and its error when the column changes', async () => {
    const user = userEvent.setup()
    vi.mocked(createCard).mockRejectedValue(new Error('x'))
    setup()
    await user.click(screen.getAllByRole('button', { name: /Add card/ })[0])
    await user.type(screen.getByLabelText(/New card title/), 'A{Enter}')
    expect(await screen.findByText('Failed to add card.')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Qualified/ }))
    expect(screen.queryByText('Failed to add card.')).not.toBeInTheDocument()
    expect(screen.queryByTestId('phone-add-card')).not.toBeInTheDocument()
  })

  it('moves the selected column earlier or later through the reorder path, disabled at the ends', async () => {
    const user = userEvent.setup()
    const onColumnsReordered = vi.fn()
    const all = [col(1, 'Prospect'), col(2, 'Hidden'), col(3, 'Qualified'), col(4, 'Won')]
    setup({ isAdmin: true, onColumnsReordered, allColumns: all, columns: [all[0], all[2], all[3]] })
    await openActions(user)
    expect(screen.getByTestId('phone-column-earlier')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Move column Prospect later' }))
    expect(onColumnsReordered).toHaveBeenLastCalledWith([2, 3, 1, 4])
    expect(screen.getByRole('tab', { name: /Prospect/ })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('tab', { name: /Won/ }))
    // Switching columns closes the menu (it is per column), so reopen it.
    expect(screen.queryByTestId('phone-column-later')).not.toBeInTheDocument()
    await openActions(user)
    expect(screen.getByTestId('phone-column-later')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Move column Won earlier' }))
    expect(onColumnsReordered).toHaveBeenLastCalledWith([1, 2, 4, 3])
  })

  it('moves a lane earlier or later, admins only, disabled at the ends', async () => {
    const user = userEvent.setup()
    const onSwimlanesReordered = vi.fn()
    setup({ isAdmin: true, onSwimlanesReordered, allSwimlanes: [lane(1, 'North'), lane(2, 'APAC'), lane(3, 'Gone')] })
    await openActions(user)
    expect(screen.getByRole('button', { name: 'Move swimlane North earlier' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move swimlane APAC later' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Move swimlane APAC earlier' }))
    expect(onSwimlanesReordered).toHaveBeenCalledWith([2, 1, 3])
  })

  it('keeps admin controls behind Column actions and Lane actions at rest, and the toggles expose state (#2384)', async () => {
    const user = userEvent.setup()
    setup({ ...edit(), onEditFieldOrder: vi.fn(), onColumnsReordered: vi.fn(), onSwimlanesReordered: vi.fn() })
    for (const id of ['phone-column-actions', 'phone-column-earlier', 'phone-lane-field-order', 'phone-lane-earlier']) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: /Edit swimlane/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Focus on / })).not.toBeInTheDocument()
    // Add card stays at rest: it is the editor's main action, not an admin control.
    expect(screen.getAllByRole('button', { name: /Add card/ }).length).toBeGreaterThan(0)
    const colToggle = screen.getByRole('button', { name: 'Column actions for Prospect' })
    expect(colToggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(colToggle)
    expect(colToggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('phone-column-actions')).toBeInTheDocument()
    await user.click(colToggle)
    expect(screen.queryByTestId('phone-column-actions')).not.toBeInTheDocument()
    const laneToggle = screen.getByRole('button', { name: 'Lane actions for North' })
    await user.click(laneToggle)
    expect(laneToggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Edit swimlane North' })).toBeInTheDocument()
    // Only North's menu opened.
    expect(screen.queryByRole('button', { name: 'Edit swimlane APAC' })).not.toBeInTheDocument()
    await user.click(laneToggle)
    expect(screen.queryByRole('button', { name: 'Edit swimlane North' })).not.toBeInTheDocument()
  })

  it('gives a non-admin Lane actions only for Focus, and none when Focus is unavailable (#2384)', async () => {
    const user = userEvent.setup()
    setup({ ...edit(), isAdmin: false, onSwimlanesReordered: vi.fn(), onEditFieldOrder: vi.fn() })
    expect(screen.queryByRole('button', { name: /^Column actions/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Lane actions for North' }))
    expect(screen.getByRole('button', { name: 'Focus on North' })).toBeInTheDocument()
    // The reorder pair and Field order are admin gates, even when the callbacks are wired.
    expect(screen.queryByTestId('phone-lane-earlier')).not.toBeInTheDocument()
    expect(screen.queryByTestId('phone-lane-later')).not.toBeInTheDocument()
    expect(screen.queryByTestId('phone-lane-field-order')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Edit swimlane/ })).not.toBeInTheDocument()
    cleanup()
    setup({ ...edit(), isAdmin: false, onFocusLane: undefined })
    expect(screen.queryByRole('button', { name: /^Lane actions/ })).not.toBeInTheDocument()
  })

  it('offers no reorder to a non-admin', () => {
    setup({ isAdmin: false, onSwimlanesReordered: vi.fn(), onColumnsReordered: vi.fn() })
    expect(screen.queryByTestId('phone-lane-earlier')).not.toBeInTheDocument()
    expect(screen.queryByTestId('phone-column-later')).not.toBeInTheDocument()
  })

  it('stepOrder and cellOrderOf compute the step and the place in the cell', () => {
    expect(stepOrder([1, 2, 3], [1, 3], 9, 1)).toBeNull()
    expect(stepOrder([1, 2, 3], [1, 3], 3, 1)).toBeNull()
    expect(stepOrder([1, 3], [1, 2, 3], 1, 1)).toBeNull()
    const cards = [card(1, 1, 1, { position: 1 }), card(2, 1, 1, { position: 0 }), card(3, 1, 2), card(4, 1, 1, { position: 2, archived_at: 'x' } as Partial<Card>)]
    expect(cellOrderOf(cards, cards[0])).toEqual({ index: 1, count: 2, earlier: 0, later: null })
    expect(cellOrderOf(cards, cards[1])).toEqual({ index: 0, count: 2, earlier: null, later: 2 })
  })

  it('cellOrderOf sends raw slots over the visible cards only (#2277)', () => {
    // A0 B1 H2 C3, H hidden by the filter. Move later on B goes right after C
    // (C's position + 1), Move earlier on C right before B (B's position).
    const cells = [card(1, 1, 1, { position: 0 }), card(2, 1, 1, { position: 1 }), card(5, 1, 1, { position: 2 }), card(3, 1, 1, { position: 3 })]
    const visible = new Set([1, 2, 3])
    expect(cellOrderOf(cells, cells[1], visible)).toEqual({ index: 1, count: 3, earlier: 0, later: 4 })
    expect(cellOrderOf(cells, cells[3], visible)).toEqual({ index: 2, count: 3, earlier: 1, later: null })
    // Without the filter the hidden card is the neighbor.
    expect(cellOrderOf(cells, cells[1])).toEqual({ index: 1, count: 4, earlier: 0, later: 3 })
    // The card itself counts even when the filter hides it.
    expect(cellOrderOf(cells, cells[2], visible)).toEqual({ index: 2, count: 4, earlier: 1, later: 4 })
    // Not in its own cell (a stale copy): nothing to step.
    expect(cellOrderOf([cells[0]], { ...cells[1], archived_at: 'x' } as Card)).toEqual({ index: 0, count: 1, earlier: null, later: null })
  })
})


describe('PhoneBoard lane actions inside the band (#2498)', () => {
  it('puts health, Add card and Lane actions inside the lane band, outside the collapse button', () => {
    setup({ isAdmin: true, onFocusLane: () => {} })
    for (const section of screen.getAllByTestId('phone-lane')) {
      const band = within(section).getByTestId('phone-lane-band')
      const actions = within(section).getByTestId('phone-lane-actions')
      expect(band).toContainElement(actions)
      expect(within(band).getByTestId('phone-lane-footer')).toContainElement(actions)
      expect(within(actions).getByRole('button', { name: /Add card/ })).toBeInTheDocument()
      expect(within(actions).getByTestId('phone-lane-actions-toggle')).toBeInTheDocument()
      expect(within(band).getByRole('button', { name: /^(Collapse|Expand) lane/ })).not.toContainElement(actions)
    }
  })

  it('keeps the open Lane actions menu inside the band', async () => {
    const user = userEvent.setup()
    setup({ isAdmin: true })
    await user.click(screen.getAllByTestId('phone-lane-actions-toggle')[0])
    const section = screen.getAllByTestId('phone-lane')[0]
    expect(within(section).getByTestId('phone-lane-band')).toContainElement(within(section).getByTestId('phone-lane-actions-menu'))
  })

  it('renders no footer when a lane has nothing to act on', () => {
    setup({ canEdit: false })
    expect(screen.getAllByTestId('phone-lane')).toHaveLength(2)
    expect(screen.queryByTestId('phone-lane-footer')).toBeNull()
    expect(screen.queryByTestId('phone-lane-actions')).toBeNull()
  })
})

describe('PhoneBoard lane band second line (#2329)', () => {
  const fdef = (id: number, name: string, field_type = 'text', position = id) =>
    ({ id, uid: `sf${id}`, name, field_type, choices: [], position, show_on_row: false, is_admin_only: false }) as unknown as SwimlaneCustomFieldDefinition
  const defs = [fdef(1, 'Owner'), fdef(2, 'Quota'), fdef(3, 'Region'), fdef(4, 'Site', 'url')]
  const fielded = (id: number, name: string, values: [number, string][], extra: Partial<Swimlane> = {}) =>
    ({ ...lane(id, name), custom_field_values: values.map(([field_definition, value]) => ({ field_definition, value })), ...extra }) as unknown as Swimlane
  const amount = {
    id: 70, uid: 'cf70', name: 'Amount', field_type: 'number', choices: [], position: 0, show_on_card: false, is_required: false,
    help_text: '', number_prefix: '$', number_suffix: 'k', number_decimals: null, choice_colors: {},
  } as unknown as CustomFieldDefinition
  const band = (laneName: string) => within(screen.getByRole('region', { name: laneName })).getByTestId('phone-lane-band')

  it('shows the first two lane fields in Swimlane fields order, outside the collapse button', () => {
    setup({ swimlanes: [fielded(1, 'North', [[2, '600'], [1, 'Avery']])], swimlaneFieldDefinitions: defs })
    const details = within(band('North')).getByTestId('phone-lane-band-details')
    expect(details).toHaveTextContent(/Owner\s*Avery.*Quota\s*600/)
    const toggle = within(band('North')).getByRole('button', { name: /Collapse lane North/ })
    expect(toggle).not.toContainElement(details)
    // One collapse target per band, at 44px.
    expect(within(band('North')).getAllByRole('button', { expanded: true })).toEqual([toggle])
    expect(toggle.className).toContain('min-h-11')
  })

  it('puts the full field list behind a 44px "N fields" toggle that opens a single-column grid', async () => {
    const user = userEvent.setup()
    setup({ swimlanes: [fielded(1, 'North', [[1, 'Avery'], [2, '600'], [3, 'West']])], swimlaneFieldDefinitions: defs })
    const more = screen.getByRole('button', { name: /^4 fields: show all field values for North/ })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(more.className).toContain('min-h-11')
    expect(screen.queryByTestId('swimlane-field-grid')).toBeNull()
    await user.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(more).toHaveFocus()
    const grid = screen.getByTestId('swimlane-field-grid')
    expect(more).toHaveAttribute('aria-controls', grid.id)
    // 18rem tracks: one column at 390px.
    expect(grid.className).toContain('minmax(18rem,1fr)')
    expect(Array.from(grid.querySelectorAll('dt')).map((e) => e.textContent)).toEqual(['Owner', 'Quota', 'Region', 'Site'])
    expect(within(grid).getByText('West')).toBeInTheDocument()
    // The unset URL field is a dash with sr-only "Not set".
    expect(within(grid).getByText('Not set')).toHaveClass('sr-only')
    await user.click(more)
    expect(screen.queryByTestId('swimlane-field-grid')).toBeNull()
  })

  it('excludes an admin-only field from a member\'s toggle count and grid', async () => {
    const user = userEvent.setup()
    const withAdminOnly = [fdef(1, 'Owner'), fdef(2, 'Quota'), fdef(3, 'Region'), { ...fdef(4, 'ARR'), is_admin_only: true } as SwimlaneCustomFieldDefinition]
    setup({ swimlanes: [fielded(1, 'North', [[1, 'Avery']])], swimlaneFieldDefinitions: withAdminOnly, isAdmin: false })
    await user.click(screen.getByRole('button', { name: /^3 fields: show all field values for North/ }))
    const grid = screen.getByTestId('swimlane-field-grid')
    expect(within(grid).queryByText('ARR')).toBeNull()
    expect(grid.querySelectorAll('dt')).toHaveLength(3)
  })

  it('shows the toggle consistently across lanes regardless of how many values are set', () => {
    const lanes = [fielded(1, 'North', []), fielded(2, 'South', [[1, 'a']]), fielded(3, 'East', [[1, 'a'], [2, 'b']])]
    setup({ swimlanes: lanes, swimlaneFieldDefinitions: [fdef(1, 'Owner'), fdef(2, 'Quota')] })
    expect(screen.queryAllByRole('button', { name: /fields: show all/ })).toHaveLength(0)
    cleanup()
    setup({ swimlanes: lanes, swimlaneFieldDefinitions: defs.slice(0, 3) })
    expect(screen.getAllByRole('button', { name: /^3 fields: show all/ })).toHaveLength(3)
  })

  it('keeps a URL field link out of the button and lifts it to 44px', () => {
    setup({ swimlanes: [fielded(1, 'North', [[4, 'https://example.com']])], swimlaneFieldDefinitions: defs })
    const details = screen.getByTestId('phone-lane-band-details')
    expect(within(details).getByRole('link')).toBeInTheDocument()
    expect(details.className).toContain('[&_a]:min-h-11')
  })

  it('hides field names when the board turns them off', () => {
    setup({ swimlanes: [fielded(1, 'North', [[1, 'Avery']])], swimlaneFieldDefinitions: defs, hideRowChipFieldNames: true })
    expect(screen.getByText('Owner:')).toHaveClass('sr-only')
  })

  it('shows the lane WIP line from the grid band code, warning text when over, glyph on a hard lane', () => {
    setup({
      swimlanes: [fielded(1, 'North', [], { wip_limit: 1, limit_enforcement: 'hard' } as Partial<Swimlane>), fielded(2, 'APAC', [], { wip_limit: 5 } as Partial<Swimlane>)],
    })
    const over = within(band('North')).getByTestId('swimlane-limit-stat')
    expect(over).toHaveTextContent('⛔ WIP 2 / 1 over')
    expect(over.className).toContain('text-warning-on-tint')
    const calm = within(band('APAC')).getByTestId('swimlane-limit-stat')
    expect(calm).toHaveTextContent(/^WIP 2 \/ 5$/)
    expect(calm.className).toContain('text-fg')
  })

  it('shows "at limit" only with show_wip_at_limit', () => {
    setup({ swimlanes: [fielded(1, 'North', [], { wip_limit: 2 } as Partial<Swimlane>)], showWipAtLimit: true })
    expect(screen.getByTestId('swimlane-limit-stat')).toHaveTextContent('WIP 2 / 2 · at limit')
  })

  it('folds a calm limit line on a collapsed lane and keeps an over one', () => {
    setup({
      swimlanes: [fielded(1, 'North', [], { wip_limit: 1 } as Partial<Swimlane>), fielded(2, 'APAC', [], { wip_limit: 5 } as Partial<Swimlane>)],
      collapsedSwimlaneIds: new Set([1, 2]),
    })
    expect(within(band('North')).getByTestId('swimlane-limit-stat')).toHaveTextContent('WIP 2 / 1 over')
    expect(within(band('APAC')).queryByTestId('swimlane-limit-stat')).toBeNull()
  })

  it('counts the lane WIP over every column, not just the selected one', () => {
    setup({ swimlanes: [fielded(1, 'North', [], { wip_limit: 9 } as Partial<Swimlane>)] })
    // North holds card 1 (Prospect, shown) and card 4 (Qualified, not shown).
    expect(screen.getByTestId('swimlane-limit-stat')).toHaveTextContent(/^WIP 2 \/ 9$/)
  })

  it('counts the lane WIP over allColumns even when a column is hidden from `columns`', () => {
    setup({
      columns: [col(1, 'Prospect')],
      allColumns: [col(1, 'Prospect'), col(2, 'Qualified')],
      swimlanes: [fielded(1, 'North', [], { wip_limit: 9 } as Partial<Swimlane>)],
    })
    // Card 4 sits in the hidden Qualified column: 2 over allColumns, 1 over `columns`.
    expect(screen.getByTestId('swimlane-limit-stat')).toHaveTextContent(/^WIP 2 \/ 9$/)
  })

  it('offers admins "Change field order" after the open field grid, 44px, and hides it otherwise', async () => {
    const user = userEvent.setup()
    const onEditFieldOrder = vi.fn()
    const props = { swimlanes: [fielded(1, 'North', [[1, 'Avery'], [2, '600'], [3, 'West']])], swimlaneFieldDefinitions: defs, onEditFieldOrder }
    setup({ ...props, isAdmin: true })
    expect(screen.queryByRole('button', { name: 'Change field order' })).toBeNull()
    await user.click(screen.getByRole('button', { name: /^4 fields:/ }))
    const link = screen.getByRole('button', { name: 'Change field order' })
    expect(link.className).toContain('min-h-11')
    await user.click(link)
    expect(onEditFieldOrder).toHaveBeenCalledTimes(1)
    cleanup()
    setup({ ...props, isAdmin: false })
    await user.click(screen.getByRole('button', { name: /^4 fields:/ }))
    expect(screen.queryByRole('button', { name: 'Change field order' })).toBeNull()
  })

  it('shows the number rollup over the lane\'s open cards, and orders stats as the grid band', () => {
    const v = (value: string) => ({ custom_field_values: [{ field_definition: 70, value }] }) as Partial<Card>
    setup({
      columns: [col(1, 'Prospect'), col(2, 'Won', { is_done: true })],
      swimlanes: [fielded(1, 'North', [[1, 'Avery']], { wip_limit: 9 } as Partial<Swimlane>)],
      cards: [card(1, 1, 1, { ...v('33'), due_date: '2000-01-01' }), card(2, 1, 1, v('380')), card(3, 2, 1, v('500'))],
      swimlaneFieldDefinitions: defs,
      rollupField: amount,
    })
    const rollup = screen.getByTestId('phone-lane-rollup')
    expect(rollup).toHaveTextContent(/^Amount: \$413k open$/)
    const text = screen.getByTestId('phone-lane-band-details').textContent ?? ''
    const at = (s: string) => text.indexOf(s)
    expect(at('Avery')).toBeLessThan(at('1 overdue'))
    expect(at('1 overdue')).toBeLessThan(at('WIP'))
    expect(at('WIP')).toBeLessThan(at('$413k open'))
  })

  it('has no second line when the lane has nothing to show', () => {
    setup({ swimlanes: [lane(1, 'North')] })
    expect(screen.queryByTestId('phone-lane-band-details')).toBeNull()
  })
})

describe('PhoneBoard sub-column switcher (#2278)', () => {
  const subs = [{ id: 31, uid: 's31', position: 0, name: 'Doing' }, { id: 32, uid: 's32', position: 1, name: 'Ready' }]
  const cards = [card(1, 1, 1, { gates_passed: 0 }), card(2, 1, 1, { gates_passed: 1 }), card(3, 1, 2, { gates_passed: 1 })]

  it('uses aria-pressed buttons in a group, names counts and announces the switch (B2)', async () => {
    const user = userEvent.setup()
    setup({ columns: [col(1, 'Build', { sub_columns: subs })], cards })
    const group = screen.getByRole('group', { name: 'Build sub-columns' })
    expect(within(group).queryByRole('radio')).not.toBeInTheDocument()
    const doing = within(group).getByRole('button', { name: 'Doing, 1 card' })
    const ready = within(group).getByRole('button', { name: 'Ready, 2 cards' })
    expect(doing).toHaveAttribute('aria-pressed', 'true')
    expect(doing).toHaveClass('bg-primary-emphasis/20', 'text-info')
    expect(doing.className).not.toContain('bg-info/10')
    expect(within(doing).getByTestId('active-mark')).toBeInTheDocument()
    await user.click(ready)
    expect(ready).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('phone-sub-column-status')).toHaveTextContent('Showing Ready, 2 cards')
    expect(screen.getByText('Card 2')).toBeInTheDocument()
    expect(screen.queryByText('Card 1')).not.toBeInTheDocument()
  })
})

describe('cellOrderOf on a gated stage (#2278 G9)', () => {
  it('steps only within the card\'s own sub-column', () => {
    const column = col(1, 'Build', { sub_columns: [{ id: 31, uid: 's31', position: 0, name: 'Doing' }, { id: 32, uid: 's32', position: 1, name: 'Ready' }] })
    const a = card(1, 1, 1, { position: 0, gates_passed: 0 })
    const b = card(2, 1, 1, { position: 1, gates_passed: 1 })
    const c = card(3, 1, 1, { position: 2, gates_passed: 0 })
    expect(cellOrderOf([a, b, c], c, null, column)).toEqual({ index: 1, count: 2, earlier: 0, later: null })
    expect(cellOrderOf([a, b, c], c, null)).toEqual({ index: 2, count: 3, earlier: 1, later: null })
  })
})

describe('PhoneBoard track chips (#2278)', () => {
  it('passes trackStates to cards: a gated column with a dimension field renders spelled-out chips', () => {
    const dim = {
      id: 41, uid: 'f41', name: 'Technical', field_type: 'single_select', choices: ['Pass'], position: 0, is_dimension: true,
      choice_resolutions: { Pass: 'satisfied' },
    } as unknown as CustomFieldDefinition
    const column = col(1, 'Build', { tracks: [{ id: 1, field_id: 41, field_uid: 'f41', name: 'Technical', position: 0 }] } as Partial<Column>)
    setup({
      columns: [column],
      cards: [card(1, 1, 1, { custom_field_values: [{ field_definition: 41, value: 'Pass' }] as never })],
      customFieldDefinitions: [dim],
    })
    expect(screen.getAllByText('Technical: done').length).toBeGreaterThan(0)
  })
})

describe('PhoneBoard lane band tiers (#2439)', () => {
  const tdef = (id: number, name: string, band_visibility: 'band' | 'details' | 'hidden', extra: Partial<SwimlaneCustomFieldDefinition> = {}) =>
    ({ id, uid: `sf${id}`, name, field_type: 'text', choices: [], position: id, show_on_row: false, is_admin_only: false, band_visibility, ...extra }) as unknown as SwimlaneCustomFieldDefinition
  const defs = [
    tdef(1, 'Owner', 'band'), tdef(2, 'Region', 'details'), tdef(3, 'Site', 'hidden'),
    tdef(4, 'Secret code', 'hidden', { is_admin_only: true }),
  ]
  const tiered = { ...lane(1, 'North'), custom_field_values: [[1, 'Avery'], [2, 'West'], [3, 'example.test'], [4, 'S3CRET']].map(([field_definition, value]) => ({ field_definition, value })) } as unknown as Swimlane
  const toggleName = /^Show \d+ more fields for North/

  it('shows only the Band fields, then "Show N more" opens Details and the Hidden on band group', async () => {
    const user = userEvent.setup()
    setup({ swimlanes: [tiered], swimlaneFieldDefinitions: defs, isAdmin: false })
    const band = screen.getByTestId('phone-lane-band-details')
    expect(band).toHaveTextContent(/Owner\s*Avery/)
    expect(band).not.toHaveTextContent('West')
    // A member counts Region (details) and Site (hidden); the admin-only field is out of the count.
    const more = screen.getByRole('button', { name: /^Show 2 more fields for North/ })
    expect(more).toHaveTextContent('Show 2 more')
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('swimlane-lane-details')).toBeNull()
    await user.click(more)
    const open = screen.getByTestId('swimlane-lane-details')
    expect(within(open).getByText('Region')).toBeInTheDocument()
    expect(within(open).getByText('West')).toBeInTheDocument()
    const hidden = within(open).getByTestId('swimlane-hidden-group')
    expect(within(hidden).getByRole('heading', { name: 'Hidden on band' })).toBeInTheDocument()
    expect(within(hidden).getByText('Site')).toBeInTheDocument()
    expect(open).toHaveTextContent('1 in details · 1 hidden on band')
    await user.click(screen.getByRole('button', { name: /^Hide details for North/ }))
    expect(screen.queryByTestId('swimlane-lane-details')).toBeNull()
  })

  it('never shows an admin-only field to a non-admin, and shows it to an admin', async () => {
    const user = userEvent.setup()
    setup({ swimlanes: [tiered], swimlaneFieldDefinitions: defs, isAdmin: false })
    await user.click(screen.getByRole('button', { name: toggleName }))
    expect(screen.queryByText('Secret code')).toBeNull()
    expect(screen.queryByText('S3CRET')).toBeNull()
    cleanup()
    setup({ swimlanes: [tiered], swimlaneFieldDefinitions: defs, isAdmin: true })
    await user.click(screen.getByRole('button', { name: /^Show 3 more fields for North/ }))
    expect(within(screen.getByTestId('swimlane-hidden-group')).getByText('Secret code')).toBeInTheDocument()
  })

  it('with isAdmin absent, treats the viewer as a non-admin: no admin-only field is shown, counted or listed (#1075)', async () => {
    const user = userEvent.setup()
    setup({ swimlanes: [tiered], swimlaneFieldDefinitions: defs })
    // Region (details) and Site (hidden) count; the admin-only Secret code does not.
    const more = screen.getByRole('button', { name: /^Show 2 more fields for North/ })
    expect(more).toHaveTextContent('Show 2 more')
    await user.click(more)
    const open = screen.getByTestId('swimlane-lane-details')
    expect(open).toHaveTextContent('1 in details · 1 hidden on band')
    const hidden = within(open).getByTestId('swimlane-hidden-group')
    expect(within(hidden).getByText('Site')).toBeInTheDocument()
    expect(screen.queryByText('Secret code')).toBeNull()
    expect(screen.queryByText('S3CRET')).toBeNull()
    expect(screen.queryByRole('button', { name: /Manage swimlane fields/ })).toBeNull()
  })

  it('offers "Manage swimlane fields" to an admin even with one field; never to a non-admin', async () => {
    const user = userEvent.setup()
    const one = [tdef(3, 'Site', 'hidden')]
    const oneLane = { ...lane(1, 'North'), custom_field_values: [{ field_definition: 3, value: 'x' }] } as unknown as Swimlane
    const onManageSwimlaneFields = vi.fn()
    setup({ swimlanes: [oneLane], swimlaneFieldDefinitions: one, isAdmin: true, onManageSwimlaneFields })
    await user.click(screen.getByRole('button', { name: toggleName }))
    await user.click(screen.getByRole('button', { name: 'Manage swimlane fields' }))
    expect(onManageSwimlaneFields).toHaveBeenCalledTimes(1)
    cleanup()
    setup({ swimlanes: [oneLane], swimlaneFieldDefinitions: one, isAdmin: false, onManageSwimlaneFields })
    await user.click(screen.getByRole('button', { name: toggleName }))
    expect(screen.queryByRole('button', { name: 'Manage swimlane fields' })).toBeNull()
  })
})
