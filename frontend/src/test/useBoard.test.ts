import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import BoardSettingsModal from '../components/Board/BoardSettingsModal'
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
  patchBoard: vi.fn(),
  reorderColumns: vi.fn(),
  reorderSwimlanes: vi.fn(),
  deleteSwimlane: vi.fn(),
  deleteColumn: vi.fn(),
  // Used only by the BoardSettingsModal render in the #1289 race test.
  exportBoardCsv: vi.fn(),
  exportBoardJson: vi.fn(),
  setBoardMember: vi.fn(),
  removeBoardMember: vi.fn(),
  deleteBoard: vi.fn(),
  enableBoardSharing: vi.fn(),
  disableBoardSharing: vi.fn(),
  getBoardExportHistory: vi.fn().mockResolvedValue({ results: [], count: 0, next: null, previous: null }),
}))

vi.mock('../api/cards', () => ({
  moveCard: vi.fn(),
}))

import { getBoardFull, reorderColumns, reorderSwimlanes, deleteSwimlane, deleteColumn, patchBoard } from '../api/boards'
import { moveCard } from '../api/cards'

const mockGetBoardFull = getBoardFull as ReturnType<typeof vi.fn>
const mockMoveCard = moveCard as ReturnType<typeof vi.fn>
const mockReorderColumns = reorderColumns as ReturnType<typeof vi.fn>
const mockReorderSwimlanes = reorderSwimlanes as ReturnType<typeof vi.fn>
const mockDeleteSwimlane = deleteSwimlane as ReturnType<typeof vi.fn>
const mockDeleteColumn = deleteColumn as ReturnType<typeof vi.fn>
const mockPatchBoard = patchBoard as ReturnType<typeof vi.fn>

function makeBoard(overrides: Partial<BoardFull> = {}): BoardFull {
  return {
    id: 1,
    uid: 'boarduid0001',
    archived_card_count: 0,
    name: 'Test Board',
    description: '',
    group: null,
    group_name: null,
    columns: [{ id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false }],
    swimlanes: [{ id: 20, uid: 'laneuid00001', name: 'Lane A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01T00:00:00Z' }],
    cards: [{
      id: 100, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Card 1', description: '', priority: 'medium',
      assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
      version: 1,
      custom_field_values: [],
      blocker_count: 0, external_ref: null,
    }],
    labels: [],
    members: [],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false, export_min_role: 'viewer', card_density: 'comfortable',
    is_starred: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    current_user_role: 'admin',
    custom_field_definitions: [],
    swimlane_custom_field_definitions: [],
    owner: { id: 1, username: 'admin', display_name: 'Admin User', avatar_url: '' },
    capabilities: { movement_export: false },
    share_token: null,
    share_token_expires_at: null,
    ...overrides,
  }
}

