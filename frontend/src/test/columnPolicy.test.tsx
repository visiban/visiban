import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ColumnHeader from '../components/Board/ColumnHeader'
import EditColumnModal from '../components/Board/EditColumnModal'
import PolicyConfirmModal from '../components/Board/PolicyConfirmModal'
import type { Column, ColumnPolicy } from '../types'
import {
  columnPolicy, entryCriteriaFor, entryCriteriaSentence, needsEntryConfirm, policyCountSummary, policyFromDraft,
} from '../utils/columnPolicy'

// Explicit column policies (#1101): the header affordance, the popover, the
// editor tab and the confirm-on-entry checklist.

vi.mock('../api/boards', () => ({ updateColumn: vi.fn() }))
import { updateColumn } from '../api/boards'
const mockUpdateColumn = vi.mocked(updateColumn)

const POLICY: ColumnPolicy = { v: 1, entry: ['Has an owner', 'Tests pass', 'Spec linked'], done: ['Reviewed', 'Docs updated'], mode: 'confirm' }

function makeColumn(overrides: Partial<Column> = {}): Column {
  return {
    id: 10, uid: 'coluid000001', name: 'Review', position: 1, color: '#3B82F6',
    wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false,
    policy: null,
    ...overrides,
  }
}

function renderHeader(over: Partial<React.ComponentProps<typeof ColumnHeader>> = {}) {
  const props = {
    column: makeColumn({ policy: POLICY }), cards: [], boardId: 1, isAdmin: true,
    onColumnUpdated: vi.fn(), onRequestDelete: vi.fn(),
    collapsed: false, onToggleCollapse: vi.fn(),
    ...over,
  }
  render(<ColumnHeader {...props} />)
  return props
}

beforeEach(() => { vi.clearAllMocks() })

describe('column policy helpers', () => {
  it('treats an empty policy as none', () => {
    expect(columnPolicy(makeColumn())).toBeNull()
    expect(columnPolicy(makeColumn({ policy: { v: 1, entry: [], done: [], mode: 'advisory' } }))).toBeNull()
    expect(columnPolicy(makeColumn({ policy: POLICY }))).toBe(POLICY)
  })

  it('counts criteria with singular and plural nouns', () => {
    expect(policyCountSummary(POLICY)).toBe('3 entry criteria, 2 done criteria')
    expect(policyCountSummary({ ...POLICY, entry: ['a'], done: ['b'] })).toBe('1 entry criterion, 1 done criterion')
  })

  it('applies entry criteria only to a card entering from another column', () => {
    const col = makeColumn({ policy: POLICY })
    expect(entryCriteriaFor({ column: 9 }, col)).toEqual(POLICY.entry)
    expect(entryCriteriaFor({ column: 10 }, col)).toEqual([])
    expect(needsEntryConfirm({ column: 9 }, col)).toBe(true)
    expect(needsEntryConfirm({ column: 9 }, makeColumn({ policy: { ...POLICY, mode: 'advisory' } }))).toBe(false)
    expect(needsEntryConfirm({ column: 9 }, makeColumn({ policy: { ...POLICY, entry: [] } }))).toBe(false)
    expect(entryCriteriaSentence('Review', ['a', 'b'])).toBe("Entry criteria for 'Review': a; b.")
  })

  it('builds the saved value from drafts', () => {
    expect(policyFromDraft(['  a ', ''], [' '], 'confirm')).toEqual({ v: 1, entry: ['a'], done: [], mode: 'confirm' })
    expect(policyFromDraft(['', '  '], [], 'confirm')).toBeNull()
  })
})

