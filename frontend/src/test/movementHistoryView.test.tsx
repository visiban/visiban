import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import MovementHistoryView from '../components/Board/MovementHistoryView'
import { useEscapeStack } from '../hooks/useEscapeStack'
import type { BoardFull, CardMovement } from '../types'

vi.mock('../api/boards', () => ({
  getBoardMovements: vi.fn(),
}))

import { getBoardMovements } from '../api/boards'
const mockGetMovements = getBoardMovements as ReturnType<typeof vi.fn>

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeBoard = {
  id: 1,
  uid: 'board1',
  name: 'Test Board',
  columns: [
    { id: 10, uid: 'c1', name: 'Todo', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
    { id: 11, uid: 'c2', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: false, is_done: true, policy: null },
  ],
  swimlanes: [
    { id: 20, uid: 's1', name: 'Acme', position: 0, color: '#6366F1', is_collapsed: false, created_at: '' },
    { id: 21, uid: 's2', name: 'Globex', position: 1, color: '#EC4899', is_collapsed: false, created_at: '' },
  ],
  members: [
    { id: null, user: { id: 5, username: 'alice', display_name: 'Alice', avatar_url: '' }, role: 'admin' as const, joined_at: '' },
  ],
  cards: [],
  labels: [],
  description: '',
  group: null,
  group_name: null,
  staleness_threshold_days: 7,
  stale_warning_pct: 50,
  allowed_priorities: ['low', 'medium', 'high', 'urgent'] as const,
  enforce_wip_limits: false,
  enforce_wip_hard: false,
  enforce_weight_limits: false, show_wip_at_limit: false, show_row_chip_field_names: true, export_min_role: 'viewer',
  is_starred: false,
  created_at: '',
  updated_at: '',
  current_user_role: 'admin' as const,
  share_token: null,
  share_link_active: false,
} as unknown as BoardFull

function makeMovement(overrides: Partial<CardMovement> = {}): CardMovement {
  return {
    id: 1,
    card_uid: 'card-uid-1',
    card_title: 'Fix login bug',
    from_column: 10,
    from_column_name: 'Todo',
    from_column_uid: 'c1',
    to_column: 11,
    to_column_name: 'Done',
    to_column_uid: 'c2',
    from_swimlane: 20,
    from_swimlane_name: 'Acme',
    from_swimlane_uid: 's1',
    to_swimlane: 20,
    to_swimlane_name: 'Acme',
    to_swimlane_uid: 's1',
    moved_by: { id: 5, username: 'alice', display_name: 'Alice', avatar_url: '' },
    moved_at: '2026-03-20T10:00:00Z',
    notes: '',
    movement_type: 'move',
    imported_from_username: null,
    ...overrides,
  }
}

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/boards/1?view=history']}>
      <MovementHistoryView board={fakeBoard} />
    </MemoryRouter>
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MovementHistoryView — empty state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMovements.mockResolvedValue({ results: [], count: 0 })
  })

  it('shows empty state message', async () => {
    renderView()
    await waitFor(() =>
      expect(screen.getByText('No card movements recorded yet.')).toBeInTheDocument()
    )
  })
})

describe('MovementHistoryView — with data', () => {
  const movement = makeMovement()

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMovements.mockResolvedValue({ results: [movement], count: 1 })
  })

  it('renders card title and movement columns', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('Fix login bug')).toBeInTheDocument())
    expect(screen.getAllByText('Done').length).toBeGreaterThan(0)
  })

  it('shows count line with total count', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('1 events found')).toBeInTheDocument())
  })

  it('Prev button is disabled on first page', async () => {
    renderView()
    await waitFor(() => screen.getByText('← Prev'))
    expect(screen.getByText('← Prev').closest('button')).toBeDisabled()
  })

  it('Next button is disabled when only one page', async () => {
    renderView()
    await waitFor(() => screen.getByText('Next →'))
    expect(screen.getByText('Next →').closest('button')).toBeDisabled()
  })
})