describe('useBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNavigate.mockClear()
  })

  it('ignores a stale silentReload response that resolves after a newer one (#1463)', async () => {
    mockGetBoardFull.mockResolvedValueOnce(makeBoard({ name: 'Initial' }))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let resolveOld!: (b: BoardFull) => void
    let resolveNew!: (b: BoardFull) => void
    mockGetBoardFull.mockReturnValueOnce(new Promise<BoardFull>((r) => { resolveOld = r }))
    mockGetBoardFull.mockReturnValueOnce(new Promise<BoardFull>((r) => { resolveNew = r }))
    const reload = result.current.silentReload
    act(() => { reload(); reload() })
    expect(result.current.silentReload).toBe(reload)

    await act(async () => { resolveNew(makeBoard({ name: 'Newer' })) })
    await act(async () => { resolveOld(makeBoard({ name: 'Older' })) })
    expect(result.current.board?.name).toBe('Newer')
  })

  it('a superseded load does not leave loading stuck (#1463)', async () => {
    let resolveLoad!: (b: BoardFull) => void
    let resolveSilent!: (b: BoardFull) => void
    mockGetBoardFull.mockReturnValueOnce(new Promise<BoardFull>((r) => { resolveLoad = r }))
    const { result } = renderHook(() => useBoard())
    expect(result.current.loading).toBe(true)
    mockGetBoardFull.mockReturnValueOnce(new Promise<BoardFull>((r) => { resolveSilent = r }))
    act(() => { result.current.silentReload() })
    await act(async () => { resolveLoad(makeBoard({ name: 'Old' })) })
    await act(async () => { resolveSilent(makeBoard({ name: 'New' })) })
    expect(result.current.loading).toBe(false)
    expect(result.current.board?.name).toBe('New')
  })

  it('a superseded failure does not set an error (#1463)', async () => {
    let rejectLoad!: (e: Error) => void
    mockGetBoardFull.mockReturnValueOnce(new Promise<BoardFull>((_r, rej) => { rejectLoad = rej }))
    const { result } = renderHook(() => useBoard())
    mockGetBoardFull.mockResolvedValueOnce(makeBoard({ name: 'Fresh' }))
    act(() => { result.current.silentReload() })
    await waitFor(() => expect(result.current.board?.name).toBe('Fresh'))
    await act(async () => { rejectLoad(new Error('late')) })
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('a failed silentReload that superseded an in-flight load falls back to load (#1463)', async () => {
    mockGetBoardFull.mockReturnValueOnce(new Promise<BoardFull>(() => {}))
    const { result } = renderHook(() => useBoard())
    mockGetBoardFull.mockRejectedValueOnce(new Error('net'))
    mockGetBoardFull.mockResolvedValueOnce(makeBoard({ name: 'Recovered' }))
    act(() => { result.current.silentReload() })
    await waitFor(() => expect(result.current.board?.name).toBe('Recovered'))
    expect(mockGetBoardFull).toHaveBeenCalledTimes(3)
    expect(result.current.loading).toBe(false)
  })

  it('a failed silentReload with no load pending stays silent (#1463)', async () => {
    mockGetBoardFull.mockResolvedValueOnce(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.loading).toBe(false))
    mockGetBoardFull.mockRejectedValueOnce(new Error('net'))
    await act(async () => { result.current.silentReload() })
    expect(result.current.error).toBeNull()
    expect(mockGetBoardFull).toHaveBeenCalledTimes(2)
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

    // Wrap render in act so the rejected promise is flushed before waitFor
    // asserts — without this the rejection races against the assertion.
    await act(async () => {
      renderHook(() => useBoard())
    })

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
      assignee: null, labels: [], due_date: null, weight: 1, position: 1, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" },
      created_at: '2026-01-01', updated_at: '2026-01-01', last_moved_at: null,
      attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
      version: 1,
      custom_field_values: [],
      blocker_count: 0, external_ref: null,
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

  // #1289 — archive / unarchive keep archived_card_count current so the
  // settings modal's delete gate sees cards archived during this session.
  it('archiveCard removes the card and increments archived_card_count', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard({ archived_card_count: 2 }))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.archiveCard(100) })
    expect(result.current.board!.cards).toHaveLength(0)
    expect(result.current.board!.archived_card_count).toBe(3)
  })

  it('archiveCard then archiveCardByUid for the same card counts it once (socket echo)', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.archiveCard(100) })
    act(() => { result.current.archiveCardByUid('carduid00001') })
    expect(result.current.board!.archived_card_count).toBe(1)
  })

  it('archiveCardByUid is a no-op for an unknown uid', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.archiveCardByUid('does-not-exist') })
    expect(result.current.board!.cards).toHaveLength(1)
    expect(result.current.board!.archived_card_count).toBe(0)
  })

  it('unarchiveCard restores the card and decrements archived_card_count once', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard({ cards: [], archived_card_count: 1 }))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    const restored = makeBoard().cards[0]
    act(() => { result.current.unarchiveCard(restored) })
    // A second call (the echoed card.unarchived event) updates in place.
    act(() => { result.current.unarchiveCard(restored) })
    expect(result.current.board!.cards).toHaveLength(1)
    expect(result.current.board!.archived_card_count).toBe(0)
  })

  it('a stale board.updated snapshot after archiving the last card cannot lower archived_card_count (#1289)', async () => {
    // Race: the local archive lands first, then a board.updated snapshot that
    // was serialized before it (archived_card_count: 0) arrives. Merging that
    // value would leave 0 active + 0 archived and a one-click delete.
    mockGetBoardFull.mockResolvedValue(makeBoard({ archived_card_count: 0 }))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.archiveCard(100) })
    act(() => { result.current.mergeBoardState({ archived_card_count: 0, name: 'Renamed' } as Partial<BoardFull>) })
    // The echoed card.archived can't re-add it: the card already left `cards`.
    act(() => { result.current.archiveCardByUid('carduid00001') })

    const board = result.current.board!
    expect(board.name).toBe('Renamed')
    expect(board.cards).toHaveLength(0)
    expect(board.archived_card_count).toBe(1)

    render(createElement(BoardSettingsModal, {
      board, isAdmin: true, onClose: vi.fn(), onBoardDeleted: vi.fn(), initialTab: 'data',
    }))
    expect(screen.getByRole('button', { name: 'Delete board' })).toBeDisabled()
    expect(screen.getByPlaceholderText('Renamed')).toBeInTheDocument()
  })

  it('a stale board.updated snapshot after an unarchive cannot re-raise archived_card_count (#1289)', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard({ cards: [], archived_card_count: 1 }))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.unarchiveCard(makeBoard().cards[0]) })
    act(() => { result.current.mergeBoardState({ archived_card_count: 1 } as Partial<BoardFull>) })
    expect(result.current.board!.archived_card_count).toBe(0)
  })

  it('addColumn adds new column', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    const newCol: Column = { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false }
    act(() => { result.current.addColumn(newCol) })
    expect(result.current.board!.columns).toHaveLength(2)
  })

  it('addColumn updates an existing column with a matching id instead of duplicating it', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    const updated: Column = { ...result.current.board!.columns[0], name: 'Renamed via echo' }
    act(() => { result.current.addColumn(updated) })
    expect(result.current.board!.columns).toHaveLength(1)
    expect(result.current.board!.columns[0].name).toBe('Renamed via echo')
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

  it('addSwimlane updates an existing swimlane with a matching id instead of duplicating it', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    const updated: Swimlane = { ...result.current.board!.swimlanes[0], name: 'Renamed via echo' }
    act(() => { result.current.addSwimlane(updated) })
    expect(result.current.board!.swimlanes).toHaveLength(1)
    expect(result.current.board!.swimlanes[0].name).toBe('Renamed via echo')
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

  it('updateLabel updates the label with the matching id', async () => {
    const board = makeBoard({ labels: [{ id: 1, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }] })
    mockGetBoardFull.mockResolvedValue(board)
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.updateLabel({ id: 1, uid: 'lbluid000001', name: 'Critical Bug', color: '#B91C1C' }) })
    expect(result.current.board!.labels[0]).toEqual({ id: 1, uid: 'lbluid000001', name: 'Critical Bug', color: '#B91C1C' })
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
        { id: 100, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Card A', description: '', priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0, external_ref: null },
        { id: 101, uid: 'carduid00002', column: 11, swimlane: 20, title: 'Card B', description: '', priority: 'low',    assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0, external_ref: null },
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
        { id: 100, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Card A', description: '', priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0, external_ref: null },
        { id: 101, uid: 'carduid00002', column: 10, swimlane: 21, title: 'Card B', description: '', priority: 'low',    assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0, external_ref: null },
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

  // #1290 — a member.* frame can arrive without is_site_admin (sent to admin
  // subscribers only); the known value must survive the row replacement.
  it('updateMember / addMember keep the known is_site_admin when a frame omits it', async () => {
    const root = { id: 3, username: 'root', display_name: 'Root', avatar_url: '' }
    mockGetBoardFull.mockResolvedValue(makeBoard({
      members: [{ id: 30, user: root, role: 'member', is_moderator: false, is_site_admin: true, joined_at: '' }],
    }))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.updateMember({ id: 30, user: root, role: 'viewer', joined_at: '' }) })
    expect(result.current.board!.members[0]).toMatchObject({ role: 'viewer', is_site_admin: true })

    act(() => { result.current.addMember({ id: 30, user: root, role: 'admin', joined_at: '' }) })
    expect(result.current.board!.members[0]).toMatchObject({ role: 'admin', is_site_admin: true })

    // A frame that does carry the field wins.
    act(() => { result.current.updateMember({ id: 30, user: root, role: 'admin', is_site_admin: false, joined_at: '' }) })
    expect(result.current.board!.members[0].is_site_admin).toBe(false)
  })

  it('addMember appends a membership that is not already present', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    const newUser = { id: 99, username: 'newbie', display_name: 'Newbie', avatar_url: '' }
    act(() => {
      result.current.addMember({ id: 40, user: newUser, role: 'member', joined_at: '' })
    })
    expect(result.current.board!.members).toHaveLength(1)
    expect(result.current.board!.members[0].user.id).toBe(99)
  })

  it('removeMember removes the membership for the given user id', async () => {
    const root = { id: 3, username: 'root', display_name: 'Root', avatar_url: '' }
    mockGetBoardFull.mockResolvedValue(makeBoard({
      members: [{ id: 30, user: root, role: 'member', joined_at: '' }],
    }))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.removeMember(3) })
    expect(result.current.board!.members).toHaveLength(0)
  })

  it('applyCustomFieldDefinitions replaces the board-level definitions wholesale', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => {
      result.current.applyCustomFieldDefinitions([
        {
          id: 1, uid: 'cfduid0001', name: 'Points', field_type: 'number', choices: [], choice_colors: {}, position: 0,
          show_on_card: false, is_required: false, help_text: '',
          number_prefix: '', number_suffix: '', number_decimals: null, created_at: '2026-01-01',
        },
      ])
    })
    expect(result.current.board!.custom_field_definitions).toHaveLength(1)
    expect(result.current.board!.custom_field_definitions[0].name).toBe('Points')
  })

  it('applySwimlaneFieldDefinitions replaces the swimlane-level definitions wholesale', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => {
      result.current.applySwimlaneFieldDefinitions([
        {
          id: 2, uid: 'sfduid0001', name: 'Owner', field_type: 'text', choices: [], choice_colors: {}, position: 0,
          show_on_row: false, is_admin_only: false, is_required: false, help_text: '',
          number_prefix: '', number_suffix: '', number_decimals: null, created_at: '2026-01-01',
        },
      ])
    })
    expect(result.current.board!.swimlane_custom_field_definitions).toHaveLength(1)
    expect(result.current.board!.swimlane_custom_field_definitions[0].name).toBe('Owner')
  })

  it('applyColumnOrder and applySwimlaneOrder replace the board arrays wholesale', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    const reorderedColumns = [...board.columns].reverse()
    act(() => { result.current.applyColumnOrder(reorderedColumns) })
    expect(result.current.board!.columns).toEqual(reorderedColumns)

    const reorderedSwimlanes = [...board.swimlanes].reverse()
    act(() => { result.current.applySwimlaneOrder(reorderedSwimlanes) })
    expect(result.current.board!.swimlanes).toEqual(reorderedSwimlanes)
  })

  // ─── silentReload (#…) — invisible tab-focus resync ────────────────────────

  it('silentReload replaces the board without flashing the loading flag', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    expect(result.current.loading).toBe(false)

    mockGetBoardFull.mockResolvedValue(makeBoard({ name: 'Silently Reloaded' }))
    await act(async () => { result.current.silentReload() })

    expect(result.current.board!.name).toBe('Silently Reloaded')
    // Never flips loading back to true — that's the whole point of "silent".
    expect(result.current.loading).toBe(false)
  })

  it('silentReload navigates away on 404/403 like the initial load', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    mockGetBoardFull.mockRejectedValue({ response: { status: 403 } })
    await act(async () => { result.current.silentReload() })

    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
  })

  it('silentReload swallows a non-404/403 error without surfacing it', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    const boardBefore = result.current.board

    mockGetBoardFull.mockRejectedValue(new Error('transient network blip'))
    await act(async () => { result.current.silentReload() })

    // Board state is untouched and no error/navigate side effect fires.
    expect(result.current.board).toEqual(boardBefore)
    expect(result.current.error).toBeNull()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  // ─── moveCard — remaining 409/403 branches ──────────────────────────────────

  it('moveCard sets moveError on 403 permission_denied and rolls back', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    mockMoveCard.mockRejectedValue({
      response: { status: 403, data: { detail: 'Viewers cannot move cards.' } },
    })

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => { await result.current.moveCard(100, 11, 20, 0) })

    expect(result.current.board!.cards[0].column).toBe(10)
    expect(result.current.moveError).toEqual({
      code: 'permission_denied',
      detail: 'Viewers cannot move cards.',
    })
  })

  it('moveCard falls back to generic copy on 403 with no detail', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    mockMoveCard.mockRejectedValue({ response: { status: 403, data: {} } })

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => { await result.current.moveCard(100, 11, 20, 0) })

    expect(result.current.moveError).toEqual({
      code: 'permission_denied',
      detail: 'You do not have permission to move this card.',
    })
  })

  it('moveCard reloads the board on 409 version_conflict', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValueOnce(board)
    mockMoveCard.mockRejectedValue({
      response: {
        status: 409,
        data: { code: 'version_conflict', detail: 'Card changed since you loaded it.', current_version: 2 },
      },
    })
    // The version-conflict branch calls load() to refetch — give it a fresh snapshot.
    const reloaded = makeBoard({ name: 'Reloaded After Conflict' })

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    mockGetBoardFull.mockResolvedValue(reloaded)
    await act(async () => { await result.current.moveCard(100, 11, 20, 0) })

    expect(result.current.moveError).toEqual({
      code: 'version_conflict',
      detail: 'Card changed since you loaded it.',
      current_version: 2,
    })
    await waitFor(() => {
      expect(result.current.board!.name).toBe('Reloaded After Conflict')
    })
  })

  it('moveCard sets pendingMove on 409 weight_limit_exceeded so forceMoveCard can retry', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    mockMoveCard.mockRejectedValueOnce({
      response: {
        status: 409,
        data: { code: 'weight_limit_exceeded', column_name: 'In Progress', current_weight: 20, weight_limit: 15, card_weight: 5 },
      },
    })

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => { await result.current.moveCard(100, 11, 20, 0) })
    expect(result.current.moveError).toMatchObject({ code: 'weight_limit_exceeded' })

    // forceMoveCard replays the pending move with force=true.
    const movedCard = { ...board.cards[0], column: 11, position: 0 }
    mockMoveCard.mockResolvedValueOnce({ card: movedCard })
    await act(async () => { await result.current.forceMoveCard() })

    expect(mockMoveCard).toHaveBeenLastCalledWith(1, 100, { column_id: 11, swimlane_id: 20, position: 0 }, true)
    expect(result.current.moveError).toBeNull()
    expect(result.current.board!.cards[0].column).toBe(11)
  })

  it('forceMoveCard rolls back and surfaces a structured error when the retry itself fails', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    mockMoveCard.mockRejectedValueOnce({
      response: {
        status: 409,
        data: { code: 'wip_limit_exceeded', column_name: 'In Progress', current_count: 3, wip_limit: 3 },
      },
    })

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => { await result.current.moveCard(100, 11, 20, 0) })

    mockMoveCard.mockRejectedValueOnce({
      response: { status: 500, data: { code: 'server_error', detail: 'Boom' } },
    })
    await act(async () => { await result.current.forceMoveCard() })

    // Rolled back to the original column, and the retry's own error is surfaced.
    expect(result.current.board!.cards[0].column).toBe(10)
    expect(result.current.moveError).toMatchObject({ code: 'server_error' })
  })

  // ─── reorderColumns / reorderSwimlanes — failure paths ──────────────────────

  it('reorderColumns rolls back to the previous order on API failure', async () => {
    const board = makeBoard({
      columns: [
        { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
        { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false },
      ],
    })
    mockGetBoardFull.mockResolvedValue(board)
    mockReorderColumns.mockRejectedValue(new Error('server error'))

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => { await result.current.reorderColumns([11, 10]) })

    expect(result.current.board!.columns.map((c) => c.id)).toEqual([10, 11])
  })

  it('reorderSwimlanes optimistically updates and applies the server response', async () => {
    const board = makeBoard({
      swimlanes: [
        { id: 20, uid: 'laneuid00001', name: 'Lane A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '' },
        { id: 21, uid: 'laneuid00002', name: 'Lane B', contact_email: '', notes: '', position: 1, color: '#3B82F6', is_collapsed: false, created_at: '' },
      ],
    })
    mockGetBoardFull.mockResolvedValue(board)
    const reordered = [board.swimlanes[1], board.swimlanes[0]]
    mockReorderSwimlanes.mockResolvedValue(reordered)

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => { await result.current.reorderSwimlanes([21, 20]) })

    expect(mockReorderSwimlanes).toHaveBeenCalledWith(1, [21, 20])
    expect(result.current.board!.swimlanes.map((s) => s.id)).toEqual([21, 20])
  })

  it('removeSwimlane re-fetches the board on API failure', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValueOnce(board)
    mockDeleteSwimlane.mockRejectedValue(new Error('server error'))

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    // The mock still returns the original board on reload, restoring the swimlane and its cards.
    mockGetBoardFull.mockResolvedValue(board)
    await act(async () => { await result.current.removeSwimlane(20) })

    await waitFor(() => {
      expect(result.current.board!.swimlanes).toHaveLength(1)
    })
    expect(result.current.board!.cards).toHaveLength(1)
  })

  it('reorderSwimlanes re-fetches the board on API failure rather than rolling back to a stale snapshot', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValueOnce(board)
    mockReorderSwimlanes.mockRejectedValue(new Error('server error'))

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    const reloaded = makeBoard({ name: 'Reloaded After Reorder Failure' })
    mockGetBoardFull.mockResolvedValue(reloaded)
    await act(async () => { await result.current.reorderSwimlanes([20]) })

    await waitFor(() => {
      expect(result.current.board!.name).toBe('Reloaded After Reorder Failure')
    })
  })

  // ─── updateBoardSettings — optimistic patch + rollback-via-reload ──────────

  it('updateBoardSettings applies the patch optimistically and persists it', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    mockPatchBoard.mockResolvedValue(undefined)
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => { await result.current.updateBoardSettings({ name: 'Patched Name' }) })

    expect(mockPatchBoard).toHaveBeenCalledWith(1, { name: 'Patched Name' })
    expect(result.current.board!.name).toBe('Patched Name')
  })

  it('updateBoardSettings reloads fresh state when the patch API call fails', async () => {
    mockGetBoardFull.mockResolvedValueOnce(makeBoard())
    mockPatchBoard.mockRejectedValue(new Error('validation failed'))

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    const reloaded = makeBoard({ name: 'Reloaded After Patch Failure' })
    mockGetBoardFull.mockResolvedValue(reloaded)
    await act(async () => { await result.current.updateBoardSettings({ name: 'Will Not Stick' }) })

    await waitFor(() => {
      expect(result.current.board!.name).toBe('Reloaded After Patch Failure')
    })
  })
})

