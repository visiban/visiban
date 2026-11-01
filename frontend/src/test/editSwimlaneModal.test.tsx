import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditSwimlaneModal from '../components/Board/EditSwimlaneModal'
import type { Card, Column, Swimlane, SwimlaneCustomFieldDefinition } from '../types'

vi.mock('../api/boards', () => ({
  updateSwimlane: vi.fn(),
  deleteSwimlane: vi.fn(),
}))

import { updateSwimlane, deleteSwimlane } from '../api/boards'

const mockUpdateSwimlane = updateSwimlane as ReturnType<typeof vi.fn>
const mockDeleteSwimlane = deleteSwimlane as ReturnType<typeof vi.fn>

function makeSwimlane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 1,
    uid: 'swimlane-uid-1',
    name: 'Default',
    color: '#6B7280',
    position: 0,
    is_collapsed: false,
    created_at: '2026-01-01T00:00:00Z', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null,
    ...overrides,
  }
}

describe('EditSwimlaneModal', () => {
  const onUpdated = vi.fn()
  const onDeleted = vi.fn()
  const onClose = vi.fn()

  beforeEach(() => { vi.clearAllMocks() })

  it('renders the swimlane name in the input', () => {
    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={makeSwimlane({ name: 'Sprint Lane' })}
        cardCount={0}
        onUpdated={onUpdated}
        onDeleted={onDeleted}
        onClose={onClose}
      />
    )
    expect(screen.getByDisplayValue('Sprint Lane')).toBeInTheDocument()
  })

  it('calls updateSwimlane with updated name on save', async () => {
    const updated = makeSwimlane({ name: 'Renamed' })
    mockUpdateSwimlane.mockResolvedValue(updated)

    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={makeSwimlane({ name: 'Default' })}
        cardCount={0}
        onUpdated={onUpdated}
        onDeleted={onDeleted}
        onClose={onClose}
      />
    )

    const user = userEvent.setup()
    const input = screen.getByDisplayValue('Default')
    await user.clear(input)
    await user.type(input, 'Renamed')
    await user.click(screen.getByRole('button', { name: /Save/ }))

    expect(mockUpdateSwimlane).toHaveBeenCalledWith(1, 1, expect.objectContaining({ name: 'Renamed' }))
    expect(onUpdated).toHaveBeenCalledWith(updated)
    expect(onClose).toHaveBeenCalled()
  })

  // #1373 — handleSave's floating-promise call site is the name input's
  // Enter key (the Save button is a plain function reference and was never
  // flagged). handleSave already catches internally (saveError); this test
  // exercises that path through the actual fixed call site.
  it('shows saveError and does not close when saving via Enter fails', async () => {
    mockUpdateSwimlane.mockRejectedValueOnce(new Error('network error'))

    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={makeSwimlane({ name: 'Default' })}
        cardCount={0}
        onUpdated={onUpdated}
        onDeleted={onDeleted}
        onClose={onClose}
      />
    )

    const user = userEvent.setup()
    const input = screen.getByDisplayValue('Default')
    await user.clear(input)
    await user.type(input, 'Renamed{Enter}')

    expect(await screen.findByText("Couldn't save this swimlane. Try again.")).toBeInTheDocument()
    expect(onUpdated).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows delete confirmation when Delete swimlane is clicked', async () => {
    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={makeSwimlane()}
        cardCount={0}
        onUpdated={onUpdated}
        onDeleted={onDeleted}
        onClose={onClose}
      />
    )
    await userEvent.setup().click(screen.getByRole('button', { name: /Delete swimlane/ }))
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument()
    // Text is split across a <span> (the name) and a trailing text node, so match
    // on the paragraph's full normalized textContent rather than a plain string.
    expect(
      screen.getByText((_, node) => node?.tagName.toLowerCase() === 'p' && node.textContent === 'Default will be permanently deleted.')
    ).toBeInTheDocument()
    expect(
      screen.getByText(/If the swimlane contains any archived cards, they will also be permanently deleted/)
    ).toBeInTheDocument()
  })

  it('blocks delete when swimlane has cards', async () => {
    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={makeSwimlane()}
        cardCount={3}
        onUpdated={onUpdated}
        onDeleted={onDeleted}
        onClose={onClose}
      />
    )
    await userEvent.setup().click(screen.getByRole('button', { name: /Delete swimlane/ }))
    expect(screen.getByText(/Move or delete all cards/)).toBeInTheDocument()
    expect(mockDeleteSwimlane).not.toHaveBeenCalled()
  })

  it('OK dismisses the blocked confirmation and returns to the edit form', async () => {
    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={makeSwimlane()}
        cardCount={3}
        onUpdated={onUpdated}
        onDeleted={onDeleted}
        onClose={onClose}
      />
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Delete swimlane/ }))
    expect(screen.getByText('Cannot delete swimlane')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'OK' }))

    expect(screen.queryByText('Cannot delete swimlane')).not.toBeInTheDocument()
    expect(screen.getByText('Edit Swimlane')).toBeInTheDocument()
    expect(mockDeleteSwimlane).not.toHaveBeenCalled()
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('Cancel dismisses the delete confirmation without deleting', async () => {
    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={makeSwimlane()}
        cardCount={0}
        onUpdated={onUpdated}
        onDeleted={onDeleted}
        onClose={onClose}
      />
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Delete swimlane/ }))
    expect(screen.getByText('Delete swimlane?')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByText('Delete swimlane?')).not.toBeInTheDocument()
    expect(screen.getByText('Edit Swimlane')).toBeInTheDocument()
    expect(mockDeleteSwimlane).not.toHaveBeenCalled()
    expect(onDeleted).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls deleteSwimlane when confirmed on empty swimlane', async () => {
    mockDeleteSwimlane.mockResolvedValue(undefined)

    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={makeSwimlane()}
        cardCount={0}
        onUpdated={onUpdated}
        onDeleted={onDeleted}
        onClose={onClose}
      />
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Delete swimlane/ }))
    await user.click(screen.getByRole('button', { name: /^Delete$/ }))

    expect(mockDeleteSwimlane).toHaveBeenCalledWith(1, 1)
    expect(onDeleted).toHaveBeenCalledWith(1)
    expect(onClose).toHaveBeenCalled()
  })

  it('color swatch buttons have aria-label', () => {
    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={makeSwimlane({ color: '#6B7280' })}
        cardCount={0}
        onUpdated={onUpdated}
        onDeleted={onDeleted}
        onClose={onClose}
      />
    )
    const swatches = screen.getAllByRole('button', { name: /Select color/ })
    expect(swatches.length).toBeGreaterThan(0)
    swatches.forEach(btn => expect(btn).toHaveAttribute('aria-label'))
  })

  it('selected color swatch has aria-pressed=true, others false', () => {
    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={makeSwimlane({ color: '#6B7280' })}
        cardCount={0}
        onUpdated={onUpdated}
        onDeleted={onDeleted}
        onClose={onClose}
      />
    )
    const swatches = screen.getAllByRole('button', { name: /Select color/ })
    const pressed = swatches.filter(btn => btn.getAttribute('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
  })

  it('swatch buttons have a focus ring class', () => {
    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={makeSwimlane()}
        cardCount={0}
        onUpdated={onUpdated}
        onDeleted={onDeleted}
        onClose={onClose}
      />
    )
    const swatches = screen.getAllByRole('button', { name: /Select color/ })
    swatches.forEach(btn => expect(btn.className).toContain('focus:ring-2'))
  })
})

