import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import BoardSettingsModal from '../components/Board/BoardSettingsModal'
import { useBoard } from '../hooks/useBoard'
import { swimlaneForRole } from '../utils/swimlaneMerge'
import type { BoardFull, Card, CardSiblingPosition, Column, Swimlane, Label, CustomFieldDefinition, SwimlaneCustomFieldDefinition } from '../types'

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
    health_status: null, effective_health_status: null, health_status_source: null, default_preset: null,
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

  it('records when each /full/ response was applied, for the first-open resync (#1968)', async () => {
    const now = vi.spyOn(Date, 'now')
    try {
      let resolveLoad!: (b: BoardFull) => void
      mockGetBoardFull.mockReturnValueOnce(new Promise<BoardFull>((r) => { resolveLoad = r }))
      const { result } = renderHook(() => useBoard())
      const getAt = result.current.getLastFullFetchAt
      expect(getAt()).toBeNull()
      now.mockReturnValue(5_000)
      await act(async () => { resolveLoad(makeBoard()) })
      expect(getAt()).toBe(5_000)

      // A silent reload refreshes it; a failed one leaves the last good value.
      now.mockReturnValue(9_000)
      mockGetBoardFull.mockResolvedValueOnce(makeBoard({ name: 'Again' }))
      await act(async () => { result.current.silentReload() })
      expect(getAt()).toBe(9_000)
      now.mockReturnValue(12_000)
      mockGetBoardFull.mockRejectedValueOnce(new Error('net'))
      await act(async () => { result.current.silentReload() })
      expect(getAt()).toBe(9_000)
      // Stable identity: BoardView reads it through a ref on the socket's open.
      expect(result.current.getLastFullFetchAt).toBe(getAt)
    } finally {
      now.mockRestore()
    }
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

  it('flags the board unavailable instead of redirecting when it returns 404 (#2041)', async () => {
    mockGetBoardFull.mockRejectedValue({ response: { status: 404 } })

    // Wrap render in act so the rejected promise is flushed before waitFor
    // asserts — without this the rejection races against the assertion.
    const { result } = await act(async () => renderHook(() => useBoard()))

    await waitFor(() => {
      expect(result.current.unavailable).toBe(true)
    })
    expect(result.current.error).toBeNull()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('flags the board unavailable the same way for 403 (#2041)', async () => {
    mockGetBoardFull.mockRejectedValue({ response: { status: 403 } })
    const { result } = renderHook(() => useBoard())

    await waitFor(() => {
      expect(result.current.unavailable).toBe(true)
    })
    expect(result.current.error).toBeNull()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it("does not carry one board's unavailable state into the next board (#2041)", async () => {
    mockGetBoardFull.mockRejectedValue({ response: { status: 404 } })
    const { result, rerender } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.unavailable).toBe(true))

    // /boards/:id reuses this hook instance; board 2 is slow, then fails with a 5xx.
    let rejectB: (e: unknown) => void = () => {}
    mockGetBoardFull.mockImplementation(() => new Promise((_, rej) => { rejectB = rej }))
    mockParamId = '2'
    try {
      rerender()
      await waitFor(() => expect(result.current.unavailable).toBe(false))
      expect(result.current.loading).toBe(true)
      await act(async () => { rejectB(new Error('boom')) })
      await waitFor(() => expect(result.current.error).toBe('Failed to load board'))
      expect(result.current.unavailable).toBe(false)
    } finally {
      mockParamId = '1'
    }
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
      board, isAdmin: true, onClose: vi.fn(), onBoardDeleted: vi.fn(), initialTab: 'data', currentUserId: board.owner.id,
    }))
    expect(screen.getByRole('button', { name: 'Delete board' })).toHaveAttribute('aria-disabled', 'true')
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

  // #1905 — the owner is an implicit admin; a frame for their lower explicit
  // row must not turn them back into a viewer in the open roster.
  it('keeps the board owner an admin across member.added / member.updated / member.removed (#1905)', async () => {
    const owner = { id: 1, username: 'admin', display_name: 'Admin User', avatar_url: '' }
    mockGetBoardFull.mockResolvedValue(makeBoard({
      members: [{ id: null, user: owner, role: 'admin', is_moderator: false, joined_at: '' }],
    }))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    act(() => { result.current.updateMember({ id: 50, user: owner, role: 'viewer', joined_at: '' }) })
    expect(result.current.board!.members[0]).toMatchObject({ id: 50, role: 'admin' })

    act(() => { result.current.addMember({ id: 50, user: owner, role: 'viewer', joined_at: '' }) })
    expect(result.current.board!.members[0]).toMatchObject({ id: 50, role: 'admin' })

    act(() => { result.current.removeMember(owner.id) })
    expect(result.current.board!.members).toHaveLength(1)
    expect(result.current.board!.members[0]).toMatchObject({ id: null, role: 'admin' })
  })

  it('addMember for the owner with no listed row appends them as admin (#1905)', async () => {
    const owner = { id: 1, username: 'admin', display_name: 'Admin User', avatar_url: '' }
    mockGetBoardFull.mockResolvedValue(makeBoard({ members: [] }))
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())
    act(() => { result.current.addMember({ id: 50, user: owner, role: 'viewer', joined_at: '' }) })
    expect(result.current.board!.members[0]).toMatchObject({ id: 50, role: 'admin' })
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

  it('silentReload flags the board unavailable on 404/403 like the initial load (#2041)', async () => {
    mockGetBoardFull.mockResolvedValue(makeBoard())
    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    mockGetBoardFull.mockRejectedValue({ response: { status: 403 } })
    await act(async () => { result.current.silentReload() })

    expect(result.current.unavailable).toBe(true)
    expect(mockNavigate).not.toHaveBeenCalled()

    // A later successful read (access restored) clears the state.
    mockGetBoardFull.mockResolvedValue(makeBoard())
    await act(async () => { result.current.silentReload() })
    expect(result.current.unavailable).toBe(false)
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

  it('moveCard reloads the board on 404 and shows the unavailable state when access was lost', async () => {
    const board = makeBoard()
    mockGetBoardFull.mockResolvedValueOnce(board)
    mockMoveCard.mockRejectedValue({ response: { status: 404, data: {} } })

    const { result } = renderHook(() => useBoard())
    await waitFor(() => expect(result.current.board).not.toBeNull())

    mockGetBoardFull.mockRejectedValue({ response: { status: 404 } })
    mockGetBoardFull.mockClear()
    await act(async () => { await result.current.moveCard(100, 11, 20, 0) })

    await waitFor(() => expect(mockGetBoardFull).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.unavailable).toBe(true))
    expect(mockNavigate).not.toHaveBeenCalled()
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

  // card.moved's sibling_positions (#1890): the cards the move renumbered.
  describe('card.moved sibling positions (#1890)', () => {
    const cell = (id: number, position: number, version = 1, overrides: Partial<Card> = {}) =>
      stored(version, { id, uid: `crd${id}`, position, ...overrides })

    async function renderCards(cards: Card[]) {
      mockGetBoardFull.mockResolvedValue(makeBoard({ cards }))
      const hook = renderHook(() => useBoard())
      await waitFor(() => expect(hook.result.current.board).not.toBeNull())
      return hook
    }

    const positionOf = (cards: Card[], id: number) => cards.find((c) => c.id === id)!.position

    it('a remote client applies the shifted sibling positions with the moved card', async () => {
      // Cell [A0, B1, C2]; a remote user moves A to 2: the server shifts C to 3.
      const { result } = await renderCards([cell(1, 0), cell(2, 1), cell(3, 2)])
      act(() => {
        result.current.updateCard(cell(1, 2, 2), [{ id: 3, position: 3, version: 1 }])
      })
      const cards = result.current.board!.cards
      expect(positionOf(cards, 1)).toBe(2)
      expect(positionOf(cards, 3)).toBe(3)
      expect(positionOf(cards, 2)).toBe(1)
      // The order the cell renders in is now the server's: B, A, C.
      const order = [...cards].sort((a, b) => a.position - b.position).map((c) => c.id)
      expect(order).toEqual([2, 1, 3])
    })

    it('a frame without sibling_positions still applies the moved card (older server)', async () => {
      const { result } = await renderCards([cell(1, 0), cell(2, 1)])
      act(() => { result.current.updateCard(cell(1, 1, 2, { column: 11 })) })
      const cards = result.current.board!.cards
      expect(cards.find((c) => c.id === 1)).toMatchObject({ column: 11, position: 1, version: 2 })
      expect(positionOf(cards, 2)).toBe(1)
    })

    it('an empty sibling_positions list changes only the moved card', async () => {
      const { result } = await renderCards([cell(1, 0), cell(2, 1)])
      const sibling = result.current.board!.cards[1]
      act(() => { result.current.updateCard(cell(1, 0, 2, { column: 11 }), []) })
      expect(result.current.board!.cards[1]).toBe(sibling)
    })

    it('skips a pair for a sibling the client holds a newer version of', async () => {
      // Sibling 2 was moved or edited since (v5); the pair was written at v4.
      const { result } = await renderCards([cell(1, 0), cell(2, 7, 5, { column: 11 })])
      act(() => {
        result.current.updateCard(cell(1, 1, 2), [{ id: 2, position: 0, version: 4 }])
      })
      expect(result.current.board!.cards.find((c) => c.id === 2)).toMatchObject({ column: 11, position: 7, version: 5 })
    })

    it('applies a pair at an equal or newer version, and ignores unknown ids', async () => {
      const { result } = await renderCards([cell(1, 0), cell(2, 1, 3), cell(3, 2, 3)])
      act(() => {
        result.current.updateCard(cell(1, 5, 2), [
          { id: 2, position: 0, version: 3 },
          { id: 3, position: 1, version: 4 },
          { id: 999, position: 4, version: 1 },
        ])
      })
      const cards = result.current.board!.cards
      expect(positionOf(cards, 2)).toBe(0)
      expect(positionOf(cards, 3)).toBe(1)
      expect(cards).toHaveLength(3)
    })

    it('a pair without a usable version is applied (pre-#1969 rule)', async () => {
      const { result } = await renderCards([cell(1, 0), cell(2, 1)])
      act(() => {
        result.current.updateCard(cell(1, 1, 2), [{ id: 2, position: 2 } as unknown as CardSiblingPosition])
      })
      expect(positionOf(result.current.board!.cards, 2)).toBe(2)
    })

    it('skips a malformed pair', async () => {
      const { result } = await renderCards([cell(1, 0), cell(2, 1)])
      act(() => {
        result.current.updateCard(cell(1, 0, 2), [
          { id: 2, position: '3', version: 1 } as unknown as CardSiblingPosition,
          null as unknown as CardSiblingPosition,
        ])
      })
      expect(positionOf(result.current.board!.cards, 2)).toBe(1)
    })

    it('a stale move frame does not apply its sibling positions', async () => {
      // Two moves of card 1 in one cell; the second frame (v3) arrived first and
      // put sibling 2 at 0. The first frame (v2) must not put it back at 1:
      // a position shift does not bump the sibling's version, so only the
      // moved card's version tells the two frames apart.
      const { result } = await renderCards([cell(1, 1, 3), cell(2, 0, 4)])
      const before = result.current.board
      act(() => {
        result.current.updateCard(cell(1, 0, 2), [{ id: 2, position: 1, version: 4 }])
      })
      expect(result.current.board).toBe(before)
      expect(positionOf(result.current.board!.cards, 2)).toBe(0)
    })

    // Ordering by event_id: two moves of different cards in one cell send the
    // same sibling at the same (unbumped) version; only the event_id orders them.
    it('an out-of-order frame from a different card\'s move does not regress a sibling', async () => {
      // Cell [A, B, S]. Move of A (event 10) put S at 3; a later move of B
      // (event 11) put it at 2. Frame 11 arrives first.
      const { result } = await renderCards([cell(1, 0), cell(2, 1), cell(3, 2, 4)])
      act(() => { result.current.updateCard(cell(2, 0, 2), [{ id: 3, position: 2, version: 4 }], 11) })
      act(() => { result.current.updateCard(cell(1, 1, 2), [{ id: 3, position: 3, version: 4 }], 10) })
      const cards = result.current.board!.cards
      expect(positionOf(cards, 3)).toBe(2)
      // The late frame's own card is still applied.
      expect(cards.find((c) => c.id === 1)).toMatchObject({ position: 1, version: 2 })
    })

    it('in-order frames apply in turn', async () => {
      const { result } = await renderCards([cell(1, 0), cell(2, 1), cell(3, 2, 4)])
      act(() => { result.current.updateCard(cell(1, 1, 2), [{ id: 3, position: 3, version: 4 }], 10) })
      expect(positionOf(result.current.board!.cards, 3)).toBe(3)
      act(() => { result.current.updateCard(cell(2, 0, 2), [{ id: 3, position: 2, version: 4 }], 11) })
      expect(positionOf(result.current.board!.cards, 3)).toBe(2)
    })

    it('a frame without event_id still applies its pairs (older server)', async () => {
      const { result } = await renderCards([cell(1, 0), cell(2, 1), cell(3, 2, 4)])
      act(() => { result.current.updateCard(cell(2, 0, 2), [{ id: 3, position: 2, version: 4 }], 11) })
      act(() => { result.current.updateCard(cell(1, 1, 2), [{ id: 3, position: 5, version: 4 }]) })
      expect(positionOf(result.current.board!.cards, 3)).toBe(5)
    })

    it('ids order only the cards they set: moves in another cell are not blocked', async () => {
      // Frame 11 renumbered card 3 (one cell); the late frame 10 renumbered
      // card 5 in an unrelated cell, which frame 11 never touched.
      const { result } = await renderCards([cell(1, 0), cell(3, 2, 4), cell(5, 1, 1, { column: 11 })])
      act(() => { result.current.updateCard(cell(2, 0, 2), [{ id: 3, position: 1, version: 4 }], 11) })
      act(() => { result.current.updateCard(cell(4, 0, 2, { column: 11 }), [{ id: 5, position: 2, version: 1 }], 10) })
      const cards = result.current.board!.cards
      expect(positionOf(cards, 3)).toBe(1)
      expect(positionOf(cards, 5)).toBe(2)
    })

    it('a late move frame of a card keeps a position a later frame already set', async () => {
      // Card 3 moved to column 11 (event 11, v5, position 0); a move of card 4
      // in that cell (event 12) then shifted it to 1, and frame 12 came first.
      const { result } = await renderCards([cell(3, 2, 4), cell(4, 0, 1, { column: 11 })])
      act(() => { result.current.updateCard(cell(4, 0, 2, { column: 11 }), [{ id: 3, position: 1, version: 5 }], 12) })
      act(() => { result.current.updateCard(cell(3, 0, 5, { column: 11 }), [], 11) })
      expect(result.current.board!.cards.find((c) => c.id === 3)).toMatchObject({ column: 11, position: 1, version: 5 })
    })

    // The real /full/ race: frame N lands while the fetch is in flight, the
    // snapshot (taken after N committed) is applied, and only then is an
    // older frame M < N for the same card delivered. M must not move it back.
    for (const via of ['load', 'silentReload'] as const) {
      it(`keeps the ordering across a /full/ response (${via})`, async () => {
        const { result } = await renderCards([cell(1, 0), cell(2, 1), cell(3, 2, 4)])
        let resolveFull!: (b: BoardFull) => void
        mockGetBoardFull.mockReturnValueOnce(new Promise((r) => { resolveFull = r }))
        act(() => { (via === 'load' ? result.current.reload : result.current.silentReload)() })
        // Frame N (move of card 2, event 11) arrives during the fetch.
        act(() => { result.current.updateCard(cell(2, 0, 2), [{ id: 3, position: 2, version: 4 }], 11) })
        await act(async () => {
          resolveFull(makeBoard({ cards: [cell(1, 1), cell(2, 0, 2), cell(3, 2, 4)] }))
        })
        await waitFor(() => expect(result.current.loading).toBe(false))
        expect(positionOf(result.current.board!.cards, 3)).toBe(2)
        // Frame M (move of card 1, event 10) is delivered after the response.
        act(() => { result.current.updateCard(cell(1, 1, 2), [{ id: 3, position: 3, version: 4 }], 10) })
        expect(positionOf(result.current.board!.cards, 3)).toBe(2)
      })
    }

    it('applies the pairs when the moved card is not on this board copy', async () => {
      const { result } = await renderCards([cell(2, 1)])
      act(() => {
        result.current.updateCard(cell(1, 0, 2), [{ id: 2, position: 2, version: 1 }])
      })
      expect(positionOf(result.current.board!.cards, 2)).toBe(2)
    })
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

// #2038: a /full/ snapshot may have been read before a frame that arrives while
// the fetch is in flight. Cards written during the fetch keep the newer copy and
// their on-board state; every other card takes the snapshot (drift recovery).
describe('useBoard — /full/ responses vs frames that land mid-fetch (#2038)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNavigate.mockClear()
  })

  const card = (id: number, version: number, overrides: Partial<Card> = {}): Card =>
    ({ ...makeBoard().cards[0], id, uid: `crd${id}`, title: `Card ${id}`, version, ...overrides })
  const byId = (b: BoardFull | null, id: number) => b!.cards.find((c) => c.id === id)
  const ids = (b: BoardFull | null) => b!.cards.map((c) => c.id).sort((x, y) => x - y)

  async function renderBoard(cards: Card[], overrides: Partial<BoardFull> = {}) {
    mockGetBoardFull.mockResolvedValueOnce(makeBoard({ cards, ...overrides }))
    const hook = renderHook(() => useBoard())
    await waitFor(() => expect(hook.result.current.board).not.toBeNull())
    return hook
  }

  type Hook = Awaited<ReturnType<typeof renderBoard>>
  /** Start a reload whose response the test resolves later. */
  function startFetch(result: Hook['result'], via: 'load' | 'silentReload' = 'silentReload') {
    let resolve!: (b: BoardFull) => void
    let reject!: (e: unknown) => void
    mockGetBoardFull.mockReturnValueOnce(new Promise<BoardFull>((res, rej) => { resolve = res; reject = rej }))
    act(() => { (via === 'load' ? result.current.reload : result.current.silentReload)() })
    return {
      resolve: async (b: BoardFull) => {
        await act(async () => { resolve(b) })
        await waitFor(() => expect(result.current.loading).toBe(false))
      },
      reject: async (e: unknown) => { await act(async () => { reject(e) }) },
    }
  }

  for (const via of ['load', 'silentReload'] as const) {
    it(`keeps a newer frame that landed during the fetch (${via})`, async () => {
      const { result } = await renderBoard([card(1, 1), card(2, 1)])
      const fetch = startFetch(result, via)
      act(() => { result.current.updateCard(card(1, 2, { title: 'Remote edit' })) })
      await fetch.resolve(makeBoard({ cards: [card(1, 1, { title: 'Before edit' }), card(2, 1, { title: 'Snapshot' })] }))
      expect(byId(result.current.board, 1)).toMatchObject({ title: 'Remote edit', version: 2 })
      // A card nothing wrote during the fetch takes the snapshot.
      expect(byId(result.current.board, 2)?.title).toBe('Snapshot')
    })
  }

  it('an equal version in the snapshot still replaces a card written during the fetch', async () => {
    const { result } = await renderBoard([card(1, 2)])
    const fetch = startFetch(result)
    act(() => { result.current.updateCard(card(1, 2, { attachment_count: 0 })) })
    // A comment or attachment changes the card without bumping its version.
    await fetch.resolve(makeBoard({ cards: [card(1, 2, { attachment_count: 3 })] }))
    expect(byId(result.current.board, 1)).toMatchObject({ attachment_count: 3, version: 2 })
  })

  it('a newer snapshot copy replaces a card written during the fetch', async () => {
    const { result } = await renderBoard([card(1, 1)])
    const fetch = startFetch(result)
    act(() => { result.current.updateCard(card(1, 2, { title: 'Frame' })) })
    await fetch.resolve(makeBoard({ cards: [card(1, 3, { title: 'Later still' })] }))
    expect(byId(result.current.board, 1)).toMatchObject({ title: 'Later still', version: 3 })
  })

  // In each case below a frame for a DIFFERENT card (2) lands during the fetch,
  // so the merge runs instead of short-circuiting, and card 1 must still take
  // the lower snapshot version: only cards written during the fetch are merged.
  it('stays authoritative for a card nothing wrote during the fetch, even at a lower version', async () => {
    // A server-side correction (a restore, a demo reset) can lower a version;
    // a write that landed before the fetch started does not protect the card.
    const { result } = await renderBoard([card(1, 1), card(2, 1)])
    act(() => { result.current.updateCard(card(1, 5, { title: 'Before the fetch' })) })
    const fetch = startFetch(result)
    act(() => { result.current.updateCard(card(2, 2, { title: 'Frame for card 2' })) })
    await fetch.resolve(makeBoard({ cards: [card(1, 3, { title: 'Corrected' }), card(2, 1)] }))
    expect(byId(result.current.board, 1)).toMatchObject({ title: 'Corrected', version: 3 })
    expect(byId(result.current.board, 2)).toMatchObject({ title: 'Frame for card 2', version: 2 })
  })

  // A copy the #1969 guard drops as older than the one on screen is not a
  // write: it must not protect a pre-fetch local copy from the snapshot.
  const staleWriters: Array<[string, (r: Hook['result']) => Promise<void> | void]> = [
    ['a stale card.updated frame', (r) => { act(() => { r.current.updateCard(card(1, 4, { title: 'Stale frame' })) }) }],
    ['a stale card.created echo', (r) => { act(() => { r.current.addCard(card(1, 4, { title: 'Stale echo' })) }) }],
    ['a stale card.unarchived frame', (r) => { act(() => { r.current.unarchiveCard(card(1, 4, { title: 'Stale restore' })) }) }],
    ['a stale move response', async (r) => {
      mockMoveCard.mockResolvedValueOnce({ card: card(1, 4, { title: 'Stale move' }) })
      await act(async () => { await r.current.moveCard(1, 10, 20, 0) })
    }],
    ['a stale forced move response', async (r) => {
      mockMoveCard.mockResolvedValueOnce({ card: card(1, 4, { title: 'Stale move' }) })
      await act(async () => { await r.current.forceMoveCardTo(1, 10, 20, 0) })
    }],
  ]
  for (const [label, write] of staleWriters) {
    it(`${label} during the fetch does not protect the card from a lower snapshot version`, async () => {
      const { result } = await renderBoard([card(1, 1), card(2, 1)])
      act(() => { result.current.updateCard(card(1, 5, { title: 'Before the fetch' })) })
      const fetch = startFetch(result)
      await write(result)
      expect(byId(result.current.board, 1)?.version).toBe(5) // the #1969 guard dropped it
      act(() => { result.current.updateCard(card(2, 2)) }) // a real write, so the merge runs
      await fetch.resolve(makeBoard({ cards: [card(1, 3, { title: 'Corrected' }), card(2, 1)] }))
      expect(byId(result.current.board, 1)).toMatchObject({ title: 'Corrected', version: 3 })
    })
  }

  it('a newer fetch does not inherit the writes of the one it superseded', async () => {
    const { result } = await renderBoard([card(1, 1), card(2, 1)])
    const first = startFetch(result)
    act(() => { result.current.updateCard(card(1, 5, { title: 'During the first fetch' })) })
    const second = startFetch(result)
    act(() => { result.current.updateCard(card(2, 2)) })
    await second.resolve(makeBoard({ cards: [card(1, 3, { title: 'Second snapshot' }), card(2, 1)] }))
    await first.resolve(makeBoard({ cards: [card(1, 1), card(2, 1)] }))
    expect(byId(result.current.board, 1)).toMatchObject({ title: 'Second snapshot', version: 3 })
    expect(byId(result.current.board, 2)?.version).toBe(2)
  })

  it('a write between two fetches does not protect a card in the second', async () => {
    const { result } = await renderBoard([card(1, 1), card(2, 1)])
    const first = startFetch(result)
    await first.resolve(makeBoard({ cards: [card(1, 1), card(2, 1)] }))
    act(() => { result.current.updateCard(card(1, 5)) })
    const second = startFetch(result)
    act(() => { result.current.updateCard(card(2, 2)) })
    await second.resolve(makeBoard({ cards: [card(1, 3, { title: 'Authoritative' }), card(2, 1)] }))
    expect(byId(result.current.board, 1)).toMatchObject({ title: 'Authoritative', version: 3 })
    expect(byId(result.current.board, 2)?.version).toBe(2)
  })

  it('after a failed fetch, the next fetch merges only the writes made during it', async () => {
    const { result } = await renderBoard([card(1, 1), card(2, 1)])
    const failed = startFetch(result)
    act(() => { result.current.updateCard(card(1, 4)) }) // during the failed fetch
    await failed.reject({ response: { status: 500 } })
    act(() => { result.current.updateCard(card(1, 5)) }) // between fetches
    const next = startFetch(result)
    act(() => { result.current.updateCard(card(2, 2)) })
    await next.resolve(makeBoard({ cards: [card(1, 3, { title: 'Authoritative' }), card(2, 1)] }))
    expect(byId(result.current.board, 1)?.version).toBe(3)
    expect(byId(result.current.board, 2)?.version).toBe(2)
  })

  it('keeps a card created during the fetch that the snapshot predates', async () => {
    const { result } = await renderBoard([card(1, 1), card(2, 1)])
    const fetch = startFetch(result)
    act(() => { result.current.addCard(card(3, 1, { title: 'Created meanwhile' })) })
    // Card 2 was removed before the snapshot was read and no frame says so:
    // drift the reload recovers.
    await fetch.resolve(makeBoard({ cards: [card(1, 1)] }))
    expect(ids(result.current.board)).toEqual([1, 3])
    expect(byId(result.current.board, 3)?.title).toBe('Created meanwhile')
  })

  it('keeps a card restored during the fetch that the snapshot predates', async () => {
    const { result } = await renderBoard([card(1, 1)], { archived_card_count: 1 })
    const fetch = startFetch(result)
    act(() => { result.current.unarchiveCard(card(2, 1, { title: 'Restored' })) })
    await fetch.resolve(makeBoard({ cards: [card(1, 1)], archived_card_count: 1 }))
    expect(ids(result.current.board)).toEqual([1, 2])
    // Not subtracted: an over-count is the safe direction (#1289).
    expect(result.current.board!.archived_card_count).toBe(1)
  })

  it('does not bring back a card deleted during the fetch', async () => {
    const { result } = await renderBoard([card(1, 1), card(2, 1), card(3, 1)])
    const fetch = startFetch(result)
    act(() => { result.current.evictCardByUid('crd1') }) // card.deleted frame
    act(() => { result.current.removeCard(2) }) // this user's own delete
    act(() => { result.current.evictCardByUid('crd9') }) // a card not on screen
    await fetch.resolve(makeBoard({ cards: [card(1, 1), card(2, 1), card(3, 1), card(9, 1)] }))
    expect(ids(result.current.board)).toEqual([3])
    expect(result.current.board!.archived_card_count).toBe(0)
  })

  it('does not bring back a card archived during the fetch, and counts it', async () => {
    const { result } = await renderBoard([card(1, 1), card(2, 1), card(3, 1)])
    const fetch = startFetch(result)
    act(() => { result.current.archiveCardByUid('crd1') }) // card.archived frame
    act(() => { result.current.archiveCard(2) }) // this user's own archive
    act(() => { result.current.archiveCardByUid('crd9') }) // a card not on screen
    // The snapshot still lists all three as on the board, and counts none.
    await fetch.resolve(makeBoard({ cards: [card(1, 1), card(2, 1), card(3, 1), card(9, 1)], archived_card_count: 0 }))
    expect(ids(result.current.board)).toEqual([3])
    expect(result.current.board!.archived_card_count).toBe(3)
  })

  it('a card archived and restored during the fetch is merged as a written card', async () => {
    const { result } = await renderBoard([card(1, 1)])
    const fetch = startFetch(result)
    act(() => { result.current.archiveCardByUid('crd1') })
    act(() => { result.current.unarchiveCard(card(1, 2, { title: 'Back' })) })
    await fetch.resolve(makeBoard({ cards: [card(1, 1)], archived_card_count: 0 }))
    expect(byId(result.current.board, 1)).toMatchObject({ title: 'Back', version: 2 })
    expect(result.current.board!.archived_card_count).toBe(0)
  })

  it('adds a snapshot card the client never had, even if a frame for it arrived meanwhile', async () => {
    // The frame cannot be applied (the card is not on screen), so it records
    // nothing and the snapshot's copy recovers the missed card.created.
    const { result } = await renderBoard([card(1, 1)])
    const fetch = startFetch(result)
    act(() => { result.current.updateCard(card(2, 4, { title: 'Frame for a missed card' })) })
    // A frame for a card on screen, so the merge runs rather than short-circuits.
    act(() => { result.current.updateCard(card(1, 2, { title: 'Edited' })) })
    await fetch.resolve(makeBoard({ cards: [card(1, 1), card(2, 3, { title: 'Snapshot' })] }))
    expect(ids(result.current.board)).toEqual([1, 2])
    expect(byId(result.current.board, 2)?.title).toBe('Snapshot')
    expect(byId(result.current.board, 1)?.title).toBe('Edited')
  })

  it('keeps a sibling position a card.moved frame set during the fetch at an equal version', async () => {
    const { result } = await renderBoard([card(1, 1, { position: 0 }), card(2, 1, { position: 1 })])
    const fetch = startFetch(result)
    // Card 1 moved to position 1; the server shifted card 2 to 0 without a bump.
    act(() => { result.current.updateCard(card(1, 2, { position: 1 }), [{ id: 2, position: 0, version: 1 }], 50) })
    await fetch.resolve(makeBoard({ cards: [card(1, 1, { position: 0 }), card(2, 1, { position: 1, title: 'Snapshot' })] }))
    expect(byId(result.current.board, 1)).toMatchObject({ position: 1, version: 2 })
    // The rest of card 2 comes from the snapshot; only its position is kept.
    expect(byId(result.current.board, 2)).toMatchObject({ position: 0, title: 'Snapshot' })
  })

  it('a newer snapshot copy of a sibling replaces the position a frame set', async () => {
    const { result } = await renderBoard([card(1, 1, { position: 0 }), card(2, 1, { position: 1 })])
    const fetch = startFetch(result)
    act(() => { result.current.updateCard(card(1, 2, { position: 1 }), [{ id: 2, position: 0, version: 1 }], 50) })
    await fetch.resolve(makeBoard({ cards: [card(1, 2, { position: 1 }), card(2, 2, { position: 4 })] }))
    expect(byId(result.current.board, 2)).toMatchObject({ position: 4, version: 2 })
  })

  it('keeps a move response that landed during the fetch', async () => {
    const { result } = await renderBoard([card(100, 1)])
    const fetch = startFetch(result)
    mockMoveCard.mockResolvedValueOnce({ card: card(100, 2, { column: 11 }) })
    await act(async () => { await result.current.moveCard(100, 11, 20, 0) })
    await fetch.resolve(makeBoard({ cards: [card(100, 1, { column: 10 })] }))
    expect(byId(result.current.board, 100)).toMatchObject({ column: 11, version: 2 })
  })

  it('keeps a forced move response that landed during the fetch', async () => {
    const { result } = await renderBoard([card(100, 1)])
    const fetch = startFetch(result)
    mockMoveCard.mockResolvedValueOnce({ card: card(100, 2, { column: 11 }) })
    await act(async () => { await result.current.forceMoveCardTo(100, 11, 20, 0) })
    await fetch.resolve(makeBoard({ cards: [card(100, 1, { column: 10 })] }))
    expect(byId(result.current.board, 100)).toMatchObject({ column: 11, version: 2 })
  })

  it('returns the snapshot unchanged when nothing was written during the fetch', async () => {
    const { result } = await renderBoard([card(1, 1)])
    const fetch = startFetch(result)
    const snapshot = makeBoard({ cards: [card(1, 1, { title: 'Snapshot' })] })
    await fetch.resolve(snapshot)
    expect(result.current.board).toBe(snapshot)
  })

  it('returns the snapshot unchanged when the writes did not change the result', async () => {
    const { result } = await renderBoard([card(1, 1)])
    const fetch = startFetch(result)
    act(() => { result.current.updateCard(card(1, 2)) })
    const snapshot = makeBoard({ cards: [card(1, 2, { title: 'Snapshot' })] })
    await fetch.resolve(snapshot)
    expect(result.current.board).toBe(snapshot)
  })

  it('does not merge a snapshot of another board into this one', async () => {
    const { result } = await renderBoard([card(1, 1)])
    const fetch = startFetch(result)
    act(() => { result.current.addCard(card(2, 1)) })
    act(() => { result.current.updateCard(card(1, 5)) })
    await fetch.resolve(makeBoard({ id: 2, cards: [card(7, 1)] }))
    expect(ids(result.current.board)).toEqual([7])
  })
})

// #2130: the rest of the board. Every non-card write applied while a /full/
// fetch is in flight is replayed over its snapshot, cascades included.
describe('useBoard — non-card writes that land mid-fetch are replayed (#2130)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNavigate.mockClear()
    mockGetArchivedCards.mockResolvedValue({ count: 0, results: [] })
  })

  const base = makeBoard()
  const card = (id: number, overrides: Partial<Card> = {}): Card =>
    ({ ...base.cards[0], id, uid: `crd${id}`, title: `Card ${id}`, ...overrides })
  const col = (id: number, overrides: Partial<Column> = {}): Column =>
    ({ ...base.columns[0], id, uid: `col${id}`, name: `Col ${id}`, position: id, ...overrides })
  const lane = (id: number, overrides: Partial<Swimlane> = {}): Swimlane =>
    ({ ...base.swimlanes[0], id, uid: `lane${id}`, name: `Lane ${id}`, position: id, ...overrides })
  const lbl = (id: number, name: string): Label => ({ id, uid: `lbl${id}`, name, color: '#EF4444' })
  const member = (userId: number, role: 'viewer' | 'member' | 'admin', extra: Record<string, unknown> = {}) => ({
    id: userId + 100, user: { id: userId, username: `u${userId}`, display_name: `U ${userId}`, avatar_url: '' },
    role, joined_at: '', ...extra,
  })
  const cardIds = (b: BoardFull | null) => b!.cards.map((c) => c.id).sort((x, y) => x - y)
  const colIds = (b: BoardFull | null) => b!.columns.map((c) => c.id)
  const laneIds = (b: BoardFull | null) => b!.swimlanes.map((s) => s.id)

  async function renderBoard(overrides: Partial<BoardFull>) {
    mockGetBoardFull.mockResolvedValueOnce(makeBoard(overrides))
    const hook = renderHook(() => useBoard())
    await waitFor(() => expect(hook.result.current.board).not.toBeNull())
    return hook
  }
  type Hook = Awaited<ReturnType<typeof renderBoard>>
  function startFetch(result: Hook['result'], via: 'load' | 'silentReload' = 'silentReload') {
    let resolve!: (b: BoardFull) => void
    mockGetBoardFull.mockReturnValueOnce(new Promise<BoardFull>((res) => { resolve = res }))
    act(() => { (via === 'load' ? result.current.reload : result.current.silentReload)() })
    return async (b: BoardFull) => {
      await act(async () => { resolve(b) })
      await waitFor(() => expect(result.current.loading).toBe(false))
    }
  }

  // Two columns, two lanes, a card in each column.
  const twoByTwo = (overrides: Partial<BoardFull> = {}) => makeBoard({
    columns: [col(10), col(11)],
    swimlanes: [lane(20), lane(21)],
    cards: [card(1, { column: 10, swimlane: 20 }), card(2, { column: 11, swimlane: 21 })],
    ...overrides,
  })

  for (const via of ['load', 'silentReload'] as const) {
    it(`a column.deleted frame removes the column and its cards from the snapshot (${via})`, async () => {
      const { result } = await renderBoard(twoByTwo())
      const resolve = startFetch(result, via)
      act(() => { result.current.evictColumn('col11') })
      // Read before the delete: the column, its card, and a card in it this
      // client never received.
      await resolve(twoByTwo({ cards: [card(1, { column: 10 }), card(2, { column: 11 }), card(3, { column: 11 })] }))
      expect(colIds(result.current.board)).toEqual([10])
      expect(cardIds(result.current.board)).toEqual([1])
    })
  }

  it('a column.deleted frame for a column not on screen still removes it from the snapshot', async () => {
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    // Created and deleted elsewhere; this client missed the create.
    act(() => { result.current.evictColumn('col12') })
    await resolve(twoByTwo({ columns: [col(10), col(11), col(12)], cards: [card(1), card(4, { column: 12 })] }))
    expect(colIds(result.current.board)).toEqual([10, 11])
    expect(cardIds(result.current.board)).toEqual([1])
  })

  it('a column delete also prunes the column from swimlane limits in the snapshot', async () => {
    const limited = lane(20, { wip_limit: 3, limit_column_ids: [10, 11] })
    const { result } = await renderBoard(twoByTwo({ swimlanes: [limited, lane(21)] }))
    const resolve = startFetch(result)
    act(() => { result.current.evictColumn('col11') })
    await resolve(twoByTwo({ swimlanes: [limited, lane(21)] }))
    expect(result.current.board!.swimlanes[0].limit_column_ids).toEqual([10])
  })

  for (const [label, remove] of [
    ['a column.deleted frame', (r: Hook['result']) => { act(() => { r.current.evictColumn('col11') }) }],
    ['a swimlane.deleted frame', (r: Hook['result']) => { act(() => { r.current.evictSwimlane('lane21') }) }],
  ] as const) {
    it(`re-reads the archived count after the snapshot when ${label} landed during the fetch`, async () => {
      const { result } = await renderBoard(twoByTwo({ archived_card_count: 3 }))
      const resolve = startFetch(result)
      // The delete's own count request answers before the snapshot lands.
      mockGetArchivedCards.mockResolvedValueOnce({ count: 1, results: [] })
      remove(result)
      await act(async () => {})
      expect(result.current.board!.archived_card_count).toBe(1)
      // The snapshot was read before the cascade, so it still counts 3.
      mockGetArchivedCards.mockResolvedValueOnce({ count: 1, results: [] })
      await resolve(twoByTwo({ archived_card_count: 3 }))
      await waitFor(() => expect(result.current.board!.archived_card_count).toBe(1))
      expect(mockGetArchivedCards).toHaveBeenCalledTimes(2)
    })
  }

  it('does not re-read the archived count when the snapshot has no archived cards', async () => {
    const { result } = await renderBoard(twoByTwo({ archived_card_count: 0 }))
    const resolve = startFetch(result)
    act(() => { result.current.evictColumn('col11') })
    await resolve(twoByTwo({ archived_card_count: 0 }))
    expect(mockGetArchivedCards).not.toHaveBeenCalled()
  })

  it("this user's own column delete is replayed over the snapshot", async () => {
    mockDeleteColumn.mockResolvedValueOnce(undefined)
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    await act(async () => { await result.current.removeColumn(11) })
    await resolve(twoByTwo())
    expect(colIds(result.current.board)).toEqual([10])
    expect(cardIds(result.current.board)).toEqual([1])
  })

  it('a card moved into a column that is then deleted does not come back from the snapshot', async () => {
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    act(() => { result.current.updateCard(card(1, { column: 11, version: 2 })) })
    act(() => { result.current.evictColumn('col11') })
    // Read before the move: card 1 is still in column 10, outside the cascade.
    await resolve(twoByTwo())
    expect(cardIds(result.current.board)).toEqual([])
  })

  // The reload may be recovering a move this tab missed: only the snapshot
  // knows where an unwritten card really is, so the local cascade must not
  // tombstone it.
  it('a card the tab still shows in a deleted column survives when the snapshot has it elsewhere (missed move)', async () => {
    // Card 2 sits in column 11 on screen; the server already moved it to 10.
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    act(() => { result.current.evictColumn('col11') })
    expect(cardIds(result.current.board)).toEqual([1]) // the local cascade
    await resolve(twoByTwo({ columns: [col(10), col(11)], cards: [card(1, { column: 10 }), card(2, { column: 10, swimlane: 21 })] }))
    expect(cardIds(result.current.board)).toEqual([1, 2])
    expect(result.current.board!.cards.find((c) => c.id === 2)?.column).toBe(10)
  })

  it('a card the tab still shows in a deleted swimlane survives when the snapshot has it elsewhere (missed move)', async () => {
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    act(() => { result.current.evictSwimlane('lane21') })
    await resolve(twoByTwo({ cards: [card(1, { swimlane: 20 }), card(2, { column: 11, swimlane: 20 })] }))
    expect(cardIds(result.current.board)).toEqual([1, 2])
    expect(result.current.board!.cards.find((c) => c.id === 2)?.swimlane).toBe(20)
  })

  it("this user's own column delete does not tombstone a card the snapshot has elsewhere", async () => {
    mockDeleteColumn.mockResolvedValueOnce(undefined)
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    await act(async () => { await result.current.removeColumn(11) })
    await resolve(twoByTwo({ cards: [card(1), card(2, { column: 10 })] }))
    expect(cardIds(result.current.board)).toEqual([1, 2])
  })

  for (const via of ['load', 'silentReload'] as const) {
    it(`a swimlane.deleted frame removes the swimlane and its cards from the snapshot (${via})`, async () => {
      const { result } = await renderBoard(twoByTwo())
      const resolve = startFetch(result, via)
      act(() => { result.current.evictSwimlane('lane21') })
      await resolve(twoByTwo({ cards: [card(1), card(2, { swimlane: 21 }), card(3, { swimlane: 21 })] }))
      expect(laneIds(result.current.board)).toEqual([20])
      expect(cardIds(result.current.board)).toEqual([1])
    })
  }

  it("this user's own swimlane delete is replayed over the snapshot", async () => {
    mockDeleteSwimlane.mockResolvedValueOnce(undefined)
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    await act(async () => { await result.current.removeSwimlane(21) })
    await resolve(twoByTwo())
    expect(laneIds(result.current.board)).toEqual([20])
    expect(cardIds(result.current.board)).toEqual([1])
  })

  it('a failed column delete reloads, and the reload does not replay the refused delete', async () => {
    mockDeleteColumn.mockRejectedValueOnce({ response: { status: 500 } })
    const { result } = await renderBoard(twoByTwo())
    const first = startFetch(result)
    // The failure's own reload supersedes the in-flight fetch.
    mockGetBoardFull.mockResolvedValueOnce(twoByTwo())
    await act(async () => { await result.current.removeColumn(11) })
    await waitFor(() => expect(colIds(result.current.board)).toEqual([10, 11]))
    await first(makeBoard({ columns: [col(10)] }))
    expect(colIds(result.current.board)).toEqual([10, 11])
    expect(cardIds(result.current.board)).toEqual([1, 2])
  })

  it('keeps a column created during the fetch, so a card created in it is not orphaned', async () => {
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    act(() => { result.current.addColumn(col(12, { name: 'New' })) })
    act(() => { result.current.addCard(card(5, { column: 12 })) })
    await resolve(twoByTwo())
    expect(colIds(result.current.board)).toEqual([10, 11, 12])
    expect(result.current.board!.cards.find((c) => c.id === 5)?.column).toBe(12)
  })

  it('a create the snapshot already holds is not added twice', async () => {
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    act(() => { result.current.addColumn(col(12, { name: 'Frame' })) })
    act(() => { result.current.addSwimlane(lane(22)) })
    act(() => { result.current.addLabel(lbl(7, 'Bug')) })
    await resolve(twoByTwo({ columns: [col(10), col(11), col(12)], swimlanes: [lane(20), lane(21), lane(22)], labels: [lbl(7, 'Bug')] }))
    expect(colIds(result.current.board)).toEqual([10, 11, 12])
    expect(laneIds(result.current.board)).toEqual([20, 21, 22])
    expect(result.current.board!.labels.map((l) => l.id)).toEqual([7])
  })

  it('keeps a swimlane created during the fetch', async () => {
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    act(() => { result.current.addSwimlane(lane(22, { name: 'New lane' })) })
    await resolve(twoByTwo())
    expect(laneIds(result.current.board)).toEqual([20, 21, 22])
  })

  it('keeps a column.updated edit over an older snapshot copy', async () => {
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    act(() => { result.current.updateColumn(col(11, { name: 'Renamed', wip_limit: 4 })) })
    await resolve(twoByTwo({ columns: [col(10, { name: 'Snapshot' }), col(11, { name: 'Old' })] }))
    expect(result.current.board!.columns[1]).toMatchObject({ name: 'Renamed', wip_limit: 4 })
    // A column nothing wrote takes the snapshot.
    expect(result.current.board!.columns[0].name).toBe('Snapshot')
  })

  it('keeps a swimlane.updated edit, re-resolved against the snapshot copy', async () => {
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    // BoardView's resolver merges the broadcast with the copy it is applied
    // to; replayed, that copy is the snapshot's.
    act(() => {
      result.current.updateSwimlane((b) => ({ ...b.swimlanes.find((s) => s.id === 21)!, name: 'Renamed' }))
    })
    await resolve(twoByTwo({ swimlanes: [lane(20), lane(21, { notes: 'From the snapshot' })] }))
    expect(result.current.board!.swimlanes[1]).toMatchObject({ name: 'Renamed', notes: 'From the snapshot' })
  })

  it('a label.updated frame renames the label and its copies on the snapshot cards', async () => {
    const old = lbl(7, 'Bug')
    const { result } = await renderBoard(twoByTwo({ labels: [old], cards: [card(1, { labels: [old] }), card(2)] }))
    const resolve = startFetch(result)
    act(() => { result.current.updateLabel(lbl(7, 'Defect')) })
    // The snapshot also holds a card with the label that this client never had.
    await resolve(twoByTwo({ labels: [old], cards: [card(1, { labels: [old] }), card(2), card(3, { labels: [old] })] }))
    expect(result.current.board!.labels).toEqual([lbl(7, 'Defect')])
    for (const id of [1, 3]) {
      expect(result.current.board!.cards.find((c) => c.id === id)?.labels).toEqual([lbl(7, 'Defect')])
    }
  })

  it('a label.deleted frame removes the label and strips it from the snapshot cards', async () => {
    const bug = lbl(7, 'Bug')
    const keep = lbl(8, 'Keep')
    const { result } = await renderBoard(twoByTwo({ labels: [bug, keep], cards: [card(1, { labels: [bug, keep] }), card(2)] }))
    const resolve = startFetch(result)
    act(() => { result.current.removeLabel('lbl7') })
    await resolve(twoByTwo({ labels: [bug, keep], cards: [card(1, { labels: [bug, keep] }), card(2, { labels: [bug] })] }))
    expect(result.current.board!.labels).toEqual([keep])
    expect(result.current.board!.cards.find((c) => c.id === 1)?.labels).toEqual([keep])
    expect(result.current.board!.cards.find((c) => c.id === 2)?.labels).toEqual([])
  })

  it('keeps a label created during the fetch', async () => {
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    act(() => { result.current.addLabel(lbl(9, 'New')) })
    await resolve(twoByTwo())
    expect(result.current.board!.labels).toEqual([lbl(9, 'New')])
  })

  it('keeps board.updated, share and star state over an older snapshot', async () => {
    const { result } = await renderBoard(twoByTwo({ archived_card_count: 2 }))
    const resolve = startFetch(result)
    act(() => { result.current.mergeBoardState({ name: 'Renamed', enforce_wip_limits: true, archived_card_count: 0 }) })
    act(() => { result.current.mergeBoardState({ share_link_active: true }) })
    act(() => { result.current.mergeBoardState({ is_starred: true }) })
    await resolve(twoByTwo({ name: 'Old', description: 'From the snapshot', archived_card_count: 5 }))
    expect(result.current.board).toMatchObject({
      name: 'Renamed', enforce_wip_limits: true, share_link_active: true, is_starred: true,
      description: 'From the snapshot',
      // Still never merged from a board.updated payload (#1289).
      archived_card_count: 5,
    })
  })

  it("keeps this user's own board settings change over an older snapshot", async () => {
    mockPatchBoard.mockResolvedValueOnce({})
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    await act(async () => { await result.current.updateBoardSettings({ name: 'Mine' }) })
    await resolve(twoByTwo({ name: 'Old' }))
    expect(result.current.board!.name).toBe('Mine')
  })

  it('keeps member changes made during the fetch', async () => {
    const { result } = await renderBoard(twoByTwo({ members: [member(1, 'admin'), member(2, 'viewer'), member(3, 'member')] }))
    const resolve = startFetch(result)
    act(() => { result.current.addMember(member(4, 'member') as never) })
    act(() => { result.current.updateMember(member(2, 'member') as never) })
    act(() => { result.current.removeMember(3) })
    await resolve(twoByTwo({ members: [member(1, 'admin'), member(2, 'viewer', { is_site_admin: true }), member(3, 'member')] }))
    const members = result.current.board!.members
    expect(members.map((m) => m.user.id)).toEqual([1, 2, 4])
    // The frame lacks is_site_admin; the snapshot's value is kept (#1290).
    expect(members[1]).toMatchObject({ role: 'member', is_site_admin: true })
  })

  it('keeps custom field definition changes made during the fetch', async () => {
    const def = (id: number, name: string) => ({ id, uid: `cf${id}`, name, position: id }) as unknown as CustomFieldDefinition
    const sdef = (id: number, name: string) => ({ id, uid: `sf${id}`, name, position: id }) as unknown as SwimlaneCustomFieldDefinition
    const { result } = await renderBoard(twoByTwo({ custom_field_definitions: [def(1, 'A'), def(2, 'B')], swimlane_custom_field_definitions: [sdef(1, 'A')] }))
    const resolve = startFetch(result)
    act(() => { result.current.applyCustomFieldDefinitions((prev) => prev.map((f) => (f.id === 1 ? def(1, 'A2') : f))) })
    act(() => { result.current.applyCustomFieldDefinitions((prev) => prev.filter((f) => f.uid !== 'cf2')) })
    act(() => { result.current.applySwimlaneFieldDefinitions([sdef(1, 'A'), sdef(2, 'New')]) })
    await resolve(twoByTwo({
      custom_field_definitions: [def(1, 'A'), def(2, 'B'), def(3, 'From the snapshot')],
      swimlane_custom_field_definitions: [sdef(1, 'A')],
    }))
    expect(result.current.board!.custom_field_definitions.map((f) => f.name)).toEqual(['A2', 'From the snapshot'])
    expect(result.current.board!.swimlane_custom_field_definitions.map((f) => f.name)).toEqual(['A', 'New'])
  })

  it('keeps column.reordered and swimlane.reordered orders over an older snapshot', async () => {
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    act(() => { result.current.applyColumnOrder([col(11, { position: 0 }), col(10, { position: 1 })]) })
    act(() => { result.current.applySwimlaneOrder([lane(21, { position: 0 }), lane(20, { position: 1 })]) })
    await resolve(twoByTwo())
    expect(colIds(result.current.board)).toEqual([11, 10])
    expect(laneIds(result.current.board)).toEqual([21, 20])
  })

  it("keeps this user's own column and swimlane reorders over an older snapshot", async () => {
    mockReorderColumns.mockResolvedValueOnce([col(11, { position: 0 }), col(10, { position: 1 })])
    mockReorderSwimlanes.mockResolvedValueOnce([lane(21, { position: 0 }), lane(20, { position: 1 })])
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    await act(async () => { await result.current.reorderColumns([11, 10]) })
    await act(async () => { await result.current.reorderSwimlanes([21, 20]) })
    await resolve(twoByTwo())
    expect(colIds(result.current.board)).toEqual([11, 10])
    expect(laneIds(result.current.board)).toEqual([21, 20])
  })

  it('an optimistic reorder still in flight keeps a snapshot column it does not name', async () => {
    let finish!: (cols: Column[]) => void
    mockReorderColumns.mockReturnValueOnce(new Promise<Column[]>((res) => { finish = res }))
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    let pending!: Promise<void>
    act(() => { pending = result.current.reorderColumns([11, 10]) })
    // The snapshot holds a column this client never received.
    await resolve(twoByTwo({ columns: [col(10), col(11), col(12)] }))
    expect(colIds(result.current.board)).toEqual([11, 10, 12])
    await act(async () => { finish([col(11), col(10), col(12)]); await pending })
  })

  it('a failed column reorder is not replayed over the snapshot', async () => {
    let fail!: (e: unknown) => void
    mockReorderColumns.mockReturnValueOnce(new Promise<Column[]>((_res, rej) => { fail = rej }))
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    let pending!: Promise<void>
    act(() => { pending = result.current.reorderColumns([11, 10]) })
    await act(async () => { fail({ response: { status: 500 } }); await pending })
    await resolve(twoByTwo({ columns: [col(10), col(11, { name: 'Snapshot' })] }))
    expect(colIds(result.current.board)).toEqual([10, 11])
    expect(result.current.board!.columns[1].name).toBe('Snapshot')
  })

  // Whole-list writes are replayed as what they changed, so an item the
  // snapshot holds and this tab never had (Missed) is not erased by them.
  describe('whole-list writes keep an item the snapshot holds and the tab missed', () => {
    const def = (id: number, name: string, extra: Record<string, unknown> = {}) =>
      ({ id, uid: `cf${id}`, name, position: id, help_text: '', ...extra }) as unknown as CustomFieldDefinition
    const sdef = (id: number, name: string, extra: Record<string, unknown> = {}) =>
      ({ id, uid: `sf${id}`, name, position: id, help_text: '', ...extra }) as unknown as SwimlaneCustomFieldDefinition
    const names = (list: { name: string }[]) => list.map((f) => f.name)

    it('the Fields tab adding a definition (custom fields)', async () => {
      const { result } = await renderBoard(twoByTwo({ custom_field_definitions: [def(0, 'A')] }))
      const resolve = startFetch(result)
      // BoardSettingsFieldsTab commits [...fields, created].
      act(() => { result.current.applyCustomFieldDefinitions([def(0, 'A'), def(2, 'Mine')]) })
      await resolve(twoByTwo({ custom_field_definitions: [def(0, 'A'), def(1, 'Missed'), def(2, 'Mine')] }))
      expect(names(result.current.board!.custom_field_definitions)).toEqual(['A', 'Missed', 'Mine'])
    })

    it('the Fields tab adding a definition the snapshot predates (custom fields)', async () => {
      const { result } = await renderBoard(twoByTwo({ custom_field_definitions: [def(0, 'A')] }))
      const resolve = startFetch(result)
      act(() => { result.current.applyCustomFieldDefinitions([def(0, 'A'), def(2, 'Mine')]) })
      await resolve(twoByTwo({ custom_field_definitions: [def(0, 'A'), def(1, 'Missed')] }))
      expect(names(result.current.board!.custom_field_definitions)).toEqual(['A', 'Missed', 'Mine'])
    })

    it('the Fields tab editing one definition only sets the fields it changed', async () => {
      const { result } = await renderBoard(twoByTwo({ custom_field_definitions: [def(0, 'A'), def(2, 'B')] }))
      const resolve = startFetch(result)
      act(() => { result.current.applyCustomFieldDefinitions([def(0, 'A renamed'), def(2, 'B')]) })
      // Another admin changed A's help text and B's name; this tab missed both.
      await resolve(twoByTwo({ custom_field_definitions: [def(0, 'A', { help_text: 'Theirs' }), def(1, 'Missed'), def(2, 'B theirs')] }))
      expect(result.current.board!.custom_field_definitions).toEqual([
        def(0, 'A renamed', { help_text: 'Theirs' }), def(1, 'Missed'), def(2, 'B theirs'),
      ])
    })

    it('the Fields tab deleting one definition removes only that one', async () => {
      const { result } = await renderBoard(twoByTwo({ custom_field_definitions: [def(0, 'A'), def(2, 'Mine')] }))
      const resolve = startFetch(result)
      act(() => { result.current.applyCustomFieldDefinitions([def(0, 'A')]) })
      await resolve(twoByTwo({ custom_field_definitions: [def(0, 'A'), def(1, 'Missed'), def(2, 'Mine')] }))
      expect(names(result.current.board!.custom_field_definitions)).toEqual(['A', 'Missed'])
    })

    it('an edit to a definition the snapshot no longer has does not bring it back', async () => {
      const { result } = await renderBoard(twoByTwo({ custom_field_definitions: [def(0, 'A'), def(2, 'B')] }))
      const resolve = startFetch(result)
      act(() => { result.current.applyCustomFieldDefinitions([def(0, 'A'), def(2, 'B renamed')]) })
      await resolve(twoByTwo({ custom_field_definitions: [def(0, 'A')] }))
      expect(names(result.current.board!.custom_field_definitions)).toEqual(['A'])
    })

    it('the row Fields tab adding a definition (swimlane fields)', async () => {
      const { result } = await renderBoard(twoByTwo({ swimlane_custom_field_definitions: [sdef(0, 'A')] }))
      const resolve = startFetch(result)
      act(() => { result.current.applySwimlaneFieldDefinitions([sdef(0, 'A'), sdef(2, 'Mine')]) })
      await resolve(twoByTwo({ swimlane_custom_field_definitions: [sdef(0, 'A'), sdef(1, 'Missed'), sdef(2, 'Mine')] }))
      expect(names(result.current.board!.swimlane_custom_field_definitions)).toEqual(['A', 'Missed', 'Mine'])
    })

    it("this user's own column reorder response", async () => {
      mockReorderColumns.mockResolvedValueOnce([col(11, { position: 0 }), col(10, { position: 1 })])
      const { result } = await renderBoard(twoByTwo())
      const resolve = startFetch(result)
      await act(async () => { await result.current.reorderColumns([11, 10]) })
      await resolve(makeBoard({ ...twoByTwo(), columns: [col(10, { position: 1 }), col(11, { position: 0 }), col(12, { name: 'Missed', position: 2 })] }))
      expect(colIds(result.current.board)).toEqual([11, 10, 12])
    })

    it("this user's own swimlane reorder response", async () => {
      mockReorderSwimlanes.mockResolvedValueOnce([lane(21, { position: 0 }), lane(20, { position: 1 })])
      const { result } = await renderBoard(twoByTwo())
      const resolve = startFetch(result)
      await act(async () => { await result.current.reorderSwimlanes([21, 20]) })
      await resolve(twoByTwo({ swimlanes: [lane(20, { position: 1 }), lane(21, { position: 0 }), lane(22, { name: 'Missed', position: 2 })] }))
      expect(laneIds(result.current.board)).toEqual([21, 20, 22])
    })

    it('a column.reordered / swimlane.reordered frame', async () => {
      const { result } = await renderBoard(twoByTwo())
      const resolve = startFetch(result)
      act(() => { result.current.applyColumnOrder([col(11, { position: 0 }), col(10, { position: 2 })]) })
      act(() => { result.current.applySwimlaneOrder([lane(21, { position: 0 }), lane(20, { position: 1 })]) })
      // Missed is placed by its position among the reordered items.
      await resolve(twoByTwo({
        columns: [col(10), col(11), col(12, { name: 'Missed', position: 1 })],
        swimlanes: [lane(20), lane(21), lane(22, { name: 'Missed', position: 5 })],
      }))
      expect(colIds(result.current.board)).toEqual([11, 12, 10])
      expect(laneIds(result.current.board)).toEqual([21, 20, 22])
    })

    it('outside a fetch a whole-list write still sets the list exactly', async () => {
      const { result } = await renderBoard(twoByTwo({ custom_field_definitions: [def(0, 'A'), def(1, 'B')] }))
      const next = [def(1, 'B', { position: 0 }), def(2, 'C')]
      act(() => { result.current.applyCustomFieldDefinitions(next) })
      expect(result.current.board!.custom_field_definitions).toEqual(next)
      act(() => { result.current.applyColumnOrder([col(11), col(10)]) })
      expect(colIds(result.current.board)).toEqual([11, 10])
    })
  })

  // The writes are replayed in the order they arrived, so the later of two
  // writes to the same item wins over the snapshot, as it did on screen.
  it('replays two edits of one column in arrival order', async () => {
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    act(() => { result.current.updateColumn(col(11, { name: 'First' })) })
    act(() => { result.current.updateColumn(col(11, { name: 'Second' })) })
    await resolve(twoByTwo({ columns: [col(10), col(11, { name: 'Snapshot' })] }))
    expect(result.current.board!.columns[1].name).toBe('Second')
  })

  it('replays a label created and then deleted in arrival order', async () => {
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    act(() => { result.current.addLabel(lbl(9, 'Short-lived')) })
    act(() => { result.current.removeLabel('lbl9') })
    await resolve(twoByTwo())
    expect(result.current.board!.labels).toEqual([])
  })

  // The updater form, fed by swimlane_custom_field.created/updated/deleted
  // frames (BoardView), mirrors the card-field cases.
  it('keeps swimlane field definition frames (updater form) made during the fetch', async () => {
    const sdef = (id: number, name: string) => ({ id, uid: `sf${id}`, name, position: id }) as unknown as SwimlaneCustomFieldDefinition
    const { result } = await renderBoard(twoByTwo({ swimlane_custom_field_definitions: [sdef(1, 'A'), sdef(2, 'B')] }))
    const resolve = startFetch(result)
    act(() => { result.current.applySwimlaneFieldDefinitions((prev) => [...prev, sdef(4, 'Created')]) })
    act(() => { result.current.applySwimlaneFieldDefinitions((prev) => prev.map((f) => (f.id === 1 ? sdef(1, 'A2') : f))) })
    act(() => { result.current.applySwimlaneFieldDefinitions((prev) => prev.filter((f) => f.uid !== 'sf2')) })
    await resolve(twoByTwo({ swimlane_custom_field_definitions: [sdef(1, 'A'), sdef(2, 'B'), sdef(3, 'From the snapshot')] }))
    expect(result.current.board!.swimlane_custom_field_definitions.map((f) => f.name)).toEqual(['A2', 'From the snapshot', 'Created'])
  })

  it('a non-card write before the fetch is not replayed: the snapshot stays authoritative', async () => {
    const { result } = await renderBoard(twoByTwo())
    act(() => { result.current.updateColumn(col(11, { name: 'Before the fetch' })) })
    const resolve = startFetch(result)
    await resolve(twoByTwo({ columns: [col(10), col(11, { name: 'Corrected' })] }))
    expect(result.current.board!.columns[1].name).toBe('Corrected')
  })

  it('a newer fetch does not replay the writes of the one it superseded', async () => {
    const { result } = await renderBoard(twoByTwo())
    const first = startFetch(result)
    act(() => { result.current.updateColumn(col(11, { name: 'During the first fetch' })) })
    const second = startFetch(result)
    await second(twoByTwo({ columns: [col(10), col(11, { name: 'Second snapshot' })] }))
    await first(twoByTwo())
    expect(result.current.board!.columns[1].name).toBe('Second snapshot')
  })

  it('does not replay writes over a snapshot of another board', async () => {
    const { result } = await renderBoard(twoByTwo())
    const resolve = startFetch(result)
    act(() => { result.current.addColumn(col(12)) })
    await resolve(makeBoard({ id: 2, columns: [col(30)] }))
    expect(colIds(result.current.board)).toEqual([30])
  })

  // #2147: a swimlane copy is written in the shape /full/ returns for the
  // role of the board it is applied to, live and when replayed over a snapshot.
  describe('swimlane responses are shaped to the role of the board they are applied to (#2147)', () => {
    const fieldDef = (id: number, isAdminOnly: boolean): SwimlaneCustomFieldDefinition => ({
      id, uid: `sfd${id}`, name: `Field ${id}`, field_type: 'text', choices: [], choice_colors: {}, position: id,
      show_on_row: false, is_admin_only: isAdminOnly, is_required: false, help_text: '',
      number_prefix: '', number_suffix: '', number_decimals: null, created_at: '2026-01-01',
    }) as SwimlaneCustomFieldDefinition
    const defs = [fieldDef(5, true), fieldDef(6, false)]
    // The admin serializer's copy, and the public one /full/ sends other roles.
    const adminLane = (id: number, overrides: Partial<Swimlane> = {}): Swimlane => lane(id, {
      contact_email: 'owner@example.com', notes: 'Account notes',
      custom_field_values: [{ field_definition: 5, value: '120000' }, { field_definition: 6, value: 'Gold' }],
      ...overrides,
    })
    const publicLane = (id: number, overrides: Partial<Swimlane> = {}): Swimlane => {
      const { contact_email: _contactEmail, notes: _notes, ...rest } = lane(id, {
        custom_field_values: [{ field_definition: 6, value: 'Gold' }], ...overrides,
      })
      return rest as Swimlane
    }
    const adminBoard = () => twoByTwo({
      current_user_role: 'admin', swimlane_custom_field_definitions: defs, swimlanes: [adminLane(20), adminLane(21)],
    })
    const memberSnapshot = () => twoByTwo({
      current_user_role: 'member', swimlane_custom_field_definitions: defs, swimlanes: [publicLane(20), publicLane(21)],
    })
    const expectPublicShape = (s: Swimlane | undefined) => {
      expect(s).toBeDefined()
      expect(s).not.toHaveProperty('contact_email')
      expect(s).not.toHaveProperty('notes')
      expect(s!.custom_field_values!.map((v) => v.field_definition)).toEqual([6])
    }

    // Each writer, fed the admin-shaped HTTP response it receives: the
    // SwimlaneRow rename and the EditSwimlaneModal save (updateSwimlane, object
    // form) and the add-swimlane create (BoardView, addSwimlane).
    const writers = [
      {
        name: 'a rename response (updateSwimlane)', id: 21, expectedName: 'Renamed',
        write: (r: Hook['result']) => { r.current.updateSwimlane(adminLane(21, { name: 'Renamed' })) },
      },
      {
        name: 'an edit modal response (updateSwimlane)', id: 21, expectedName: 'Edited',
        write: (r: Hook['result']) => {
          r.current.updateSwimlane(adminLane(21, {
            name: 'Edited', contact_email: 'new@example.com', notes: 'New notes',
            custom_field_values: [{ field_definition: 5, value: '99' }, { field_definition: 6, value: 'Silver' }],
          }))
        },
      },
      {
        name: 'a create response (addSwimlane)', id: 22, expectedName: 'Lane 22',
        write: (r: Hook['result']) => { r.current.addSwimlane(adminLane(22)) },
      },
    ] as const

    for (const w of writers) {
      it(`${w.name} landing after a self role change to member, mid-fetch`, async () => {
        const { result } = await renderBoard(adminBoard())
        // BoardView's self member.updated handler: sync the role, then reload.
        act(() => { result.current.mergeBoardState({ current_user_role: 'member' }) })
        const resolve = startFetch(result)
        act(() => { w.write(result) })
        // Applied live under the synced role.
        expectPublicShape(result.current.board!.swimlanes.find((s) => s.id === w.id))
        await resolve(memberSnapshot())
        const after = result.current.board!.swimlanes.find((s) => s.id === w.id)
        expectPublicShape(after)
        expect(after!.name).toBe(w.expectedName)
      })

      it(`${w.name} replayed over a snapshot read under a member role`, async () => {
        // No self frame (a role change that publishes none): the live board is
        // still admin when the response lands, the snapshot is not.
        const { result } = await renderBoard(adminBoard())
        const resolve = startFetch(result)
        act(() => { w.write(result) })
        expect(result.current.board!.swimlanes.find((s) => s.id === w.id)).toHaveProperty('contact_email')
        await resolve(memberSnapshot())
        const after = result.current.board!.swimlanes.find((s) => s.id === w.id)
        expectPublicShape(after)
        expect(after!.name).toBe(w.expectedName)
      })

      it(`${w.name} still applies in full on an admin board, mid-fetch`, async () => {
        const { result } = await renderBoard(adminBoard())
        const resolve = startFetch(result)
        act(() => { w.write(result) })
        await resolve(adminBoard())
        const after = result.current.board!.swimlanes.find((s) => s.id === w.id)
        expect(after).toMatchObject({ name: w.expectedName, contact_email: expect.any(String), notes: expect.any(String) })
        expect(after!.custom_field_values!.map((v) => v.field_definition)).toEqual([5, 6])
      })
    }

    it('the edit modal response replaces the admin values on an admin board', async () => {
      const { result } = await renderBoard(adminBoard())
      const resolve = startFetch(result)
      act(() => { writers[1].write(result) })
      await resolve(adminBoard())
      expect(result.current.board!.swimlanes[1]).toMatchObject({
        contact_email: 'new@example.com', notes: 'New notes',
        custom_field_values: [{ field_definition: 5, value: '99' }, { field_definition: 6, value: 'Silver' }],
      })
    })

    it('a role change to member reshapes the swimlanes already held, without the reload', async () => {
      const { result } = await renderBoard(adminBoard())
      act(() => { result.current.mergeBoardState({ current_user_role: 'member' }) })
      for (const s of result.current.board!.swimlanes) expectPublicShape(s)
    })

    it('a merge that does not change the role leaves the swimlanes as they are', async () => {
      const { result } = await renderBoard(adminBoard())
      const before = result.current.board!.swimlanes
      act(() => { result.current.mergeBoardState({ name: 'Renamed' }) })
      expect(result.current.board!.swimlanes).toBe(before)
    })

    it('a swimlane.updated resolver is shaped too once the role is member', async () => {
      // The resolver form keeps admin-only values the broadcast lacks from the
      // copy on screen (#1140); under a member role they are not kept.
      const { result } = await renderBoard(adminBoard())
      act(() => { result.current.mergeBoardState({ current_user_role: 'member' }) })
      act(() => {
        result.current.updateSwimlane(() => adminLane(21, { name: 'From a frame' }))
      })
      expectPublicShape(result.current.board!.swimlanes[1])
      expect(result.current.board!.swimlanes[1].name).toBe('From a frame')
    })

    describe('a definitions change reshapes the swimlanes already held', () => {
      const ids = (s: Swimlane | undefined) => s!.custom_field_values!.map((v) => v.field_definition)
      const closed = () => defs.map((d) => (d.id === 6 ? { ...d, is_admin_only: true } : d))
      const writers: Array<[string, (r: Hook['result']) => void]> = [
        ['definitions updated', (r) => { r.current.applySwimlaneFieldDefinitions((prev) => prev.map((d) => (d.id === 6 ? { ...d, is_admin_only: true } : d))) }],
        ['definitions reordered', (r) => { r.current.applySwimlaneFieldDefinitions(closed()) }],
      ]
      it.each(writers)('%s: a member loses the value of a definition that became admin-only', async (_n, write) => {
        const { result } = await renderBoard(twoByTwo({
          current_user_role: 'member', swimlane_custom_field_definitions: defs, swimlanes: [publicLane(20), publicLane(21)],
        }))
        expect(ids(result.current.board!.swimlanes[1])).toEqual([6])
        act(() => { write(result) })
        expect(ids(result.current.board!.swimlanes[1])).toEqual([])
      })
      it.each(writers)('%s: an admin keeps every value', async (_n, write) => {
        const { result } = await renderBoard(adminBoard())
        act(() => { write(result) })
        expect(ids(result.current.board!.swimlanes[1])).toEqual([5, 6])
      })
    })

    describe('swimlaneForRole', () => {
      const board = (role: BoardFull['current_user_role']) =>
        makeBoard({ current_user_role: role, swimlane_custom_field_definitions: defs })

      it('returns the copy unchanged for admin and site_admin', () => {
        const copy = adminLane(21)
        expect(swimlaneForRole(copy, board('admin'))).toBe(copy)
        expect(swimlaneForRole(copy, board('site_admin'))).toBe(copy)
      })

      for (const role of ['member', 'viewer', null] as const) {
        it(`drops the fields the public serializer omits for ${String(role)}`, () => {
          expectPublicShape(swimlaneForRole(adminLane(21), board(role)))
        })
      }

      it('drops a value whose definition the board does not hold', () => {
        const copy = adminLane(21, { custom_field_values: [{ field_definition: 6, value: 'Gold' }, { field_definition: 9, value: 'x' }] })
        expect(swimlaneForRole(copy, board('member')).custom_field_values).toEqual([{ field_definition: 6, value: 'Gold' }])
      })

      it('leaves an absent value list absent', () => {
        const copy = adminLane(21)
        delete copy.custom_field_values
        expect(swimlaneForRole(copy, board('member'))).not.toHaveProperty('custom_field_values')
      })
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

// The dwell overlay reads `column_entered_at` off the card (#459), so an optimistic move
// has to keep it true until the server's copy lands, or the cell lies in between.
describe('useBoard — column_entered_at across a move (#459)', () => {
  const ENTERED = '2026-10-01T00:00:00.000Z'
  const NOW = Date.UTC(2026, 10, 3, 12)

  async function renderCard() {
    const base = makeBoard()
    mockGetBoardFull.mockResolvedValue({
      ...base,
      columns: [base.columns[0], { ...base.columns[0], id: 11, uid: 'col11', name: 'Doing' }, { ...base.columns[0], id: 12, uid: 'col12', name: 'Done', is_done: true }],
      cards: [{ ...base.cards[0], column: base.columns[0].id, column_entered_at: ENTERED, version: 1 }],
    })
    const hook = renderHook(() => useBoard())
    await waitFor(() => expect(hook.result.current.board).not.toBeNull())
    return hook
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Starts a move that never settles, so the optimistic copy can be read. */
  function moveAndHold(result: { current: ReturnType<typeof useBoard> }, column: number, swimlane: number) {
    mockMoveCard.mockReturnValueOnce(new Promise(() => {}))
    act(() => { void result.current.moveCard(result.current.board!.cards[0].id, column, swimlane, 0) })
    return result.current.board!.cards[0]
  }

  it('starts a new visit when the card changes column', async () => {
    const { result } = await renderCard()
    const before = Date.now()
    const card = moveAndHold(result, 11, result.current.board!.cards[0].swimlane)
    expect(card.column_entered_at).not.toBe(ENTERED)
    expect(Date.parse(card.column_entered_at!)).toBeGreaterThanOrEqual(before - 1000)
  })

  it('clears it when the card enters a done column', async () => {
    const { result } = await renderCard()
    expect(moveAndHold(result, 12, result.current.board!.cards[0].swimlane).column_entered_at).toBeNull()
  })

  it('keeps it on a swimlane-only move, which is not a new visit', async () => {
    const { result } = await renderCard()
    const { column } = result.current.board!.cards[0]
    expect(moveAndHold(result, column, 99).column_entered_at).toBe(ENTERED)
  })

  it('restores it when the move is rolled back', async () => {
    const { result } = await renderCard()
    const { id, swimlane } = result.current.board!.cards[0]
    mockMoveCard.mockRejectedValueOnce(new Error('network'))
    await act(async () => { await result.current.moveCard(id, 11, swimlane, 0) })
    expect(result.current.board!.cards[0].column_entered_at).toBe(ENTERED)
  })

  it('takes the server value from the move response', async () => {
    const { result } = await renderCard()
    const card = result.current.board!.cards[0]
    mockMoveCard.mockResolvedValueOnce({ card: { ...card, column: 11, version: 2, column_entered_at: '2026-11-03T11:59:59.000Z' } })
    await act(async () => { await result.current.moveCard(card.id, 11, card.swimlane, 0) })
    expect(result.current.board!.cards[0].column_entered_at).toBe('2026-11-03T11:59:59.000Z')
  })

  it('applies the same rules to a forced move', async () => {
    const { result } = await renderCard()
    const { id, swimlane } = result.current.board!.cards[0]
    mockMoveCard.mockRejectedValueOnce(new Error('network'))
    await act(async () => { await result.current.forceMoveCardTo(id, 12, swimlane, 0) })
    expect(result.current.board!.cards[0].column_entered_at).toBe(ENTERED)
    mockMoveCard.mockReturnValueOnce(new Promise(() => {}))
    act(() => { void result.current.forceMoveCardTo(id, 12, swimlane, 0) })
    expect(result.current.board!.cards[0].column_entered_at).toBeNull()
  })
})
