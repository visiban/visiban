import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AddChildDialog from '../components/Card/AddChildDialog'
import CardNeededField from '../components/Card/CardNeededField'
import SelectDropdown from '../components/Common/SelectDropdown'
import { addChild, getChildBoardOptions, setNeeded } from '../api/cards'
import { getColumns } from '../api/boards'
import type { Card, ChildBoardOptions } from '../types'

// #2549 / #2552: Add child's Due date with the "Inactive while planned" helper (desktop and phone wording), the
// lead-time worked example, the phone bottom sheet for Needed, and changing Needed on an existing child.
vi.mock('../api/cards', () => ({ addChild: vi.fn(), getChildBoardOptions: vi.fn(), setNeeded: vi.fn() }))
vi.mock('../api/boards', () => ({ patchBoard: vi.fn(), getColumns: vi.fn() }))

const OPTIONS = {
  fixed_board: null, default: { id: 7, name: 'Delivery' }, can_set_default: false,
  boards: [{ id: 7, name: 'Delivery', can_set_default: false }],
} as unknown as ChildBoardOptions
const LATER = [{ id: 21, name: 'Qualify' }, { id: 22, name: 'Proposal' }]

function setup() {
  vi.mocked(getChildBoardOptions).mockResolvedValue(OPTIONS)
  const onAdded = vi.fn()
  render(<AddChildDialog boardId={1} boardName="Pipeline" cardId={5} onClose={vi.fn()} onAdded={onAdded} laterColumns={LATER} />)
  return { onAdded }
}

function phone(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

describe('Add child: Due date (#2549)', () => {
  beforeEach(() => { vi.mocked(addChild).mockReset(); vi.mocked(addChild).mockResolvedValue({} as never) })

  it('a Now child sends its date and shows no inactive helper', async () => {
    const user = userEvent.setup()
    const { onAdded } = setup()
    const due = await screen.findByLabelText('Due date (optional)')
    expect(screen.queryByTestId('due-inactive-help')).toBeNull()
    expect(due).not.toHaveAttribute('aria-describedby')
    await user.type(screen.getByLabelText('Title'), 'Kickoff')
    await user.type(due, '2026-12-04')
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(vi.mocked(addChild).mock.calls[0][2]).toMatchObject({ due_date: '2026-12-04' })
  })

  it('opens its Needed sheet as a dialog named "Needed" on a phone', async () => {
    const user = userEvent.setup()
    const original = window.matchMedia
    phone(true)
    try {
      setup()
      await user.click(await screen.findByLabelText('Needed'))
      expect(await screen.findByRole('dialog', { name: 'Needed' })).toBeInTheDocument()
    } finally { window.matchMedia = original }
  })

  it('omits due_date when empty', async () => {
    const user = userEvent.setup()
    const { onAdded } = setup()
    await user.type(await screen.findByLabelText('Title'), 'Kickoff')
    await user.click(screen.getByRole('button', { name: 'Add to Delivery' }))
    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(vi.mocked(addChild).mock.calls[0][2]).not.toHaveProperty('due_date')
  })

  it('a planned child explains the inactive date and shows the worked example', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(await screen.findByLabelText('Needed'))
    await user.click(await screen.findByRole('option', { name: 'When the parent reaches Proposal' }))
    const help = screen.getByTestId('due-inactive-help')
    expect(help).toHaveTextContent('Inactive while planned. Saved now; it counts once the work is pulled or the parent reaches Proposal, so a fixed date never sits in Due soon for weeks.')
    // Phone wording (canvas § 9), shown below 640px by `sm:hidden`.
    expect(help.querySelector('.sm\\:hidden')).toHaveTextContent('Counts once needed.')
    expect(screen.getByLabelText('Due date (optional)')).toHaveAttribute('aria-describedby', help.id)
    const ex = screen.getByTestId('needed-lead-time-examples')
    expect(ex).toHaveTextContent('“Book Proposal workshop”: needed at Qualify')
    expect(ex).toHaveTextContent('“Proposal workshop”: needed at Proposal')
  })

  it('the first later column shows only the rule, with no earlier column to name', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(await screen.findByLabelText('Needed'))
    await user.click(await screen.findByRole('option', { name: 'When the parent reaches Qualify' }))
    expect(screen.getByTestId('needed-lead-time-hint')).toHaveTextContent('Lead time without dates: split the work.')
    expect(screen.queryByTestId('needed-lead-time-examples')).toBeNull()
  })
})