describe('MovementHistoryView — filters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMovements.mockResolvedValue({ results: [makeMovement()], count: 1 })
  })

  it('passes swimlane_id param when swimlane filter is selected', async () => {
    renderView()
    await waitFor(() => screen.getAllByTestId('history-row'))

    // Open the Swimlane dropdown and pick "Acme"
    fireEvent.click(screen.getByText('Swimlane'))
    fireEvent.click(screen.getByText('Acme'))

    await waitFor(() =>
      expect(mockGetMovements).toHaveBeenCalledWith(
        fakeBoard.id,
        expect.objectContaining({ swimlane_id: '20' })
      )
    )
  })

  it('passes column_id param when column filter is selected', async () => {
    renderView()
    await waitFor(() => screen.getAllByTestId('history-row'))

    fireEvent.click(screen.getByRole('button', { name: /^Column/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Done' }))

    await waitFor(() =>
      expect(mockGetMovements).toHaveBeenCalledWith(
        fakeBoard.id,
        expect.objectContaining({ to_column_id: '11' })
      )
    )
  })

  it('passes user_id param when user filter is selected', async () => {
    renderView()
    await waitFor(() => screen.getAllByTestId('history-row'))

    fireEvent.click(screen.getByRole('button', { name: /^User/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alice' }))

    await waitFor(() =>
      expect(mockGetMovements).toHaveBeenCalledWith(
        fakeBoard.id,
        expect.objectContaining({ moved_by_id: '5' })
      )
    )
  })

  it('passes since param from date input', async () => {
    renderView()
    await waitFor(() => screen.getAllByTestId('history-row'))

    fireEvent.change(screen.getByLabelText('Since date'), { target: { value: '2026-01-01' } })

    await waitFor(() =>
      expect(mockGetMovements).toHaveBeenCalledWith(
        fakeBoard.id,
        expect.objectContaining({ moved_after: '2026-01-01' })
      )
    )
  })

  it('shows "Clear filters" button when filter is active and clears on click', async () => {
    renderView()
    await waitFor(() => screen.getAllByTestId('history-row'))

    fireEvent.click(screen.getByRole('button', { name: /^Column/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Done' }))

    await waitFor(() => expect(screen.getByText('Clear filters')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Clear filters'))

    await waitFor(() =>
      expect(mockGetMovements).toHaveBeenLastCalledWith(
        fakeBoard.id,
        expect.not.objectContaining({ to_column_id: '11' })
      )
    )
  })

  it('shows "No movements match the current filters." when filtered results are empty', async () => {
    mockGetMovements.mockResolvedValue({ results: [], count: 0 })
    renderView()
    // Apply a filter first so it shows filter-specific empty text
    await waitFor(() => screen.getByText('No card movements recorded yet.'))

    // Simulate filtered empty state by having data then filter returning 0
    mockGetMovements.mockResolvedValue({ results: [], count: 0 })
    fireEvent.click(screen.getByRole('button', { name: /^Column/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Done' }))

    await waitFor(() =>
      expect(screen.getByText('No movements match the current filters.')).toBeInTheDocument()
    )
  })
})

describe('MovementHistoryView — slide-in panel', () => {
  const movement = makeMovement()

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMovements.mockResolvedValue({ results: [movement], count: 1 })
  })

  it('opens slide-in panel on row click', async () => {
    renderView()
    const row = await waitFor(() => screen.getByTestId('history-row'))
    fireEvent.click(row)

    await waitFor(() =>
      expect(screen.getByRole('complementary', { name: 'Movement detail' })).toBeInTheDocument()
    )
    expect(screen.getByRole('heading', { name: 'Fix login bug' })).toBeInTheDocument()
  })

  it('closes slide-in panel when close button is clicked', async () => {
    renderView()
    const row = await waitFor(() => screen.getByTestId('history-row'))
    fireEvent.click(row)

    await waitFor(() => screen.getByRole('complementary', { name: 'Movement detail' }))
    fireEvent.click(screen.getByLabelText('Close panel'))

    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Movement detail' })).not.toBeInTheDocument()
    )
  })

  it('closes slide-in panel on Escape key', async () => {
    renderView()
    const row = await waitFor(() => screen.getByTestId('history-row'))
    fireEvent.click(row)
    await waitFor(() => screen.getByRole('complementary', { name: 'Movement detail' }))

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Movement detail' })).not.toBeInTheDocument()
    )
  })

  it('does not swallow ArrowUp/ArrowDown typed inside a filter input (#1853)', async () => {
    renderView()
    await waitFor(() => screen.getByTestId('history-row'))
    const input = document.querySelector('input') as HTMLInputElement
    input.focus()
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    input.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(false)
    const up = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    input.dispatchEvent(up)
    expect(up.defaultPrevented).toBe(false)
  })

  it('still handles ArrowDown from the table (#1853)', async () => {
    renderView()
    const row = await waitFor(() => screen.getByTestId('history-row'))
    row.focus()
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    row.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
  })

  it('ArrowDown from body moves real focus to the row, then Enter opens the slide-in (#1853)', async () => {
    renderView()
    const row = await waitFor(() => screen.getByTestId('history-row'))
    expect(document.activeElement).toBe(document.body)
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(row))
    fireEvent.keyDown(row, { key: 'Enter' })
    await waitFor(() => screen.getByRole('complementary', { name: 'Movement detail' }))
    expect(row).toHaveAttribute('aria-current', 'true')
  })

  it('Enter on a non-row control or a filter input does not open the slide-in (#1853)', async () => {
    renderView()
    const row = await waitFor(() => screen.getByTestId('history-row'))
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(row))
    const button = screen.getByRole('button', { name: /^Column/ })
    button.focus()
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(screen.queryByRole('complementary', { name: 'Movement detail' })).not.toBeInTheDocument()
    const input = document.querySelector('input') as HTMLInputElement
    input.focus()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByRole('complementary', { name: 'Movement detail' })).not.toBeInTheDocument()
  })

  it('arrows from the filter trigger or an open menu item do not move the table (#1853)', async () => {
    mockGetMovements.mockResolvedValue({
      results: [makeMovement({ id: 1 }), makeMovement({ id: 2, card_title: 'B' }), makeMovement({ id: 3, card_title: 'C' })],
      count: 3,
    })
    renderView()
    await waitFor(() => expect(screen.getAllByTestId('history-row')).toHaveLength(3))
    const rows = screen.getAllByTestId('history-row')
    const trigger = screen.getByRole('button', { name: /^Column/ })
    trigger.focus()
    const onTrigger = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    trigger.dispatchEvent(onTrigger)
    expect(rows.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])

    fireEvent.click(trigger)
    const item = screen.getByRole('menuitem', { name: 'Done' })
    item.focus()
    // The dropdown preventDefaults its own arrows, so assert the table did not react.
    fireEvent.keyDown(item, { key: 'ArrowDown' })
    fireEvent.keyDown(item, { key: 'ArrowDown' })
    expect(rows.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
    expect(rows.some((r) => r.contains(document.activeElement))).toBe(false)
  })

  it('Enter with focus on body (not a row) does not open the slide-in (#1853)', async () => {
    renderView()
    const row = await waitFor(() => screen.getByTestId('history-row'))
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(row))
    row.blur()
    expect(document.activeElement).toBe(document.body)
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(screen.queryByRole('complementary', { name: 'Movement detail' })).not.toBeInTheDocument()
  })

  it('arrow on the slide-in Close button is not handled by the table (#1853)', async () => {
    renderView()
    const row = await waitFor(() => screen.getByTestId('history-row'))
    fireEvent.click(row)
    await waitFor(() => screen.getByRole('complementary', { name: 'Movement detail' }))
    const close = screen.getByLabelText('Close panel')
    close.focus()
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    close.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
  })

  it('roving tabIndex has exactly one tab stop that follows focus (#1853)', async () => {
    mockGetMovements.mockResolvedValue({
      results: [makeMovement({ id: 1 }), makeMovement({ id: 2, card_title: 'B' }), makeMovement({ id: 3, card_title: 'C' })],
      count: 3,
    })
    renderView()
    await waitFor(() => expect(screen.getAllByTestId('history-row')).toHaveLength(3))
    const rows = screen.getAllByTestId('history-row')
    const stops = () => rows.map((r) => r.getAttribute('tabindex'))
    expect(stops()).toEqual(['0', '-1', '-1'])
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(rows[0]))
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(rows[1]))
    expect(stops()).toEqual(['-1', '0', '-1'])
    fireEvent.keyDown(rows[1], { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(rows[2]))
    expect(stops()).toEqual(['-1', '-1', '0'])
  })

  it('Escape closes the slide-in, returns focus to its row, and Enter reopens it (#1853)', async () => {
    renderView()
    const row = await waitFor(() => screen.getByTestId('history-row'))
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(row))
    fireEvent.keyDown(row, { key: 'Enter' })
    await waitFor(() => screen.getByRole('complementary', { name: 'Movement detail' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Movement detail' })).not.toBeInTheDocument()
    )
    await waitFor(() => expect(document.activeElement).toBe(row))
    fireEvent.keyDown(row, { key: 'Enter' })
    await waitFor(() => screen.getByRole('complementary', { name: 'Movement detail' }))
  })

  it('Escape with a priority-25 menu open (user menu stand-in) closes only that menu (#1853)', async () => {
    const menuClose = vi.fn()
    function Harness() {
      useEscapeStack(() => { menuClose() }, 25)
      return <MovementHistoryView board={fakeBoard} />
    }
    render(<MemoryRouter><Harness /></MemoryRouter>)
    const row = await waitFor(() => screen.getByTestId('history-row'))
    fireEvent.click(row)
    await waitFor(() => screen.getByRole('complementary', { name: 'Movement detail' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(menuClose).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('complementary', { name: 'Movement detail' })).toBeInTheDocument()
  })

  it('Escape with a filter dropdown open closes only the dropdown, then the slide-in (#1853)', async () => {
    renderView()
    const row = await waitFor(() => screen.getByTestId('history-row'))
    fireEvent.click(row)
    await waitFor(() => screen.getByRole('complementary', { name: 'Movement detail' }))
    fireEvent.click(screen.getByRole('button', { name: /^Column/ }))
    expect(screen.getByRole('menuitem', { name: 'Done' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Done' })).not.toBeInTheDocument())
    expect(screen.getByRole('complementary', { name: 'Movement detail' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Movement detail' })).not.toBeInTheDocument()
    )
  })

  it('Escape closes only the slide-in and does not reach a lower-priority handler (#1853)', async () => {
    const lower = vi.fn()
    function Harness() {
      useEscapeStack(() => { lower() }, 15)
      return <MovementHistoryView board={fakeBoard} />
    }
    render(<MemoryRouter><Harness /></MemoryRouter>)
    const row = await waitFor(() => screen.getByTestId('history-row'))
    fireEvent.click(row)
    await waitFor(() => screen.getByRole('complementary', { name: 'Movement detail' }))

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Movement detail' })).not.toBeInTheDocument()
    )
    expect(lower).not.toHaveBeenCalled()

    // With the slide-in closed, Escape falls through to the lower handler.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(lower).toHaveBeenCalledTimes(1)
  })

  it('table uses plain table semantics, not role=grid (#1853)', async () => {
    renderView()
    await waitFor(() => screen.getByTestId('history-row'))
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Movement history' })).toBeInTheDocument()
  })

  it('panel shows from/to column names', async () => {
    renderView()
    const row = await waitFor(() => screen.getByTestId('history-row'))
    fireEvent.click(row)

    await waitFor(() => screen.getByRole('complementary', { name: 'Movement detail' }))
    expect(screen.getAllByText('Todo').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Done').length).toBeGreaterThan(0)
  })
})

describe('MovementHistoryView — imported rows (#1675)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMovements.mockResolvedValue({
      results: [makeMovement({ imported_from_username: 'carol' })],
      count: 1,
    })
  })

  it('shows the source name under the mover in the table and in the panel', async () => {
    renderView()
    const row = await waitFor(() => screen.getByTestId('history-row'))
    const cellNote = screen.getByText('imported, originally carol')
    expect(cellNote).toHaveAttribute('title', 'imported, originally carol')
    fireEvent.click(row)
    await waitFor(() => screen.getByRole('complementary', { name: 'Movement detail' }))
    expect(screen.getByText(/· imported, originally carol/)).toBeInTheDocument()
  })

  it('says "imported" when the file named nobody', async () => {
    mockGetMovements.mockResolvedValue({
      results: [makeMovement({ imported_from_username: '' })],
      count: 1,
    })
    renderView()
    await waitFor(() => expect(screen.getByText('imported')).toBeInTheDocument())
  })

  it('shows no note on a row recorded on the board', async () => {
    mockGetMovements.mockResolvedValue({ results: [makeMovement()], count: 1 })
    renderView()
    await waitFor(() => screen.getByTestId('history-row'))
    expect(screen.queryByText(/imported/)).not.toBeInTheDocument()
  })
})

describe('MovementHistoryView — pagination', () => {
  // 51 items triggers page 2 being available.
  const movements = Array.from({ length: 50 }, (_, i) =>
    makeMovement({ id: i + 1, card_uid: `uid-${i}`, card_title: `Card ${i + 1}` })
  )

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMovements.mockResolvedValue({ results: movements, count: 110 })
  })

  it('shows correct item range and total', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('110 events found')).toBeInTheDocument())
  })

  it('Next button is enabled when more pages exist', async () => {
    renderView()
    await waitFor(() => screen.getByText('Next →'))
    expect(screen.getByText('Next →').closest('button')).not.toBeDisabled()
  })

  it('clicking Next requests page 2', async () => {
    renderView()
    await waitFor(() => screen.getByText('Next →'))
    fireEvent.click(screen.getByText('Next →'))

    await waitFor(() =>
      expect(mockGetMovements).toHaveBeenCalledWith(
        fakeBoard.id,
        expect.objectContaining({ offset: '50' })
      )
    )
  })
})

describe('MovementHistoryView — mover who is not in the member list (#1714)', () => {
  const outsider = { id: 42, username: 'auditor', display_name: 'Audit Reader', avatar_url: '' }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMovements.mockResolvedValue({
      results: [
        makeMovement({ id: 1, moved_by: outsider }),
        makeMovement({ id: 2, moved_by: outsider }),
        makeMovement({ id: 3 }),
        makeMovement({ id: 4, moved_by: null }),
      ],
      count: 4,
    })
  })

  it('offers the mover as a User option once, after the members, and filters by them', async () => {
    renderView()
    await waitFor(() => expect(screen.getAllByTestId('history-row')).toHaveLength(4))

    fireEvent.click(screen.getByRole('button', { name: /^User/ }))
    const options = screen.getAllByRole('menuitem').map((el) => el.textContent)
    expect(options.filter((t) => t?.includes('Alice'))).toHaveLength(1)
    expect(options.filter((t) => t?.includes('Audit Reader'))).toHaveLength(1)
    expect(options.findIndex((t) => t?.includes('Alice'))).toBeLessThan(
      options.findIndex((t) => t?.includes('Audit Reader')),
    )

    mockGetMovements.mockResolvedValue({ results: [], count: 0 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Audit Reader' }))
    await waitFor(() =>
      expect(mockGetMovements).toHaveBeenCalledWith(
        fakeBoard.id,
        expect.objectContaining({ moved_by_id: '42' })
      )
    )
    // The option stays available after the results narrow to nothing.
    await waitFor(() => expect(screen.getByText('No movements match the current filters.')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Audit Reader/ })).toBeInTheDocument()
  })
})
