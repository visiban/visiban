import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AddColumnModal from '../components/Board/AddColumnModal'
import { createColumn } from '../api/boards'

vi.mock('../api/boards', () => ({ createColumn: vi.fn() }))

// #1900 — AddColumnModal write flow: validation, payload, failure, intake note.
const col = { id: 5, name: 'Doing' }
function setup(over: Partial<React.ComponentProps<typeof AddColumnModal>> = {}) {
  const props = { boardId: 7, onAdded: vi.fn(), onClose: vi.fn(), ...over }
  render(<AddColumnModal {...props} />)
  return props
}

describe('AddColumnModal', () => {
  beforeEach(() => { vi.mocked(createColumn).mockReset() })

  it('disables Add until a name is typed and never calls the API for a blank name', async () => {
    setup()
    const add = screen.getByRole('button', { name: 'Add Column' })
    expect(add).toBeDisabled()
    await userEvent.setup().type(screen.getByPlaceholderText('e.g. In Progress'), '   ')
    expect(add).toBeDisabled()
    expect(createColumn).not.toHaveBeenCalled()
  })

  it('creates with a trimmed name and digit-only limits, then notifies and closes', async () => {
    vi.mocked(createColumn).mockResolvedValue(col as never)
    const user = userEvent.setup()
    const props = setup()
    await user.type(screen.getByPlaceholderText('e.g. In Progress'), '  Doing ')
    await user.type(screen.getByPlaceholderText('e.g. 5'), '4x2')
    await user.type(screen.getByPlaceholderText('e.g. 20'), '9')
    await user.click(screen.getByRole('button', { name: 'Add Column' }))
    await waitFor(() => expect(props.onAdded).toHaveBeenCalledWith(col))
    expect(createColumn).toHaveBeenCalledWith(7, expect.objectContaining({ name: 'Doing', wip_limit: 42, weight_limit: 9 }))
    expect(props.onClose).toHaveBeenCalled()
  })

  it('omits empty limits and submits on Enter', async () => {
    vi.mocked(createColumn).mockResolvedValue(col as never)
    const user = userEvent.setup()
    setup()
    await user.type(screen.getByPlaceholderText('e.g. In Progress'), 'Doing{Enter}')
    await waitFor(() => expect(createColumn).toHaveBeenCalled())
    expect(vi.mocked(createColumn).mock.calls[0][1]).toMatchObject({ wip_limit: undefined, weight_limit: undefined })
  })

  it('shows an error and stays open when the API fails', async () => {
    vi.mocked(createColumn).mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    const props = setup()
    await user.type(screen.getByPlaceholderText('e.g. In Progress'), 'Doing')
    await user.click(screen.getByRole('button', { name: 'Add Column' }))
    expect(await screen.findByText('Failed to add column. Please try again.')).toBeInTheDocument()
    expect(props.onAdded).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Add Column' })).toBeEnabled()
  })

  it('Cancel closes without saving', async () => {
    const props = setup()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onClose).toHaveBeenCalled()
    expect(createColumn).not.toHaveBeenCalled()
  })

  it('names the intake takeover only when the column will become intake', () => {
    const { unmount } = render(<AddColumnModal boardId={1} onAdded={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByTestId('intake-takeover-note')).not.toBeInTheDocument()
    unmount()
    const r = render(<AddColumnModal boardId={1} onAdded={vi.fn()} onClose={vi.fn()} willBecomeIntake />)
    expect(screen.getByTestId('intake-takeover-note')).toHaveTextContent(/This will be the board's intake column/)
    r.unmount()
    render(<AddColumnModal boardId={1} onAdded={vi.fn()} onClose={vi.fn()} willBecomeIntake replacesIntake />)
    expect(screen.getByTestId('intake-takeover-note')).toHaveTextContent(/current intake column can be named/)
  })
})
