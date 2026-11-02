import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import BoardSettingsModal from '../components/Board/BoardSettingsModal'
import { useBoard } from '../hooks/useBoard'
import type { BoardFull, Card, Column, Swimlane, Label } from '../types'

const mockNavigate = vi.fn()

// Mock react-router-dom
let mockParamId = '1'
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: mockParamId }),
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
  getArchivedCards: vi.fn(),
}))

import { getBoardFull, reorderColumns, reorderSwimlanes, deleteSwimlane, deleteColumn, patchBoard } from '../api/boards'
import { moveCard, getArchivedCards } from '../api/cards'
const mockGetArchivedCards = getArchivedCards as ReturnType<typeof vi.fn>

const mockGetBoardFull = getBoardFull as ReturnType<typeof vi.fn>
const mockMoveCard = moveCard as ReturnType<typeof vi.fn>
const mockReorderColumns = reorderColumns as ReturnType<typeof vi.fn>
const mockReorderSwimlanes = reorderSwimlanes as ReturnType<typeof vi.fn>
const mockDeleteSwimlane = deleteSwimlane as ReturnType<typeof vi.fn>
const mockDeleteColumn = deleteColumn as ReturnType<typeof vi.fn>
const mockPatchBoard = patchBoard as ReturnType<typeof vi.fn>

