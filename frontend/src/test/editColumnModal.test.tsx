import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditColumnModal from '../components/Board/EditColumnModal'
import type { Column } from '../types'

vi.mock('../api/boards', () => ({
  updateColumn: vi.fn(),
}))

import { updateColumn } from '../api/boards'

const mockUpdateColumn = updateColumn as ReturnType<typeof vi.fn>

function makeColumn(overrides: Partial<Column> = {}): Column {
  return {
    id: 1,
    uid: 'col-uid-1',
    name: 'Backlog',
    position: 0,
    color: '#6B7280',
    wip_limit: null,
    weight_limit: null,
    allow_card_creation: false,
    is_done: false,
    ...overrides,
  }
}

describe('EditColumnModal', () => {
  const onUpdated = vi.fn()
  const onRequestDelete = vi.fn()
  const onClose = vi.fn()

  beforeEach(() => { vi.clearAllMocks() })

  it('renders is_done checkbox unchecked for a non-done column', () => {
    render(
      <EditColumnModal
        boardId={1}
        column={makeColumn({ is_done: false })}
        cardCount={0}
        onUpdated={onUpdated}
        onRequestDelete={onRequestDelete}
        onClose={onClose}
      />
    )
    const checkbox = screen.getByRole('checkbox', { name: /Count as completed/ })
    expect(checkbox).not.toBeChecked()
  })

  it('renders is_done checkbox checked for a done column', () => {
    render(
      <EditColumnModal
        boardId={1}
        column={makeColumn({ is_done: true })}
        cardCount={0}
        onUpdated={onUpdated}
        onRequestDelete={onRequestDelete}
        onClose={onClose}
      />
    )
    const checkbox = screen.getByRole('checkbox', { name: /Count as completed/ })
    expect(checkbox).toBeChecked()
  })

  it('toggling is_done checkbox and saving sends is_done=true in the request', async () => {
    const updatedColumn = makeColumn({ is_done: true })
    mockUpdateColumn.mockResolvedValue(updatedColumn)

    render(
      <EditColumnModal
        boardId={1}
        column={makeColumn({ is_done: false })}
        cardCount={0}
        onUpdated={onUpdated}
        onRequestDelete={onRequestDelete}
        onClose={onClose}
      />
    )

    const user = userEvent.setup()
    const checkbox = screen.getByRole('checkbox', { name: /Count as completed/ })
    await user.click(checkbox)
    expect(checkbox).toBeChecked()

    const saveBtn = screen.getByRole('button', { name: /Save/ })
    await user.click(saveBtn)

    expect(mockUpdateColumn).toHaveBeenCalledWith(
      1,
      1,
      expect.objectContaining({ is_done: true })
    )
    expect(onUpdated).toHaveBeenCalledWith(updatedColumn)
    expect(onClose).toHaveBeenCalled()
  })

  it('shows analytics behavior section label', () => {
    render(
      <EditColumnModal
        boardId={1}
        column={makeColumn()}
        cardCount={0}
        onUpdated={onUpdated}
        onRequestDelete={onRequestDelete}
        onClose={onClose}
      />
    )
    expect(screen.getByText('Analytics behavior')).toBeInTheDocument()
    expect(screen.getByText(/Cards moved into this column are counted as completed/)).toBeInTheDocument()
  })

  it('includes is_done=false when saving without toggling', async () => {
    const updatedColumn = makeColumn({ is_done: false })
    mockUpdateColumn.mockResolvedValue(updatedColumn)

    render(
      <EditColumnModal
        boardId={1}
        column={makeColumn({ is_done: false })}
        cardCount={0}
        onUpdated={onUpdated}
        onRequestDelete={onRequestDelete}
        onClose={onClose}
      />
    )

    await userEvent.setup().click(screen.getByRole('button', { name: /Save/ }))

    expect(mockUpdateColumn).toHaveBeenCalledWith(
      1,
      1,
      expect.objectContaining({ is_done: false })
    )
  })

  it('color swatch buttons have aria-label', () => {
    render(
      <EditColumnModal
        boardId={1}
        column={makeColumn({ color: '#6B7280' })}
        cardCount={0}
        onUpdated={onUpdated}
        onRequestDelete={onRequestDelete}
        onClose={onClose}
      />
    )
    const swatches = screen.getAllByRole('button', { name: /Select color/ })
    expect(swatches.length).toBeGreaterThan(0)
    swatches.forEach(btn => expect(btn).toHaveAttribute('aria-label'))
  })

  it('selected color swatch has aria-pressed=true, others false', () => {
    const selectedColor = '#6B7280'
    render(
      <EditColumnModal
        boardId={1}
        column={makeColumn({ color: selectedColor })}
        cardCount={0}
        onUpdated={onUpdated}
        onRequestDelete={onRequestDelete}
        onClose={onClose}
      />
    )
    const swatches = screen.getAllByRole('button', { name: /Select color/ })
    const pressed = swatches.filter(btn => btn.getAttribute('aria-pressed') === 'true')
    const unpressed = swatches.filter(btn => btn.getAttribute('aria-pressed') === 'false')
    expect(pressed).toHaveLength(1)
    expect(unpressed.length).toBeGreaterThan(0)
  })
})
