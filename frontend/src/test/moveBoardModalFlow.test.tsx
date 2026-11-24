import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError } from 'axios'
import MoveBoardModal from '../components/Board/MoveBoardModal'
import { listGroups } from '../api/groups'
import { moveBoardToGroup } from '../api/boards'

vi.mock('../api/groups', () => ({ listGroups: vi.fn() }))
vi.mock('../api/boards', () => ({ moveBoardToGroup: vi.fn() }))

// #1900 — MoveBoardModal write flow, blocked rows, keyboard and failure copy.
const g = (id: number, name: string, parent: number | null, can = true) =>
  ({ id, name, parent, can_place_boards: can }) as never
const board = (group: number | null) => ({ id: 3, name: 'Roadmap', group }) as never
const httpError = (status: number) => new AxiosError('x', 'ERR', undefined, undefined, { status } as never)

function setup(group: number | null = null) {
  const props = { board: board(group), onMoved: vi.fn(), onClose: vi.fn() }
  render(<MoveBoardModal {...props} />)
  return props
}

describe('MoveBoardModal flow', () => {
  beforeEach(() => {
    vi.mocked(listGroups).mockReset().mockResolvedValue([g(1, 'Eng', null), g(2, 'Locked', null, false), g(3, 'Platform', 1)])
    vi.mocked(moveBoardToGroup).mockReset()
  })

  it('moves to the chosen group, then notifies and closes', async () => {
    const updated = { id: 3, group: 1 }
    vi.mocked(moveBoardToGroup).mockResolvedValue(updated as never)
    const user = userEvent.setup()
    const props = setup()
    await user.click(await screen.findByRole('radio', { name: /Eng/ }))
    await user.click(screen.getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(props.onMoved).toHaveBeenCalledWith(updated))
    expect(moveBoardToGroup).toHaveBeenCalledWith(3, 1)
    expect(props.onClose).toHaveBeenCalled()
  })

  it('moving back to Personal sends null', async () => {
    vi.mocked(moveBoardToGroup).mockResolvedValue({} as never)
    const user = userEvent.setup()
    setup(1)
    await user.click(await screen.findByRole('radio', { name: /Personal/ }))
    await user.click(screen.getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(moveBoardToGroup).toHaveBeenCalledWith(3, null))
  })

  it('a blocked group shows its reason, stays focusable and cannot be selected', async () => {
    const user = userEvent.setup()
    setup()
    const locked = await screen.findByRole('radio', { name: /Locked/ })
    expect(locked).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Group admins only')).toBeInTheDocument()
    await user.click(locked)
    expect(locked).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled()
  })

  it('the board\'s current group reads "Current group" and a blocked parent opens onto a placeable child', async () => {
    vi.mocked(listGroups).mockResolvedValue([g(1, 'Eng', null, false), g(3, 'Platform', 1)])
    setup(1)
    expect(await screen.findByText('Current group')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Platform/ })).toBeInTheDocument()
  })

  it('expands and collapses a parent group', async () => {
    vi.mocked(listGroups).mockResolvedValue([g(1, 'Eng', null, false), g(3, 'Platform', 1, false)])
    const user = userEvent.setup()
    setup()
    await user.click(await screen.findByRole('button', { name: 'Expand Eng' }))
    expect(screen.getByRole('radio', { name: /Platform/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Collapse Eng' }))
    expect(screen.queryByRole('radio', { name: /Platform/ })).not.toBeInTheDocument()
    expect(screen.getByText('You can only place boards in groups where you are an admin.')).toBeInTheDocument()
  })

  it('arrow keys move focus and select the row, skipping selection on a blocked row', async () => {
    const user = userEvent.setup()
    setup()
    const personal = await screen.findByRole('radio', { name: /Personal/ })
    personal.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('radio', { name: /Eng/ })).toHaveFocus()
    expect(screen.getByRole('radio', { name: /Eng/ })).toHaveAttribute('aria-checked', 'true')
    await user.keyboard('{End}')
    expect(screen.getByRole('radio', { name: /Locked/ })).toHaveFocus()
    expect(screen.getByRole('radio', { name: /Locked/ })).toHaveAttribute('aria-checked', 'false')
    await user.keyboard('{Home}')
    expect(personal).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('radio', { name: /Locked/ })).toHaveFocus()
  })

  it('a 403 on a group target shows the group-specific message and keeps the modal open', async () => {
    vi.mocked(moveBoardToGroup).mockRejectedValue(httpError(403))
    const user = userEvent.setup()
    const props = setup()
    await user.click(await screen.findByRole('radio', { name: /Eng/ }))
    await user.click(screen.getByRole('button', { name: 'Move' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not move this board to that group.')
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('a server error shows the generic message and choosing again clears it', async () => {
    vi.mocked(moveBoardToGroup).mockRejectedValue(httpError(500))
    const user = userEvent.setup()
    setup()
    await user.click(await screen.findByRole('radio', { name: /Eng/ }))
    await user.click(screen.getByRole('button', { name: 'Move' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not move this board. Try again.')
    await user.click(screen.getByRole('radio', { name: /Personal/ }))
    expect(screen.getByRole('alert')).toBeEmptyDOMElement()
  })

  it('shows a load error when groups cannot be fetched', async () => {
    vi.mocked(listGroups).mockRejectedValue(new Error('down'))
    setup()
    expect(await screen.findByText('Could not load groups. Please try again.')).toBeInTheDocument()
  })

  it('shows an empty note when there are no groups', async () => {
    vi.mocked(listGroups).mockResolvedValue([])
    setup()
    expect(await screen.findByText('No groups available.')).toBeInTheDocument()
  })
})
