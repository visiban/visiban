import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import EditColumnModal from '../components/Board/EditColumnModal'
import type { Column, CustomFieldDefinition, Swimlane } from '../types'

vi.mock('../api/boards', () => ({
  updateColumn: vi.fn(),
  createCustomFieldDefinition: vi.fn(),
  saveColumnStage: vi.fn(),
}))

const column: Column = {
  id: 5, uid: 'c5', name: 'Discovery', position: 1, color: '#000', wip_limit: null, weight_limit: null,
  allow_card_creation: true, is_done: false, policy: null,
  sub_columns: [{ id: 11, uid: 's11', position: 0, name: 'Doing' }, { id: 12, uid: 's12', position: 1, name: 'Ready' }],
  tracks: [{ id: 1, field_id: 41, field_uid: 'f41', name: 'Technical', position: 0 }],
} as Column
const lanes = [{ id: 3, name: 'APAC', not_applicable_field_ids: [41] }] as unknown as Swimlane[]
const defs = [{ id: 41, name: 'Technical', is_dimension: true }] as unknown as CustomFieldDefinition[]

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
    expect(screen.getByTestId('stage-footer')).toHaveTextContent(/unsaved Settings and Policy changes will be lost/)
    fireEvent.change(screen.getByLabelText('Sub-column 1 name'), { target: { value: 'Building' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    expect(screen.queryByRole('button', { name: 'Save stage' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Stage' }))
    expect(screen.getByLabelText('Sub-column 1 name')).toHaveValue('Building')
  })
})
