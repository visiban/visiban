import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  SHEET_GAP, SHEET_WIDTH, NOTCH_INSET,
  classifyTransition, computeCardSheetPlacement, computeNotch, sameFrame, samePlacement, useCardSheetPlacement,
} from '../hooks/useCardSheetPlacement'
import type { SheetGeometry, SheetPlacement } from '../hooks/useCardSheetPlacement'

// #1914 — the anchor rule for the card detail sheet.
const VH = 900
const geometry = (overrides: Partial<SheetGeometry> = {}): SheetGeometry => ({
  column: { left: 240, right: 460 },
  lanesRight: 220,
  toolbarBottom: 96,
  cardCenterY: 300,
  ...overrides,
})
const place = (viewportWidth: number, g: SheetGeometry | null = geometry(), docked = false) =>
  computeCardSheetPlacement({ viewportWidth, viewportHeight: VH, geometry: g, docked })

// #1915 — "Dock to edge" ranks below full-screen and above the anchor rule.
describe('computeCardSheetPlacement docked input (#1915)', () => {
  it('stays full-screen at <= 640px even when docked', () => {
    expect(place(640, geometry(), true).mode).toBe('fullscreen')
    expect(place(375, null, true).mode).toBe('fullscreen')
  })

  it('docks at every width above 640px, including >= 1280px where it would anchor', () => {
    expect(place(1600).mode).toBe('anchored')
    for (const vw of [641, 1024, 1279, 1280, 1600, 2560]) {
      expect(place(vw, geometry(), true)).toMatchObject({ mode: 'docked', side: null, left: null, top: 0, bottom: 0, notch: null })
    }
  })

  it('defaults to the anchor rule when the input is omitted', () => {
    expect(computeCardSheetPlacement({ viewportWidth: 1600, viewportHeight: VH, geometry: geometry() }).mode).toBe('anchored')
  })
})

describe('computeCardSheetPlacement (#1914)', () => {
  it('is full-screen at <= 640px, whatever the geometry', () => {
    expect(place(640).mode).toBe('fullscreen')
    expect(place(375).mode).toBe('fullscreen')
    expect(place(375, null).mode).toBe('fullscreen')
  })

  it('docks to the right edge from 641px up to 1279px, even when the column has room', () => {
    for (const vw of [641, 1024, 1279]) {
      const p = place(vw)
      expect(p).toMatchObject({ mode: 'docked', side: null, left: null, top: 0, bottom: 0, notch: null })
    }
  })

  it('anchors to the right of the column when it fits (1280px is anchored)', () => {
    const p = place(1280)
    expect(p.mode).toBe('anchored')
    expect(p.side).toBe('right')
    expect(p.left).toBe(460 + SHEET_GAP)
    // Top: toolbar bottom + 8px; bottom: 12px above the viewport edge.
    expect(p.top).toBe(96 + 8)
    expect(p.bottom).toBe(12)
    expect(p.notch).toEqual({ y: 300 - 104, clamped: false })
  })

  it('flips to the left of the column when the right side has no room', () => {
    const p = place(1440, geometry({ column: { left: 1000, right: 1220 } }))
    expect(p.mode).toBe('anchored')
    expect(p.side).toBe('left')
    expect(p.left).toBe(1000 - SHEET_GAP - SHEET_WIDTH)
  })

  it('docks when neither side fits, rather than covering the lane labels', () => {
    // Right: 826 + 540 > 1300 - 16. Left: 594 - 540 = 54, inside the 220px labels.
    const p = place(1300, geometry({ column: { left: 600, right: 820 } }))
    expect(p.mode).toBe('docked')
  })

  it('docks when the card has no measurable element (it is never centered)', () => {
    expect(place(1600, null)).toMatchObject({ mode: 'docked', left: null, notch: null })
  })

  it('docks rather than start under the sticky lane labels or run off screen', () => {
    // Column scrolled under the labels: the right placement would begin at 126px.
    expect(place(1600, geometry({ column: { left: -100, right: 120 } })).mode).toBe('docked')
    // Column scrolled past the right edge: the left placement would overflow it.
    expect(place(1600, geometry({ column: { left: 1700, right: 1920 } })).mode).toBe('docked')
  })

  // Dense board: 9 columns x 6 swimlanes, the card in the last column.
  describe('dense board, 9 columns x 6 swimlanes', () => {
    const LANES = 220
    const COL = 220
    const SEP = 16
    const columnAt = (index: number, scrollLeft: number) => {
      const left = LANES + SEP + index * (COL + SEP) - scrollLeft
      return { left, right: left + COL }
    }
    const lanes = Array.from({ length: 6 }, (_, i) => 100 + i * 140)

    it('flips left for a card in the last column scrolled into view, on every lane', () => {
      const vw = 1600
      const content = LANES + SEP + 9 * (COL + SEP)
      const column = columnAt(8, content - vw)
      for (const cardCenterY of lanes) {
        const p = place(vw, geometry({ column, lanesRight: LANES, cardCenterY }))
        expect(p.mode).toBe('anchored')
        expect(p.side).toBe('left')
        expect(p.left! >= LANES).toBe(true)
        expect(p.left! + SHEET_WIDTH <= vw - 16).toBe(true)
      }
    })

    it('anchors right for a card in the first column', () => {
      const p = place(1600, geometry({ column: columnAt(0, 0), lanesRight: LANES }))
      expect(p.side).toBe('right')
    })

    it('docks for the last column while it is still off screen', () => {
      expect(place(1600, geometry({ column: columnAt(8, 0), lanesRight: LANES })).mode).toBe('docked')
    })
  })
})

