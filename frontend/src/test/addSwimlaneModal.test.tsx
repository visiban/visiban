import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AddSwimlaneModal from '../components/Swimlane/AddSwimlaneModal'
import type { Swimlane } from '../types'

vi.mock('../api/boards', () => ({
  createSwimlane: vi.fn(),
}))

import { createSwimlane } from '../api/boards'

const mockCreateSwimlane = createSwimlane as ReturnType<typeof vi.fn>

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

describe('AddSwimlaneModal', () => {
  const onAdded = vi.fn()
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the Name field and Add Swimlane button', () => {
    render(<AddSwimlaneModal boardId={1} onAdded={onAdded} onClose={onClose} />)
    expect(screen.getByPlaceholderText('Swimlane name')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add Swimlane' })).toBeInTheDocument()
  })

  it('disables Add Swimlane while the name is empty', () => {
    render(<AddSwimlaneModal boardId={1} onAdded={onAdded} onClose={onClose} />)
    expect(screen.getByRole('button', { name: 'Add Swimlane' })).toBeDisabled()
  })

  it('calls createSwimlane and onAdded/onClose on successful Enter-key submit', async () => {
    const created = makeSwimlane({ name: 'Sprint 1' })
    mockCreateSwimlane.mockResolvedValue(created)

    render(<AddSwimlaneModal boardId={1} onAdded={onAdded} onClose={onClose} />)
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('Swimlane name'), 'Sprint 1')
    await user.keyboard('{Enter}')

    expect(mockCreateSwimlane).toHaveBeenCalledWith(1, { name: 'Sprint 1', contact_email: '', color: expect.any(String) })
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(created))
    expect(onClose).toHaveBeenCalled()
  })

  // --- Rejection path (#1375) — this call had no error handling at all before:
  // a failed create silently reset the saving state with no indication to the user.
  it('shows an inline error and keeps the modal open when createSwimlane rejects with a detail error', async () => {
    mockCreateSwimlane.mockRejectedValue({
      response: { data: { detail: 'A swimlane with this name already exists.' } },
    })

    render(<AddSwimlaneModal boardId={1} onAdded={onAdded} onClose={onClose} />)
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('Swimlane name'), 'Duplicate')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(screen.getByText('A swimlane with this name already exists.')).toBeInTheDocument()
    )
    expect(onAdded).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows a fallback error message when the API rejects with no structured body', async () => {
    mockCreateSwimlane.mockRejectedValue(new Error('Network Error'))

    render(<AddSwimlaneModal boardId={1} onAdded={onAdded} onClose={onClose} />)
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('Swimlane name'), 'Oops')
    await user.click(screen.getByRole('button', { name: 'Add Swimlane' }))

    await waitFor(() =>
      expect(screen.getByText('Failed to add swimlane.')).toBeInTheDocument()
    )
  })

  it('clears the saving state after a rejection so the form is usable again', async () => {
    mockCreateSwimlane.mockRejectedValue(new Error('fail'))

    render(<AddSwimlaneModal boardId={1} onAdded={onAdded} onClose={onClose} />)
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('Swimlane name'), 'Retry me')
    await user.click(screen.getByRole('button', { name: 'Add Swimlane' }))

    await waitFor(() => expect(screen.getByText('Failed to add swimlane.')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Add Swimlane' })).not.toBeDisabled()
  })
})