function makeBoard(overrides: Partial<BoardFull> = {}): BoardFull {
  return {
    health_status: null, effective_health_status: null, health_status_source: null,
    id: 1,
    uid: 'boarduid0001',
    archived_card_count: 0,
    name: 'Test Board',
    description: '',
    group: null,
    group_name: null,
    columns: [{ id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null }],
    swimlanes: [{ id: 20, uid: 'laneuid00001', name: 'Lane A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '2026-01-01T00:00:00Z', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null }],
    cards: [{
      id: 100, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Card 1', description: '', priority: 'medium',
      assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null,
      version: 1,
      custom_field_values: [],
      blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
    }],
    labels: [],
    members: [],
    staleness_threshold_days: 7, stale_warning_pct: 50, allowed_priorities: [],
    enforce_wip_limits: false, enforce_wip_hard: false, enforce_weight_limits: false, show_wip_at_limit: false, show_row_chip_field_names: true, export_min_role: 'viewer', card_density: 'comfortable',
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
    share_link_active: false,
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
      blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '',
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

    const newCol: Column = { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null }
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

    const newSwimlane: Swimlane = { id: 21, uid: 'laneuid00002', name: 'Lane B', contact_email: '', notes: '', position: 1, color: '#3B82F6', is_collapsed: false, created_at: '2026-01-01', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null }
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

    let outcome: unknown
    await act(async () => {
      outcome = await result.current.moveCard(100, 11, 20, 0)
    })

    expect(outcome).toEqual({ ok: true })
    expect(mockMoveCard).toHaveBeenCalledWith(1, 100, { column_id: 11, swimlane_id: 20, position: 0, version: 1 })
    expect(result.current.board!.cards[0].column).toBe(11)
  })

  it('moveCard rolls back on error and reports the failure to the caller', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    const failure = new Error('fail')
    mockMoveCard.mockRejectedValue(failure)

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    let outcome: unknown
    await act(async () => {
      outcome = await result.current.moveCard(100, 11, 20, 0)
    })

    // Never rejects (drag-and-drop voids the call); failure is in the result (#1761).
    expect(outcome).toEqual({ ok: false, error: failure })

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

  describe('swimlane limits (#1150)', () => {
    // Doing (11) at its column WIP limit; Lane B (21) at its own limit too.
    const limitedBoard = () => makeBoard({
      enforce_wip_limits: true,
      columns: [
        { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
        { id: 11, uid: 'coluid000002', name: 'Doing', position: 1, color: '#3B82F6', wip_limit: 1, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
      ],
      swimlanes: [
        { id: 20, uid: 'laneuid00001', name: 'Lane A', position: 0, color: '#6B7280', is_collapsed: false, created_at: '', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null },
        { id: 21, uid: 'laneuid00002', name: 'Lane B', position: 1, color: '#6B7280', is_collapsed: false, created_at: '', wip_limit: 1, weight_limit: null, limit_enforcement: 'hard', limit_column_ids: [10, 11] },
      ],
      cards: [
        { ...makeBoard().cards[0] },
        { ...makeBoard().cards[0], id: 101, uid: 'carduid00002', column: 11, swimlane: 21 },
      ],
    })

    it('a hard row refusal names the column limit it also tripped, and offers no retry', async () => {
      mockGetBoardFull.mockResolvedValue(limitedBoard())
      mockMoveCard.mockRejectedValueOnce({ response: { status: 409, data: {
        code: 'swimlane_wip_hard_blocked', detail: 'Swimlane WIP limit enforced — move blocked.',
        column_name: 'Doing', swimlane_name: 'Lane B', current_count: 1, wip_limit: 1,
      } } })
      const { result } = renderHook(() => useBoard())
      await waitFor(() => expect(result.current.board).not.toBeNull())
      await act(async () => { await result.current.moveCard(100, 11, 21, 0) })
      expect(result.current.moveError).toMatchObject({
        code: 'swimlane_wip_hard_blocked',
        also: ['Column "Doing" is at its WIP limit (1/1), admins can override.'],
      })
      expect(result.current.board!.cards[0]).toMatchObject({ column: 10, swimlane: 20 })
      // Hard: forceMoveCard has nothing to replay.
      await act(async () => { await result.current.forceMoveCard() })
      expect(mockMoveCard).toHaveBeenCalledTimes(1)
    })

    it('a soft row refusal keeps the move for the admin override', async () => {
      const board = limitedBoard()
      mockGetBoardFull.mockResolvedValue(board)
      mockMoveCard.mockRejectedValueOnce({ response: { status: 409, data: {
        code: 'swimlane_wip_limit_exceeded', column_name: 'To Do', swimlane_name: 'Lane B',
        current_count: 1, wip_limit: 1,
      } } })
      mockMoveCard.mockResolvedValueOnce({ card: { ...board.cards[0], swimlane: 21, version: 2 } })
      const { result } = renderHook(() => useBoard())
      await waitFor(() => expect(result.current.board).not.toBeNull())
      await act(async () => { await result.current.moveCard(100, 10, 21, 0) })
      // Only the row tripped (the card stays in To Do): no `also`.
      expect(result.current.moveError).toEqual({
        code: 'swimlane_wip_limit_exceeded', column_name: 'To Do', swimlane_name: 'Lane B',
        current_count: 1, wip_limit: 1,
      })
      await act(async () => { await result.current.forceMoveCard() })
      expect(mockMoveCard).toHaveBeenLastCalledWith(1, 100, { column_id: 10, swimlane_id: 21, position: 0 }, true)
    })

    it('evictColumn drops the column from every row limit, nulling an emptied list', async () => {
      const board = limitedBoard()
      board.swimlanes[0] = { ...board.swimlanes[0], limit_column_ids: [11] }
      mockGetBoardFull.mockResolvedValue(board)
      const { result } = renderHook(() => useBoard())
      await waitFor(() => expect(result.current.board).not.toBeNull())
      act(() => { result.current.evictColumn('coluid000002') })
      expect(result.current.board!.swimlanes.map((s) => s.limit_column_ids)).toEqual([null, [10]])
    })
  })

  it('moveCard raises a move_failed toast for a network error (#1761)', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    mockMoveCard.mockRejectedValue(Object.assign(new Error('Network Error'), { isAxiosError: true }))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    await act(async () => { await result.current.moveCard(100, 11, 20, 0) })
    expect(result.current.moveError).toEqual({ code: 'move_failed', detail: 'A network error occurred.' })
  })

  it('moveCard explains a 404 and refreshes the board (#1761)', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    mockMoveCard.mockRejectedValue({ response: { status: 404, data: {} } })
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    await act(async () => { await result.current.moveCard(100, 11, 20, 0) })
    expect(result.current.moveError).toEqual({ code: 'move_failed', detail: 'The card or board no longer exists, so the board was refreshed.' })
  })

  it('a later successful move clears a stale move_failed toast (#1761)', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    mockMoveCard.mockRejectedValueOnce(Object.assign(new Error('Network Error'), { isAxiosError: true }))
    mockMoveCard.mockResolvedValueOnce({ card: { ...board.cards[0], column: 11 } })
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    await act(async () => { await result.current.moveCard(100, 11, 20, 0) })
    expect(result.current.moveError?.code).toBe('move_failed')
    await act(async () => { await result.current.moveCard(100, 11, 20, 0) })
    expect(result.current.moveError).toBeNull()
  })

  it('forceMoveCard raises move_failed on a network error (#1761)', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    mockMoveCard.mockRejectedValueOnce({ response: { status: 409, data: { code: 'wip_limit_exceeded', column_name: 'X', current_count: 1, wip_limit: 1 } } })
    mockMoveCard.mockRejectedValueOnce(Object.assign(new Error('Network Error'), { isAxiosError: true }))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    await act(async () => { await result.current.moveCard(100, 11, 20, 0) })
    await act(async () => { await result.current.forceMoveCard() })
    expect(result.current.moveError).toEqual({ code: 'move_failed', detail: 'A network error occurred.' })
    expect(result.current.board!.cards[0].column).toBe(10)
  })

  it('forceMoveCard maps an unknown error code to move_failed, not a broken limit toast (#1761)', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValue(board)
    mockMoveCard.mockRejectedValueOnce({ response: { status: 409, data: { code: 'wip_limit_exceeded', column_name: 'X', current_count: 1, wip_limit: 1 } } })
    mockMoveCard.mockRejectedValueOnce(Object.assign(new Error('x'), { isAxiosError: true, response: { status: 429, data: { code: 'throttled' } } }))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    await act(async () => { await result.current.moveCard(100, 11, 20, 0) })
    await act(async () => { await result.current.forceMoveCard() })
    expect(result.current.moveError?.code).toBe('move_failed')
  })

  it('moveCard does not replace a specific 409 limit toast with move_failed (#1761)', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    mockMoveCard.mockRejectedValue({ response: { status: 409, data: { code: 'wip_limit_exceeded', column_name: 'X', current_count: 1, wip_limit: 1 } } })
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    await act(async () => { await result.current.moveCard(100, 11, 20, 0) })
    expect(result.current.moveError?.code).toBe('wip_limit_exceeded')
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

  it('moveCard rolls back on generic error with a generic move_failed toast', async () => {
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
    // No specific code applies, so the generic toast is raised (#1761)
    expect(result.current.moveError?.code).toBe('move_failed')
  })

  it('reorderColumns optimistically updates and applies server response', async () => {
    const board = makeBoard({
      columns: [
        { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
        { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
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
        { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
        { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
      ],
      cards: [
        { id: 100, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Card A', description: '', priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '' },
        { id: 101, uid: 'carduid00002', column: 11, swimlane: 20, title: 'Card B', description: '', priority: 'low',    assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '' },
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

  it('evictColumn refreshes archived_card_count from the server (#1637)', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard({ archived_card_count: 5 }))
    mockGetArchivedCards.mockResolvedValue({ count: 2, offset: 0, page_size: 50, results: [] })
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.evictColumn('coluid000001') })
    await waitFor(() => expect(result.current.board!.archived_card_count).toBe(2))
    expect(mockGetArchivedCards).toHaveBeenCalledWith(1, 0)
  })

  it('evictSwimlane refreshes archived_card_count from the server (#1637)', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard({ archived_card_count: 5 }))
    mockGetArchivedCards.mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] })
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.evictSwimlane('laneuid00001') })
    await waitFor(() => expect(result.current.board!.archived_card_count).toBe(0))
  })

  it('evict keeps the old archived_card_count when the refresh fails, and skips it at zero (#1637)', async () => {
    mockGetArchivedCards.mockReset()
    mockGetBoardFull.mockResolvedValue(makeBoard({ archived_card_count: 3 }))
    mockGetArchivedCards.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    act(() => { result.current.evictColumn('coluid000001') })
    await waitFor(() => expect(mockGetArchivedCards).toHaveBeenCalledTimes(1))
    expect(result.current.board!.archived_card_count).toBe(3)

    mockGetArchivedCards.mockClear()
    mockGetBoardFull.mockResolvedValue(makeBoard({ archived_card_count: 0 }))
    const second = renderHook(() => useBoard())
    await waitFor(() => expect(second.result.current.board).not.toBeNull())
    act(() => { second.result.current.evictColumn('coluid000001') })
    expect(mockGetArchivedCards).not.toHaveBeenCalled()
  })

  it('removeColumn refreshes archived_card_count after a successful delete (#1637)', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard({ archived_card_count: 5 }))
    mockDeleteColumn.mockResolvedValue(undefined)
    mockGetArchivedCards.mockResolvedValue({ count: 1, offset: 0, page_size: 50, results: [] })
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => { await result.current.removeColumn(10) })
    await waitFor(() => expect(result.current.board!.archived_card_count).toBe(1))
  })

  it('removeSwimlane refreshes archived_card_count after a successful delete (#1637)', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard({ archived_card_count: 5 }))
    mockDeleteSwimlane.mockResolvedValue(undefined)
    mockGetArchivedCards.mockResolvedValue({ count: 0, offset: 0, page_size: 50, results: [] })
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    await act(async () => { await result.current.removeSwimlane(20) })
    await waitFor(() => expect(result.current.board!.archived_card_count).toBe(0))
  })

  it('discards a count refresh that was overtaken by a local archive (#1637)', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard({
      archived_card_count: 2,
      columns: [
        { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
        { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
      ],
    }))
    let resolveCount: (v: unknown) => void = () => {}
    mockGetArchivedCards.mockReturnValue(new Promise((r) => { resolveCount = r }))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.evictColumn('coluid000002') })
    // card 100 (in column 10) is archived locally while the request is in flight.
    act(() => { result.current.archiveCard(result.current.board!.cards[0].id) })
    expect(result.current.board!.archived_card_count).toBe(3)

    await act(async () => { resolveCount({ count: 2, offset: 0, page_size: 50, results: [] }) })
    expect(result.current.board!.archived_card_count).toBe(3)
  })

  it('discards a count refresh overtaken by a full reload (#1637)', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard({ archived_card_count: 2 }))
    let resolveCount: (v: unknown) => void = () => {}
    mockGetArchivedCards.mockReturnValue(new Promise((r) => { resolveCount = r }))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.evictColumn('coluid000001') })
    mockGetBoardFull.mockResolvedValue(makeBoard({ archived_card_count: 4 }))
    await act(async () => { result.current.silentReload() })
    await waitFor(() => expect(result.current.board!.archived_card_count).toBe(4))

    await act(async () => { resolveCount({ count: 1, offset: 0, page_size: 50, results: [] }) })
    expect(result.current.board!.archived_card_count).toBe(4)
  })

  it('never writes a late board A count onto board B (#1637)', async () => {
    mockParamId = '1'
    mockGetBoardFull.mockResolvedValue(makeBoard({ archived_card_count: 2 }))
    let resolveCount: (v: unknown) => void = () => {}
    mockGetArchivedCards.mockReturnValue(new Promise((r) => { resolveCount = r }))
    const { result, rerender } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    act(() => { result.current.evictColumn('coluid000001') })

    mockParamId = '2'
    mockGetBoardFull.mockResolvedValue(makeBoard({ id: 2, archived_card_count: 7 }))
    rerender()
    await waitFor(() => expect(result.current.board!.id).toBe(2))

    await act(async () => { resolveCount({ count: 1, offset: 0, page_size: 50, results: [] }) })
    expect(result.current.board!.archived_card_count).toBe(7)
    mockParamId = '1'
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
        { id: 20, uid: 'laneuid00001', name: 'Lane A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null },
        { id: 21, uid: 'laneuid00002', name: 'Lane B', contact_email: '', notes: '', position: 1, color: '#3B82F6', is_collapsed: false, created_at: '', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null },
      ],
      cards: [
        { id: 100, uid: 'carduid00001', column: 10, swimlane: 20, title: 'Card A', description: '', priority: 'medium', assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '' },
        { id: 101, uid: 'carduid00002', column: 10, swimlane: 21, title: 'Card B', description: '', priority: 'low',    assignee: null, labels: [], due_date: null, weight: 1, position: 0, created_by: { id: 1, username: "user1", display_name: "User 1", avatar_url: "" }, created_at: '', updated_at: '', last_moved_at: null, attachment_count: 0, checklist_total: 0, checklist_done: 0, is_stale: false, archived_at: null, version: 1, custom_field_values: [], blocker_count: 0, external_ref: null, is_blocked: false, blocked_at: null, blocked_reason: '' },
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

  it('removeLabel strips the label from cards, leaving other cards and labels untouched (#1888)', async () => {
    const bug = { id: 1, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }
    const keep = { id: 2, uid: 'lbluid000002', name: 'Keep', color: '#22C55E' }
    const base = makeBoard({ labels: [bug, keep] })
    const tmpl = base.cards[0] ?? ({} as never)
    const cards = [
      { ...tmpl, id: 101, uid: 'carduid00101', labels: [bug, keep] },
      { ...tmpl, id: 102, uid: 'carduid00102', labels: [keep] },
    ]
    mockGetBoardFull.mockResolvedValue({ ...base, cards })
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    const untouched = result.current.board!.cards[1]

    act(() => { result.current.removeLabel('lbluid000001') })
    const b = result.current.board!
    expect(b.labels.map((l) => l.uid)).toEqual(['lbluid000002'])
    expect(b.cards[0].labels.map((l) => l.uid)).toEqual(['lbluid000002'])
    expect(b.cards[1]).toBe(untouched)
  })

  it('removeLabel with an unknown uid is a no-op on cards (#1888)', async () => {
    const keep = { id: 2, uid: 'lbluid000002', name: 'Keep', color: '#22C55E' }
    const base = makeBoard({ labels: [keep] })
    const tmpl = base.cards[0] ?? ({} as never)
    mockGetBoardFull.mockResolvedValue({ ...base, cards: [{ ...tmpl, id: 101, uid: 'carduid00101', labels: [keep] }] })
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    const before = result.current.board!.cards[0]

    act(() => { result.current.removeLabel('nope') })
    expect(result.current.board!.cards[0]).toBe(before)
    expect(result.current.board!.labels).toHaveLength(1)
  })

  it('updateLabel propagates name/color onto cards holding it, preserving other cards (#1888)', async () => {
    const bug = { id: 1, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }
    const keep = { id: 2, uid: 'lbluid000002', name: 'Keep', color: '#22C55E' }
    const base = makeBoard({ labels: [bug, keep] })
    const tmpl = base.cards[0]
    mockGetBoardFull.mockResolvedValue({ ...base, cards: [
      { ...tmpl, id: 101, uid: 'carduid00101', labels: [bug, keep] },
      { ...tmpl, id: 102, uid: 'carduid00102', labels: [keep] },
    ] })
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    const untouched = result.current.board!.cards[1]

    act(() => { result.current.updateLabel({ ...bug, name: 'Defect', color: '#000000' }) })
    const b = result.current.board!
    expect(b.cards[0].labels[0]).toMatchObject({ id: 1, name: 'Defect', color: '#000000' })
    expect(b.cards[0].labels[1]).toBe(keep)
    expect(b.cards[1]).toBe(untouched)
  })

  it('updateCard drops a label that is no longer on the board (#1888)', async () => {
    const bug = { id: 1, uid: 'lbluid000001', name: 'Bug', color: '#EF4444' }
    const keep = { id: 2, uid: 'lbluid000002', name: 'Keep', color: '#22C55E' }
    const base = makeBoard({ labels: [keep] })
    const tmpl = base.cards[0]
    mockGetBoardFull.mockResolvedValue({ ...base, cards: [{ ...tmpl, id: 101, uid: 'carduid00101', labels: [keep] }] })
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    // a response/echo built before label.deleted still carries the deleted label
    act(() => { result.current.updateCard({ ...tmpl, id: 101, uid: 'carduid00101', labels: [bug, keep], version: 9 } as never) })
    const c = result.current.board!.cards[0]
    expect(c.labels).toEqual([keep])
    expect(c.version).toBe(9)

    // a clean card is stored as given (identity preserved)
    const clean = { ...tmpl, id: 101, uid: 'carduid00101', labels: [keep], version: 10 } as never
    act(() => { result.current.updateCard(clean) })
    expect(result.current.board!.cards[0]).toBe(clean)
  })

  // #1301 — a membership frame never carries has_all_content_access; the
  // known value must survive so the panel keeps showing effective access.
  it('updateMember keeps the known has_all_content_access when a frame omits it (#1301)', async () => {
    const root = { id: 3, username: 'root', display_name: 'Root', avatar_url: '' }
    mockGetBoardFull.mockResolvedValue({
      ...makeBoard(),
      members: [{ id: 30, user: root, role: 'viewer', is_moderator: false, has_all_content_access: true, joined_at: '' }],
    })
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    act(() => { result.current.updateMember({ id: 30, user: root, role: 'member', joined_at: '' }) })
    expect(result.current.board!.members[0]).toMatchObject({ role: 'member', has_all_content_access: true })
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

  // #1301 — removing an all-content user's membership leaves their access
  // intact, so the row stays, as a refetch would return it.
  it('removeMember keeps an all-content user listed without a membership (#1301)', async () => {
    const root = { id: 3, username: 'root', display_name: 'Root', avatar_url: '' }
    mockGetBoardFull.mockResolvedValue(makeBoard({
      members: [{ id: 30, user: root, role: 'viewer', has_all_content_access: true, joined_at: '' }],
    }))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.removeMember(3) })
    expect(result.current.board!.members).toHaveLength(1)
    expect(result.current.board!.members[0]).toMatchObject({ id: null, role: 'site_admin', has_all_content_access: true })
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

  it('applyCustomFieldDefinitions updaters compose when queued before a re-render (#1970)', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    const def = (id: number, name: string) => ({
      id, uid: `cfduid${id}`, name, field_type: 'number', choices: [], choice_colors: {}, position: id,
      show_on_card: false, is_required: false, help_text: '',
      number_prefix: '', number_suffix: '', number_decimals: null, created_at: '2026-01-01',
    }) as never
    act(() => {
      result.current.applyCustomFieldDefinitions((prev) => [...prev, def(1, 'A')])
      result.current.applyCustomFieldDefinitions((prev) => [...prev, def(2, 'B')])
      result.current.applyCustomFieldDefinitions((prev) => prev.map((f) => (f.id === 1 ? def(1, 'A2') : f)))
    })
    expect(result.current.board!.custom_field_definitions.map((f) => f.name)).toEqual(['A2', 'B'])
  })

  it('applySwimlaneFieldDefinitions updaters compose when queued before a re-render (#1970)', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    const def = (id: number, name: string) => ({
      id, uid: `sfduid${id}`, name, field_type: 'text', choices: [], choice_colors: {}, position: id,
      show_on_row: false, is_admin_only: false, is_required: false, help_text: '',
      number_prefix: '', number_suffix: '', number_decimals: null, created_at: '2026-01-01',
    }) as never
    act(() => {
      result.current.applySwimlaneFieldDefinitions((prev) => [...prev, def(1, 'A')])
      result.current.applySwimlaneFieldDefinitions((prev) => [...prev, def(2, 'B')])
    })
    expect(result.current.board!.swimlane_custom_field_definitions.map((f) => f.name)).toEqual(['A', 'B'])
  })

  it('updateSwimlane accepts a resolver fed the latest board (#1970)', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    const existing = result.current.board!.swimlanes[0]
    expect(existing).toBeDefined()
    act(() => {
      result.current.updateSwimlane((b) => ({ ...b.swimlanes.find((s) => s.id === existing.id)!, name: 'Resolved' }))
    })
    expect(result.current.board!.swimlanes.find((s) => s.id === existing.id)!.name).toBe('Resolved')
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

  it('moveCard reloads the board on 404 and leaves the page when access was lost', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValueOnce(board)
    mockMoveCard.mockRejectedValue({ response: { status: 404, data: {} } })

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    mockGetBoardFull.mockRejectedValue({ response: { status: 404 } })
    mockGetBoardFull.mockClear()
    await act(async () => { await result.current.moveCard(100, 11, 20, 0) })

    await waitFor(() => expect(mockGetBoardFull).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true }))
    expect(result.current.board!.cards[0].column).toBe(10)
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

  it('forceMoveCard rolls back and surfaces a generic move_failed when the retry fails with an unknown code', async () => {
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
    // An unknown code can't render in the limit toast, so it becomes move_failed (#1761).
    expect(result.current.moveError?.code).toBe('move_failed')
  })

  // CardDetail's Move popover forces its own target, never the shared pendingMove (#1772).
  describe('forceMoveCardTo (#1772)', () => {
    it('forces the explicit target with no pendingMove and no version, and reports ok', async () => {
      const board = makeBoard()
      mockGetBoardFull.mockResolvedValue(board)
      const { result } = renderHook(() => useBoard())
      await waitFor(() => expect(result.current.board).not.toBeNull())

      const movedCard = { ...board.cards[0], column: 11, position: 9999, version: 2 }
      mockMoveCard.mockResolvedValueOnce({ card: movedCard })
      let outcome: unknown
      await act(async () => { outcome = await result.current.forceMoveCardTo(100, 11, 20, 9999) })

      expect(outcome).toEqual({ ok: true })
      expect(mockMoveCard).toHaveBeenLastCalledWith(1, 100, { column_id: 11, swimlane_id: 20, position: 9999 }, true)
      expect(result.current.board!.cards[0]).toEqual(movedCard)
      expect(result.current.moveError).toBeNull()
    })

    it('uses its own arguments over a pendingMove and clears the earlier limit toast', async () => {
      const board = makeBoard()
      mockGetBoardFull.mockResolvedValue(board)
      mockMoveCard.mockRejectedValueOnce({
        response: { status: 409, data: { code: 'wip_limit_exceeded', column_name: 'In Progress', current_count: 3, wip_limit: 3 } },
      })
      const { result } = renderHook(() => useBoard())
      await waitFor(() => expect(result.current.board).not.toBeNull())
      await act(async () => { await result.current.moveCard(100, 11, 20, 0) })
      expect(result.current.moveError).toMatchObject({ code: 'wip_limit_exceeded' })

      mockMoveCard.mockResolvedValueOnce({ card: { ...board.cards[0], column: 11, position: 9999 } })
      await act(async () => { await result.current.forceMoveCardTo(100, 11, 20, 9999) })

      expect(mockMoveCard).toHaveBeenLastCalledWith(1, 100, { column_id: 11, swimlane_id: 20, position: 9999 }, true)
      expect(result.current.moveError).toBeNull()
      // The pendingMove was cleared with the toast: the toast's override is now a no-op.
      mockMoveCard.mockClear()
      await act(async () => { await result.current.forceMoveCard() })
      expect(mockMoveCard).not.toHaveBeenCalled()
    })

    it('rolls back, sets moveError and reports the failure', async () => {
      const board = makeBoard()
      mockGetBoardFull.mockResolvedValue(board)
      const { result } = renderHook(() => useBoard())
      await waitFor(() => expect(result.current.board).not.toBeNull())

      const err = { message: 'Network Error', isAxiosError: true }
      mockMoveCard.mockRejectedValueOnce(err)
      let outcome: unknown
      await act(async () => { outcome = await result.current.forceMoveCardTo(100, 11, 20, 9999) })

      expect(outcome).toEqual({ ok: false, error: err })
      expect(result.current.board!.cards[0].column).toBe(10)
      expect(result.current.moveError?.code).toBe('move_failed')
    })

    it('reports a structured refusal with its body intact', async () => {
      const board = makeBoard()
      mockGetBoardFull.mockResolvedValue(board)
      const { result } = renderHook(() => useBoard())
      await waitFor(() => expect(result.current.board).not.toBeNull())

      const err = { response: { status: 409, data: { code: 'wip_hard_blocked', column_name: 'In Progress', current_count: 3, wip_limit: 3 } } }
      mockMoveCard.mockRejectedValueOnce(err)
      let outcome: unknown
      await act(async () => { outcome = await result.current.forceMoveCardTo(100, 11, 20, 9999) })

      expect(outcome).toEqual({ ok: false, error: err })
      expect(result.current.board!.cards[0].column).toBe(10)
      expect(result.current.moveError).toMatchObject({ code: 'wip_hard_blocked' })
    })
  })

  // ─── reorderColumns / reorderSwimlanes — failure paths ──────────────────────

  it('reorderColumns rolls back to the previous order on API failure', async () => {
    const board = makeBoard({
      columns: [
        { id: 10, uid: 'coluid000001', name: 'To Do', position: 0, color: '#3B82F6', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
        { id: 11, uid: 'coluid000002', name: 'Done', position: 1, color: '#10B981', wip_limit: null, weight_limit: null, allow_card_creation: true, is_done: false, policy: null },
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
        { id: 20, uid: 'laneuid00001', name: 'Lane A', contact_email: '', notes: '', position: 0, color: '#6B7280', is_collapsed: false, created_at: '', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null },
        { id: 21, uid: 'laneuid00002', name: 'Lane B', contact_email: '', notes: '', position: 1, color: '#3B82F6', is_collapsed: false, created_at: '', wip_limit: null, weight_limit: null, limit_enforcement: null, limit_column_ids: null },
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

// #1969: a card arrives on two transports (HTTP responses, socket frames) that
// are not ordered against each other. An older version must never replace a
// newer one; an equal version still replaces (counters change without a bump).
describe('useBoard — stale card versions (#1969)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNavigate.mockClear()
  })

  const stored = (version: number, overrides: Partial<Card> = {}) => ({ ...makeBoard().cards[0], version, ...overrides })

  async function renderAt(version: number, overrides: Partial<Card> = {}) {
    mockGetBoardFull.mockResolvedValue(makeBoard({ cards: [stored(version, overrides)] }))
    const hook = renderHook(() => useBoard())
    await waitFor(() => expect(hook.result.current.board).not.toBeNull())
    return hook
  }

  it('updateCard ignores an older version and keeps the board identity', async () => {
    const { result } = await renderAt(3, { title: 'Newer' })
    const before = result.current.board
    act(() => { result.current.updateCard(stored(2, { title: 'Older' })) })
    expect(result.current.board).toBe(before)
    expect(result.current.board!.cards[0]).toMatchObject({ title: 'Newer', version: 3 })
  })

  it('updateCard replaces on an equal version (a comment/attachment counter change)', async () => {
    const { result } = await renderAt(3)
    act(() => { result.current.updateCard(stored(3, { attachment_count: 2 })) })
    expect(result.current.board!.cards[0]).toMatchObject({ attachment_count: 2, version: 3 })
  })

  it('updateCard replaces on a newer version', async () => {
    const { result } = await renderAt(3)
    act(() => { result.current.updateCard(stored(4, { title: 'Remote' })) })
    expect(result.current.board!.cards[0]).toMatchObject({ title: 'Remote', version: 4 })
  })

  it('updateCard replaces when the incoming card carries no version', async () => {
    const { result } = await renderAt(3)
    const { version: _omit, ...unversioned } = stored(3, { title: 'Unversioned' })
    act(() => { result.current.updateCard(unversioned as Card) })
    expect(result.current.board!.cards[0].title).toBe('Unversioned')
  })

  it('updateCard replaces when the stored card carries no version', async () => {
    const { version: _omit, ...unversioned } = stored(1)
    mockGetBoardFull.mockResolvedValue(makeBoard({ cards: [unversioned as Card] }))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    act(() => { result.current.updateCard(stored(1, { title: 'Replaced' })) })
    expect(result.current.board!.cards[0].title).toBe('Replaced')
  })

  it('a stale card.moved frame cannot move the card back', async () => {
    // A remote edit (v3) landed after the move (v2); the move frame arrives last.
    const { result } = await renderAt(3, { column: 11, title: 'Edited' })
    act(() => { result.current.updateCard(stored(2, { column: 11, title: 'Before edit' })) })
    // ...and an even older move frame cannot put it back in the old column.
    act(() => { result.current.updateCard(stored(1, { column: 10 })) })
    expect(result.current.board!.cards[0]).toMatchObject({ column: 11, title: 'Edited', version: 3 })
  })

  it('addCard ignores an older copy of a card it already holds (late card.created)', async () => {
    const { result } = await renderAt(2, { title: 'Edited' })
    act(() => { result.current.addCard(stored(1, { title: 'As created' })) })
    expect(result.current.board!.cards).toHaveLength(1)
    expect(result.current.board!.cards[0]).toMatchObject({ title: 'Edited', version: 2 })
    act(() => { result.current.addCard(stored(2, { title: 'Same version' })) })
    expect(result.current.board!.cards[0].title).toBe('Same version')
  })

  it('unarchiveCard ignores an older copy of a card already back on the board', async () => {
    const { result } = await renderAt(4, { title: 'Edited after restore' })
    act(() => { result.current.unarchiveCard(stored(3, { title: 'As restored' })) })
    expect(result.current.board!.cards[0]).toMatchObject({ title: 'Edited after restore', version: 4 })
    expect(result.current.board!.archived_card_count).toBe(0)
  })

  it('a move response that lands after a newer socket frame keeps the newer card', async () => {
    const { result } = await renderAt(1)
    let resolveMove!: (v: { card: Card }) => void
    mockMoveCard.mockReturnValueOnce(new Promise((r) => { resolveMove = r }))
    let pending!: Promise<unknown>
    act(() => { pending = result.current.moveCard(100, 11, 20, 0) })
    // The move's own echo (v2) and then a remote edit (v3) arrive over the socket first.
    act(() => { result.current.updateCard(stored(2, { column: 11 })) })
    act(() => { result.current.updateCard(stored(3, { column: 11, title: 'Remote edit' })) })
    let outcome: unknown
    await act(async () => { resolveMove({ card: stored(2, { column: 11 }) }); outcome = await pending })
    expect(outcome).toEqual({ ok: true })
    expect(result.current.board!.cards[0]).toMatchObject({ column: 11, title: 'Remote edit', version: 3 })
  })

  it('a move response with a newer version than any frame replaces the optimistic card', async () => {
    const { result } = await renderAt(1)
    mockMoveCard.mockResolvedValueOnce({ card: stored(2, { column: 11, position: 0 }) })
    await act(async () => { await result.current.moveCard(100, 11, 20, 0) })
    expect(result.current.board!.cards[0]).toMatchObject({ column: 11, version: 2 })
  })

  it('a forced move response that lands after a newer socket frame keeps the newer card', async () => {
    const { result } = await renderAt(1)
    let resolveMove!: (v: { card: Card }) => void
    mockMoveCard.mockReturnValueOnce(new Promise((r) => { resolveMove = r }))
    let pending!: Promise<unknown>
    act(() => { pending = result.current.forceMoveCardTo(100, 11, 20, 9999) })
    act(() => { result.current.updateCard(stored(3, { column: 11, title: 'Remote edit' })) })
    let outcome: unknown
    await act(async () => { resolveMove({ card: stored(2, { column: 11 }) }); outcome = await pending })
    expect(outcome).toEqual({ ok: true })
    expect(result.current.board!.cards[0]).toMatchObject({ title: 'Remote edit', version: 3 })
  })

  // A failed move puts back only the moved card's location, and only while no
  // newer version of it has arrived; frames for other cards that landed during
  // the request survive.
  describe('failed-move rollback keeps frames that landed meanwhile', () => {
    const other = (version: number, overrides: Partial<Card> = {}) =>
      ({ ...makeBoard().cards[0], id: 101, uid: 'carduid00101', title: 'Other', version, ...overrides })

    async function renderTwo() {
      mockGetBoardFull.mockResolvedValue(makeBoard({ cards: [stored(1, { title: 'Mover' }), other(1)] }))
      const hook = renderHook(() => useBoard())
      await waitFor(() => expect(hook.result.current.board).not.toBeNull())
      return hook
    }

    const failures: [string, unknown][] = [
      ['403', { response: { status: 403, data: { detail: 'nope' } } }],
      ['409 wip_limit_exceeded', { response: { status: 409, data: { code: 'wip_limit_exceeded', column_name: 'Doing', current_count: 3, wip_limit: 3 } } }],
      ['a network error', new Error('Network Error')],
    ]

    for (const [label, failure] of failures) {
      it(`moveCard (${label}): restores the moved card's location and keeps another card's frame`, async () => {
        const { result } = await renderTwo()
        let rejectMove!: (e: unknown) => void
        mockMoveCard.mockReturnValueOnce(new Promise((_r, rej) => { rejectMove = rej }))
        let pending!: Promise<unknown>
        act(() => { pending = result.current.moveCard(100, 11, 20, 3) })
        expect(result.current.board!.cards[0].column).toBe(11)
        act(() => { result.current.updateCard(other(2, { title: 'Other, edited remotely' })) })
        act(() => { result.current.addCard({ ...other(1), id: 102, uid: 'carduid00102', title: 'Created meanwhile' }) })
        let outcome: unknown
        await act(async () => { rejectMove(failure); outcome = await pending })
        expect(outcome).toMatchObject({ ok: false })
        const cards = result.current.board!.cards
        expect(cards.find((c) => c.id === 100)).toMatchObject({ column: 10, swimlane: 20, position: 0, title: 'Mover', version: 1 })
        expect(cards.find((c) => c.id === 101)).toMatchObject({ title: 'Other, edited remotely', version: 2 })
        expect(cards.find((c) => c.id === 102)?.title).toBe('Created meanwhile')
      })

      it(`forceMoveCardTo (${label}): restores the moved card's location and keeps another card's frame`, async () => {
        const { result } = await renderTwo()
        let rejectMove!: (e: unknown) => void
        mockMoveCard.mockReturnValueOnce(new Promise((_r, rej) => { rejectMove = rej }))
        let pending!: Promise<unknown>
        act(() => { pending = result.current.forceMoveCardTo(100, 11, 20, 9999) })
        act(() => { result.current.updateCard(other(2, { title: 'Other, edited remotely' })) })
        let outcome: unknown
        await act(async () => { rejectMove(failure); outcome = await pending })
        expect(outcome).toMatchObject({ ok: false })
        const cards = result.current.board!.cards
        expect(cards.find((c) => c.id === 100)).toMatchObject({ column: 10, position: 0, version: 1 })
        expect(cards.find((c) => c.id === 101)).toMatchObject({ title: 'Other, edited remotely', version: 2 })
      })
    }

    it('keeps a newer version of the moved card itself that arrived during the request', async () => {
      const { result } = await renderTwo()
      let rejectMove!: (e: unknown) => void
      mockMoveCard.mockReturnValueOnce(new Promise((_r, rej) => { rejectMove = rej }))
      let pending!: Promise<unknown>
      act(() => { pending = result.current.moveCard(100, 11, 20, 3) })
      // Another session moved the card to column 12 and the frame landed first.
      act(() => { result.current.updateCard(stored(2, { title: 'Mover', column: 12 })) })
      await act(async () => { rejectMove(new Error('Network Error')); await pending })
      expect(result.current.board!.cards.find((c) => c.id === 100)).toMatchObject({ column: 12, version: 2 })
    })

    it('keeps an equal-version counter change on the moved card while restoring its location', async () => {
      const { result } = await renderTwo()
      let rejectMove!: (e: unknown) => void
      mockMoveCard.mockReturnValueOnce(new Promise((_r, rej) => { rejectMove = rej }))
      let pending!: Promise<unknown>
      act(() => { pending = result.current.forceMoveCardTo(100, 11, 20, 9999) })
      act(() => { result.current.updateCard(stored(1, { title: 'Mover', column: 10, attachment_count: 4 })) })
      await act(async () => { rejectMove(new Error('Network Error')); await pending })
      expect(result.current.board!.cards.find((c) => c.id === 100)).toMatchObject({ column: 10, position: 0, attachment_count: 4 })
    })

    it('a failed move of a card the board does not hold leaves the board as it is', async () => {
      const { result } = await renderTwo()
      const before = result.current.board
      mockMoveCard.mockRejectedValueOnce(new Error('Network Error'))
      await act(async () => { await result.current.moveCard(999, 11, 20, 0) })
      expect(result.current.board!.cards).toEqual(before!.cards)
    })

    it('does not bring back a moved card that was deleted during the request', async () => {
      const { result } = await renderTwo()
      let rejectMove!: (e: unknown) => void
      mockMoveCard.mockReturnValueOnce(new Promise((_r, rej) => { rejectMove = rej }))
      let pending!: Promise<unknown>
      act(() => { pending = result.current.moveCard(100, 11, 20, 3) })
      act(() => { result.current.evictCardByUid('carduid00001') })
      await act(async () => { rejectMove({ response: { status: 403, data: {} } }); await pending })
      expect(result.current.board!.cards.map((c) => c.id)).toEqual([101])
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
    // mode for those would be a lie. Roll back with the generic move_failed toast.
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
    expect(result.current.moveError?.code).toBe('move_failed')
  })
})
