import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import StageSettingsPanel from '../components/Board/StageSettingsPanel'
import { stageErrorMessage } from '../utils/stageSettings'
import TrackChips, { GateProgress } from '../components/Card/TrackChips'
import type { Column, CustomFieldDefinition, Swimlane } from '../types'

vi.mock('../api/boards', () => ({
  createCustomFieldDefinition: vi.fn(),
  saveColumnStage: vi.fn(),
}))
import { createCustomFieldDefinition, saveColumnStage } from '../api/boards'
const mockCreate = createCustomFieldDefinition as ReturnType<typeof vi.fn>
const mockSave = saveColumnStage as ReturnType<typeof vi.fn>

const column: Column = {
  id: 5, uid: 'c5', name: 'Discovery', position: 1, color: '#000', wip_limit: null, weight_limit: null,
  allow_card_creation: true, is_done: false, policy: null,
  sub_columns: [{ id: 11, uid: 's11', position: 0, name: 'Doing' }, { id: 12, uid: 's12', position: 1, name: 'Ready' }],
  tracks: [{ id: 1, field_id: 41, field_uid: 'f41', name: 'Technical', position: 0 }],
}
const lanes = [
  { id: 3, name: 'APAC', not_applicable_field_ids: [41] },
  { id: 4, name: 'EMEA', not_applicable_field_ids: [] },
] as unknown as Swimlane[]
const defs = [
  { id: 41, name: 'Technical', is_dimension: true },
  { id: 43, name: 'Legal', is_dimension: true },
  { id: 7, name: 'Region', is_dimension: false },
] as unknown as CustomFieldDefinition[]

const renderPanel = (over: Partial<Parameters<typeof StageSettingsPanel>[0]> = {}) => {
  const onSaved = vi.fn()
  const onCancel = vi.fn()
  render(<StageSettingsPanel boardId={9} column={column} swimlanes={lanes} definitions={defs} onSaved={onSaved} onCancel={onCancel} {...over} />)
  return { onSaved, onCancel }
}

beforeEach(() => { mockCreate.mockReset(); mockSave.mockReset() })

