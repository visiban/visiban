import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { User } from '../types'

const mockListGroups = vi.fn()
const mockListBoards = vi.fn()
const mockListStarred = vi.fn()
vi.mock('../api/groups', () => ({ listGroups: () => mockListGroups() }))
vi.mock('../api/boards', () => ({ listBoards: () => mockListBoards(), listStarredBoards: () => mockListStarred() }))

import { useLoadShellNavData } from '../hooks/useLoadShellNavData'

const user = { id: 7 } as unknown as User
const wrapAt = (path: string) => ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>

describe('useLoadShellNavData (#2473)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockListGroups.mockResolvedValue([{ id: 10, name: 'Team', parent: null }])
    mockListBoards.mockResolvedValue([{ id: 1, name: 'Alpha', group: 10, group_name: 'Team' }, { id: 2, name: 'Solo', group: null, group_name: null }])
    mockListStarred.mockResolvedValue([{ id: 2, name: 'Solo', group: null }])
  })

  it('loads groups, boards and starred boards, and records the board being viewed as recent', async () => {
    localStorage.setItem('user:prefs:recent-boards:7', JSON.stringify([{ id: 99, name: 'Gone' }]))
    const { result } = renderHook(() => useLoadShellNavData(user, 0), { wrapper: wrapAt('/boards/1') })
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.groups).toHaveLength(1)
    expect(result.current.boards).toHaveLength(2)
    await waitFor(() => expect(result.current.starredBoards.map((b) => b.id)).toEqual([2]))
    // The inaccessible entry is pruned; the viewed board is recorded with its group.
    await waitFor(() => expect(result.current.recentBoards).toEqual([{ id: 1, name: 'Alpha', groupAncestors: ['Team'] }]))
  })

  it('records nothing off a board, and survives a failed load', async () => {
    mockListBoards.mockRejectedValue(new Error('down'))
    mockListStarred.mockRejectedValue(new Error('down'))
    const { result } = renderHook(() => useLoadShellNavData(user, 0), { wrapper: wrapAt('/settings') })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.boards).toEqual([])
    expect(result.current.recentBoards).toEqual([])
  })
})