describe('computeNotch (#1914, frame 3)', () => {
  it('tracks the card center inside the sheet', () => {
    expect(computeNotch(400, 100, 12, VH)).toEqual({ y: 300, clamped: false })
  })

  it('clamps 28px from the top corner when the card is scrolled above the sheet', () => {
    expect(computeNotch(-50, 100, 12, VH)).toEqual({ y: NOTCH_INSET, clamped: true, direction: 'up' })
  })

  it('clamps 28px from the bottom corner when the card is scrolled below it', () => {
    expect(computeNotch(2000, 100, 12, VH)).toEqual({ y: VH - 12 - NOTCH_INSET - 100, clamped: true, direction: 'down' })
  })

  it('rounds y to whole pixels but computes clamped on the unrounded value', () => {
    expect(computeNotch(400.4, 100, 12, VH)).toEqual({ y: 300, clamped: false })
    expect(computeNotch(128.2, 100.4, 12, VH)).toEqual({ y: 28, clamped: true, direction: 'up' })
  })

  it('takes direction from the unclamped center, even on a sheet under 56px tall', () => {
    expect(computeNotch(5000, 100, VH - 140, VH)).toEqual({ y: NOTCH_INSET, clamped: true, direction: 'down' })
    expect(computeNotch(-5, 100, VH - 140, VH)).toEqual({ y: NOTCH_INSET, clamped: true, direction: 'up' })
  })
})