describe('ColumnHeader Policy button (#1101)', () => {
  it('is visible at rest with the counts in its accessible name', () => {
    renderHeader({ isAdmin: false })
    const btn = screen.getByRole('button', { name: 'Column policy for Review: 3 entry criteria, 2 done criteria' })
    expect(btn).toHaveAttribute('aria-haspopup', 'dialog')
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    // The word hides below lg; the icon and the accessible name stay.
    expect(within(btn).getByText('Policy').className).toContain('hidden lg:inline')
  })

  it('is absent when the column has no policy', () => {
    renderHeader({ column: makeColumn() })
    expect(screen.queryByRole('button', { name: /Column policy for/ })).not.toBeInTheDocument()
  })

  it('opens the popover with both lists and the mode, and Escape closes it back to the button', async () => {
    const user = userEvent.setup()
    renderHeader({ isAdmin: false })
    const btn = screen.getByRole('button', { name: /Column policy for Review/ })
    await user.click(btn)
    const dialog = screen.getByRole('dialog', { name: 'Column policy for Review' })
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    expect(btn.className).toContain('text-info bg-info/10')
    expect(within(dialog).getByText('Confirm on entry')).toBeInTheDocument()
    expect(within(dialog).getByText('Has an owner')).toBeInTheDocument()
    expect(within(dialog).getByText('Docs updated')).toBeInTheDocument()
    // Non-admins get no edit control at all.
    expect(within(dialog).queryByRole('button', { name: 'Edit policy' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(btn).toHaveFocus()
  })

  it('shows "No criteria yet." for an empty list and the advisory tag', async () => {
    const user = userEvent.setup()
    renderHeader({ column: makeColumn({ policy: { v: 1, entry: [], done: ['Shipped'], mode: 'advisory' } }) })
    await user.click(screen.getByRole('button', { name: 'Column policy for Review: 0 entry criteria, 1 done criterion' }))
    const dialog = screen.getByRole('dialog', { name: 'Column policy for Review' })
    expect(within(dialog).getByText('No criteria yet.')).toBeInTheDocument()
    expect(within(dialog).getByText('Advisory')).toBeInTheDocument()
  })

  it('a second click and an outside click both close it', async () => {
    const user = userEvent.setup()
    renderHeader()
    const btn = screen.getByRole('button', { name: /Column policy for Review/ })
    await user.click(btn)
    await user.click(btn)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(btn)
    await user.click(document.body)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes when keyboard focus leaves the popover and its button', async () => {
    const user = userEvent.setup()
    render(
      <>
        <ColumnHeader column={makeColumn({ policy: POLICY })} cards={[]} boardId={1} isAdmin={false}
          onColumnUpdated={vi.fn()} onRequestDelete={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} />
        <button type="button">Elsewhere</button>
      </>,
    )
    await user.click(screen.getByRole('button', { name: /Column policy for Review/ }))
    expect(screen.getByRole('dialog', { name: 'Column policy for Review' })).toBeInTheDocument()
    screen.getByRole('button', { name: 'Elsewhere' }).focus()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('Edit policy opens the editor on the Policy tab, and closing returns focus to the Policy button', async () => {
    const user = userEvent.setup()
    renderHeader()
    const btn = screen.getByRole('button', { name: /Column policy for Review/ })
    await user.click(btn)
    await user.click(screen.getByRole('button', { name: 'Edit policy' }))
    const modal = await screen.findByRole('dialog', { name: 'Edit Column' })
    expect(within(modal).getByRole('tab', { name: 'Policy' })).toHaveAttribute('aria-selected', 'true')
    expect(within(modal).getByRole('textbox', { name: 'Entry criterion 1' })).toHaveValue('Has an owner')
    await user.click(within(modal).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(btn).toHaveFocus())
  })
})

describe('ColumnHeader kebab "Add policy…" (#1101)', () => {
  it('is offered to an admin on a column with no policy and opens the Policy tab', async () => {
    const user = userEvent.setup()
    renderHeader({ column: makeColumn() })
    await user.click(screen.getByRole('button', { name: 'Actions for column "Review"' }))
    await user.click(screen.getByRole('menuitem', { name: 'Add policy…' }))
    const modal = await screen.findByRole('dialog', { name: 'Edit Column' })
    expect(within(modal).getByRole('tab', { name: 'Policy' })).toHaveAttribute('aria-selected', 'true')
    expect(within(modal).getAllByText('No criteria yet.')).toHaveLength(2)
    await waitFor(() => expect(within(modal).getByRole('tab', { name: 'Policy' })).toHaveFocus())
  })

  it('is not offered when the column already has a policy', async () => {
    const user = userEvent.setup()
    renderHeader()
    await user.click(screen.getByRole('button', { name: 'Actions for column "Review"' }))
    expect(screen.queryByRole('menuitem', { name: 'Add policy…' })).not.toBeInTheDocument()
  })
})

describe('EditColumnModal Policy tab (#1101)', () => {
  const renderModal = (column: Column, initialTab?: 'settings' | 'policy') => {
    const props = { boardId: 1, column, cardCount: 0, onUpdated: vi.fn(), onRequestDelete: vi.fn(), onClose: vi.fn(), initialTab }
    render(<EditColumnModal {...props} />)
    return props
  }

  it('opens on Settings by default and switches tabs with the arrow keys', async () => {
    const user = userEvent.setup()
    renderModal(makeColumn())
    const settings = screen.getByRole('tab', { name: 'Settings' })
    expect(settings).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Name *')).toHaveFocus()
    settings.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Policy' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Policy' })).toHaveFocus()
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Definition of done shows as a read-only list in card detail. It never blocks moving out.')
    await user.keyboard('{ArrowLeft}')
    expect(settings).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Policy' })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Home}')
    expect(settings).toHaveAttribute('aria-selected', 'true')
  })

  it('adds, edits, reorders and removes criteria, then saves the normalized policy', async () => {
    const user = userEvent.setup()
    mockUpdateColumn.mockResolvedValue(makeColumn())
    const props = renderModal(makeColumn(), 'policy')
    await user.click(screen.getByRole('button', { name: 'Add criterion to Entry criteria' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Entry criterion 1' })).toHaveFocus())
    await user.keyboard('First')
    await user.click(screen.getByRole('button', { name: 'Add criterion to Entry criteria' }))
    await user.type(screen.getByRole('textbox', { name: 'Entry criterion 2' }), '  Second  ')
    // The last row's "down" is aria-disabled and does nothing.
    const down2 = screen.getByRole('button', { name: 'Move entry criterion 2 down' })
    expect(down2).toHaveAttribute('aria-disabled', 'true')
    await user.click(down2)
    await user.click(screen.getByRole('button', { name: 'Move entry criterion 2 up' }))
    expect(screen.getByRole('textbox', { name: 'Entry criterion 1' })).toHaveValue('  Second  ')
    expect(screen.getByText('Entry criterion moved to position 1 of 2.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add criterion to Definition of done' }))
    await user.type(screen.getByRole('textbox', { name: 'Done criterion 1' }), 'Approved')
    await user.click(screen.getByRole('button', { name: 'Add criterion to Definition of done' }))
    // A blank row is dropped on save.
    await user.click(screen.getByRole('button', { name: 'Remove done criterion 2' }))
    expect(screen.getByText('Done criterion 2 removed.')).toBeInTheDocument()
    await user.click(screen.getByText('Ask the mover to confirm'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockUpdateColumn).toHaveBeenCalled())
    expect(mockUpdateColumn.mock.calls[0][2]).toMatchObject({
      policy: { v: 1, entry: ['Second', 'First'], done: ['Approved'], mode: 'confirm' },
    })
    expect(props.onUpdated).toHaveBeenCalled()
  })

  it('removing the last criterion of both lists saves policy: null', async () => {
    const user = userEvent.setup()
    mockUpdateColumn.mockResolvedValue(makeColumn())
    renderModal(makeColumn({ policy: { v: 1, entry: ['Only'], done: [], mode: 'advisory' } }), 'policy')
    await user.click(screen.getByRole('button', { name: 'Remove entry criterion 1' }))
    // Focus falls back to the list's Add button when the list empties.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add criterion to Entry criteria' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockUpdateColumn).toHaveBeenCalled())
    expect(mockUpdateColumn.mock.calls[0][2]).toMatchObject({ policy: null })
  })

  it('stops at eight criteria with a reason on the Add button', async () => {
    const user = userEvent.setup()
    renderModal(makeColumn({ policy: { v: 1, entry: Array.from({ length: 8 }, (_, i) => `c${i}`), done: [], mode: 'advisory' } }), 'policy')
    const add = screen.getByRole('button', { name: 'Add criterion to Entry criteria' })
    expect(add).toHaveAttribute('aria-disabled', 'true')
    expect(add).toHaveAccessibleDescription('Up to 8 criteria per list.')
    await user.click(add)
    expect(screen.queryByRole('textbox', { name: 'Entry criterion 9' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Entry criterion 1' })).toHaveAttribute('maxLength', '200')
  })

  it('removing a middle row focuses the row that took its place', async () => {
    const user = userEvent.setup()
    renderModal(makeColumn({ policy: { v: 1, entry: ['a', 'b', 'c'], done: [], mode: 'advisory' } }), 'policy')
    await user.click(screen.getByRole('button', { name: 'Remove entry criterion 2' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Entry criterion 2' })).toHaveFocus())
    expect(screen.getByRole('textbox', { name: 'Entry criterion 2' })).toHaveValue('c')
  })

  it('Save stays disabled with a blank name, from either tab', async () => {
    const user = userEvent.setup()
    renderModal(makeColumn(), 'settings')
    await user.clear(screen.getByLabelText('Name *'))
    await user.click(screen.getByRole('tab', { name: 'Policy' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(mockUpdateColumn).not.toHaveBeenCalled()
  })

  it('a save that never touched the policy does not send it', async () => {
    // Another admin may have changed it since this modal opened (#1101).
    const user = userEvent.setup()
    mockUpdateColumn.mockResolvedValue(makeColumn())
    renderModal(makeColumn({ policy: POLICY }))
    await user.type(screen.getByLabelText('Name *'), ' 2')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockUpdateColumn).toHaveBeenCalled())
    expect(mockUpdateColumn.mock.calls[0][2]).not.toHaveProperty('policy')
    expect(mockUpdateColumn.mock.calls[0][2]).toMatchObject({ name: 'Review 2' })
  })

  it('says why Save is off when the name is blank, even from the Policy tab', async () => {
    const user = userEvent.setup()
    renderModal(makeColumn())
    await user.clear(screen.getByLabelText('Name *'))
    await user.click(screen.getByRole('tab', { name: 'Policy' }))
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    expect(save).toHaveAccessibleDescription('Name is required.')
  })

  it('ties the definition-of-done helper to its list', () => {
    renderModal(makeColumn(), 'policy')
    expect(screen.getByRole('group', { name: 'Definition of done' })).toHaveAccessibleDescription(
      'Definition of done shows as a read-only list in card detail. It never blocks moving out.',
    )
  })

  it('shows the save error in the footer status region', async () => {
    const user = userEvent.setup()
    mockUpdateColumn.mockRejectedValue(new Error('nope'))
    renderModal(makeColumn({ policy: POLICY }), 'policy')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Failed to save column. Please try again.')).toBeInTheDocument()
  })
})

describe('PolicyConfirmModal (#1101)', () => {
  const renderModal = () => {
    const props = {
      cardTitle: 'Fix login', targetColumnName: 'Review', sourceColumnName: 'In progress',
      criteria: ['Has an owner', 'Tests pass'], onConfirm: vi.fn(), onCancel: vi.fn(),
    }
    render(<PolicyConfirmModal {...props} />)
    return props
  }

  it('keeps Move aria-disabled, focusable and described until every item is checked', async () => {
    const user = userEvent.setup()
    const props = renderModal()
    expect(screen.getByRole('dialog', { name: 'Move “Fix login” to Review?' })).toBeInTheDocument()
    const move = screen.getByRole('button', { name: 'Move to Review' })
    expect(move).toHaveAttribute('aria-disabled', 'true')
    expect(move).not.toBeDisabled()
    expect(move).toHaveAccessibleDescription('2 of 2 still to check.')
    await user.click(screen.getByRole('checkbox', { name: 'Has an owner' }))
    expect(move).toHaveAccessibleDescription('1 of 2 still to check.')
    await user.click(move)
    expect(props.onConfirm).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: 'Tests pass' }))
    expect(move).not.toHaveAttribute('aria-disabled')
    await user.click(move)
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('unchecking an item disables Move again', async () => {
    const user = userEvent.setup()
    renderModal()
    await user.click(screen.getByRole('checkbox', { name: 'Has an owner' }))
    await user.click(screen.getByRole('checkbox', { name: 'Tests pass' }))
    await user.click(screen.getByRole('checkbox', { name: 'Tests pass' }))
    expect(screen.getByRole('button', { name: 'Move to Review' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('"Keep in" names the source column and cancels', async () => {
    const user = userEvent.setup()
    const props = renderModal()
    await user.click(screen.getByRole('button', { name: 'Keep in In progress' }))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onConfirm).not.toHaveBeenCalled()
  })
})
