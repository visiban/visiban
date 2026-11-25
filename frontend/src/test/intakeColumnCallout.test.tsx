import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditColumnModal from '../components/Board/EditColumnModal'
import AddColumnModal from '../components/Board/AddColumnModal'
import type { Column } from '../types'

vi.mock('../api/boards', () => ({ updateColumn: vi.fn(), createColumn: vi.fn() }))

const column = (o: Partial<Column> = {}): Column => ({
  id: 1, uid: 'u1', name: 'Backlog', position: 0, color: '#6B7280', wip_limit: null,
  weight_limit: null, allow_card_creation: true, is_done: false, policy: null, ...o,
})

const renderEdit = (col: Column, isIntakeColumn?: boolean) =>
  render(
    <EditColumnModal boardId={1} column={col} cardCount={0} onUpdated={vi.fn()}
      onRequestDelete={vi.fn()} onClose={vi.fn()} isIntakeColumn={isIntakeColumn} />,
  )

describe('EditColumnModal intake callout (#2298)', () => {
  it('shows on the intake column, naming only the bottleneck pick', () => {
    renderEdit(column(), true)
    const note = screen.getByRole('note', { name: 'Intake column' })
    expect(note).toHaveTextContent("This is the board's intake column. Analytics doesn't name it as the bottleneck.")
    expect(note.textContent ?? '').not.toMatch(/exclud/i)
  })

  it('is absent on other columns and when the prop is not given', () => {
    const { unmount } = renderEdit(column({ id: 2 }), false)
    expect(screen.queryByTestId('intake-column-callout')).toBeNull()
    unmount()
    renderEdit(column())
    expect(screen.queryByTestId('intake-column-callout')).toBeNull()
  })

  it('is absent on a done column even if flagged intake', () => {
    renderEdit(column({ is_done: true }), true)
    expect(screen.queryByTestId('intake-column-callout')).toBeNull()
  })

  it('does not flicker when the Done checkbox draft is toggled', async () => {
    renderEdit(column(), true)
    await userEvent.click(screen.getByRole('checkbox', { name: /Count as completed/ }))
    expect(screen.getByTestId('intake-column-callout')).toBeInTheDocument()
  })

  it('follows reordering: the role moves with the prop', () => {
    const { rerender } = renderEdit(column(), false)
    expect(screen.queryByTestId('intake-column-callout')).toBeNull()
    rerender(
      <EditColumnModal boardId={1} column={column()} cardCount={0} onUpdated={vi.fn()}
        onRequestDelete={vi.fn()} onClose={vi.fn()} isIntakeColumn />,
    )
    expect(screen.getByTestId('intake-column-callout')).toBeInTheDocument()
  })

  it('More is collapsed by default and toggles by keyboard with aria-expanded', async () => {
    renderEdit(column(), true)
    const more = screen.getByRole('button', { name: 'More' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    const bodyId = more.getAttribute('aria-controls')!
    const body = document.getElementById(bodyId)!
    expect(body).toHaveAttribute('hidden')
    more.focus()
    await userEvent.keyboard('{Enter}')
    const less = screen.getByRole('button', { name: 'Less' })
    expect(less).toHaveAttribute('aria-expanded', 'true')
    expect(body).not.toHaveAttribute('hidden')
    expect(body).toHaveTextContent(/still appears in the cumulative flow/)
    expect(body.textContent ?? '').not.toMatch(/exclud/i)
    await userEvent.keyboard(' ')
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('links to the Analytics bottleneck docs in a new tab', async () => {
    renderEdit(column(), true)
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    const link = screen.getByRole('link', { name: 'Learn more about bottleneck detection, opens docs' })
    expect(link.getAttribute('href')).toMatch(/^https:\/\/docs\.visiban\.com\/(latest|next|\d+\.\d+)\/features\/analytics\/#bottleneck$/)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toMatch(/noopener/)
    expect(link.getAttribute('rel')).toMatch(/noreferrer/)
  })
})

describe('EditColumnModal intake checkbox and Done More (#2299)', () => {
  it('shows a checked, disabled "Not named as the bottleneck" checkbox only on the intake column', () => {
    const { unmount } = renderEdit(column(), true)
    const cb = screen.getByRole('checkbox', { name: 'Not named as the bottleneck' })
    expect(cb).toBeChecked()
    expect(cb).toBeDisabled()
    unmount()
    renderEdit(column({ id: 2 }), false)
    expect(screen.queryByRole('checkbox', { name: 'Not named as the bottleneck' })).toBeNull()
  })

  it('follows reordering for the checkbox', () => {
    const { rerender } = renderEdit(column(), false)
    expect(screen.queryByRole('checkbox', { name: 'Not named as the bottleneck' })).toBeNull()
    rerender(
      <EditColumnModal boardId={1} column={column()} cardCount={0} onUpdated={vi.fn()}
        onRequestDelete={vi.fn()} onClose={vi.fn()} isIntakeColumn />,
    )
    expect(screen.getByRole('checkbox', { name: 'Not named as the bottleneck' })).toBeDisabled()
  })

  it('done column shows a collapsed More that toggles by keyboard and never says exclude', async () => {
    renderEdit(column({ is_done: true }))
    const more = screen.getByRole('button', { name: 'More' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    const body = document.getElementById(more.getAttribute('aria-controls')!)!
    expect(body).toHaveAttribute('hidden')
    more.focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Less' })).toHaveAttribute('aria-expanded', 'true')
    expect(body).not.toHaveAttribute('hidden')
    expect(body).toHaveTextContent(/throughput, lead time, and cycle time/)
    expect(body).toHaveTextContent(/Dwell time and the heatmap skip/)
    expect(body.textContent ?? '').not.toMatch(/exclud/i)
  })

  it('done column keeps the editable Count as completed checkbox; not-done has no Done More', async () => {
    const { unmount } = renderEdit(column({ is_done: true }))
    const cb = screen.getByRole('checkbox', { name: /Count as completed/ })
    expect(cb).toBeEnabled()
    await userEvent.click(cb)
    expect(cb).not.toBeChecked()
    unmount()
    renderEdit(column())
    expect(screen.queryByTestId('done-column-more')).toBeNull()
  })
})

describe('AddColumnModal take-over note (#2298)', () => {
  const renderAdd = (p: { willBecomeIntake?: boolean; replacesIntake?: boolean }) =>
    render(<AddColumnModal boardId={1} onAdded={vi.fn()} onClose={vi.fn()} {...p} />)

  it('is absent unless the new column becomes intake', () => {
    renderAdd({})
    expect(screen.queryByTestId('intake-takeover-note')).toBeNull()
  })

  it('says it becomes the intake column and that the old one becomes eligible', () => {
    renderAdd({ willBecomeIntake: true, replacesIntake: true })
    const note = screen.getByTestId('intake-takeover-note')
    expect(note).toHaveTextContent(/will become the board's intake column/)
    expect(note).toHaveTextContent(/current intake column can be named as the bottleneck again/)
    expect(note.textContent ?? '').not.toMatch(/exclud/i)
  })

  it('on a board with no intake yet, makes no claim about another column', () => {
    renderAdd({ willBecomeIntake: true, replacesIntake: false })
    const note = screen.getByTestId('intake-takeover-note')
    expect(note).toHaveTextContent(/This will be the board's intake column/)
    expect(note.textContent ?? '').not.toMatch(/bottleneck again/)
  })
})