describe('EditSwimlaneModal — URL fields (#1390)', () => {
  const onUpdated = vi.fn()
  const onClose = vi.fn()
  const crmDef = {
    id: 7, uid: 'sfuid0000007', name: 'CRM', field_type: 'url' as const, choices: [], position: 0,
    show_on_row: true, is_admin_only: false, is_required: false, help_text: '', number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {}, created_at: '',
  }

  beforeEach(() => { vi.clearAllMocks() })

  function renderModal() {
    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={makeSwimlane({ custom_field_values: [] })}
        cardCount={0}
        onUpdated={onUpdated}
        onDeleted={vi.fn()}
        onClose={onClose}
        swimlaneFieldDefinitions={[crmDef]}
      />
    )
  }

  it('sends the normalized URL when Save is clicked straight from the url input', async () => {
    mockUpdateSwimlane.mockResolvedValue(makeSwimlane())
    renderModal()
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: 'CRM' }), 'crm.example.com/acct/42')
    // No explicit blur: the Save click itself blurs the input.
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(mockUpdateSwimlane).toHaveBeenCalledWith(1, 1, expect.objectContaining({
      custom_field_values: [{ field_definition: 7, value: 'https://crm.example.com/acct/42' }],
    }))
    expect(onClose).toHaveBeenCalled()
  })

  it('does not save or close with an invalid URL, and keeps the error on the focused input', async () => {
    renderModal()
    const user = userEvent.setup()
    const input = screen.getByRole('textbox', { name: 'CRM' })
    await user.type(input, 'javascript:alert(1)')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(mockUpdateSwimlane).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a web address starting with http:// or https://')
    expect(input).toHaveValue('javascript:alert(1)')
    expect(input).toHaveFocus()
  })

  it('saves once the invalid URL is corrected', async () => {
    mockUpdateSwimlane.mockResolvedValue(makeSwimlane())
    renderModal()
    const user = userEvent.setup()
    const input = screen.getByRole('textbox', { name: 'CRM' })
    await user.type(input, 'ftp://x')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(mockUpdateSwimlane).not.toHaveBeenCalled()
    await user.clear(input)
    await user.type(input, 'https://crm.example.com')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(mockUpdateSwimlane).toHaveBeenCalledWith(1, 1, expect.objectContaining({
      custom_field_values: [{ field_definition: 7, value: 'https://crm.example.com' }],
    }))
  })

  it('routes a server 400 for the url field into its error slot', async () => {
    mockUpdateSwimlane.mockRejectedValue({
      response: { status: 400, data: { custom_field_values: ["'CRM': Enter a valid URL."] } },
    })
    renderModal()
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: 'CRM' }), 'https://crm.example.com')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid web address')
    expect(screen.getByText(/Fix the highlighted field/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps the generic message for a failure it cannot pin to a field', async () => {
    mockUpdateSwimlane.mockRejectedValue(new Error('network'))
    renderModal()
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: 'CRM' }), 'https://crm.example.com')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText("Couldn't save this swimlane. Try again.")).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Escape closes an open multi-select field menu before the modal (#1391)', async () => {
    const onClose = vi.fn()
    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={makeSwimlane({ custom_field_values: [] })}
        cardCount={0}
        onUpdated={vi.fn()}
        onDeleted={vi.fn()}
        onClose={onClose}
        swimlaneFieldDefinitions={[{
          id: 3, uid: 'sfuid0000003', name: 'Markets', field_type: 'multi_select',
          choices: ['EMEA', 'APAC'], position: 0, show_on_row: true, is_admin_only: false,
          is_required: false, help_text: '', number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {}, created_at: '2026-01-01',
        }]}
      />
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Markets: No value' }))
    expect(screen.getByRole('listbox', { name: 'Markets' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: 'Markets' })).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // #1478 — a dropdown field's menu used to render inside the field list's
  // `overflow-y-auto` region and was clipped away. It must portal out of it.
  describe('dropdown swimlane field (#1478)', () => {
    const onDeleted = vi.fn()
    const def: SwimlaneCustomFieldDefinition = {
      id: 5, uid: 'sfuid0000005', name: 'Owner', field_type: 'dropdown', choices: ['Bob', 'Ed', 'Sally'],
      position: 0, show_on_row: true, is_admin_only: false, is_required: false, help_text: '',
      number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {}, created_at: '2026-01-01',
    }

    function renderModal() {
      return render(
        <EditSwimlaneModal
          boardId={1}
          swimlane={makeSwimlane({ custom_field_values: [] })}
          cardCount={0}
          onUpdated={onUpdated}
          onDeleted={onDeleted}
          onClose={onClose}
          swimlaneFieldDefinitions={[def]}
        />
      )
    }

    it('renders every choice outside the scrolling field list', async () => {
      renderModal()
      await userEvent.click(screen.getByRole('button', { name: /— No value —/ }))
      const menu = screen.getByRole('menu')
      expect(menu.closest('.overflow-y-auto')).toBeNull()
      expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Bob', 'Ed', 'Sally'])
    })

    it('saves the picked choice', async () => {
      mockUpdateSwimlane.mockResolvedValue(makeSwimlane())
      renderModal()
      await userEvent.click(screen.getByRole('button', { name: /— No value —/ }))
      await userEvent.click(screen.getByRole('menuitem', { name: 'Sally' }))
      await userEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(mockUpdateSwimlane).toHaveBeenCalledWith(
        1, 1, expect.objectContaining({ custom_field_values: [{ field_definition: 5, value: 'Sally' }] })
      )
    })

    it('Escape closes only the menu, not the modal', async () => {
      renderModal()
      await userEvent.click(screen.getByRole('button', { name: /— No value —/ }))
      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(onClose).not.toHaveBeenCalled()
    })
  })
})

