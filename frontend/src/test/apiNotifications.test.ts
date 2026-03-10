import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}))

import client from '../api/client'
import { listNotifications, getUnreadCount, markRead, markAllRead } from '../api/notifications'

const mockGet = client.get as ReturnType<typeof vi.fn>
const mockPost = client.post as ReturnType<typeof vi.fn>

describe('notifications API', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('listNotifications calls GET /api/notifications/', async () => {
    const notifications = [{ id: 1, verb: 'card.moved' }]
    mockGet.mockResolvedValue({ data: notifications })
    const result = await listNotifications()
    expect(mockGet).toHaveBeenCalledWith('/api/notifications/')
    expect(result).toEqual(notifications)
  })

  it('getUnreadCount calls GET /api/notifications/unread-count/', async () => {
    mockGet.mockResolvedValue({ data: { count: 5 } })
    const result = await getUnreadCount()
    expect(mockGet).toHaveBeenCalledWith('/api/notifications/unread-count/')
    expect(result).toBe(5)
  })

  it('markRead calls POST /api/notifications/mark-read/ with ids', async () => {
    mockPost.mockResolvedValue({ data: {} })
    await markRead([1, 2, 3])
    expect(mockPost).toHaveBeenCalledWith('/api/notifications/mark-read/', { ids: [1, 2, 3] })
  })

  it('markAllRead calls POST /api/notifications/mark-read/ with all flag', async () => {
    mockPost.mockResolvedValue({ data: {} })
    await markAllRead()
    expect(mockPost).toHaveBeenCalledWith('/api/notifications/mark-read/', { all: true })
  })
})
