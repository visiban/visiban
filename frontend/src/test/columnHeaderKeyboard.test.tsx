import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { updateColumn } from '../api/boards'
import ColumnHeader from '../components/Board/ColumnHeader'
import { EscapeLowerHandlers } from './escapeSelectionProbe'
import type { Column } from '../types'

vi.mock('../api/boards', () => ({ updateColumn: vi.fn() }))

const column: Column = {
  id: 10, uid: 'coluid000001', name: 'Backlog', position: 0, color: '#3B82F6',
  wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null,
}

function renderHeader(over: Partial<React.ComponentProps<typeof ColumnHeader>> = {}) {
  const props = {
    column, cards: [], boardId: 1, isAdmin: true,
    onColumnUpdated: vi.fn(), onRequestDelete: vi.fn(),
    collapsed: false, onToggleCollapse: vi.fn(),
    ...over,
  }
  render(<ColumnHeader {...props} />)
  return props
}

// #1376 — S1082: click handlers on non-interactive elements need keyboard parity
describe('ColumnHeader — keyboard (#1376)', () => {
  it('admin column name is a button; Enter and Space start inline rename', async () => {
    const user = userEvent.setup()
    renderHeader()
    const nameBtn = screen.getByRole('button', { name: 'Backlog' })
    nameBtn.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByDisplayValue('Backlog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    screen.getByRole('button', { name: 'Backlog' }).focus()
    await user.keyboard(' ')
    expect(screen.getByDisplayValue('Backlog')).toBeInTheDocument()
  })

  it('non-admin column name is plain text, not a button', () => {
    renderHeader({ isAdmin: false })
    expect(screen.queryByRole('button', { name: 'Backlog' })).not.toBeInTheDocument()
    expect(screen.getByText('Backlog')).toBeInTheDocument()
  })

  it('collapsed header expands on Enter/Space but not when the drag-handle dot is clicked', async () => {
    const user = userEvent.setup()
    const props = renderHeader({ collapsed: true })
    const header = screen.getByTitle('Expand "Backlog"')
    header.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(props.onToggleCollapse).toHaveBeenCalledTimes(2)
    await user.click(header.querySelector('[data-column-drag-handle]') as HTMLElement)
    expect(props.onToggleCollapse).toHaveBeenCalledTimes(2)
  })

  it('Space/Enter on the focused drag-handle dot does not expand a collapsed column', async () => {
    const user = userEvent.setup()
    const props = renderHeader({ collapsed: true })
    const dot = screen.getByTitle('Expand "Backlog"').querySelector('[data-column-drag-handle]') as HTMLElement
    dot.tabIndex = 0
    dot.focus()
    await user.keyboard(' ')
    await user.keyboard('{Enter}')
    expect(props.onToggleCollapse).not.toHaveBeenCalled()
  })
})

// #1775 — the Edit settings modal opens from a kebab item that unmounts with its menu
describe('ColumnHeader — focus return from the kebab (#1775)', () => {
  it('Edit settings: Tab stays in the modal and Escape returns focus to the column kebab', async () => {
    const user = userEvent.setup()
    renderHeader()
    const kebab = screen.getByRole('button', { name: 'Actions for column "Backlog"' })
    await user.click(kebab)
    await user.click(screen.getByRole('menuitem', { name: 'Edit settings…' }))
    const dialog = await screen.findByRole('dialog', { name: /Edit Column/i })
    await user.tab()
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(kebab).toHaveFocus()
  })
})

describe('ColumnHeader — Escape in the rename input (#1860)', () => {
  it('cancels the rename without reaching the selection-clear handler', async () => {
    const user = userEvent.setup()
    const onLower = vi.fn()
    render(<><EscapeLowerHandlers onLower={onLower} /><ColumnHeader column={column} cards={[]} boardId={1} isAdmin onColumnUpdated={vi.fn()} onRequestDelete={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} /></>)
    await user.click(screen.getByRole('button', { name: 'Backlog' }))
    await user.type(screen.getByDisplayValue('Backlog'), 'x{Escape}')
    expect(screen.queryByDisplayValue('Backlogx')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Backlog' })).toBeInTheDocument()
    expect(onLower).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onLower).toHaveBeenCalled()
  })
})

// #1738 — the collapsed abbreviation is the only identifier of a collapsed column,
// so it must not drop below the 12px informational-text floor.
describe('ColumnHeader — collapsed abbreviation size (#1738)', () => {
  it('renders the abbreviation at text-xs, not a sub-12px arbitrary size', () => {
    renderHeader({ collapsed: true, abbreviation: 'BKL' })
    const abbr = screen.getByText('BKL')
    expect(abbr).toHaveClass('text-xs')
    expect(abbr.className).not.toMatch(/text-\[\d+px\]/)
  })
})

describe('ColumnHeader — focus returns to the rename opener (#2087)', () => {
  it('Escape returns focus to the name button', async () => {
    const user = userEvent.setup()
    renderHeader()
    await user.click(screen.getByRole('button', { name: 'Backlog' }))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Backlog' })).toHaveFocus()
  })
  it('Enter commit returns focus to the name button', async () => {
    const user = userEvent.setup()
    renderHeader()
    await user.click(screen.getByRole('button', { name: 'Backlog' }))
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Backlog' })).toHaveFocus()
  })
  it('a changed-name Enter commit saves via updateColumn and returns focus', async () => {
    const user = userEvent.setup()
    const updated = { ...column, name: 'Backlog2' }
    vi.mocked(updateColumn).mockResolvedValue(updated)
    const onColumnUpdated = vi.fn()
    renderHeader({ onColumnUpdated })
    await user.click(screen.getByRole('button', { name: 'Backlog' }))
    await user.type(screen.getByDisplayValue('Backlog'), '2{Enter}')
    await waitFor(() => expect(onColumnUpdated).toHaveBeenCalledWith(updated))
    expect(updateColumn).toHaveBeenCalledWith(1, column.id, { name: 'Backlog2' })
    expect(screen.getByRole('button', { name: 'Backlog' })).toHaveFocus()
  })
  it('a blur commit does not pull focus back', async () => {
    const user = userEvent.setup()
    renderHeader()
    await user.click(screen.getByRole('button', { name: 'Backlog' }))
    await user.click(document.body)
    expect(screen.getByRole('button', { name: 'Backlog' })).not.toHaveFocus()
  })
})

// #2343 — the admin kebab is hover-revealed; a touch device has no hover, so it must show at rest
describe('ColumnHeader — kebab touch reveal (#2343)', () => {
  it('the kebab wrapper carries hover, focus-within and no-hover reveals', () => {
    renderHeader()
    const wrapper = screen.getByRole('button', { name: 'Actions for column "Backlog"' }).parentElement as HTMLElement
    const cls = wrapper.closest('[class*="opacity-0"]')?.className ?? ''
    expect(cls).toContain('opacity-0')
    expect(cls).toContain('group-hover/col:opacity-100')
    expect(cls).toContain('focus-within:opacity-100')
    expect(cls).toContain('[@media(hover:none)]:opacity-100')
  })
})

describe('ColumnHeader — split stage (#2278)', () => {
  const stage = { ...column, sub_columns: [{ id: 1, uid: 'sub1', position: 0, name: 'Doing' }, { id: 2, uid: 'sub2', position: 1, name: 'Ready' }] } as Column
  const card = (id: number, gates_passed: number) => ({ id, column: 10, gates_passed }) as unknown as React.ComponentProps<typeof ColumnHeader>['cards'][number]

  it('prints a count line per sub-column, the last one as waiting', () => {
    renderHeader({ column: stage, cards: [card(1, 0), card(2, 1), card(3, 1)] })
    expect(screen.getByText('Doing: 1 working')).toBeInTheDocument()
    expect(screen.getByText('Ready: 2 waiting')).toBeInTheDocument()
  })

  it('lays the counts out as a dashed-divided grid: name above count, bare working count, "N waiting" last (#2531)', () => {
    renderHeader({ column: stage, cards: [card(1, 0), card(2, 1), card(3, 1)] })
    const cells = screen.getAllByTestId('column-sub-count')
    expect(cells).toHaveLength(2)
    const row = screen.getByTestId('column-sub-counts')
    expect(row.className).toContain('grid')
    expect(row.className).not.toContain('divide-x')
    expect(row.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))')
    expect(cells[0].className).not.toContain('border-l')
    expect(cells[1].className).toContain('border-dashed')
    expect(cells[1].className).toContain('border-line-boundary')
    const first = cells[0].querySelectorAll('[aria-hidden="true"]')
    expect(first[0]).toHaveTextContent('Doing')
    expect(first[0].className).toContain('font-semibold')
    expect(first[0].className).toContain('line-clamp-2')
    expect(first[0]).toHaveAttribute('title', 'Doing')
    expect(first[1].textContent).toBe('1')
    const last = cells[1].querySelectorAll('[aria-hidden="true"]')
    expect(last[1].textContent).toBe('2 waiting')
    expect(cells[1]).toHaveTextContent('Ready: 2 waiting')
  })

  it('renders no sub-column summary on an unsplit column (#2386)', () => {
    renderHeader({ column, cards: [card(1, 0)] })
    expect(screen.queryByTestId('column-sub-counts')).not.toBeInTheDocument()
  })

  it('offers Stage settings… only to a board admin (the stage action is admin-only on the server)', async () => {
    const user = userEvent.setup()
    renderHeader({ column: stage })
    const trigger = document.querySelector<HTMLElement>('[aria-haspopup="menu"], [aria-haspopup="true"]')!
    await user.click(trigger)
    expect(await screen.findByText('Stage settings…')).toBeInTheDocument()
  })

  it('opens the Stage tab, not Settings, from the Stage settings… item (#2278)', async () => {
    const user = userEvent.setup()
    const lanes = [{ id: 3, name: 'APAC', not_applicable_field_ids: [] }] as unknown as React.ComponentProps<typeof ColumnHeader>['swimlanes']
    const defs = [{ id: 41, name: 'Technical', is_dimension: true }] as unknown as React.ComponentProps<typeof ColumnHeader>['customFieldDefinitions']
    renderHeader({ column: stage, swimlanes: lanes, customFieldDefinitions: defs })
    const trigger = document.querySelector<HTMLElement>('[aria-haspopup="menu"], [aria-haspopup="true"]')!
    await user.click(trigger)
    await user.click(await screen.findByText('Stage settings…'))
    expect(await screen.findByTestId('stage-settings-panel')).toBeInTheDocument()
  })

  it('renders no Stage settings… path for a non-admin', () => {
    renderHeader({ column: stage, isAdmin: false })
    expect(document.querySelector('[aria-haspopup="menu"], [aria-haspopup="true"]')).toBeNull()
    expect(screen.queryByText('Stage settings…')).not.toBeInTheDocument()
  })
})

