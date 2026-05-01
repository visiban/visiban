import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const mockPathname = vi.fn(() => '/')
const mockIsMacPlatform = vi.fn(() => false)

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: mockPathname() }),
}))

vi.mock('../utils/platform', () => ({
  isMacPlatform: () => mockIsMacPlatform(),
}))

import { useNavbarSearchLabel } from '../hooks/useNavbarSearchLabel'

describe('useNavbarSearchLabel', () => {
  beforeEach(() => {
    mockPathname.mockReturnValue('/')
    mockIsMacPlatform.mockReturnValue(false)
  })

  it('returns Search cards on a board route', () => {
    mockPathname.mockReturnValue('/boards/42')
    const { result } = renderHook(() => useNavbarSearchLabel())
    expect(result.current.placeholder).toBe('Search cards…')
    expect(result.current.ariaLabel).toContain('Search cards')
  })

  it('returns Jump to board on the dashboard route', () => {
    mockPathname.mockReturnValue('/')
    const { result } = renderHook(() => useNavbarSearchLabel())
    expect(result.current.placeholder).toBe('Jump to board…')
  })

  it('returns Jump to board on a group route', () => {
    mockPathname.mockReturnValue('/groups/5')
    const { result } = renderHook(() => useNavbarSearchLabel())
    expect(result.current.placeholder).toBe('Jump to board…')
  })

  it('returns Jump to on settings and admin routes', () => {
    for (const path of ['/settings', '/admin', '/admin/users']) {
      mockPathname.mockReturnValue(path)
      const { result } = renderHook(() => useNavbarSearchLabel())
      expect(result.current.placeholder).toBe('Jump to…')
    }
  })

  it('uses Cmd+K in aria label on Mac', () => {
    mockIsMacPlatform.mockReturnValue(true)
    mockPathname.mockReturnValue('/boards/1')
    const { result } = renderHook(() => useNavbarSearchLabel())
    expect(result.current.ariaLabel).toContain('Cmd+K')
  })

  it('uses Ctrl+K in aria label on non-Mac', () => {
    mockIsMacPlatform.mockReturnValue(false)
    mockPathname.mockReturnValue('/boards/1')
    const { result } = renderHook(() => useNavbarSearchLabel())
    expect(result.current.ariaLabel).toContain('Ctrl+K')
  })
})