describe('useBoard — maintenance mode (#783)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNavigate.mockClear()
  })

  it('moveCard explains a 503 instead of silently reverting', async () => {
    // Without this branch the optimistic move makes the drag look like it
    // succeeded, then the card snaps back with no message at all.
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    mockMoveCard.mockRejectedValue({
      response: {
        status: 503,
        data: { code: 'maintenance_mode', detail: 'Back by 14:00 UTC.' },
      },
    })

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => {
      await result.current.moveCard(100, 11, 20, 0)
    })

    expect(result.current.board!.cards[0].column).toBe(10)
    expect(result.current.moveError).toEqual({
      code: 'maintenance_mode',
      detail: 'Back by 14:00 UTC.',
    })
  })

  it('falls back to generic copy when the 503 carries no detail', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    mockMoveCard.mockRejectedValue({
      response: { status: 503, data: { code: 'maintenance_mode' } },
    })

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => {
      await result.current.moveCard(100, 11, 20, 0)
    })

    expect(result.current.moveError).toEqual({
      code: 'maintenance_mode',
      detail: 'Maintenance mode is active.',
    })
  })

  it('ignores a 503 that is not a maintenance response', async () => {
    // A proxy or an overloaded backend also returns 503; claiming maintenance
    // mode for those would be a lie. Roll back, but say nothing specific.
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    mockMoveCard.mockRejectedValue({
      response: { status: 503, data: '<html>502 Bad Gateway</html>' },
    })

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => {
      await result.current.moveCard(100, 11, 20, 0)
    })

    expect(result.current.board!.cards[0].column).toBe(10)
    expect(result.current.moveError).toBeNull()
  })
})
