import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import ChecklistItemControls from '../components/Card/ChecklistItemControls'
import { useEscapeStack } from '../hooks/useEscapeStack'
import type { BoardUser, CardChecklistItem } from '../types'

const user = (id: number, name: string): BoardUser => ({ id, username: name.toLowerCase(), display_name: name, avatar_url: '' })
const ALICE = user(1, 'Alice')
const GONE = user(9, 'Gina')

function item(over: Partial<CardChecklistItem> = {}): CardChecklistItem {
  return { id: 1, text: 'Write spec', is_checked: false, position: 0, created_by: ALICE, assignee: null, due_date: null, ...over }
}

// Stands in for CardDetail's panel-close entry at priority 30 (#445).
function Panel({ onClose, it }: { onClose: () => void; it: CardChecklistItem }) {
  useEscapeStack(() => { onClose() }, 30)
  return <ChecklistItemControls item={it} members={[ALICE]} canEdit today="2026-11-13" onSave={() => {}} />
}

const escape = () => fireEvent.keyDown(document, { key: 'Escape' })

describe('ChecklistItemControls (#445)', () => {
  it('Escape closes the assignee picker without closing the panel', () => {
    const onClose = vi.fn()
    render(<Panel onClose={onClose} it={item()} />)
    fireEvent.click(screen.getByRole('button', { name: /Assign Write spec/ }))
    expect(screen.getByRole('list', { name: /Assignee for/ })).toBeInTheDocument()
    escape()
    expect(screen.queryByRole('list', { name: /Assignee for/ })).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape closes the date input without closing the panel or saving', () => {
    const onClose = vi.fn()
    const onSave = vi.fn()
    render(
      <>
        <Panel onClose={onClose} it={item()} />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Set due date/ }))
    const input = screen.getByLabelText(/Set due date/)
    fireEvent.change(input, { target: { value: '2026-12-01' } })
    escape()
    expect(screen.queryByLabelText(/Set due date/, { selector: 'input' })).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('does not mark Unassigned pressed when the assignee has left the board', () => {
    render(<ChecklistItemControls item={item({ assignee: GONE })} members={[ALICE]} canEdit today="2026-11-13" onSave={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Change assignee/ }))
    const list = screen.getByRole('list', { name: /Assignee for/ })
    expect(within(list).getByRole('button', { name: 'Unassigned' })).toHaveAttribute('aria-pressed', 'false')
    expect(within(list).getByRole('button', { name: /Gina \(no longer a board member\)/ })).toHaveAttribute('aria-pressed', 'true')
  })
})
