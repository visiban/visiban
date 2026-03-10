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
  importBoard,
  exportBoardCsv,
  exportBoardJson,
  getBoardAnalytics,
  createColumn,
  reorderColumns,
  createSwimlane,
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
    await getBoardAnalytics(2, 30, 7)
    expect(mockClient.get).toHaveBeenCalledWith('/api/boards/2/analytics/', {
      params: { days: 30, stalled_days: 7 },
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
