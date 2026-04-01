import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useBoard } from '../hooks/useBoard'
import type { BoardFull, Card, Column, Swimlane, Label } from '../types'

const mockNavigate = vi.fn()

// Mock react-router-dom
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: '1' }),
  useNavigate: () => mockNavigate,
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
    uid: 'boarduid0001',
    name: 'Test Board',
    description: '',
    group: null,
    group_name: null,
    columns: [{ id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false }],
    swimlanes: [{ id: 20, uid: 'laneuid00001', name: 'Lane A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01T00:00:00Z' }],
    cards: [{
      id: 100, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Card 1', description: '', priority: 'medium',
      assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: 1,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
      version: 1,
    }],
    labels: [],
    members: [],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false,
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
    mockNavigate.mockClear()
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

  it('sets error when load fails with a non-404 error', async () => {
    mockGetBoardFull.mockRejectedValue(new Error('fail'))
    const { result } = renderHook(() => useBoard())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.error).toBe('Failed to load board')
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('navigates to / when board returns 404', async () => {
    mockGetBoardFull.mockRejectedValue({ response: { status: 404 } })
    renderHook(() => useBoard())

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
    })
  })

  it('navigates to / when board returns 403', async () => {
    mockGetBoardFull.mockRejectedValue({ response: { status: 403 } })
    renderHook(() => useBoard())

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
    })
  })

  it('addCard adds a new card', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())

    await waitFor(() => expect(result.current.board).not.toBeNull())

    const newCard: Card = {
      id: 200, uid: 'carduid00002', column: 10, swimlane: 20, title: 'New Card', description: '', priority: 'low',
      assignee: null, labels: [], due_date: null, weight: 1, position: 1, created_by: 1,
      created_at: '2026-01-01', updated_at: '2026-01-01', last_moved_at: null,
      attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
      version: 1,
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

    const newCol: Column = { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false }
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

    const newSwimlane: Swimlane = { id: 21, uid: 'laneuid00002', name: 'Lane B', contact_email: '', notes: '', position: 1, color: '#3B82F6', is_collapsed: false, created_at: '2026-01-01' }
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

    const label: Label = { id: 1, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }
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

    expect(mockMoveCard).toHaveBeenCalledWith(1, 100, { column_id: 11, swimlane_id: 20, position: 0, version: 1 })
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

  it('moveCard sets moveError on 409 wip_limit_exceeded and rolls back', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    mockMoveCard.mockRejectedValue({
      response: {
        status: 409,
        data: {
          code: 'wip_limit_exceeded',
          column_name: 'In Progress',
          current_count: 3,
          wip_limit: 3,
        },
      },
    })

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => {
      await result.current.moveCard(100, 11, 20, 0)
    })

    // Card must be rolled back to original column
    expect(result.current.board!.cards[0].column).toBe(10)
    // moveError must be populated with the server payload
    expect(result.current.moveError).toEqual({
      code: 'wip_limit_exceeded',
      column_name: 'In Progress',
      current_count: 3,
      wip_limit: 3,
    })
  })

  it('clearMoveError clears the moveError state', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    mockMoveCard.mockRejectedValue({
      response: {
        status: 409,
        data: {
          code: 'wip_limit_exceeded',
          column_name: 'In Progress',
          current_count: 2,
          wip_limit: 2,
        },
      },
    })

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => {
      await result.current.moveCard(100, 11, 20, 0)
    })

    expect(result.current.moveError).not.toBeNull()

    act(() => { result.current.clearMoveError() })
    expect(result.current.moveError).toBeNull()
  })

  it('moveCard rolls back on generic error without setting moveError', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    // A plain 500 error — no WIP-specific payload
    mockMoveCard.mockRejectedValue({ response: { status: 500, data: { detail: 'Server error' } } })

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => {
      await result.current.moveCard(100, 11, 20, 0)
    })

    expect(result.current.board!.cards[0].column).toBe(10)
    // moveError must not be set for non-409 errors
    expect(result.current.moveError).toBeNull()
  })

  it('reorderColumns optimistically updates and applies server response', async () => {
    const board = makeBoard({
      columns: [
        { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
        { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
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

  // ─── removeColumn rollback (#413) ───────────────────────────────────────────

  it('removeColumn re-fetches board on API failure', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    mockDeleteColumn.mockRejectedValue(new Error('Server error'))

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    // Column and its cards are optimistically removed
    await act(async () => { await result.current.removeColumn(10) })

    // On failure, load() is called to re-fetch — the mock still returns the
    // original board, so the column and cards should be restored.
    await waitFor(() => {
      expect(result.current.board!.columns).toHaveLength(1)
      expect(result.current.board!.columns[0].id).toBe(10)
    })
    expect(result.current.board!.cards).toHaveLength(1)
    // getBoardFull called twice: initial load + rollback re-fetch
    expect(mockGetBoardFull).toHaveBeenCalledTimes(2)
  })

  // ─── Hard-block 409 (#341) ────────────────────────────────────────────────

  it('moveCard sets moveError on 409 wip_hard_blocked and rolls back', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    mockMoveCard.mockRejectedValue({
      response: {
        status: 409,
        data: {
          code: 'wip_hard_blocked',
          column_name: 'In Progress',
          current_count: 3,
          wip_limit: 3,
        },
      },
    })

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => {
      await result.current.moveCard(100, 11, 20, 0)
    })

    // Card must be rolled back to original column
    expect(result.current.board!.cards[0].column).toBe(10)
    // moveError must reflect the hard block code
    expect(result.current.moveError).toEqual({
      code: 'wip_hard_blocked',
      column_name: 'In Progress',
      current_count: 3,
      wip_limit: 3,
    })
  })

  it('forceMoveCard is a no-op after a hard-block (pendingMove is never set)', async () => {
    // After a hard-block, forceMoveCard must not call the API again because
    // pendingMove is null. We verify this by checking that moveCard was only
    // called once (for the initial move) and not a second time via forceMoveCard.
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    mockMoveCard.mockRejectedValue({
      response: {
        status: 409,
        data: { code: 'wip_hard_blocked', column_name: 'In Progress', current_count: 3, wip_limit: 3 },
      },
    })

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => {
      await result.current.moveCard(100, 11, 20, 0)
    })

    mockMoveCard.mockClear()

    // forceMoveCard should be a no-op — pendingMove was never set
    await act(async () => {
      await result.current.forceMoveCard()
    })

    expect(mockMoveCard).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // #571 — UID-based WebSocket eviction helpers
  // -------------------------------------------------------------------------

  it('evictCardByUid removes the card with the matching uid', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.evictCardByUid('carduid00001') })
    expect(result.current.board!.cards).toHaveLength(0)
  })

  it('evictCardByUid is a no-op for an unknown uid', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.evictCardByUid('does-not-exist') })
    expect(result.current.board!.cards).toHaveLength(1)
  })

  it('evictColumn removes the column and its cards from state', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    // card[0] belongs to column id=10, uid='coluid000001'
    act(() => { result.current.evictColumn('coluid000001') })
    expect(result.current.board!.columns).toHaveLength(0)
    expect(result.current.board!.cards).toHaveLength(0)
  })

  it('evictColumn leaves cards in other columns intact', async () => {
    const board = makeBoard({
      columns: [
        { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
        { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
      ],
      cards: [
        { id: 100, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Card A', description: '', priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: 1, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1 },
        { id: 101, uid: 'carduid00002', column: 11, swimlane: 20, title: 'Card B', description: '', priority: 'low',    assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: 1, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1 },
      ],
    })
    mockGetBoardFull.mockResolvedValue(board)
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.evictColumn('coluid000001') })
    expect(result.current.board!.columns).toHaveLength(1)
    expect(result.current.board!.columns[0].uid).toBe('coluid000002')
    expect(result.current.board!.cards).toHaveLength(1)
    expect(result.current.board!.cards[0].uid).toBe('carduid00002')
  })

  it('evictSwimlane removes the swimlane and its cards from state', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    // card[0] belongs to swimlane id=20, uid='laneuid00001'
    act(() => { result.current.evictSwimlane('laneuid00001') })
    expect(result.current.board!.swimlanes).toHaveLength(0)
    expect(result.current.board!.cards).toHaveLength(0)
  })

  it('evictSwimlane leaves cards in other swimlanes intact', async () => {
    const board = makeBoard({
      swimlanes: [
        { id: 20, uid: 'laneuid00001', name: 'Lane A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '' },
        { id: 21, uid: 'laneuid00002', name: 'Lane B', contact_email: '', notes: '', position: 1, color: '#3B82F6', is_collapsed: false, created_at: '' },
      ],
      cards: [
        { id: 100, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Card A', description: '', priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: 1, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1 },
        { id: 101, uid: 'carduid00002', column: 10, swimlane: 21, title: 'Card B', description: '', priority: 'low',    assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: 1, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1 },
      ],
    })
    mockGetBoardFull.mockResolvedValue(board)
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.evictSwimlane('laneuid00001') })
    expect(result.current.board!.swimlanes).toHaveLength(1)
    expect(result.current.board!.swimlanes[0].uid).toBe('laneuid00002')
    expect(result.current.board!.cards).toHaveLength(1)
    expect(result.current.board!.cards[0].uid).toBe('carduid00002')
  })

  it('removeLabel removes the label with the matching uid', async () => {
    const board = makeBoard({
      labels: [{ id: 1, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }],
    })
    mockGetBoardFull.mockResolvedValue(board)
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.removeLabel('lbluid000001') })
    expect(result.current.board!.labels).toHaveLength(0)
  })
})
