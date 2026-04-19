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
    name: 'Default',
    color: '#6B7280',
    position: 0,
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
