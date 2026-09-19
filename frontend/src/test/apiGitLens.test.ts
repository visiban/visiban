import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getLensConnection,
  putLensConnection,
  deleteLensConnection,
  getLensBoard,
} from '../api/gitLens'
import client from '../api/client'
import type { LensConnection, LensData } from '../types'

// gitLens.ts had no direct test file at all before this — everything about it was
// only exercised indirectly through useLensData.test.ts, which mocks this module
// entirely and therefore never runs getLensBoard's own param-building logic. #1067
// is precisely what changed that logic (adding labels/assignee), so it is the
// least-covered surface this branch touches.

vi.mock('../api/client', () => ({
  default: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

const mockConnection = {
  id: 1,
  provider: 'gitlab',
  repo_slug: 'acme/widgets',
  column_dim: 'pipeline',
  swimlane_dim: 'milestone',
} as unknown as LensConnection

const sampleData = {} as unknown as LensData

describe('gitLens API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getLensConnection calls GET /api/v1/git-lens/connections/{id}/', async () => {
    vi.mocked(client.get).mockResolvedValue({ data: mockConnection })
    const result = await getLensConnection(5)
    expect(client.get).toHaveBeenCalledWith('/api/v1/git-lens/connections/5/')
    expect(result).toEqual(mockConnection)
  })

  it('putLensConnection calls PUT with the provided fields', async () => {
    vi.mocked(client.put).mockResolvedValue({ data: mockConnection })
    await putLensConnection(5, { provider: 'gitlab', repo_slug: 'acme/widgets' })
    expect(client.put).toHaveBeenCalledWith('/api/v1/git-lens/connections/5/', {
      provider: 'gitlab',
      repo_slug: 'acme/widgets',
    })
  })

  it('deleteLensConnection calls DELETE /api/v1/git-lens/connections/{id}/', async () => {
    vi.mocked(client.delete).mockResolvedValue({ data: null })
    await deleteLensConnection(5)
    expect(client.delete).toHaveBeenCalledWith('/api/v1/git-lens/connections/5/')
  })

  describe('getLensBoard', () => {
    it('omits every optional param when none are given', async () => {
      vi.mocked(client.get).mockResolvedValue({ data: sampleData })
      const result = await getLensBoard(5)
      expect(client.get).toHaveBeenCalledWith('/api/v1/git-lens/board/5/', { params: {} })
      expect(result).toEqual(sampleData)
    })

    it('includes labels and assignee as server-side params when set', async () => {
      vi.mocked(client.get).mockResolvedValue({ data: sampleData })
      await getLensBoard(5, { labels: 'backend,bug', assignee: 'alice' })
      expect(client.get).toHaveBeenCalledWith('/api/v1/git-lens/board/5/', {
        params: { labels: 'backend,bug', assignee: 'alice' },
      })
    })

    it('omits labels/assignee when falsy so an unfiltered request stays param-free', async () => {
      // useLensData always calls with `labels: labels || undefined` and a possibly
      // empty-string assignee; both must drop out of the request rather than being
      // sent as an explicit empty-string filter (which would be its own cache key).
      vi.mocked(client.get).mockResolvedValue({ data: sampleData })
      await getLensBoard(5, { labels: '', assignee: '' })
      expect(client.get).toHaveBeenCalledWith('/api/v1/git-lens/board/5/', { params: {} })
    })

    it('includes refresh=1 for the force-refetch path and omits it otherwise', async () => {
      vi.mocked(client.get).mockResolvedValue({ data: sampleData })
      await getLensBoard(5, { refresh: 1 })
      expect(client.get).toHaveBeenCalledWith('/api/v1/git-lens/board/5/', {
        params: { refresh: 1 },
      })

      vi.mocked(client.get).mockClear()
      await getLensBoard(5, { refresh: undefined })
      expect(client.get).toHaveBeenCalledWith('/api/v1/git-lens/board/5/', { params: {} })
    })

    it('includes state, milestone, column_dim and swimlane_dim when set', async () => {
      vi.mocked(client.get).mockResolvedValue({ data: sampleData })
      await getLensBoard(5, {
        column_dim: 'pipeline',
        swimlane_dim: 'assignee',
        state: 'open',
        milestone: '__none__',
      })
      expect(client.get).toHaveBeenCalledWith('/api/v1/git-lens/board/5/', {
        params: {
          column_dim: 'pipeline',
          swimlane_dim: 'assignee',
          state: 'open',
          milestone: '__none__',
        },
      })
    })
  })
})
