import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AddChildDialog from '../components/Card/AddChildDialog'
import { addChild, getChildBoardOptions } from '../api/cards'
import { buildPlannedStatusLine } from '../utils/cardStatusLine'
import type { ChildBoardOptions } from '../types'

vi.mock('../api/cards', () => ({ addChild: vi.fn(), getChildBoardOptions: vi.fn() }))
vi.mock('../api/boards', () => ({ patchBoard: vi.fn() }))

const OPTIONS: ChildBoardOptions = {
  fixed_board: null,
  default: { id: 7, name: 'Delivery' },
  can_set_default: false,
  boards: [{ id: 7, name: 'Delivery', can_set_default: false }],
} as ChildBoardOptions

const LATER = [{ id: 21, name: 'Qualify' }, { id: 22, name: 'Proposal' }]

function setup(laterColumns?: { id: number; name: string }[]) {
  vi.mocked(getChildBoardOptions).mockResolvedValue(OPTIONS)
  const onAdded = vi.fn()
  render(<AddChildDialog boardId={1} boardName="Pipeline" cardId={5} onClose={vi.fn()} onAdded={onAdded} laterColumns={laterColumns} />)
  return { onAdded }
}

describe('Add child: Needed (#2371)', () => {
  beforeEach(() => { vi.mocked(addChild).mockReset(); vi.mocked(addChild).mockResolvedValue({} as never) })

  it('offers Now then each later column, with the helper text, and sends nothing extra for Now', async () => {
    const user = userEvent.setup()
    const { onAdded } = setup(LATER)
    const needed = await screen.findByLabelText('Needed')
    expect(needed).toHaveAttribute('aria-describedby')
    expect(screen.getByText('Options: Now, then each later column on Pipeline.')).toBeInTheDocument()
    expect(screen.queryByTestId('needed-lead-time-hint')).toBeNull()
    await user.type(screen.getByLabelText('Title'), 'Proposal workshop')
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(vi.mocked(addChild).mock.calls[0][2]).not.toHaveProperty('needed_at_column')
  })

  it('a later column shows the lead-time hint and sends needed_at_column', async () => {
    const user = userEvent.setup()
    const { onAdded } = setup(LATER)
    await user.click(await screen.findByLabelText('Needed'))
    await user.click(await screen.findByRole('option', { name: 'When the parent reaches Proposal' }))
    expect(screen.getByTestId('needed-lead-time-hint')).toHaveTextContent('Lead time without dates: split the work.')
    await user.type(screen.getByLabelText('Title'), 'Proposal workshop')
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(vi.mocked(addChild).mock.calls[0][2]).toMatchObject({ needed_at_column: 22 })
  })

  it('hides the field when no later column exists', async () => {
    setup([])
    await screen.findByLabelText('Title')
    expect(screen.queryByLabelText('Needed')).toBeNull()
  })
})

describe('buildPlannedStatusLine (#2371)', () => {
  const base = { due_date: null, is_stale: false, parent: null }
  const today = '2026-11-22'

  it('planned, with and without a date and a visible column', () => {
    expect(buildPlannedStatusLine({ ...base, planned: true, needed_at_column_name: 'Proposal' }, today))
      .toEqual({ kind: 'planned', tone: 'tertiary', text: 'Planned for Proposal' })
    expect(buildPlannedStatusLine({ ...base, planned: true, needed_at_column_name: 'Proposal', due_date: '2026-12-04' }, today)?.text)
      .toBe('Planned for Proposal · Dec 4, counts once needed')
    expect(buildPlannedStatusLine({ ...base, planned: true, needed_at_column_name: null }, today)?.text)
      .toBe('Planned for a later stage')
  })

  it('a date that passed while planned is a warning', () => {
    expect(buildPlannedStatusLine({ ...base, planned: true, due_date: '2026-11-01' }, today))
      .toEqual({ kind: 'planned-passed', tone: 'warning', text: 'Nov 1 passed while planned' })
  })

  it('needed now names the column only for a visible parent, and yields to Stale', () => {
    expect(buildPlannedStatusLine({ ...base, needed_now: true, parent: { hidden: false, column_name: 'Proposal' } }, today)?.text)
      .toBe('Needed now: parent is in Proposal')
    expect(buildPlannedStatusLine({ ...base, needed_now: true, parent: { hidden: true } }, today)?.text)
      .toBe('Needed now: the parent moved on')
    expect(buildPlannedStatusLine({ ...base, needed_now: true, is_stale: true }, today)).toBeNull()
    expect(buildPlannedStatusLine(base, today)).toBeNull()
  })
})