describe('classifyTransition (#1914)', () => {
  const anchoredRight = place(1600)
  const anchoredRightElsewhere = place(1600, geometry({ column: { left: 480, right: 700 } }))
  const anchoredLeft = place(1600, geometry({ column: { left: 1000, right: 1220 } }))
  const docked = place(1024)

  it('opens on the first placement', () => {
    expect(classifyTransition(null, anchoredRight, 'open')).toBe('open')
  })

  it('slides when the sheet stays on the same side', () => {
    expect(classifyTransition(anchoredRight, anchoredRightElsewhere, 'resize')).toBe('slide')
    expect(classifyTransition(anchoredRight, anchoredRightElsewhere, 'swap')).toBe('slide')
  })

  it('a swap to the same frame still cross-fades the body (a zero-distance slide)', () => {
    expect(classifyTransition(docked, docked, 'swap')).toBe('slide')
  })

  it('fades when the side flips or the mode changes', () => {
    expect(classifyTransition(anchoredRight, anchoredLeft, 'scroll')).toBe('fade')
    expect(classifyTransition(docked, anchoredRight, 'appear')).toBe('fade')
    expect(classifyTransition(anchoredRight, docked, 'resize')).toBe('fade')
  })

  it('slides when the dock toggle moves the sheet, either way (#1915), and plays nothing if it did not move', () => {
    expect(classifyTransition(anchoredRight, docked, 'dock-toggle')).toBe('slide')
    expect(classifyTransition(docked, anchoredRight, 'dock-toggle')).toBe('slide')
    expect(classifyTransition(anchoredLeft, docked, 'dock-toggle')).toBe('slide')
    expect(classifyTransition(docked, docked, 'dock-toggle')).toBe('none')
  })

  it('always fades after an in-sheet Move, even on the same side', () => {
    expect(classifyTransition(anchoredRight, anchoredRightElsewhere, 'move')).toBe('fade')
  })

  it('plays nothing for a notch-only change', () => {
    const moved: SheetPlacement = { ...anchoredRight, notch: { y: 10, clamped: true } }
    expect(sameFrame(anchoredRight, moved)).toBe(true)
    expect(samePlacement(anchoredRight, moved)).toBe(false)
    expect(classifyTransition(anchoredRight, moved, 'scroll')).toBe('none')
  })

  it('treats a changed clamp direction as a different placement (#1946)', () => {
    const up: SheetPlacement = { ...anchoredRight, notch: { y: 28, clamped: true, direction: 'up' } }
    const down: SheetPlacement = { ...anchoredRight, notch: { y: 28, clamped: true, direction: 'down' } }
    expect(samePlacement(up, down)).toBe(false)
    expect(samePlacement(up, { ...up, notch: { ...up.notch! } })).toBe(true)
  })
})

// #1915 — the hook tags a change of the docked input as a 'dock-toggle'. At
// >= 1280px the sheet anchors when undocked and docks when docked, so the
// toggle changes the placement and is not swallowed as an unchanged frame.
describe('useCardSheetPlacement dock toggle (#1915)', () => {
  const originalWidth = window.innerWidth
  let board: HTMLElement
  beforeEach(() => {
    // A measurable card, so the undocked placement anchors instead of docking.
    board = document.createElement('div')
    board.setAttribute('data-board-scroll', '')
    const card = document.createElement('div')
    card.setAttribute('data-card-id', '1')
    card.getBoundingClientRect = () => ({ left: 240, right: 460, top: 280, bottom: 320, width: 220, height: 40, x: 240, y: 280, toJSON: () => ({}) })
    board.appendChild(card)
    document.body.appendChild(board)
  })
  afterEach(() => { window.innerWidth = originalWidth; board.remove() })

  it("reports reason 'dock-toggle' and a docked placement when the docked input flips", () => {
    window.innerWidth = 1600
    const { result, rerender } = renderHook(
      ({ d }) => useCardSheetPlacement(1, 'a:b', d),
      { initialProps: { d: false } },
    )
    expect(result.current.placement.mode).toBe('anchored')
    expect(result.current.reason).toBe('open')
    rerender({ d: true })
    expect(result.current.reason).toBe('dock-toggle')
    expect(result.current.placement.mode).toBe('docked')
  })

  it("does not report 'dock-toggle' when the docked input is unchanged", () => {
    window.innerWidth = 1600
    const { result, rerender } = renderHook(
      ({ d }) => useCardSheetPlacement(1, 'a:b', d),
      { initialProps: { d: true } },
    )
    expect(result.current.placement.mode).toBe('docked')
    rerender({ d: true })
    expect(result.current.reason).not.toBe('dock-toggle')
    expect(result.current.reason).toBe('open')
  })
})