describe('StageSettingsPanel (#2278)', () => {
  it('seeds sub-columns, tracks and this stage\'s lane exceptions', () => {
    renderPanel()
    expect(screen.getByLabelText('Sub-column 1 name')).toHaveValue('Doing')
    expect(screen.getByLabelText('Sub-column 2 name')).toHaveValue('Ready')
    expect(screen.getByRole('button', { name: 'Remove track Technical' })).toBeInTheDocument()
    expect(screen.getByText('APAC: Technical is not applicable')).toBeInTheDocument()
    // Two is the floor: no single-sub-column stage.
    // aria-disabled, not disabled, so the reason stays reachable by keyboard (G5).
    const remove = screen.getByRole('button', { name: 'Remove sub-column Doing' })
    expect(remove).toHaveAttribute('aria-disabled', 'true')
    expect(remove).toHaveAccessibleDescription(/at least two sub-columns, or none/)
    fireEvent.click(remove)
    expect(screen.getByLabelText('Sub-column 1 name')).toHaveValue('Doing')
  })

  it('caps sub-columns at four and blocks empty or duplicate names', () => {
    renderPanel()
    const add = screen.getByRole('button', { name: 'Add sub-column' })
    fireEvent.click(add)
    expect(screen.getByText('Every sub-column needs a name.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save stage' })).toBeDisabled()
    // The invalid input names its error (WCAG 3.3.1).
    const third = screen.getByLabelText('Sub-column 3 name')
    expect(third).toHaveAttribute('aria-invalid', 'true')
    expect(third).toHaveAccessibleDescription('Every sub-column needs a name.')
    fireEvent.change(screen.getByLabelText('Sub-column 3 name'), { target: { value: 'doing' } })
    expect(screen.getByText('Sub-column names must be different.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Sub-column 3 name'), { target: { value: 'Review' } })
    fireEvent.click(add)
    expect(add).toHaveAttribute('aria-disabled', 'true')
    expect(add).toHaveAccessibleDescription('A stage has at most four sub-columns.')
    fireEvent.click(add)
    expect(screen.queryByLabelText('Sub-column 5 name')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove sub-column 4' }))
    expect(screen.queryByLabelText('Sub-column 4 name')).not.toBeInTheDocument()
  })

  it('focuses the new row on add and the next control on remove (G4)', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Add sub-column' }))
    expect(screen.getByLabelText('Sub-column 3 name')).toHaveFocus()
    fireEvent.change(screen.getByLabelText('Sub-column 3 name'), { target: { value: 'Review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove sub-column Ready' }))
    expect(screen.getByRole('button', { name: 'Remove sub-column Review' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Remove track Technical' }))
    expect(screen.getByLabelText('New track name')).toHaveFocus()
  })

  it('refuses a track name that is already a field, with a reason (G5)', () => {
    renderPanel()
    fireEvent.change(screen.getByLabelText('New track name'), { target: { value: 'legal' } })
    expect(screen.getByRole('button', { name: 'Add track' })).toBeDisabled()
    expect(screen.getByLabelText('New track name')).toHaveAccessibleDescription(/already exists/)
  })

  it('summarizes which cards a removed sub-column moves before Save (G6)', () => {
    const cards = [
      { column: 5, gates_passed: 1 }, { column: 5, gates_passed: 1 }, { column: 5, gates_passed: 0 }, { column: 6, gates_passed: 1 },
    ]
    renderPanel({ cards, column: { ...column, sub_columns: [...column.sub_columns!, { id: 13, uid: 's13', position: 2, name: 'Review' }] } })
    expect(screen.queryByTestId('stage-consequences')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove sub-column Ready' }))
    expect(screen.getByTestId('stage-consequences')).toHaveTextContent('2 cards will move from Ready back to Doing.')
    fireEvent.click(screen.getByRole('button', { name: 'Remove all sub-columns' }))
    expect(screen.getByTestId('stage-consequences')).toHaveTextContent('1 card will move from Doing back to the plain Discovery column.')
  })

  it('disables every input and marks the panel busy while saving (G2)', async () => {
    let resolve: (v: unknown) => void = () => {}
    mockSave.mockReturnValue(new Promise((r) => { resolve = r }))
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Save stage' }))
    await waitFor(() => expect(screen.getByTestId('stage-settings-panel')).toHaveAttribute('aria-busy', 'true'))
    expect(screen.getByLabelText('Sub-column 1 name')).toBeDisabled()
    resolve({ column, remapped: [] })
    await waitFor(() => expect(screen.getByTestId('stage-settings-panel')).toHaveAttribute('aria-busy', 'false'))
  })

  it('splits a plain column into two and can make it plain again', () => {
    renderPanel({ column: { ...column, sub_columns: [] } })
    fireEvent.click(screen.getByRole('button', { name: 'Split into sub-columns' }))
    expect(screen.getByLabelText('Sub-column 2 name')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove all sub-columns' }))
    expect(screen.queryByLabelText('Sub-column 1 name')).not.toBeInTheDocument()
  })

  it('creates a new track as a Done / Not applicable dimension, then saves the stage atomically', async () => {
    mockCreate.mockResolvedValue({ id: 50 })
    const saved = { ...column, tracks: [] }
    mockSave.mockResolvedValue({ column: saved, remapped: [{ id: 1, gates_passed: 0, version: 2 }] })
    const { onSaved } = renderPanel()
    fireEvent.change(screen.getByLabelText('New track name'), { target: { value: 'Business' } })
    fireEvent.keyDown(screen.getByLabelText('New track name'), { key: 'Enter' })
    fireEvent.change(screen.getByLabelText('Existing track field'), { target: { value: '43' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.change(screen.getByLabelText('Exception swimlane'), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('Exception track'), { target: { value: screen.getByRole('option', { name: 'Business' }).getAttribute('value') } })
    fireEvent.click(screen.getByRole('button', { name: 'Add swimlane exception' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove exception APAC: Technical' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save stage' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(mockCreate).toHaveBeenCalledWith(9, {
      name: 'Business', field_type: 'dropdown', choices: ['Done', 'Not applicable'], is_dimension: true,
      choice_resolutions: { Done: 'satisfied', 'Not applicable': 'not_applicable' },
    })
    expect(mockSave).toHaveBeenCalledWith(9, 5, {
      sub_columns: [{ id: 11, name: 'Doing' }, { id: 12, name: 'Ready' }],
      tracks: [41, 50, 43],
      not_applicable: [{ swimlane_id: 4, field_id: 50 }],
    })
    expect(onSaved).toHaveBeenCalledWith({ ...saved, remapped: [{ id: 1, gates_passed: 0, version: 2 }] })
  })

  it('removing a track drops its exceptions too', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Remove track Technical' }))
    expect(screen.queryByText('APAC: Technical is not applicable')).not.toBeInTheDocument()
  })

  it('shows the server refusal and keeps the panel open', async () => {
    mockSave.mockRejectedValue({ response: { status: 400, data: { sub_columns: ['A stage can have at most 4 sub-columns.'] } } })
    const { onSaved, onCancel } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Save stage' }))
    expect(await screen.findByText('A stage can have at most 4 sub-columns.')).toHaveAttribute('role', 'alert')
    // After a failed save focus returns to Save, and the live regions stay mounted (WCAG 4.1.3).
    expect(screen.getByRole('button', { name: 'Save stage' })).toHaveFocus()
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })
})

describe('stageErrorMessage', () => {
  it('maps string codes first, then field messages, then a generic line', () => {
    expect(stageErrorMessage({ response: { status: 409, data: { code: 'version_conflict' } } })).toMatch(/changed this stage/)
    expect(stageErrorMessage({ response: { status: 404, data: { code: 'column_not_found' } } })).toBe('This column was deleted.')
    expect(stageErrorMessage({ response: { status: 403, data: { detail: 'x' } } })).toBe('Only board admins can change stage settings.')
    expect(stageErrorMessage({ response: { status: 400, data: { tracks: 'Not a dimension.' } } })).toBe('Not a dimension.')
    expect(stageErrorMessage(new Error('net'))).toMatch(/Check your connection/)
    // A duplicate new-track name comes back from the field create, not the stage save.
    expect(stageErrorMessage({ response: { status: 400, data: { name: ['A field with this name already exists.'] } } })).toBe('Track name: A field with this name already exists.')
    expect(stageErrorMessage({ response: { status: 400, data: { something_else: 1 } } })).not.toMatch(/connection/)
  })
})

describe('TrackChips and GateProgress', () => {
  it('carries state by icon and words, not color alone', () => {
    render(<TrackChips tracks={[
      { id: 1, name: 'Technical', state: 'done', fromLane: false },
      { id: 2, name: 'Business', state: 'open', fromLane: false },
      { id: 3, name: 'Legal', state: 'not_applicable', fromLane: true },
    ]} />)
    const items = screen.getAllByRole('listitem')
    expect(items.map((li) => li.getAttribute('data-track-state'))).toEqual(['done', 'open', 'not_applicable'])
    expect(screen.getByText('Technical: done')).toHaveClass('sr-only')
    expect(items[2]).toHaveAttribute('title', 'Legal: not applicable for this swimlane')
    expect(items.every((li) => li.querySelector('svg'))).toBe(true)
  })

  it('spells states out at phone width and renders nothing without tracks', () => {
    const { container, rerender } = render(<TrackChips tracks={[]} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<TrackChips spelledOut tracks={[{ id: 1, name: 'Technical', state: 'open', fromLane: false }]} />)
    expect(screen.getAllByText('Technical: open')).toHaveLength(2)
  })

  it('names the sub-column on the progress bar', () => {
    const { container, rerender } = render(<GateProgress index={1} names={['Doing', 'Ready']} />)
    expect(screen.getByRole('img', { name: 'Sub-column 2 of 2: Ready' })).toBeInTheDocument()
    rerender(<GateProgress index={0} names={['Only']} />)
    expect(container).toBeEmptyDOMElement()
  })
})
