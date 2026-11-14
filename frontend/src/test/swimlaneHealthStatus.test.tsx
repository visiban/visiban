import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SwimlaneRow from '../components/Board/SwimlaneRow'
import type { Card, Column, Swimlane } from '../types'

vi.mock('../api/boards', () => ({ updateSwimlane: vi.fn(), patchSwimlane: vi.fn() }))
import { patchSwimlane } from '../api/boards'
import { mergeSwimlaneFromBroadcast } from '../utils/swimlaneMerge'
import { InstanceFlagsContext } from '../contexts/InstanceFlagsContext'
vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useDndContext: () => ({ active: null }),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: {},
  useSortable: () => ({ setNodeRef: () => {}, attributes: {}, listeners: {}, transform: null, transition: undefined, isDragging: false }),
}))

vi.mock('../components/Board/BoardCell', () => ({
  default: ({ column, swimlane, overlayCell, overlayLabel, currentCardId }: { column: Column; swimlane: Swimlane; overlayCell?: { value: number } | null; overlayLabel?: string; currentCardId?: number | null }) => (
    <div
      data-testid={`cell-${column.id}-${swimlane.id}`}
      data-current-card-id={String(currentCardId ?? '')}
      data-overlay-value={overlayCell ? String(overlayCell.value) : ''}
      data-overlay-label={overlayLabel ?? ''}
    >
      Cell
    </div>
  ),
}))

vi.mock('../components/Board/EditSwimlaneModal', () => ({
  default: ({ userDateFormat }: { userDateFormat?: string }) => <div data-testid="edit-swimlane-modal" data-date-format={userDateFormat}>Edit Swimlane</div>,
}))

vi.mock('../api/cards', () => ({ createCard: vi.fn() }))