describe('SelectDropdown phoneSheet (#2552)', () => {
  const original = window.matchMedia
  afterEach(() => { window.matchMedia = original })

  it('opens as a bottom sheet with a scrim below 640px, and as an anchored menu otherwise', async () => {
    const user = userEvent.setup()
    phone(true)
    const { unmount } = render(<SelectDropdown id="s" ariaLabel="Needed" phoneSheet value="now" onChange={vi.fn()} options={[{ value: 'now', label: 'Now' }]} />)
    await user.click(document.getElementById('s')!)
    const sheet = screen.getByRole('listbox').parentElement!
    expect(sheet).toHaveAttribute('data-sheet', 'true')
    expect(sheet.style.bottom).toBe('0px')
    expect(screen.getByTestId('select-sheet-scrim')).toBeInTheDocument()
    unmount()
    phone(false)
    render(<SelectDropdown id="t" ariaLabel="Needed" phoneSheet value="now" onChange={vi.fn()} options={[{ value: 'now', label: 'Now' }]} />)
    await user.click(document.getElementById('t')!)
    expect(screen.getByRole('listbox').parentElement).not.toHaveAttribute('data-sheet')
    expect(screen.queryByTestId('select-sheet-scrim')).toBeNull()
  })

  it('is a named dialog with a 44px Close that dismisses it, returns focus to the trigger and releases the scroll lock', async () => {
    const user = userEvent.setup()
    phone(true)
    render(<SelectDropdown id="s" ariaLabel="Needed" phoneSheet value="now" onChange={vi.fn()} options={[{ value: 'now', label: 'Now' }]} />)
    const trigger = document.getElementById('s')!
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Needed' })).toBeInTheDocument()
    expect(screen.getByRole('listbox', { name: 'Needed' })).toBeInTheDocument()
    expect(document.body.style.overflow).toBe('hidden')
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close.className).toContain('min-h-11')
    await user.click(close)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
    expect(document.body.style.overflow).toBe('')
  })

  it('restores the page scroll when unmounted while open, and does not close on a scroll', async () => {
    const user = userEvent.setup()
    phone(true)
    const { unmount } = render(<SelectDropdown id="s" ariaLabel="Needed" phoneSheet value="now" onChange={vi.fn()} options={[{ value: 'now', label: 'Now' }]} />)
    await user.click(document.getElementById('s')!)
    fireEvent.scroll(window)
    expect(screen.getByRole('dialog', { name: 'Needed' })).toBeInTheDocument()
    unmount()
    expect(document.body.style.overflow).toBe('')
  })
})

const child = (over: Partial<Card> = {}): Card => ({
  id: 9, column: 100, planned: false, needed_at_column: null, needed_at_column_name: null,
  parent: { hidden: false, id: 5, title: 'Hooli', board_id: 1, board_name: 'Pipeline', column_id: 20, column_name: 'Lead', swimlane_id: 1, swimlane_name: 'Hooli', archived: false, board_parent_name_singular: '' },
  ...over,
} as Card)

