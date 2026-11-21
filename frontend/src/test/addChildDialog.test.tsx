import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError } from 'axios'
import AddChildDialog from '../components/Card/AddChildDialog'
import { addChild, getChildBoardOptions } from '../api/cards'
import { patchBoard } from '../api/boards'
import type { ChildBoardOptions } from '../types'

vi.mock('../api/cards', () => ({ addChild: vi.fn(), getChildBoardOptions: vi.fn() }))
vi.mock('../api/boards', () => ({ patchBoard: vi.fn() }))

const BASE: ChildBoardOptions = {
  fixed_board: null,
  default: null,
  can_set_default: false,
  boards: [{ id: 7, name: 'Delivery', can_set_default: false }, { id: 8, name: 'Ops', can_set_default: false }],
}

function axiosError(status: number, data: unknown = {}) {
  const e = new AxiosError('x')
  e.response = { status, data } as never
  return e
}

function setup(options: ChildBoardOptions, props: Partial<React.ComponentProps<typeof AddChildDialog>> = {}) {
  vi.mocked(getChildBoardOptions).mockResolvedValue(options)
  const onClose = vi.fn()
  const onAdded = vi.fn()
  render(<AddChildDialog boardId={1} boardName="Pipeline" cardId={5} onClose={onClose} onAdded={onAdded} {...props} />)
  return { onClose, onAdded, user: userEvent.setup() }
}

