import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ColumnHeader from '../components/Board/ColumnHeader'
import type { Column } from '../types'

vi.mock('../api/boards', () => ({ updateColumn: vi.fn() }))

const column: Column = {
  id: 10, uid: 'coluid000001', name: 'Backlog', position: 0, color: '#3B82F6',
  wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false,
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
