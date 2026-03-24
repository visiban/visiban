import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the client module before any imports that use it
vi.mock('../api/client', () => {
  const mockClient = {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
    defaults: { baseURL: 'http://localhost:8000' },
  }
  return { default: mockClient }
})

import client from '../api/client'
import {
  listBoards,
  createBoard,
  getBoard,
  getBoardFull,
  updateBoard,
  deleteBoard,
  moveBoardToGroup,
  importBoard,
  exportBoardCsv,
  exportBoardJson,
  getBoardAnalytics,
  getBoardSummary,
  createColumn,
  updateColumn,
  deleteColumn,
  reorderColumns,
  createSwimlane,
  updateSwimlane,
  deleteSwimlane,
  reorderSwimlanes,
  listLabels,
  createLabel,
  setBoardMember,
  removeBoardMember,
} from '../api/boards'
import { moveCard, createCard } from '../api/cards'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockClient = client as any

describe('Board API wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('listBoards calls GET /api/boards/', async () => {
    mockClient.get.mockResolvedValue({ data: { results: [{ id: 1 }] } })
    const result = await listBoards()
    expect(mockClient.get).toHaveBeenCalledWith('/api/boards/')
    expect(result).toEqual([{ id: 1 }])
  })

  it('getBoard calls GET /api/boards/:id/', async () => {
    mockClient.get.mockResolvedValue({ data: { id: 5, name: 'Test' } })
    const result = await getBoard(5)
    expect(mockClient.get).toHaveBeenCalledWith('/api/boards/5/')
    expect(result).toEqual({ id: 5, name: 'Test' })
  })

  it('getBoardFull calls GET /api/boards/:id/full/', async () => {
    mockClient.get.mockResolvedValue({ data: { id: 3, columns: [] } })
    await getBoardFull(3)
    expect(mockClient.get).toHaveBeenCalledWith('/api/boards/3/full/')
  })

  it('createBoard sends POST with data', async () => {
    const data = { name: 'New Board', description: 'Desc' }
    mockClient.post.mockResolvedValue({ data: { id: 10, ...data } })
    const result = await createBoard(data)
    expect(mockClient.post).toHaveBeenCalledWith('/api/boards/', data)
    expect(result.name).toBe('New Board')
  })

  it('updateBoard sends PUT with partial data', async () => {
    mockClient.put.mockResolvedValue({ data: { id: 1, name: 'Updated' } })
    await updateBoard(1, { name: 'Updated' })
    expect(mockClient.put).toHaveBeenCalledWith('/api/boards/1/', { name: 'Updated' })
  })

  it('deleteBoard sends DELETE', async () => {
    await deleteBoard(7)
    expect(mockClient.delete).toHaveBeenCalledWith('/api/boards/7/')
  })

  describe('importBoard', () => {
    it('sends FormData with file', async () => {
      const file = new File(['{}'], 'board.json', { type: 'application/json' })
      mockClient.post.mockResolvedValue({ data: { id: 99 } })
      await importBoard(file)

      expect(mockClient.post).toHaveBeenCalledWith('/api/boards/import/', expect.any(FormData))
      const formData = mockClient.post.mock.calls[0][1] as FormData
      expect(formData.get('file')).toBe(file)
      expect(formData.get('name')).toBeNull()
      expect(formData.get('group_id')).toBeNull()
    })

    it('includes optional name in FormData', async () => {
      const file = new File(['{}'], 'board.json', { type: 'application/json' })
      mockClient.post.mockResolvedValue({ data: { id: 99 } })
      await importBoard(file, 'My Board')

      const formData = mockClient.post.mock.calls[0][1] as FormData
      expect(formData.get('name')).toBe('My Board')
    })

    it('includes optional groupId in FormData', async () => {
      const file = new File(['{}'], 'board.json', { type: 'application/json' })
      mockClient.post.mockResolvedValue({ data: { id: 99 } })
      await importBoard(file, 'Board', 42)

      const formData = mockClient.post.mock.calls[0][1] as FormData
      expect(formData.get('group_id')).toBe('42')
    })
  })

  describe('exportBoard', () => {
    it('exportBoardCsv opens correct URL', () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
      exportBoardCsv(5)
      expect(openSpy).toHaveBeenCalledWith('http://localhost:8000/api/boards/5/export/', '_blank')
      openSpy.mockRestore()
    })

    it('exportBoardJson opens URL with format=json', () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
      exportBoardJson(5)
      expect(openSpy).toHaveBeenCalledWith('http://localhost:8000/api/boards/5/export/?format=json', '_blank')
      openSpy.mockRestore()
    })
  })

  it('getBoardAnalytics calls correct endpoint with params', async () => {
    mockClient.get.mockResolvedValue({ data: { days: 30 } })
    await getBoardAnalytics(2, 30)
    expect(mockClient.get).toHaveBeenCalledWith('/api/boards/2/analytics/', {
      params: { days: 30 },
    })
  })

  it('getBoardAnalytics omits stalled_days when not specified', async () => {
    mockClient.get.mockResolvedValue({ data: {} })
    await getBoardAnalytics(1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/boards/1/analytics/', {
      params: { days: 30 },
    })
  })

  it('createColumn sends POST to board columns endpoint', async () => {
    mockClient.post.mockResolvedValue({ data: { id: 1 } })
    await createColumn(3, { name: 'To Do', color: '#ff0000' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/boards/3/columns/', { name: 'To Do', color: '#ff0000' })
  })

  it('reorderColumns sends POST with order array', async () => {
    mockClient.post.mockResolvedValue({ data: [] })
    await reorderColumns(1, [3, 1, 2])
    expect(mockClient.post).toHaveBeenCalledWith('/api/boards/1/columns/reorder/', { order: [3, 1, 2] })
  })

  it('createSwimlane sends POST to board swimlanes endpoint', async () => {
    mockClient.post.mockResolvedValue({ data: { id: 1 } })
    await createSwimlane(2, { name: 'Customer A', color: '#00ff00' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/boards/2/swimlanes/', { name: 'Customer A', color: '#00ff00' })
  })

  it('moveBoardToGroup sends POST with group_id', async () => {
    mockClient.post.mockResolvedValue({ data: { id: 5, group: 10 } })
    await moveBoardToGroup(5, 10)
    expect(mockClient.post).toHaveBeenCalledWith('/api/boards/5/move-group/', { group_id: 10 })
  })

  it('moveBoardToGroup accepts null to ungroup a board', async () => {
    mockClient.post.mockResolvedValue({ data: { id: 5, group: null } })
    const result = await moveBoardToGroup(5, null)
    expect(mockClient.post).toHaveBeenCalledWith('/api/boards/5/move-group/', { group_id: null })
    expect(result).toEqual({ id: 5, group: null })
  })

  it('getBoardSummary calls GET /api/boards/:id/summary/', async () => {
    mockClient.get.mockResolvedValue({ data: { total_cards: 5 } })
    const result = await getBoardSummary(1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/boards/1/summary/')
    expect(result).toEqual({ total_cards: 5 })
  })

  it('getBoardAnalytics uses default days=30 when not specified', async () => {
    mockClient.get.mockResolvedValue({ data: {} })
    await getBoardAnalytics(1, 30, 14)
    expect(mockClient.get).toHaveBeenCalledWith('/api/boards/1/analytics/', {
      params: { days: 30, stalled_days: 14 },
    })
  })

  it('updateColumn sends PUT to /api/boards/:id/columns/:colId/', async () => {
    mockClient.put.mockResolvedValue({ data: { id: 10, name: 'In Progress' } })
    await updateColumn(1, 10, { name: 'In Progress' })
    expect(mockClient.put).toHaveBeenCalledWith('/api/boards/1/columns/10/', { name: 'In Progress' })
  })

  it('deleteColumn sends DELETE to /api/boards/:id/columns/:colId/', async () => {
    await deleteColumn(1, 10)
    expect(mockClient.delete).toHaveBeenCalledWith('/api/boards/1/columns/10/')
  })

  it('updateSwimlane sends PUT to /api/boards/:id/swimlanes/:swimlaneId/', async () => {
    mockClient.put.mockResolvedValue({ data: { id: 20, name: 'Lane B' } })
    await updateSwimlane(1, 20, { name: 'Lane B' })
    expect(mockClient.put).toHaveBeenCalledWith('/api/boards/1/swimlanes/20/', { name: 'Lane B' })
  })

  it('deleteSwimlane sends DELETE to /api/boards/:id/swimlanes/:swimlaneId/', async () => {
    await deleteSwimlane(1, 20)
    expect(mockClient.delete).toHaveBeenCalledWith('/api/boards/1/swimlanes/20/')
  })

  it('reorderSwimlanes sends POST with order array', async () => {
    mockClient.post.mockResolvedValue({ data: [] })
    await reorderSwimlanes(1, [21, 20])
    expect(mockClient.post).toHaveBeenCalledWith('/api/boards/1/swimlanes/reorder/', { order: [21, 20] })
  })

  it('listLabels calls GET /api/boards/:id/labels/', async () => {
    mockClient.get.mockResolvedValue({ data: [{ id: 1, name: 'Bug', color: '#EF4444' }] })
    const result = await listLabels(1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/boards/1/labels/')
    expect(result).toEqual([{ id: 1, name: 'Bug', color: '#EF4444' }])
  })

  it('createLabel sends POST /api/boards/:id/labels/ with data', async () => {
    mockClient.post.mockResolvedValue({ data: { id: 2, name: 'Feature', color: '#3B82F6' } })
    const result = await createLabel(1, { name: 'Feature', color: '#3B82F6' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/boards/1/labels/', { name: 'Feature', color: '#3B82F6' })
    expect(result).toEqual({ id: 2, name: 'Feature', color: '#3B82F6' })
  })

  it('setBoardMember calls POST /api/boards/:id/members/ with user_id and role', async () => {
    mockClient.post.mockResolvedValue({ data: { id: 1, user: { id: 7 }, role: 'member' } })
    const result = await setBoardMember(1, 7, 'member')
    expect(mockClient.post).toHaveBeenCalledWith('/api/boards/1/members/', { user_id: 7, role: 'member' })
    expect(result).toEqual({ id: 1, user: { id: 7 }, role: 'member' })
  })

  it('removeBoardMember calls DELETE /api/boards/:id/members/:userId/', async () => {
    await removeBoardMember(1, 7)
    expect(mockClient.delete).toHaveBeenCalledWith('/api/boards/1/members/7/')
  })
})

describe('Card API wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('moveCard sends POST with correct payload', async () => {
    mockClient.post.mockResolvedValue({ data: { card: { id: 10 }, movement: { id: 1 } } })
    const payload = { column_id: 2, swimlane_id: 3, position: 0 }
    const result = await moveCard(1, 10, payload)
    expect(mockClient.post).toHaveBeenCalledWith('/api/boards/1/cards/10/move/', payload)
    expect(result).toEqual({ card: { id: 10 }, movement: { id: 1 } })
  })

  it('createCard sends POST with card data', async () => {
    const cardData = { column: 1, swimlane: 2, title: 'New Card' }
    mockClient.post.mockResolvedValue({ data: { id: 5, ...cardData } })
    const result = await createCard(1, cardData)
    expect(mockClient.post).toHaveBeenCalledWith('/api/boards/1/cards/', cardData)
    expect(result.title).toBe('New Card')
  })
})