async function choose(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('combobox', { name: /Child board/ }))
  await user.click(await screen.findByRole('option', { name }))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AddChildDialog (#2208)', () => {
  it('member with no default: "Choose a board", Add child disabled until a board and a title are given', async () => {
    const { user, onAdded } = setup(BASE)
    const dialog = await screen.findByRole('dialog', { name: 'Add child' })
    expect(dialog).toHaveTextContent('Where should this child go?')
    expect(dialog).toHaveTextContent('Pipeline has no default child board yet.')
    expect(dialog).toHaveTextContent('A board admin can set one so this step is skipped.')
    expect(screen.getByText('Choose a board')).toBeInTheDocument()
    const primary = screen.getByRole('button', { name: 'Add child' })
    expect(primary).toBeDisabled()
    await user.type(screen.getByLabelText('Title'), 'Write the plan')
    expect(primary).toBeDisabled()
    await choose(user, 'Delivery')
    const go = screen.getByRole('button', { name: 'Add to Delivery' })
    expect(go).toBeEnabled()
    vi.mocked(addChild).mockResolvedValue({} as never)
    await user.click(go)
    expect(addChild).toHaveBeenCalledWith(1, 5, { board_id: 7, title: 'Write the plan' })
    expect(patchBoard).not.toHaveBeenCalled()
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ boardName: 'Delivery', title: 'Write the plan' }))
  })

  it('preselects the default board, so the button already reads "Add to Delivery"', async () => {
    setup({ ...BASE, default: { id: 7, name: 'Delivery' }, can_set_default: true })
    expect(await screen.findByRole('button', { name: 'Add to Delivery' })).toBeDisabled() // title still empty
    expect(screen.queryByText(/has no default child board yet/)).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('an admin of both boards can make the choice the default: one follow-up PATCH', async () => {
    const { user, onAdded } = setup({
      ...BASE, can_set_default: true,
      boards: [{ id: 7, name: 'Delivery', can_set_default: true }],
    })
    await choose(user, 'Delivery')
    await user.type(screen.getByLabelText('Title'), 'Task')
    await user.click(screen.getByRole('checkbox', { name: 'Use Delivery as the default for Pipeline' }))
    vi.mocked(addChild).mockResolvedValue({} as never)
    vi.mocked(patchBoard).mockResolvedValue({} as never)
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(patchBoard).toHaveBeenCalledWith(1, { default_child_board: 7 })
  })

  it('an admin of this board who does not administer the chosen board sees the hint, not the checkbox', async () => {
    const { user } = setup({
      ...BASE, can_set_default: true,
      boards: [{ id: 7, name: 'Delivery', can_set_default: false }],
    })
    await choose(user, 'Delivery')
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Add child' })).toHaveTextContent('A board admin can set one so this step is skipped.')
  })

  it('a refused default PATCH does not undo the add', async () => {
    const { user, onAdded } = setup({ ...BASE, can_set_default: true, boards: [{ id: 7, name: 'Delivery', can_set_default: true }] })
    await choose(user, 'Delivery')
    await user.type(screen.getByLabelText('Title'), 'Task')
    await user.click(screen.getByRole('checkbox'))
    vi.mocked(addChild).mockResolvedValue({} as never)
    vi.mocked(patchBoard).mockRejectedValue(axiosError(400))
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    await waitFor(() => expect(onAdded).toHaveBeenCalled())
  })

  it('a fixed board replaces the select', async () => {
    setup({ ...BASE, fixed_board: { hidden: false, id: 8, name: 'Ops', can_add: true } })
    expect(await screen.findByText(/New children go there too/)).toHaveTextContent('Ops')
    expect(screen.queryByText('Child board')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add to Ops' })).toBeDisabled()
  })

  it('a fixed board the viewer cannot add to disables Add child and says why', async () => {
    setup({ ...BASE, fixed_board: { hidden: false, id: 8, name: 'Ops', can_add: false } })
    expect(await screen.findByRole('alert')).toHaveTextContent("you can't add cards there")
    expect(screen.getByRole('alert')).toHaveTextContent('Ops')
    expect(screen.getByRole('button', { name: 'Add to Ops' })).toBeDisabled()
    expect(screen.queryByLabelText('Title')).toBeNull()
    expect(screen.queryByText(/no longer available/)).toBeNull()
  })

  it('a failed "use as default" write is reported to the caller after the child is added', async () => {
    const { user, onAdded } = setup({ ...BASE, can_set_default: true, boards: [{ id: 7, name: 'Delivery', can_set_default: true }] })
    vi.mocked(addChild).mockResolvedValue({} as never)
    vi.mocked(patchBoard).mockRejectedValue(new Error('nope'))
    await choose(user, 'Delivery')
    await user.click(screen.getByRole('checkbox'))
    await user.type(screen.getByLabelText('Title'), 'Task')
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ boardName: 'Delivery', title: 'Task', defaultNotSet: true }))
  })

  it('a hidden fixed board disables Add child', async () => {
    setup({ ...BASE, fixed_board: { hidden: true } })
    expect(await screen.findByRole('alert')).toHaveTextContent("on a board you can't open")
    expect(screen.getByRole('button', { name: 'Add child' })).toBeDisabled()
    expect(screen.queryByLabelText('Title')).toBeNull()
  })

  it('says so when no board can take children', async () => {
    setup({ ...BASE, boards: [] })
    expect(await screen.findByText(/No board can take new children from Pipeline/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add child' })).toBeDisabled()
  })

  it('a 404 says the board is gone and re-reads the options', async () => {
    const { user } = setup({ ...BASE, default: { id: 7, name: 'Delivery' } })
    await user.type(await screen.findByLabelText('Title'), 'Task')
    vi.mocked(addChild).mockRejectedValue(axiosError(404))
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That board is no longer available')
    await waitFor(() => expect(getChildBoardOptions).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Add to Delivery' })).toBeEnabled()
  })

  it('shows a 400 rule message, and a generic line for anything else', async () => {
    const { user } = setup({ ...BASE, default: { id: 7, name: 'Delivery' } })
    await user.type(await screen.findByLabelText('Title'), 'Task')
    vi.mocked(addChild).mockRejectedValueOnce(axiosError(400, { detail: 'A card can have at most 100 children.' }))
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A card can have at most 100 children.')
    vi.mocked(addChild).mockRejectedValueOnce(new Error('boom'))
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't add the child"))
  })

  it('a failed options read says so', async () => {
    vi.mocked(getChildBoardOptions).mockRejectedValue(new Error('x'))
    render(<AddChildDialog boardId={1} boardName="Pipeline" cardId={5} onClose={vi.fn()} onAdded={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the boards")
  })

  it('Escape and Cancel close it; the sheet is full screen on a phone', async () => {
    const { user, onClose } = setup(BASE)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.className).toContain('max-sm:inset-0')
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('Enter in the title field submits', async () => {
    const { user } = setup({ ...BASE, default: { id: 7, name: 'Delivery' } })
    vi.mocked(addChild).mockResolvedValue({} as never)
    await user.type(await screen.findByLabelText('Title'), 'Quick{Enter}')
    expect(addChild).toHaveBeenCalledWith(1, 5, { board_id: 7, title: 'Quick' })
  })
})
