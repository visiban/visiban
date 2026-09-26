/** Tests for the floating overlay legend (#1147) — ramp rows, empty state, compact form. */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import GridOverlayLegend from '../components/Board/GridOverlay/GridOverlayLegend'
import { buildGridOverlayState } from '../gridOverlays/slot'
import { cellKey } from '../gridOverlays/types'
import type { GridOverlay } from '../gridOverlays/types'
import type { Column, Swimlane } from '../types'

function makeColumn(id: number): Column {
  return { id, uid: `col${id}`, name: `Col ${id}`, position: id, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false }
}
function makeSwimlane(id: number): Swimlane {
  return { id, uid: `lane${id}`, name: `Lane ${id}`, contact_email: '', notes: '', position: id, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01' }
}

function fixedOverlay(values: Record<string, number>): GridOverlay {
  return {
    id: 'test-fixed',
    label: 'Dwell time',
    description: 'Days a card has sat in this cell.',
    compute: () => new Map(Object.entries(values).map(([k, v]) => [k, { value: v, label: `${v} days` }])),
  }
}

/** Board with values 1, 4, 5 and 8 across four cells — one per level, max 8. */
function spreadState() {
  return buildGridOverlayState(
    fixedOverlay({
      [cellKey(1, 1)]: 1,
      [cellKey(2, 1)]: 4,
      [cellKey(3, 1)]: 5,
      [cellKey(4, 1)]: 8,
    }),
    { columns: [1, 2, 3, 4].map(makeColumn), swimlanes: [makeSwimlane(1)], cards: [], isFiltered: false },
  )!
}

describe('GridOverlayLegend', () => {
  it('names the overlay, captions it, and lists the four levels highest first', () => {
    render(<GridOverlayLegend state={spreadState()} />)
    const legend = screen.getByRole('group', { name: 'Dwell time overlay scale' })
    expect(legend).toHaveTextContent('Dwell time')
    expect(legend).toHaveTextContent('Days a card has sat in this cell.')
    // Observed values, not formula ceilings (which would read 2 / 4 / 6 / 8).
    const rows = legend.textContent ?? ''
    expect(rows.indexOf('8')).toBeLessThan(rows.indexOf('1'))
    for (const value of ['1', '4', '5', '8']) expect(legend).toHaveTextContent(value)
  })

  it('labels each row with its level for screen readers', () => {
    render(<GridOverlayLegend state={spreadState()} />)
    expect(screen.getByRole('group', { name: /overlay scale/ })).toHaveTextContent('level 4 of 4')
  })

  it('renders an em dash, never a zero, for a level no cell landed in', () => {
    const state = buildGridOverlayState(
      fixedOverlay({ [cellKey(1, 1)]: 1, [cellKey(2, 1)]: 8 }),
      { columns: [1, 2].map(makeColumn), swimlanes: [makeSwimlane(1)], cards: [], isFiltered: false },
    )!
    render(<GridOverlayLegend state={state} />)
    const legend = screen.getByRole('group', { name: /overlay scale/ })
    expect(legend).toHaveTextContent('—')
    expect(legend).not.toHaveTextContent('0')
  })

  it('shows a one-line empty state instead of a meaningless ramp', () => {
    const state = buildGridOverlayState(fixedOverlay({}), {
      columns: [makeColumn(1)], swimlanes: [makeSwimlane(1)], cards: [], isFiltered: false,
    })!
    render(<GridOverlayLegend state={state} />)
    expect(screen.getByRole('group', { name: /overlay scale/ })).toHaveTextContent('No values on this board yet.')
  })

  it('blames the filter, not the board, when a filter is what emptied the overlay', () => {
    const state = buildGridOverlayState(fixedOverlay({}), {
      columns: [makeColumn(1)], swimlanes: [makeSwimlane(1)], cards: [], isFiltered: true,
    })!
    render(<GridOverlayLegend state={state} />)
    expect(screen.getByRole('group', { name: /overlay scale/ })).toHaveTextContent('No values match the active filters.')
  })

  it('carries the same empty-state copy into the compact form', () => {
    const state = buildGridOverlayState(fixedOverlay({}), {
      columns: [makeColumn(1)], swimlanes: [makeSwimlane(1)], cards: [], isFiltered: true,
    })!
    render(<GridOverlayLegend state={state} isLargeViewport={false} />)
    expect(screen.getByRole('group', { name: /overlay scale/ })).toHaveTextContent('No values match the active filters.')
  })

  it('never swallows a click on the grid or the scrollbar behind it', () => {
    render(<GridOverlayLegend state={spreadState()} />)
    expect(screen.getByRole('group', { name: /overlay scale/ }).className).toContain('pointer-events-none')
  })

  it('fades out during a drag without unmounting, so nothing reflows', () => {
    const { rerender } = render(<GridOverlayLegend state={spreadState()} isDragging />)
    expect(screen.getByRole('group', { name: /overlay scale/ }).className).toContain('opacity-0')
    rerender(<GridOverlayLegend state={spreadState()} isDragging={false} />)
    expect(screen.getByRole('group', { name: /overlay scale/ }).className).toContain('opacity-100')
  })

  it('drops to a compact single-row form below lg, keeping the scale readable to AT', () => {
    render(<GridOverlayLegend state={spreadState()} isLargeViewport={false} />)
    const legend = screen.getByRole('group', { name: 'Dwell time overlay scale' })
    expect(legend).toHaveTextContent('Dwell time')
    // No per-level ranges and no caption in the compact form...
    expect(legend).not.toHaveTextContent('Days a card has sat in this cell.')
    // ...but the scale is still described in words.
    expect(legend).toHaveTextContent('Four levels, lightest to darkest. Highest value 8.')
  })
})