// Sonar S1082 on the multi-lane add-card wrapper: the keyboard path belongs to the menu trigger.
describe('ColumnHeader — multi-lane add-card keyboard (S1082)', () => {
  const lanes = [
    { id: 1, name: 'Lane A', color: '#111111', collapsed: false },
    { id: 2, name: 'Lane B', color: '#222222', collapsed: false },
  ]

  it('Enter and Space on the trigger open the lane menu without starting a rename', async () => {
    const user = userEvent.setup()
    const onAddCard = vi.fn()
    renderHeader({ onAddCard, addCardLanes: lanes })
    const trigger = screen.getByTestId('column-add-card')
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menu', { name: 'Add card to which swimlane?' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    trigger.focus()
    await user.keyboard(' ')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    await user.click(screen.getByRole('menuitem', { name: /Lane B/ }))
    expect(onAddCard).toHaveBeenCalledWith(2)
  })

  it('double-clicking the trigger does not open the stage settings the header double-click opens', async () => {
    const user = userEvent.setup()
    renderHeader({ onAddCard: vi.fn(), addCardLanes: lanes })
    const trigger = screen.getByTestId('column-add-card')
    await user.dblClick(trigger)
    expect(screen.queryByRole('dialog', { name: /Edit Column/i })).toBeNull()
    // Control: a double-click on the header itself opens settings in this same setup.
    await user.dblClick(trigger.closest('div[class*="group/col"]')!)
    expect(await screen.findByRole('dialog', { name: /Edit Column/i })).toBeInTheDocument()
  })
})
