import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLensViewPrefs } from '../hooks/useLensViewPrefs'

const BOARD_ID = 42

function storageKey() {
  return `board:${BOARD_ID}:lens-view-prefs`
}

describe('useLensViewPrefs (#1065)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('returns default sidebar width and empty column widths when nothing is stored', () => {
    const { result } = renderHook(() => useLensViewPrefs(BOARD_ID))
    expect(result.current.prefs.sidebarWidth).toBe(200)
    expect(result.current.prefs.columnWidths).toEqual({})
  })

  it('loads persisted prefs from localStorage', () => {
    localStorage.setItem(storageKey(), JSON.stringify({ sidebarWidth: 300, columnWidths: { open: 400 } }))
    const { result } = renderHook(() => useLensViewPrefs(BOARD_ID))
    expect(result.current.prefs.sidebarWidth).toBe(300)
    expect(result.current.prefs.columnWidths).toEqual({ open: 400 })
  })

  it('falls back to defaults on malformed JSON in localStorage', () => {
    localStorage.setItem(storageKey(), 'not-json{{{{')
    const { result } = renderHook(() => useLensViewPrefs(BOARD_ID))
    expect(result.current.prefs.sidebarWidth).toBe(200)
    expect(result.current.prefs.columnWidths).toEqual({})
  })

  it('falls back to defaults when columnWidths is a corrupt shape (array instead of object)', () => {
    localStorage.setItem(storageKey(), JSON.stringify({ sidebarWidth: 250, columnWidths: [1, 2, 3] }))
    const { result } = renderHook(() => useLensViewPrefs(BOARD_ID))
    // sidebarWidth is still honored — only the corrupt field falls back.
    expect(result.current.prefs.sidebarWidth).toBe(250)
    expect(result.current.prefs.columnWidths).toEqual({})
  })

  it('falls back to defaults when sidebarWidth is a non-number', () => {
    localStorage.setItem(storageKey(), JSON.stringify({ sidebarWidth: 'wide', columnWidths: { open: 300 } }))
    const { result } = renderHook(() => useLensViewPrefs(BOARD_ID))
    expect(result.current.prefs.sidebarWidth).toBe(200)
    expect(result.current.prefs.columnWidths).toEqual({ open: 300 })
  })

  it('setSidebarWidth enforces 120..480 bounds (#1065 clamp range)', () => {
    const { result } = renderHook(() => useLensViewPrefs(BOARD_ID))
    act(() => { result.current.setSidebarWidth(10) })
    expect(result.current.prefs.sidebarWidth).toBe(120)
    act(() => { result.current.setSidebarWidth(9999) })
    expect(result.current.prefs.sidebarWidth).toBe(480)
    act(() => { result.current.setSidebarWidth(300) })
    expect(result.current.prefs.sidebarWidth).toBe(300)
  })

  it('setColumnWidth enforces 160..640 bounds (#1065 clamp range), keyed by string', () => {
    const { result } = renderHook(() => useLensViewPrefs(BOARD_ID))
    act(() => { result.current.setColumnWidth('in_review', 50) })
    expect(result.current.prefs.columnWidths.in_review).toBe(160)
    act(() => { result.current.setColumnWidth('in_review', 9999) })
    expect(result.current.prefs.columnWidths.in_review).toBe(640)
    act(() => { result.current.setColumnWidth('in_review', 320) })
    expect(result.current.prefs.columnWidths.in_review).toBe(320)
  })

  it('setColumnWidth does not disturb other column keys', () => {
    const { result } = renderHook(() => useLensViewPrefs(BOARD_ID))
    act(() => { result.current.setColumnWidth('open', 300) })
    act(() => { result.current.setColumnWidth('closed', 400) })
    expect(result.current.prefs.columnWidths).toEqual({ open: 300, closed: 400 })
  })

  it('persists sidebar and column widths to localStorage on update', () => {
    const { result } = renderHook(() => useLensViewPrefs(BOARD_ID))
    act(() => { result.current.setSidebarWidth(250) })
    act(() => { result.current.setColumnWidth('open', 350) })
    const stored = JSON.parse(localStorage.getItem(storageKey()) ?? '{}')
    expect(stored.sidebarWidth).toBe(250)
    expect(stored.columnWidths.open).toBe(350)
  })

  it('uses board-scoped storage key (different boards are isolated)', () => {
    const { result: r1 } = renderHook(() => useLensViewPrefs(1))
    const { result: r2 } = renderHook(() => useLensViewPrefs(2))
    act(() => { r1.current.setSidebarWidth(300) })
    expect(r1.current.prefs.sidebarWidth).toBe(300)
    expect(r2.current.prefs.sidebarWidth).toBe(200)
  })
})