describe('CardNeededField (#2549)', () => {
  beforeEach(() => {
    vi.mocked(setNeeded).mockReset()
    vi.mocked(getColumns).mockReset()
    vi.mocked(getColumns).mockResolvedValue([
      { id: 20, name: 'Lead', position: 0 }, { id: 21, name: 'Qualify', position: 1 }, { id: 22, name: 'Proposal', position: 2 },
    ] as never)
  })

  it('offers Now and the later parent columns, and plans the child', async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    vi.mocked(setNeeded).mockResolvedValue({ needed_at_column: 22, planned: true, planned_released_at: null })
    render(<CardNeededField card={child()} boardId={3} firstColumnId={100} canEdit onChanged={onChanged} />)
    expect(screen.getByText('Options: Now, then each later column on Pipeline.')).toBeInTheDocument()
    await waitFor(() => expect(getColumns).toHaveBeenCalledWith(1))
    await user.click(screen.getByLabelText('Needed'))
    expect(screen.queryByRole('option', { name: 'When the parent reaches Lead' })).toBeNull()
    await user.click(await screen.findByRole('option', { name: 'When the parent reaches Proposal' }))
    await waitFor(() => expect(setNeeded).toHaveBeenCalledWith(3, 9, 22))
    expect(onChanged).toHaveBeenCalledWith({ needed_at_column: 22, planned: true, planned_released_at: null })
  })

  it('says a viewer of the parent board needs member access when the server refuses (403)', async () => {
    const user = userEvent.setup()
    vi.mocked(setNeeded).mockRejectedValue({ response: { status: 403 } })
    render(<CardNeededField card={child()} boardId={3} firstColumnId={100} canEdit onChanged={vi.fn()} />)
    await user.click(screen.getByLabelText('Needed'))
    await user.click(await screen.findByRole('option', { name: 'When the parent reaches Proposal' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('You need member access to Pipeline to change when this counts.')
  })

  it('opens a sheet named "Needed" through the real field on a phone', async () => {
    const user = userEvent.setup()
    const original = window.matchMedia
    phone(true)
    try {
      render(<CardNeededField card={child()} boardId={3} firstColumnId={100} canEdit onChanged={vi.fn()} />)
      await user.click(screen.getByLabelText('Needed'))
      expect(await screen.findByRole('dialog', { name: 'Needed' })).toBeInTheDocument()
    } finally { window.matchMedia = original }
  })

  it('sets a planned child to Now and reports a failed write', async () => {
    const user = userEvent.setup()
    vi.mocked(setNeeded).mockRejectedValue(new Error('no'))
    render(<CardNeededField card={child({ planned: true, needed_at_column: 22, needed_at_column_name: 'Proposal' })} boardId={3} firstColumnId={100} canEdit onChanged={vi.fn()} />)
    await user.click(screen.getByLabelText('Needed'))
    await user.click(await screen.findByRole('option', { name: 'Now' }))
    await waitFor(() => expect(setNeeded).toHaveBeenCalledWith(3, 9, null))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't change Needed. Try again.")
  })

  it('a hidden parent reads no parent board; a card in progress or with no parent shows nothing', () => {
    const { unmount } = render(<CardNeededField card={child({ parent: { hidden: true } })} boardId={3} firstColumnId={100} canEdit onChanged={vi.fn()} />)
    expect(getColumns).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Needed')).toHaveTextContent('Now')
    unmount()
    const { container } = render(<CardNeededField card={child({ column: 101 })} boardId={3} firstColumnId={100} canEdit onChanged={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    render(<CardNeededField card={child({ parent: null })} boardId={3} firstColumnId={100} canEdit onChanged={vi.fn()} />)
    expect(screen.queryByTestId('card-needed-field')).toBeNull()
  })

  it('is disabled for a viewer and keeps the stored column when the parent read fails', async () => {
    vi.mocked(getColumns).mockRejectedValue(new Error('gone'))
    render(<CardNeededField card={child({ planned: true, needed_at_column: 22, needed_at_column_name: 'Proposal' })} boardId={3} firstColumnId={100} canEdit={false} onChanged={vi.fn()} />)
    expect(screen.getByLabelText('Needed')).toBeDisabled()
    expect(screen.getByLabelText('Needed')).toHaveTextContent('When the parent reaches Proposal')
  })
})
