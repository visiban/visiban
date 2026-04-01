import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../api/client', () => ({
  default: {
    post: vi.fn(),
    patch: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
}))

import client from '../api/client'
import {
  createCard, updateCard, deleteCard, moveCard,
  getCardMovements, getCardComments, addCardComment, deleteComment,
  getCardActivities, getCardAttachments, uploadCardAttachment,
  deleteCardAttachment, getChecklist, addChecklistItem,
  updateChecklistItem, deleteChecklistItem,
  archiveCard, unarchiveCard, getArchivedCards,
} from '../api/cards'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockClient = client as any

describe('cards API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('createCard posts to correct URL', async () => {
    const card = { id: 1, title: 'New' }
    mockClient.post.mockResolvedValue({ data: card })
    const result = await createCard(5, { column: 1, swimlane: 2, title: 'New' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/boards/5/cards/', { column: 1, swimlane: 2, title: 'New' })
    expect(result).toEqual(card)
  })

  it('updateCard patches card', async () => {
    const card = { id: 1, title: 'Updated' }
    mockClient.patch.mockResolvedValue({ data: card })
    const result = await updateCard(5, 1, { title: 'Updated' })
    expect(mockClient.patch).toHaveBeenCalledWith('/api/boards/5/cards/1/', { title: 'Updated' })
    expect(result).toEqual(card)
  })

  it('deleteCard sends delete request', async () => {
    mockClient.delete.mockResolvedValue({})
    await deleteCard(5, 1)
    expect(mockClient.delete).toHaveBeenCalledWith('/api/boards/5/cards/1/')
  })

  it('moveCard posts move data', async () => {
    const response = { card: { id: 1 }, movement: { id: 10 } }
    mockClient.post.mockResolvedValue({ data: response })
    const result = await moveCard(5, 1, { column_id: 2, swimlane_id: 3, position: 0 })
    expect(mockClient.post).toHaveBeenCalledWith('/api/boards/5/cards/1/move/', { column_id: 2, swimlane_id: 3, position: 0 })
    expect(result).toEqual(response)
  })

  it('getCardMovements fetches movements', async () => {
    const movements = [{ id: 1 }]
    mockClient.get.mockResolvedValue({ data: movements })
    const result = await getCardMovements(5, 1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/boards/5/cards/1/movements/')
    expect(result).toEqual(movements)
  })

  it('getCardComments fetches comments', async () => {
    mockClient.get.mockResolvedValue({ data: [] })
    const result = await getCardComments(5, 1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/boards/5/cards/1/comments/')
    expect(result).toEqual([])
  })

  it('addCardComment posts comment', async () => {
    const comment = { id: 1, body: 'Hello' }
    mockClient.post.mockResolvedValue({ data: comment })
    const result = await addCardComment(5, 1, 'Hello')
    expect(mockClient.post).toHaveBeenCalledWith('/api/boards/5/cards/1/comments/', { body: 'Hello' })
    expect(result).toEqual(comment)
  })

  describe("deleteComment", () => {
    it("calls DELETE on the comment endpoint", async () => {
      mockClient.delete.mockResolvedValueOnce({ data: undefined });
      await deleteComment(1, 2, 99);
      expect(mockClient.delete).toHaveBeenCalledWith("/api/boards/1/cards/2/comments/99/");
    });
  })

  it('getCardActivities fetches activities', async () => {
    mockClient.get.mockResolvedValue({ data: [] })
    const result = await getCardActivities(5, 1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/boards/5/cards/1/activities/')
    expect(result).toEqual([])
  })

  it('getCardAttachments fetches attachments', async () => {
    mockClient.get.mockResolvedValue({ data: [] })
    const result = await getCardAttachments(5, 1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/boards/5/cards/1/attachments/')
    expect(result).toEqual([])
  })

  it('uploadCardAttachment posts FormData', async () => {
    const attachment = { id: 1, filename: 'test.png' }
    mockClient.post.mockResolvedValue({ data: attachment })
    const file = new File(['content'], 'test.png', { type: 'image/png' })
    const result = await uploadCardAttachment(5, 1, file)
    expect(mockClient.post).toHaveBeenCalled()
    const callArgs = mockClient.post.mock.calls[0]
    expect(callArgs[0]).toBe('/api/boards/5/cards/1/attachments/')
    expect(callArgs[1]).toBeInstanceOf(FormData)
    expect(result).toEqual(attachment)
  })

  it('deleteCardAttachment sends delete', async () => {
    mockClient.delete.mockResolvedValue({})
    await deleteCardAttachment(5, 1, 10)
    expect(mockClient.delete).toHaveBeenCalledWith('/api/boards/5/cards/1/attachments/10/')
  })

  it('getChecklist fetches checklist items', async () => {
    mockClient.get.mockResolvedValue({ data: [] })
    const result = await getChecklist(5, 1)
    expect(mockClient.get).toHaveBeenCalledWith('/api/boards/5/cards/1/checklist/')
    expect(result).toEqual([])
  })

  it('addChecklistItem posts item', async () => {
    const item = { id: 1, text: 'Do this' }
    mockClient.post.mockResolvedValue({ data: item })
    const result = await addChecklistItem(5, 1, 'Do this')
    expect(mockClient.post).toHaveBeenCalledWith('/api/boards/5/cards/1/checklist/', { text: 'Do this' })
    expect(result).toEqual(item)
  })

  it('updateChecklistItem patches item', async () => {
    const item = { id: 1, text: 'Done', is_checked: true }
    mockClient.patch.mockResolvedValue({ data: item })
    const result = await updateChecklistItem(5, 1, 1, { is_checked: true })
    expect(mockClient.patch).toHaveBeenCalledWith('/api/boards/5/cards/1/checklist/1/', { is_checked: true })
    expect(result).toEqual(item)
  })

  it('deleteChecklistItem deletes item', async () => {
    mockClient.delete.mockResolvedValue({})
    await deleteChecklistItem(5, 1, 1)
    expect(mockClient.delete).toHaveBeenCalledWith('/api/boards/5/cards/1/checklist/1/')
  })

  describe('archiveCard', () => {
    it('posts to archive endpoint and returns card', async () => {
      const card = { id: 1, title: 'Archived', archived_at: '2024-01-01T00:00:00Z' }
      mockClient.post.mockResolvedValue({ data: card })
      const result = await archiveCard(5, 1)
      expect(mockClient.post).toHaveBeenCalledWith('/api/boards/5/cards/1/archive/')
      expect(result).toEqual(card)
    })
  })

  describe('unarchiveCard', () => {
    it('posts to unarchive endpoint and returns card', async () => {
      const card = { id: 1, title: 'Restored', archived_at: null }
      mockClient.post.mockResolvedValue({ data: card })
      const result = await unarchiveCard(5, 1)
      expect(mockClient.post).toHaveBeenCalledWith('/api/boards/5/cards/1/unarchive/')
      expect(result).toEqual(card)
    })
  })

  describe('getArchivedCards', () => {
    it('fetches from archived endpoint and returns paginated page', async () => {
      const page = { count: 1, offset: 0, page_size: 50, results: [{ id: 1, title: 'Old card' }] }
      mockClient.get.mockResolvedValue({ data: page })
      const result = await getArchivedCards(5)
      expect(mockClient.get).toHaveBeenCalledWith('/api/boards/5/cards/archived/', { params: { offset: 0 } })
      expect(result).toEqual(page)
    })

    it('passes offset param when specified', async () => {
      const page = { count: 75, offset: 50, page_size: 50, results: [] }
      mockClient.get.mockResolvedValue({ data: page })
      await getArchivedCards(5, 50)
      expect(mockClient.get).toHaveBeenCalledWith('/api/boards/5/cards/archived/', { params: { offset: 50 } })
    })
  })
})
