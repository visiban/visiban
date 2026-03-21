import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useViewPrefs } from '../hooks/useViewPrefs'

const BOARD_ID = 42

function storageKey() {
  return `board:${BOARD_ID}:view-prefs`
}

describe('useViewPrefs', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('returns default prefs when nothing is stored', () => {
    const { result } = renderHook(() => useViewPrefs(BOARD_ID))
    const { prefs } = result.current
    expect(prefs.hiddenColumnIds).toEqual([])
    expect(prefs.hiddenSwimlaneIds).toEqual([])
    expect(prefs.expandedColumnIds).toEqual([])
    expect(prefs.swimlaneColumnWidth).toBe(220)
    expect(prefs.hideLabels).toBe(false)
    expect(prefs.hideDueDate).toBe(false)
    expect(prefs.hideAssignee).toBe(false)
    expect(prefs.hidePriority).toBe(false)
  })

  it('loads persisted prefs from localStorage', () => {
    localStorage.setItem(storageKey(), JSON.stringify({
      hiddenColumnIds: [5, 7],
      hideLabels: true,
    }))
    const { result } = renderHook(() => useViewPrefs(BOARD_ID))
    expect(result.current.prefs.hiddenColumnIds).toEqual([5, 7])
    expect(result.current.prefs.hideLabels).toBe(true)
  })

  it('persists prefs to localStorage on update', () => {
    const { result } = renderHook(() => useViewPrefs(BOARD_ID))
    act(() => { result.current.toggleHiddenColumn(3) })
    const stored = JSON.parse(localStorage.getItem(storageKey()) ?? '{}')
    expect(stored.hiddenColumnIds).toContain(3)
  })

  it('toggleHiddenColumn adds a column id', () => {
    const { result } = renderHook(() => useViewPrefs(BOARD_ID))
    act(() => { result.current.toggleHiddenColumn(10) })
    expect(result.current.prefs.hiddenColumnIds).toContain(10)
  })

  it('toggleHiddenColumn removes an already-hidden column id', () => {
    localStorage.setItem(storageKey(), JSON.stringify({ hiddenColumnIds: [10] }))
    const { result } = renderHook(() => useViewPrefs(BOARD_ID))
    act(() => { result.current.toggleHiddenColumn(10) })
    expect(result.current.prefs.hiddenColumnIds).not.toContain(10)
  })

  it('toggleHiddenSwimlane adds and removes a swimlane id', () => {
    const { result } = renderHook(() => useViewPrefs(BOARD_ID))
    act(() => { result.current.toggleHiddenSwimlane(20) })
    expect(result.current.prefs.hiddenSwimlaneIds).toContain(20)
    act(() => { result.current.toggleHiddenSwimlane(20) })
    expect(result.current.prefs.hiddenSwimlaneIds).not.toContain(20)
  })

  it('toggleExpandedColumn adds and removes a column id', () => {
    const { result } = renderHook(() => useViewPrefs(BOARD_ID))
    act(() => { result.current.toggleExpandedColumn(5) })
    expect(result.current.prefs.expandedColumnIds).toContain(5)
    act(() => { result.current.toggleExpandedColumn(5) })
    expect(result.current.prefs.expandedColumnIds).not.toContain(5)
  })

  it('expandAllColumns sets the full list', () => {
    const { result } = renderHook(() => useViewPrefs(BOARD_ID))
    act(() => { result.current.expandAllColumns([1, 2, 3]) })
    expect(result.current.prefs.expandedColumnIds).toEqual([1, 2, 3])
  })

  it('collapseAllColumns clears expandedColumnIds', () => {
    localStorage.setItem(storageKey(), JSON.stringify({ expandedColumnIds: [1, 2, 3] }))
    const { result } = renderHook(() => useViewPrefs(BOARD_ID))
    act(() => { result.current.collapseAllColumns() })
    expect(result.current.prefs.expandedColumnIds).toEqual([])
  })

  it('setSwimlaneColumnWidth enforces 56..400 bounds', () => {
    const { result } = renderHook(() => useViewPrefs(BOARD_ID))
    act(() => { result.current.setSwimlaneColumnWidth(10) })
    expect(result.current.prefs.swimlaneColumnWidth).toBe(56)
    act(() => { result.current.setSwimlaneColumnWidth(9999) })
    expect(result.current.prefs.swimlaneColumnWidth).toBe(400)
    act(() => { result.current.setSwimlaneColumnWidth(300) })
    expect(result.current.prefs.swimlaneColumnWidth).toBe(300)
  })

  it('setColumnWidth enforces 160..600 bounds', () => {
    const { result } = renderHook(() => useViewPrefs(BOARD_ID))
    act(() => { result.current.setColumnWidth(1, 50) })
    expect(result.current.prefs.columnWidths[1]).toBe(160)
    act(() => { result.current.setColumnWidth(1, 9999) })
    expect(result.current.prefs.columnWidths[1]).toBe(600)
    act(() => { result.current.setColumnWidth(1, 250) })
    expect(result.current.prefs.columnWidths[1]).toBe(250)
  })

  it('setSwimlaneHeight enforces 48..800 bounds', () => {
    const { result } = renderHook(() => useViewPrefs(BOARD_ID))
    act(() => { result.current.setSwimlaneHeight(1, 10) })
    expect(result.current.prefs.swimlaneHeights[1]).toBe(48)
    act(() => { result.current.setSwimlaneHeight(1, 9999) })
    expect(result.current.prefs.swimlaneHeights[1]).toBe(800)
    act(() => { result.current.setSwimlaneHeight(1, 200) })
    expect(result.current.prefs.swimlaneHeights[1]).toBe(200)
  })

  it('setCardFieldPref toggles boolean card fields', () => {
    const { result } = renderHook(() => useViewPrefs(BOARD_ID))
    act(() => { result.current.setCardFieldPref('hideLabels', true) })
    expect(result.current.prefs.hideLabels).toBe(true)
    act(() => { result.current.setCardFieldPref('hideDueDate', true) })
    expect(result.current.prefs.hideDueDate).toBe(true)
  })

  it('uses board-scoped storage key (different boards are isolated)', () => {
    const { result: r1 } = renderHook(() => useViewPrefs(1))
    const { result: r2 } = renderHook(() => useViewPrefs(2))
    act(() => { r1.current.toggleHiddenColumn(99) })
    expect(r1.current.prefs.hiddenColumnIds).toContain(99)
    expect(r2.current.prefs.hiddenColumnIds).not.toContain(99)
  })

  it('falls back to defaults on malformed JSON in localStorage', () => {
    localStorage.setItem(storageKey(), 'not-json{{{{')
    const { result } = renderHook(() => useViewPrefs(BOARD_ID))
    expect(result.current.prefs.hiddenColumnIds).toEqual([])
    expect(result.current.prefs.swimlaneColumnWidth).toBe(220)
  })
})