describe('EditSwimlaneModal — date format (#1993)', () => {
  it('shows a date row in the userDateFormat preference', () => {
    const dateDef = {
      id: 8, uid: 'sfuid0000008', name: 'Renewal', field_type: 'date' as const, choices: [], position: 0,
      show_on_row: true, is_admin_only: false, is_required: false, help_text: '', number_prefix: '', number_suffix: '', number_decimals: null, choice_colors: {}, created_at: '',
    }
    render(
      <EditSwimlaneModal
        boardId={1}
        swimlane={makeSwimlane({ custom_field_values: [{ field_definition: 8, value: '2026-11-26' }] } as never)}
        cardCount={0}
        onUpdated={vi.fn()}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
        swimlaneFieldDefinitions={[dateDef]}
        userDateFormat="DD/MM/YYYY"
      />
    )
    expect(screen.getByText('26/11/2026')).toBeInTheDocument()
  })
})

describe('EditSwimlaneModal — limits (#1150)', () => {
  const columns: Column[] = [
    { id: 10, uid: 'c10', name: 'Backlog', position: 0, color: '#000000', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
    { id: 11, uid: 'c11', name: 'Doing', position: 1, color: '#000000', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
    { id: 12, uid: 'c12', name: 'Done', position: 2, color: '#000000', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: true },
  ]
  const card = (id: number, column: number, weight = 1): Card => ({
    id, uid: `k${id}`, column, swimlane: 1, title: 't', description: '', priority: 'medium', assignee: null,
    labels: [], due_date: null, weight, position: 0, created_by: { id: 1, username: 'u', display_name: '', avatar_url: '' },
    created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0,
    is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0, external_ref: null,
  })
  const laneCards = [card(1, 10, 2), card(2, 11, 3), card(3, 12, 5)]

  function renderModal(swimlane: Swimlane = makeSwimlane(), flags = { enforce_wip_limits: true, enforce_wip_hard: false, enforce_weight_limits: true }) {
    return render(
      <EditSwimlaneModal
        boardId={1} swimlane={swimlane} cardCount={3} onUpdated={vi.fn()} onDeleted={vi.fn()} onClose={vi.fn()}
        columns={columns} laneCards={laneCards} limitFlags={flags}
      />,
    )
  }

  beforeEach(() => { vi.clearAllMocks() })

  it('shows "Now N" over the counted columns (done excluded by default)', () => {
    renderModal()
    expect(screen.getByText('Now 2 · 0 = no limit')).toBeInTheDocument()
    expect(screen.getByText('Now 5 · 0 = no limit')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Backlog' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Done/ })).not.toBeChecked()
    expect(screen.getByText('Default: every column not marked done.')).toBeInTheDocument()
  })

  it('saves the limits, the enforcement and null columns when the default is untouched', async () => {
    mockUpdateSwimlane.mockResolvedValue(makeSwimlane())
    const user = userEvent.setup()
    renderModal()
    await user.type(screen.getByLabelText('WIP limit'), '3')
    await user.type(screen.getByLabelText('Weight limit'), '8')
    await user.click(screen.getByRole('radio', { name: /Block for everyone/ }))
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(mockUpdateSwimlane).toHaveBeenCalledWith(1, 1, expect.objectContaining({
      wip_limit: 3, weight_limit: 8, limit_enforcement: 'hard', limit_column_ids: null,
    }))
  })

  it('a changed selection becomes an explicit, sorted list and updates "Now N"', async () => {
    mockUpdateSwimlane.mockResolvedValue(makeSwimlane())
    const user = userEvent.setup()
    renderModal()
    await user.click(screen.getByRole('checkbox', { name: 'Backlog' }))
    await user.click(screen.getByRole('checkbox', { name: /Done/ }))
    expect(screen.getByText('Now 2 · 0 = no limit')).toBeInTheDocument() // Doing + Done count now
    expect(screen.getByText('Only cards in the checked columns count.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(mockUpdateSwimlane).toHaveBeenCalledWith(1, 1, expect.objectContaining({ limit_column_ids: [11, 12] }))
  })

  it('refuses to save with no column checked, and says why', async () => {
    const user = userEvent.setup()
    renderModal()
    await user.click(screen.getByRole('checkbox', { name: 'Backlog' }))
    await user.click(screen.getByRole('checkbox', { name: 'Doing' }))
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(mockUpdateSwimlane).not.toHaveBeenCalled()
    expect(screen.getByText(/Choose at least one column/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Backlog' })).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('checkbox', { name: 'Backlog' })).toHaveFocus()
  })

  it('warns when the new limit is already below the current count, worded for the board mode', async () => {
    const user = userEvent.setup()
    renderModal() // Follow board settings; the board blocks with admin override
    await user.type(screen.getByLabelText('WIP limit'), '1')
    expect(screen.getByText('Already over: 2 cards count now. Nothing moves; a new card is refused until no card counts, unless a board admin overrides.')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Weight limit'), '4')
    expect(screen.getByText('Already over: 5 weight counts now. Nothing moves; a card that would add weight past 4 is refused, unless a board admin overrides.')).toBeInTheDocument()
  })

  it('the already-over note follows the selected enforcement', async () => {
    const user = userEvent.setup()
    renderModal(makeSwimlane(), { enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false })
    await user.type(screen.getByLabelText('WIP limit'), '1')
    // Follow board settings on a board that enforces nothing.
    expect(screen.getByText('Already over: 2 cards count now. This limit is not enforced here, so it only shows on the row.')).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: /Block for everyone/ }))
    expect(screen.getByText('Already over: 2 cards count now. Nothing moves; a new card is refused until no card counts for everyone.')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Weight limit'), '4')
    // Hard mode leaves weight a block an admin can override.
    expect(screen.getByText(/a card that would add weight past 4 is refused, unless a board admin overrides\./)).toBeInTheDocument()
  })

  it('0 or empty clears a limit; null enforcement is "Follow board settings"', async () => {
    mockUpdateSwimlane.mockResolvedValue(makeSwimlane())
    const user = userEvent.setup()
    renderModal(makeSwimlane({ wip_limit: 4, weight_limit: 9, limit_enforcement: 'block', limit_column_ids: [11] }))
    expect(screen.getByRole('radio', { name: /Block, admins can override/ })).toBeChecked()
    await user.clear(screen.getByLabelText('WIP limit'))
    await user.type(screen.getByLabelText('WIP limit'), '0')
    await user.clear(screen.getByLabelText('Weight limit'))
    await user.click(screen.getByRole('radio', { name: /Follow board settings/ }))
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(mockUpdateSwimlane).toHaveBeenCalledWith(1, 1, expect.objectContaining({
      wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: [11],
    }))
  })

  it('describes what the board settings mean right now', () => {
    const { unmount } = renderModal(makeSwimlane(), { enforce_wip_limits: false, enforce_wip_hard: true, enforce_weight_limits: false })
    expect(screen.getByText('Board now: WIP limits block everyone; weight limits only show on the row.')).toBeInTheDocument()
    unmount()
    renderModal(makeSwimlane(), { enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false })
    expect(screen.getByText('Board now: WIP limits only show on the row; weight limits only show on the row.')).toBeInTheDocument()
  })

  it('the form body is a named, focusable scroll region', () => {
    renderModal()
    const region = screen.getByRole('region', { name: 'Swimlane settings' })
    expect(region).toHaveAttribute('tabIndex', '0')
  })
})
