import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditSwimlaneModal from '../components/Board/EditSwimlaneModal'
import type { Swimlane } from '../types'

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
    created_at: '2026-01-01T00:00:00Z',
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
    show_on_row: true, is_admin_only: false, is_required: false, help_text: '', number_prefix: '', number_suffix: '', number_decimals: null, created_at: '',
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
          is_required: false, help_text: '', number_prefix: '', number_suffix: '', number_decimals: null, created_at: '2026-01-01',
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
})
