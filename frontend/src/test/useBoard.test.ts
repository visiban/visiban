import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useBoard } from '../hooks/useBoard'
import type { BoardFull, Card, Column, Swimlane, Label } from '../types'

// Mock react-router-dom
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: '1' }),
}))

// Mock API modules
vi.mock('../api/boards', () => ({
  getBoardFull: vi.fn(),
  updateBoard: vi.fn(),
  reorderColumns: vi.fn(),
  deleteSwimlane: vi.fn(),
  deleteColumn: vi.fn(),
}))

vi.mock('../api/cards', () => ({
  moveCard: vi.fn(),
}))

import { getBoardFull, reorderColumns, deleteSwimlane, deleteColumn } from '../api/boards'
import { moveCard } from '../api/cards'

const mockGetBoardFull = getBoardFull as ReturnType<typeof vi.fn>
const mockMoveCard = moveCard as ReturnType<typeof vi.fn>
const mockReorderColumns = reorderColumns as ReturnType<typeof vi.fn>
const mockDeleteSwimlane = deleteSwimlane as ReturnType<typeof vi.fn>
const mockDeleteColumn = deleteColumn as ReturnType<typeof vi.fn>

function makeBoard(overrides: Partial<BoardFull> = {}): BoardFull {
  return {
    id: 1,
    name: 'Test Board',
    description: '',
    group: null,
    group_name: null,
    columns: [{ id: 10, name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true }],
    swimlanes: [{ id: 20, name: 'Lane A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01T00:00:00Z' }],
    cards: [{
      id: 100, column: 10, swimlane: 20, title: 'Card 1', description: '', priority: 'medium',
      assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: 1,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false,
    }],
    labels: [],
    members: [],
    staleness_threshold_days: 7, close_editor_on_enter: false, allowed_priorities: [],
    is_starred: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    current_user_role: 'admin',
    ...overrides,
  }
}

describe('useBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads board on mount', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    const { result } = renderHook(() => useBoard())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.board).toEqual(board)
    expect(result.current.error).toBeNull()
  })

  it('sets error when load fails', async () => {
    mockGetBoardFull.mockRejectedValue(new Error('fail'))
    const { result } = renderHook(() => useBoard())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.error).toBe('Failed to load board')
  })

  it('addCard adds a new card', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())

    await waitFor(() => expect(result.current.board).not.toBeNull())

    const newCard: Card = {
      id: 200, column: 10, swimlane: 20, title: 'New Card', description: '', priority: 'low',
      assignee: null, labels: [], due_date: null, weight: 1, position: 1, created_by: 1,
      created_at: '2026-01-01', updated_at: '2026-01-01', last_moved_at: null,
      attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false,
    }

    act(() => { result.current.addCard(newCard) })
    expect(result.current.board!.cards).toHaveLength(2)
    expect(result.current.board!.cards[1].id).toBe(200)
  })

  it('addCard updates existing card', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    const updatedCard = { ...result.current.board!.cards[0], title: 'Updated' }
    act(() => { result.current.addCard(updatedCard) })
    expect(result.current.board!.cards).toHaveLength(1)
    expect(result.current.board!.cards[0].title).toBe('Updated')
  })

  it('removeCard removes card by id', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.removeCard(100) })
    expect(result.current.board!.cards).toHaveLength(0)
  })

  it('addColumn adds new column', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    const newCol: Column = { id: 11, name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true }
    act(() => { result.current.addColumn(newCol) })
    expect(result.current.board!.columns).toHaveLength(2)
  })

  it('removeColumn removes column and its cards', async () => {
    mockDeleteColumn.mockResolvedValue(undefined)
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => { await result.current.removeColumn(10) })
    expect(result.current.board!.columns).toHaveLength(0)
    expect(result.current.board!.cards).toHaveLength(0)
  })

  it('addSwimlane adds new swimlane', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    const newSwimlane: Swimlane = { id: 21, name: 'Lane B', contact_email: '', notes: '', position: 1, color: '#3B82F6', is_collapsed: false, created_at: '2026-01-01' }
    act(() => { result.current.addSwimlane(newSwimlane) })
    expect(result.current.board!.swimlanes).toHaveLength(2)
  })

  it('removeSwimlane removes swimlane and its cards', async () => {
    mockDeleteSwimlane.mockResolvedValue(undefined)
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => { await result.current.removeSwimlane(20) })
    expect(result.current.board!.swimlanes).toHaveLength(0)
    expect(result.current.board!.cards).toHaveLength(0)
  })

  it('updateCard updates existing card', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    const updated = { ...result.current.board!.cards[0], title: 'Renamed' }
    act(() => { result.current.updateCard(updated) })
    expect(result.current.board!.cards[0].title).toBe('Renamed')
  })

  it('updateColumn updates existing column', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    const updated = { ...result.current.board!.columns[0], name: 'Renamed' }
    act(() => { result.current.updateColumn(updated) })
    expect(result.current.board!.columns[0].name).toBe('Renamed')
  })

  it('addLabel adds label to board', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    const label: Label = { id: 1, name: 'Bug', color: '#EF4444' }
    act(() => { result.current.addLabel(label) })
    expect(result.current.board!.labels).toHaveLength(1)
  })

  it('updateSwimlane updates existing swimlane', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    const updated = { ...result.current.board!.swimlanes[0], name: 'Renamed Lane' }
    act(() => { result.current.updateSwimlane(updated) })
    expect(result.current.board!.swimlanes[0].name).toBe('Renamed Lane')
  })

  it('moveCard optimistically updates and then applies server response', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    const movedCard = { ...board.cards[0], column: 11, position: 0 }
    mockMoveCard.mockResolvedValue({ card: movedCard })

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => {
      await result.current.moveCard(100, 11, 20, 0)
    })

    expect(mockMoveCard).toHaveBeenCalledWith(1, 100, { column_id: 11, swimlane_id: 20, position: 0 })
    expect(result.current.board!.cards[0].column).toBe(11)
  })

  it('moveCard rolls back on error', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    mockMoveCard.mockRejectedValue(new Error('fail'))

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => {
      await result.current.moveCard(100, 11, 20, 0)
    })

    // Should roll back to original column
    expect(result.current.board!.cards[0].column).toBe(10)
  })

  it('reorderColumns optimistically updates and applies server response', async () => {
    const board = makeBoard({
      columns: [
        { id: 10, name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true },
        { id: 11, name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true },
      ],
    })
    mockGetBoardFull.mockResolvedValue(board)
    const reorderedCols = [board.columns[1], board.columns[0]]
    mockReorderColumns.mockResolvedValue(reorderedCols)

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => {
      await result.current.reorderColumns([11, 10])
    })

    expect(mockReorderColumns).toHaveBeenCalledWith(1, [11, 10])
  })

  it('reload re-fetches the board', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    mockGetBoardFull.mockResolvedValue(makeBoard({ name: 'Reloaded' }))
    act(() => { result.current.reload() })
    await waitFor(() => {
      expect(result.current.board!.name).toBe('Reloaded')
    })
  })
})
