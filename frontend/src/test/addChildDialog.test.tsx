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
    // #2542: a static hint tells a child card from a checklist item, tied to the Title field.
    expect(screen.getByLabelText('Title')).toHaveAccessibleDescription('A child card has its own workflow on another board. For a simple to-do, use the checklist.')
    expect(screen.getByTestId('child-title-hint')).toHaveClass('text-xs', 'text-fg-muted')
    await choose(user, 'Delivery')
    const go = screen.getByRole('button', { name: 'Add to Delivery' })
    expect(go).toBeEnabled()
    vi.mocked(addChild).mockResolvedValue({} as never)
    await user.click(go)
    expect(addChild).toHaveBeenCalledWith(1, 5, { board_id: 7, title: 'Write the plan', apply_default_team: false })
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
    expect(screen.getByRole('dialog')).toHaveTextContent('A board admin can set one so this step is skipped.')
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

  it('names the child board in the title and the parent card and column in the header line (#2209)', async () => {
    setup({ ...BASE, default: { id: 7, name: 'Delivery' } }, { parentTitle: 'Acme: platform renewal', parentColumn: 'Qualify' })
    const dialog = await screen.findByRole('dialog', { name: 'Add child to Delivery' })
    expect(dialog).toHaveTextContent('Parent: Acme: platform renewal · Qualify')
    expect(dialog).not.toHaveTextContent('Where should this child go?')
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
    // The real body of a link rule is CodedValidationError's `{code, detail}`: the detail is shown, never the code.
    vi.mocked(addChild).mockRejectedValueOnce(axiosError(400, { code: 'children_limit', detail: 'A card can have at most 100 children.' }))
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A card can have at most 100 children.')
    expect(screen.getByRole('alert')).not.toHaveTextContent('children_limit')
    // A code with no detail maps to its copy (#2447), never the raw `parent_archived`.
    vi.mocked(addChild).mockRejectedValueOnce(axiosError(400, { code: 'parent_archived' }))
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That card is archived. Restore it before adding children.'))
    expect(screen.getByRole('alert')).not.toHaveTextContent('parent_archived')
    // A field error still shows its first message.
    vi.mocked(addChild).mockRejectedValueOnce(axiosError(400, { title: ['This field may not be blank.'] }))
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This field may not be blank.'))
    vi.mocked(addChild).mockRejectedValueOnce(new Error('boom'))
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't add the child"))
  })

  it('an archived parent disables Add and says why, before any write (#2447)', async () => {
    setup({ ...BASE, default: { id: 7, name: 'Delivery' }, disabled_reason: 'parent_archived' })
    expect(await screen.findByRole('alert')).toHaveTextContent('This card is archived. Restore it before adding children.')
    expect(screen.queryByLabelText('Title')).toBeNull()
    expect(screen.queryByLabelText('Child board')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add to Delivery' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add to Delivery' })).toHaveAccessibleDescription('This card is archived. Restore it before adding children.')
    expect(addChild).not.toHaveBeenCalled()
  })

  it('says "Showing N of M" when the server capped the boards, and preselects the default it kept (#2449)', async () => {
    setup({ ...BASE, default: { id: 8, name: 'Ops' }, boards_total: 240 })
    expect(await screen.findByTestId('child-board-options-cap')).toHaveTextContent('Showing 2 of 240 boards, by name.')
    expect(screen.getByLabelText('Child board')).toHaveAccessibleDescription(/Showing 2 of 240 boards, by name\./)
    expect(screen.getByRole('button', { name: 'Add to Ops' })).toBeInTheDocument()
  })

  it('shows no cap line for a complete list or an older server (#2449)', async () => {
    setup({ ...BASE, boards_total: 2 })
    await screen.findByLabelText('Child board')
    expect(screen.queryByTestId('child-board-options-cap')).toBeNull()
  })

  it('a failed options read says so', async () => {
    vi.mocked(getChildBoardOptions).mockRejectedValue(new Error('x'))
    render(<AddChildDialog boardId={1} boardName="Pipeline" cardId={5} onClose={vi.fn()} onAdded={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the boards")
  })

  it('a failed options read offers Retry, which reads again and recovers (#2448)', async () => {
    vi.mocked(getChildBoardOptions).mockRejectedValueOnce(new Error('x'))
    vi.mocked(getChildBoardOptions).mockResolvedValueOnce(BASE)
    const user = userEvent.setup()
    render(<AddChildDialog boardId={1} boardName="Pipeline" cardId={5} onClose={vi.fn()} onAdded={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Retry' }))
    // Retry unmounts on click: focus goes to the dialog heading, never <body>.
    const heading = screen.getByRole('heading', { level: 2 })
    expect(heading).toHaveAttribute('tabindex', '-1')
    expect(heading).toHaveFocus()
    expect(await screen.findByLabelText('Title')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(document.body).not.toHaveFocus()
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
    expect(addChild).toHaveBeenCalledWith(1, 5, { board_id: 7, title: 'Quick', apply_default_team: false })
  })
})

describe('AddChildDialog lane default team (#2211)', () => {
  const members = [
    { id: 10, role: 'member' as const, joined_at: '', user: { id: 10, username: 'mia', display_name: 'Mia Reyes', avatar_url: '' } },
    { id: 11, role: 'member' as const, joined_at: '', user: { id: 11, username: 'dan', display_name: 'Dan Kovacs', avatar_url: '' } },
  ]
  const TEAM: ChildBoardOptions = {
    ...BASE,
    default: { id: 7, name: 'Delivery' },
    boards: [{ id: 7, name: 'Delivery', can_set_default: false, default_assignee_id: 10 }, { id: 8, name: 'Ops', can_set_default: false, default_assignee_id: null }],
    default_team: { swimlane: { id: 3, name: 'Acme Corp' }, member_ids: [11, 10] },
  }

  it('shows the board\'s pre-assigned member with the Add child caption and applies the team', async () => {
    const { user } = setup(TEAM, { members })
    const group = await screen.findByRole('group', { name: 'Assignees' })
    expect(group).toHaveTextContent('Mia Reyes')
    expect(group).toHaveTextContent("From the Acme Corp default team on Pipeline, the lane the parent is in. Delivery's own lanes are not consulted. Also on the team, not assigned: Dan Kovacs.")
    await user.type(screen.getByLabelText('Title'), 'Kickoff')
    vi.mocked(addChild).mockResolvedValue({} as never)
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    expect(addChild).toHaveBeenCalledWith(1, 5, { board_id: 7, title: 'Kickoff', expected_assignee_id: 10 })
  })

  it('Unassign sends apply_default_team false', async () => {
    const { user } = setup(TEAM, { members })
    await user.click(await screen.findByRole('button', { name: 'Unassign Mia Reyes' }))
    await user.type(screen.getByLabelText('Title'), 'Kickoff')
    vi.mocked(addChild).mockResolvedValue({} as never)
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    expect(addChild).toHaveBeenCalledWith(1, 5, { board_id: 7, title: 'Kickoff', apply_default_team: false })
  })

  it('sends apply_default_team false when no chip was shown (the roster no longer lists the server\'s pick)', async () => {
    const { user } = setup(TEAM, { members: members.filter((m) => m.user.id !== 10) })
    await user.type(await screen.findByLabelText('Title'), 'Kickoff')
    expect(screen.queryByRole('group', { name: 'Assignees' })).toBeNull()
    vi.mocked(addChild).mockResolvedValue({} as never)
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    expect(addChild).toHaveBeenCalledWith(1, 5, { board_id: 7, title: 'Kickoff', apply_default_team: false })
  })

  it('Unassign keeps the caption, moves focus to "+ Add", and "+ Add" re-applies the team', async () => {
    const { user } = setup(TEAM, { members })
    await user.click(await screen.findByRole('button', { name: 'Unassign Mia Reyes' }))
    const group = screen.getByRole('group', { name: 'Assignees' })
    expect(group).toHaveAccessibleDescription(/^From the Acme Corp default team on Pipeline/)
    expect(group).toHaveTextContent('No one assigned.')
    expect(group).toHaveTextContent('From the Acme Corp default team on Pipeline')
    expect(screen.getByRole('status')).toHaveTextContent('Mia Reyes unassigned.')
    const add = screen.getByRole('button', { name: 'Add Mia Reyes' })
    expect(add).toHaveFocus()
    await user.click(add)
    expect(screen.getByRole('button', { name: 'Unassign Mia Reyes' })).toHaveFocus()
    await user.type(screen.getByLabelText('Title'), 'Kickoff')
    vi.mocked(addChild).mockResolvedValue({} as never)
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    expect(addChild).toHaveBeenCalledWith(1, 5, { board_id: 7, title: 'Kickoff', expected_assignee_id: 10 })
  })

  it('never shows a parent-board viewer as the chip or in the caption, and opts out of the team', async () => {
    // A stale pick: the server named Mia, but she is now a viewer on the parent board.
    const demoted = members.map((m) => (m.user.id === 10 ? { ...m, role: 'viewer' as const } : m))
    const { user } = setup(TEAM, { members: demoted })
    await user.type(await screen.findByLabelText('Title'), 'Kickoff')
    expect(screen.queryByRole('group', { name: 'Assignees' })).toBeNull()
    expect(screen.queryByText(/Mia Reyes/)).toBeNull()
    vi.mocked(addChild).mockResolvedValue({} as never)
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    expect(addChild).toHaveBeenCalledWith(1, 5, { board_id: 7, title: 'Kickoff', apply_default_team: false })
  })

  it('drops a parent-board viewer from the "not assigned" caption names', async () => {
    const demoted = members.map((m) => (m.user.id === 11 ? { ...m, role: 'viewer' as const } : m))
    setup(TEAM, { members: demoted })
    const group = await screen.findByRole('group', { name: 'Assignees' })
    expect(group).toHaveTextContent('Mia Reyes')
    expect(group).not.toHaveTextContent('Dan Kovacs')
  })

  it('names the parent card in the header line and offers "Back to board"', async () => {
    const { onClose, user } = setup(TEAM, { members, parentTitle: 'Acme: platform renewal', parentColumn: 'Qualify' })
    const dialog = await screen.findByRole('dialog', { name: 'Add child to Delivery' })
    expect(dialog).toHaveTextContent('Parent: Acme: platform renewal · Qualify')
    expect(dialog).not.toHaveTextContent('Where should this child go?')
    await user.click(screen.getByRole('button', { name: 'Back to board' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows no chip on a board where nobody on the team can be assigned', async () => {
    const { user } = setup(TEAM, { members })
    await screen.findByRole('group', { name: 'Assignees' })
    await choose(user, 'Ops')
    expect(screen.queryByRole('group', { name: 'Assignees' })).toBeNull()
  })

  it('shows no chip without the members list or without a team', async () => {
    setup(TEAM)
    await screen.findByRole('button', { name: 'Add to Delivery' })
    expect(screen.queryByRole('group', { name: 'Assignees' })).toBeNull()
  })
})