const columns: Column[] = [
  { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
  { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
]

const swimlane: Swimlane = {
  id: 20, uid: 'laneuid00001', name: 'Customer A', contact_email: 'a@test.com', notes: '', position: 0,
  color: '#6B7280', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null, health_status: null,
}

// collapsed/onToggleCollapse/onFocus/isFocused are now controlled props (Step 2 of #340).
const defaultProps = () => ({
  swimlane,
  columns,
  cards: [] as Card[],
  boardId: 1,
  isAdmin: true,
  canEdit: true,
  closeEditorOnEnter: false,
  collapsedColumnIds: new Set<number>(),
  filteredCardIds: null as Set<number> | null,
  selectedCardIds: new Set<number>(),
  onToggleCardSelection: vi.fn(),
  onCardClick: vi.fn(),
  onCardAdded: vi.fn(),
  onSwimlaneUpdated: vi.fn(),
  onSwimlaneDeleted: vi.fn(),
  collapsed: false,
  onToggleCollapse: vi.fn(),
  onFocus: vi.fn(),
  onExitFocus: vi.fn(),
  isFocused: false,
})


// Lane health status (#2243): the manual pin on a swimlane, admin-edited,
// never inherited from or rolled up to the board.
const patchMock = vi.mocked(patchSwimlane)
const lane = (health_status: Swimlane['health_status']): Swimlane => ({ ...swimlane, health_status })

afterEach(() => { patchMock.mockReset() })

describe('SwimlaneRow lane health status (#2243)', () => {
  it('admin on an unset lane gets the icon trigger, not a pill', () => {
    render(<SwimlaneRow {...defaultProps()} />)
    const icon = screen.getByRole('button', { name: 'Set health status for lane Customer A' })
    expect(icon).toHaveAttribute('aria-haspopup', 'dialog')
    expect(icon).toHaveAttribute('aria-expanded', 'false')
    expect(icon.className).toContain('opacity-0')
    expect(icon.className).toContain('focus:opacity-100')
    expect(document.querySelector('[data-health-status]')).toBeNull()
  })

  it('the popover offers three values and No status, no Inherit, and says the lane is separate', async () => {
    const user = userEvent.setup()
    render(<SwimlaneRow {...defaultProps()} />)
    await user.click(screen.getByRole('button', { name: 'Set health status for lane Customer A' }))
    const dialog = await screen.findByRole('dialog', { name: 'Health status for lane Customer A' })
    const radios = within(dialog).getAllByRole('radio')
    expect(radios.map((r) => r.closest('label')?.querySelector('.font-medium')?.textContent)).toEqual(
      ['On track', 'At risk', 'Off track', 'No status'],
    )
    expect(within(dialog).queryByText(/Inherit/)).toBeNull()
    expect(within(dialog).getByText('No status set.', { selector: 'p' })).toBeInTheDocument()
    expect(within(dialog).getByText("This lane's status is separate from the board's status.")).toBeInTheDocument()
  })

  it('admin sets a status: PATCHes only health_status, merges, announces and focuses the new pill', async () => {
    const user = userEvent.setup()
    const updated = lane('at_risk')
    patchMock.mockResolvedValue(updated)
    const props = defaultProps()
    const { rerender } = render(<SwimlaneRow {...props} />)
    await user.click(screen.getByRole('button', { name: 'Set health status for lane Customer A' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('radio', { name: /At risk/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(props.onSwimlaneUpdated).toHaveBeenCalledWith(updated))
    expect(patchMock).toHaveBeenCalledWith(1, 20, { health_status: 'at_risk' })
    expect(screen.getByText('Lane Customer A health status set to At risk.')).toBeInTheDocument()
    rerender(<SwimlaneRow {...props} swimlane={updated} />)
    const pill = screen.getByRole('button', { name: 'Health status for lane Customer A: At risk' })
    expect(pill).toHaveFocus()
    expect(pill.className).not.toContain('border-dashed')
    expect(pill.className).toContain('px-1.5')
    expect(pill).toHaveAttribute('title', "Lane health status: At risk. Separate from the board's status. Click to change.")
    expect(screen.queryByRole('button', { name: 'Set health status for lane Customer A' })).toBeNull()
  })

  it('admin clears a status: PATCHes null, announces, and focus moves to the icon', async () => {
    const user = userEvent.setup()
    const cleared = lane(null)
    patchMock.mockResolvedValue(cleared)
    const props = { ...defaultProps(), swimlane: lane('off_track') }
    const { rerender } = render(<SwimlaneRow {...props} />)
    await user.click(screen.getByRole('button', { name: 'Health status for lane Customer A: Off track' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Set on this lane.', { selector: 'p' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: /No status/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(props.onSwimlaneUpdated).toHaveBeenCalledWith(cleared))
    expect(patchMock).toHaveBeenCalledWith(1, 20, { health_status: null })
    expect(screen.getByText('Lane Customer A health status cleared.')).toBeInTheDocument()
    rerender(<SwimlaneRow {...props} swimlane={cleared} />)
    expect(screen.getByRole('button', { name: 'Set health status for lane Customer A' })).toHaveFocus()
  })

  it('keeps the popover open with the 403 message and the draft on a failed save', async () => {
    const user = userEvent.setup()
    patchMock.mockRejectedValue({ response: { status: 403 } })
    render(<SwimlaneRow {...defaultProps()} />)
    await user.click(screen.getByRole('button', { name: 'Set health status for lane Customer A' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('radio', { name: /On track/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByText('Only admins can change health status.')).toBeInTheDocument()
    expect(within(dialog).getByRole('radio', { name: /On track/ })).toBeChecked()
  })

  it('shows the generic error for any other failure', async () => {
    const user = userEvent.setup()
    patchMock.mockRejectedValue(new Error('network'))
    render(<SwimlaneRow {...defaultProps()} />)
    await user.click(screen.getByRole('button', { name: 'Set health status for lane Customer A' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('radio', { name: /Off track/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByText('Could not save health status. Try again.')).toBeInTheDocument()
  })

  it('is not optimistic: shows Saving… and stays open until the server answers', async () => {
    const user = userEvent.setup()
    let resolve: (s: Swimlane) => void = () => {}
    patchMock.mockReturnValue(new Promise<Swimlane>((r) => { resolve = r }))
    const props = defaultProps()
    render(<SwimlaneRow {...props} />)
    await user.click(screen.getByRole('button', { name: 'Set health status for lane Customer A' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('radio', { name: /At risk/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-disabled', 'true')
    expect(props.onSwimlaneUpdated).not.toHaveBeenCalled()
    await act(async () => { resolve(lane('at_risk')) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('a member sees a set status as plain text and nothing on an unset lane', () => {
    const { rerender } = render(<SwimlaneRow {...defaultProps()} isAdmin={false} swimlane={lane('at_risk')} />)
    const pill = document.querySelector('[data-health-status="at_risk"]') as HTMLElement
    expect(pill.tagName).toBe('SPAN')
    expect(pill).toHaveTextContent('Health status for lane Customer A: At risk')
    expect(pill).toHaveAttribute('title', "Lane health status: At risk. Separate from the board's status.")
    expect(screen.queryByRole('button', { name: /health status/i })).toBeNull()
    rerender(<SwimlaneRow {...defaultProps()} isAdmin={false} swimlane={lane(null)} />)
    expect(document.querySelector('[data-health-status]')).toBeNull()
    expect(screen.queryByRole('button', { name: /health status/i })).toBeNull()
  })

  it('a viewer on an unset lane sees no pill and no control at all', () => {
    render(<SwimlaneRow {...defaultProps()} isAdmin={false} canEdit={false} />)
    expect(document.querySelector('[data-health-status]')).toBeNull()
    expect(screen.queryByText(/No status/)).toBeNull()
    expect(screen.queryByRole('button', { name: /health status/i })).toBeNull()
  })

  it('collapsed: a set status is a shape-only inline pill; an unset lane shows nothing even to admins', () => {
    const { rerender } = render(<SwimlaneRow {...defaultProps()} collapsed swimlane={lane('on_track')} />)
    const pill = screen.getByRole('button', { name: 'Health status for lane Customer A: On track' })
    expect(within(pill).getByText('On track').className).toContain('sr-only')
    rerender(<SwimlaneRow {...defaultProps()} collapsed swimlane={lane(null)} />)
    expect(screen.queryByRole('button', { name: /health status/i })).toBeNull()
  })

  it("double-clicking the pill or the icon never opens the panel's edit modal", () => {
    const { rerender } = render(<SwimlaneRow {...defaultProps()} swimlane={lane('at_risk')} />)
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Health status for lane Customer A: At risk' }))
    expect(screen.queryByTestId('edit-swimlane-modal')).toBeNull()
    rerender(<SwimlaneRow {...defaultProps()} swimlane={lane(null)} />)
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Set health status for lane Customer A' }))
    expect(screen.queryByTestId('edit-swimlane-modal')).toBeNull()
  })

  it('double-clicking the collapsed pill never opens the edit modal', () => {
    render(<SwimlaneRow {...defaultProps()} collapsed swimlane={lane('at_risk')} />)
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Health status for lane Customer A: At risk' }))
    expect(screen.queryByTestId('edit-swimlane-modal')).toBeNull()
  })

  it('a remote swimlane.updated merge changes the pill without an announcement', () => {
    const merged = mergeSwimlaneFromBroadcast([lane(null)], lane('off_track'), [])
    expect(merged.health_status).toBe('off_track')
    const { rerender } = render(<SwimlaneRow {...defaultProps()} swimlane={lane(null)} />)
    rerender(<SwimlaneRow {...defaultProps()} swimlane={merged} />)
    expect(screen.getByRole('button', { name: 'Health status for lane Customer A: Off track' })).not.toHaveFocus()
    expect(screen.queryByText(/health status set to/)).toBeNull()
  })

  it('clearing on a collapsed lane hands focus to the name and leaves no pending icon focus', async () => {
    const user = userEvent.setup()
    const cleared = lane(null)
    patchMock.mockResolvedValue(cleared)
    const props = { ...defaultProps(), collapsed: true, swimlane: lane('at_risk') }
    const { rerender } = render(<SwimlaneRow {...props} />)
    await user.click(screen.getByRole('button', { name: 'Health status for lane Customer A: At risk' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('radio', { name: /No status/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(props.onSwimlaneUpdated).toHaveBeenCalledWith(cleared))
    rerender(<SwimlaneRow {...props} swimlane={cleared} />)
    expect(screen.getByRole('button', { name: 'Customer A' })).toHaveFocus()
    // Expanding later must not steal focus to the icon.
    rerender(<SwimlaneRow {...props} swimlane={cleared} collapsed={false} />)
    expect(screen.getByRole('button', { name: 'Set health status for lane Customer A' })).not.toHaveFocus()
  })

  it('changing one set status to another keeps focus on the pill and leaves no pending focus request', async () => {
    const user = userEvent.setup()
    const next = lane('off_track')
    patchMock.mockResolvedValue(next)
    const props = { ...defaultProps(), swimlane: lane('at_risk') }
    const { rerender } = render(<SwimlaneRow {...props} />)
    await user.click(screen.getByRole('button', { name: 'Health status for lane Customer A: At risk' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('radio', { name: /Off track/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(props.onSwimlaneUpdated).toHaveBeenCalledWith(next))
    rerender(<SwimlaneRow {...props} swimlane={next} />)
    const pill = screen.getByRole('button', { name: 'Health status for lane Customer A: Off track' })
    await waitFor(() => expect(pill).toHaveFocus())
    // No trigger swap: the icon never appears for a set lane.
    expect(screen.queryByRole('button', { name: 'Set health status for lane Customer A' })).toBeNull()
    // A stray request would steal focus to the icon once the lane is cleared remotely.
    rerender(<SwimlaneRow {...props} swimlane={lane(null)} />)
    expect(screen.getByRole('button', { name: 'Set health status for lane Customer A' })).not.toHaveFocus()
  })

  it('a remote clear while the pill popover is open keeps the popover and its draft', async () => {
    const user = userEvent.setup()
    const props = { ...defaultProps(), swimlane: lane('at_risk') }
    const { rerender } = render(<SwimlaneRow {...props} />)
    await user.click(screen.getByRole('button', { name: 'Health status for lane Customer A: At risk' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('radio', { name: /Off track/ }))
    rerender(<SwimlaneRow {...props} swimlane={lane(null)} />)
    const still = screen.getByRole('dialog', { name: 'Health status for lane Customer A' })
    expect(within(still).getByRole('radio', { name: /Off track/ })).toBeChecked()
    expect(within(still).getByText('No status set.', { selector: 'p' })).toBeInTheDocument()
    await user.click(within(still).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Set health status for lane Customer A' })).toBeInTheDocument()
  })

  it('demo mode: the icon is focusable, aria-disabled, has a 24px target and never opens', async () => {
    const user = userEvent.setup()
    render(
      <InstanceFlagsContext.Provider value={{ demo_mode: true } as React.ContextType<typeof InstanceFlagsContext>}>
        <SwimlaneRow {...defaultProps()} />
      </InstanceFlagsContext.Provider>,
    )
    const icon = screen.getByRole('button', { name: 'Set health status for lane Customer A' })
    expect(icon).toHaveAttribute('aria-disabled', 'true')
    expect(icon).not.toHaveAttribute('aria-haspopup')
    expect(icon.className).toContain('min-w-6')
    expect(icon.className).toContain('min-h-6')
    await user.click(icon)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
