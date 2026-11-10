import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import ColorSwatchPicker from '../components/Common/ColorSwatchPicker'
import AddColumnModal from '../components/Board/AddColumnModal'
import AddSwimlaneModal from '../components/Swimlane/AddSwimlaneModal'
import { boardColorsInUse, boardColorsOutsidePalette } from '../utils/boardColors'
import { COLUMN_COLORS } from '../constants/colors'

const board = {
  columns: [
    { id: 1, name: 'To Do', color: '#112233' },
    { id: 2, name: 'Doing', color: '#3b82f6' }, // a preset, lower-case
    { id: 3, name: 'Done', color: '#112233' }, // duplicate of column 1
  ],
  swimlanes: [{ id: 1, name: 'Team A', color: '#abc' }],
  labels: [{ id: 1, name: 'Bug', color: '#445566' }, { id: 2, name: 'Odd', color: 'not-a-color' }],
} as unknown as Parameters<typeof boardColorsInUse>[0]

describe('boardColorsInUse (#2098)', () => {
  it('lists columns, swimlanes then labels, deduped on canonical hex, skipping invalid values', () => {
    const out = boardColorsInUse(board)
    expect(out.map((c) => c.color)).toEqual(['#112233', '#3B82F6', '#AABBCC', '#445566'])
    expect(out[0].usedBy).toBe('column To Do')
    expect(out[2].usedBy).toBe('swimlane Team A')
    expect(out[3].usedBy).toBe('label Bug')
  })

  it('is stable across calls and empty for an empty board', () => {
    expect(boardColorsInUse(board)).toEqual(boardColorsInUse(board))
    expect(boardColorsInUse({ columns: [], swimlanes: [], labels: [] })).toEqual([])
  })

  it('boardColorsOutsidePalette drops presets and tolerates undefined', () => {
    const out = boardColorsOutsidePalette(boardColorsInUse(board), COLUMN_COLORS)
    expect(out.map((c) => c.color)).not.toContain('#3B82F6')
    expect(out.map((c) => c.color)).toContain('#112233')
    expect(boardColorsOutsidePalette(undefined, COLUMN_COLORS)).toEqual([])
  })
})

describe('"On this board" row in the custom color popover (#2098)', () => {
  const open = () => fireEvent.click(screen.getByRole('button', { name: /custom color/i }))

  it('shows labeled swatches with accessible names, excluding presets; choosing one applies it', () => {
    const onChange = vi.fn()
    render(<ColorSwatchPicker colors={COLUMN_COLORS} value="#3B82F6" onChange={onChange} allowCustom boardColors={boardColorsInUse(board)} />)
    open()
    const row = screen.getByRole('group', { name: 'On this board' })
    const names = within(row).getAllByRole('button').map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(['Use color from column To Do', 'Use color from swimlane Team A', 'Use color from label Bug'])
    names.forEach((n) => expect(n).not.toContain('#'))
    fireEvent.click(within(row).getByRole('button', { name: 'Use color from label Bug' }))
    expect(onChange).toHaveBeenCalledWith('#445566')
    expect(screen.queryByRole('dialog', { name: 'Custom color' })).not.toBeInTheDocument()
  })

  it('marks the swatch matching the current value pressed', () => {
    render(<ColorSwatchPicker colors={COLUMN_COLORS} value="#112233" onChange={vi.fn()} allowCustom boardColors={boardColorsInUse(board)} />)
    open()
    expect(screen.getByRole('button', { name: 'Use color from column To Do' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Use color from label Bug' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('hides the row when there are no board colors or they are all presets', () => {
    const { rerender } = render(<ColorSwatchPicker colors={COLUMN_COLORS} value={null} onChange={vi.fn()} allowCustom />)
    open()
    expect(screen.queryByText('On this board')).not.toBeInTheDocument()
    rerender(<ColorSwatchPicker colors={COLUMN_COLORS} value={null} onChange={vi.fn()} allowCustom boardColors={[{ color: '#3B82F6', usedBy: 'column Doing' }]} />)
    expect(screen.queryByText('On this board')).not.toBeInTheDocument()
  })

  it('AddColumnModal and AddSwimlaneModal pass the prop through', () => {
    const colors = [{ color: '#112233', usedBy: 'column To Do' }]
    const { unmount } = render(<AddColumnModal boardId={1} onAdded={vi.fn()} onClose={vi.fn()} boardColors={colors} />)
    open()
    expect(screen.getByRole('button', { name: 'Use color from column To Do' })).toBeInTheDocument()
    unmount()
    render(<AddSwimlaneModal boardId={1} onAdded={vi.fn()} onClose={vi.fn()} boardColors={colors} />)
    open()
    expect(screen.getByRole('button', { name: 'Use color from column To Do' })).toBeInTheDocument()
  })
})
