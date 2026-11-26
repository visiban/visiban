import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import EditColumnModal from '../components/Board/EditColumnModal'
import type { Column, CustomFieldDefinition, Swimlane } from '../types'

vi.mock('../api/boards', () => ({
  updateColumn: vi.fn(),
  createCustomFieldDefinition: vi.fn(),
  saveColumnStage: vi.fn(),
  updateCustomFieldDefinition: vi.fn(),
  getStageCardCounts: vi.fn(() => Promise.resolve([])),
}))
import { saveColumnStage, updateColumn } from '../api/boards'

const column: Column = {
  id: 5, uid: 'c5', name: 'Discovery', position: 1, color: '#000', wip_limit: null, weight_limit: null,
  allow_card_creation: true, is_done: false, policy: null,
  sub_columns: [{ id: 11, uid: 's11', position: 0, name: 'Doing' }, { id: 12, uid: 's12', position: 1, name: 'Ready' }],
  tracks: [{ id: 1, field_id: 41, field_uid: 'f41', name: 'Technical', position: 0 }],
} as Column
const lanes = [{ id: 3, name: 'APAC', not_applicable_field_ids: [41] }] as unknown as Swimlane[]
const defs = [{ id: 41, name: 'Technical', is_dimension: true }] as unknown as CustomFieldDefinition[]

const SAVED_NOTE = 'Stage saved. Your Settings and Policy changes are not saved yet.'
const renderModal = (over: Partial<Parameters<typeof EditColumnModal>[0]> = {}) => render(
  <EditColumnModal boardId={9} column={column} cardCount={0} onUpdated={vi.fn()} onRequestDelete={vi.fn()} onClose={vi.fn()} {...over} />,
)

describe('EditColumnModal Stage tab (#2278)', () => {
  it('never offers Save stage without loaded swimlanes and fields (B1)', () => {
    renderModal({ initialTab: 'stage' })
    expect(screen.getByTestId('stage-settings-unavailable')).toHaveTextContent(/can't load/)
    expect(screen.queryByRole('button', { name: 'Save stage' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('stage-settings-panel')).not.toBeInTheDocument()
  })

  it('keeps phone targets at 44px: tabs and Settings controls carry max-sm:min-h-11', () => {
    renderModal({ swimlanes: lanes, customFieldDefinitions: defs })
    for (const t of screen.getAllByRole('tab')) expect(t.className).toContain('max-sm:min-h-11')
    expect(screen.getByRole('button', { name: 'Save' }).className).toContain('max-sm:min-h-11')
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain('max-sm:min-h-11')
  })

  it('seeds lane exceptions from the lanes the caller passes, with Save in the fixed footer', () => {
    renderModal({ initialTab: 'stage', swimlanes: lanes, customFieldDefinitions: defs })
    expect(screen.getByText('APAC: Technical is not applicable')).toBeInTheDocument()
    expect(screen.getByTestId('stage-footer')).toContainElement(screen.getByRole('button', { name: 'Save stage' }))
  })

  it('keeps Stage drafts across tab switches and warns about other tabs (G2)', () => {
    renderModal({ swimlanes: lanes, customFieldDefinitions: defs })
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Discovery 2' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Stage' }))
    expect(screen.getByTestId('stage-footer')).toHaveTextContent(/The dialog stays open so you can save your Settings and Policy changes after/)
    fireEvent.change(screen.getByLabelText('Sub-column 1 name'), { target: { value: 'Building' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    expect(screen.queryByRole('button', { name: 'Save stage' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Stage' }))
    expect(screen.getByLabelText('Sub-column 1 name')).toHaveValue('Building')
  })

  it('closes after Save stage when no other tab has unsaved edits', async () => {
    const saved = { ...column, name: 'Discovery' }
    vi.mocked(saveColumnStage).mockResolvedValue({ column: saved, remapped: [{ id: 1, gates_passed: 0, version: 2 }] })
    const onUpdated = vi.fn(); const onClose = vi.fn()
    renderModal({ initialTab: 'stage', swimlanes: lanes, customFieldDefinitions: defs, onUpdated, onClose })
    expect(screen.getByTestId('stage-footer')).toHaveTextContent('Save stage saves this tab only and closes.')
    fireEvent.click(screen.getByRole('button', { name: 'Save stage' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onUpdated).toHaveBeenCalledWith({ ...saved, remapped: [{ id: 1, gates_passed: 0, version: 2 }] })
  })

  it('keeps Settings drafts when Save stage runs, then hands the board the stage on Save (#2368)', async () => {
    const stageSaved = { ...column, sub_columns: [{ id: 11, uid: 's11', position: 0, name: 'Building' }, { id: 12, uid: 's12', position: 1, name: 'Ready' }] }
    const remapped = [{ id: 7, gates_passed: 0, version: 3 }]
    vi.mocked(saveColumnStage).mockResolvedValue({ column: stageSaved, remapped })
    vi.mocked(updateColumn).mockResolvedValue({ ...stageSaved, name: 'Discovery 2' } as Column)
    const onUpdated = vi.fn(); const onClose = vi.fn()
    renderModal({ swimlanes: lanes, customFieldDefinitions: defs, onUpdated, onClose })
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Discovery 2' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Stage' }))
    fireEvent.change(screen.getByLabelText('Sub-column 1 name'), { target: { value: 'Building' } })
    screen.getByRole('button', { name: 'Save stage' }).focus()
    // Focus as of the DOM change that first shows the notice (#2609): the remount has just destroyed the
    // focused Save stage button, so a focus move left to a passive effect is still on <body> here.
    let focusedWithNotice: Element | null = null
    const observer = new MutationObserver(() => {
      if (!focusedWithNotice && screen.queryByText(SAVED_NOTE)) focusedWithNotice = document.activeElement
    })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true })
    fireEvent.click(screen.getByRole('button', { name: 'Save stage' }))
    expect(await screen.findByText(SAVED_NOTE)).toBeInTheDocument()
    observer.disconnect()
    expect(focusedWithNotice).toBe(screen.getByRole('tab', { name: 'Stage' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(onUpdated).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: 'Stage' })).toHaveFocus()
    // The panel reseeds from the saved stage, so a second save sends its rows.
    expect(screen.getByLabelText('Sub-column 1 name')).toHaveValue('Building')
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    expect(screen.getByLabelText('Name *')).toHaveValue('Discovery 2')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onUpdated).toHaveBeenCalledWith({ ...stageSaved, name: 'Discovery 2', remapped })
  })

  it('hands a saved stage to the board when the modal is canceled afterward (#2368)', async () => {
    const remapped = [{ id: 7, gates_passed: 0, version: 3 }]
    vi.mocked(saveColumnStage).mockClear()
    vi.mocked(saveColumnStage).mockResolvedValue({ column, remapped })
    const onUpdated = vi.fn(); const onClose = vi.fn()
    renderModal({ swimlanes: lanes, customFieldDefinitions: defs, onUpdated, onClose })
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Discovery 2' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Stage' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save stage' }))
    await screen.findByText('Stage saved. Your Settings and Policy changes are not saved yet.')
    // A second Save stage while still dirty accumulates the remap.
    fireEvent.click(screen.getByRole('button', { name: 'Save stage' }))
    await waitFor(() => expect(saveColumnStage).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onUpdated).toHaveBeenCalledWith({ ...column, remapped: [...remapped, ...remapped] })
    expect(onClose).toHaveBeenCalled()
  })
})
