import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import {
  BAND_MAX_WIDTH, BOARD_GRID_MIN_WIDTH, BOARD_VIEW_WIDTH_VAR, boardGridMinWidth, boardGridTemplate,
  clampColumnWidth, columnTrack, columnTrackLine, measureTrackLeftOf, resizedColumnWidth, separatorTrackLine,
  startInsertGesture, trackFloor, useBoardViewWidthVar, type BoardTrack, type TrackResizeMeasure,
} from '../components/Board/boardGrid'

// #2300: one grid template shared by the header row, every lane and every row separator.
describe('boardGridTemplate', () => {
  it('interleaves 16px outer gutters, minmax(0, 1fr) columns and 8px gaps', () => {
    expect(boardGridTemplate(['column', 'column', 'column'])).toBe(
      '16px minmax(0, 1fr) 8px minmax(0, 1fr) 8px minmax(0, 1fr) 16px',
    )
  })

  it('gives a two-way split stage a 2fr track and a hidden or collapsed column a 40px stub', () => {
    expect(boardGridTemplate(['split', 'narrow'])).toBe('16px minmax(0, 2fr) 8px 40px 16px')
  })

  it('is just the gutter with no columns', () => {
    expect(boardGridTemplate([])).toBe('16px')
  })
})

// #2300 + #1990: a saved column width is a track weight, width / 220 fr.
describe('column weights', () => {
  it('renders a default-width (or unsaved) column exactly like the plain 1fr track', () => {
    expect(columnTrack(undefined)).toBe('column')
    expect(columnTrack(220)).toBe('column')
    expect(columnTrack(220, true)).toBe('split')
    expect(boardGridTemplate([columnTrack(undefined), columnTrack(220)])).toBe(
      '16px minmax(0, 1fr) 8px minmax(0, 1fr) 16px',
    )
  })

  it('turns a custom width into a weighted fr track, rounded to 4 places', () => {
    expect(boardGridTemplate([columnTrack(440), columnTrack(330), columnTrack(230)])).toBe(
      '16px minmax(0, 2fr) 8px minmax(0, 1.5fr) 8px minmax(0, 1.0455fr) 16px',
    )
  })

  it('clamps a saved width to 160..600 before weighting it', () => {
    expect(clampColumnWidth(50)).toBe(160)
    expect(clampColumnWidth(9000)).toBe(600)
    expect(clampColumnWidth(Number.NaN)).toBe(220)
    expect(boardGridTemplate([columnTrack(50), columnTrack(9000)])).toBe(
      '16px minmax(0, 0.7273fr) 8px minmax(0, 2.7273fr) 16px',
    )
  })

  it('keeps hidden and collapsed stubs at 40px whatever the neighbors weigh', () => {
    expect(boardGridTemplate([columnTrack(440), 'narrow', columnTrack(220)])).toBe(
      '16px minmax(0, 2fr) 8px 40px 8px minmax(0, 1fr) 16px',
    )
  })

  it('gives a split stage one column of width per sub-column (#2531)', () => {
    expect(columnTrack(220, 2)).toBe('split')
    expect(boardGridTemplate([columnTrack(220, 4), columnTrack(220, 3)])).toBe('16px minmax(0, 4fr) 8px minmax(0, 3fr) 16px')
    expect(boardGridTemplate([columnTrack(330, 4)])).toBe('16px minmax(0, 6fr) 16px')
    expect(trackFloor(columnTrack(220, 4))).toBe(4 * 160 + 3 * 8)
    expect(trackFloor(columnTrack(220, 3))).toBe(3 * 160 + 2 * 8)
    expect(trackFloor('split')).toBe(2 * 160 + 8)
    expect(columnTrack(220, 1)).toBe('column')
  })

  it('doubles a resized split stage on top of its weight (#2278)', () => {
    expect(boardGridTemplate([columnTrack(330, true)])).toBe('16px minmax(0, 3fr) 16px')
  })

  it('keeps the threshold when every column is scaled alike', () => {
    expect(boardGridMinWidth(Array(7).fill(columnTrack(600)))).toBe(BOARD_GRID_MIN_WIDTH)
    expect(boardGridMinWidth(Array(15).fill(columnTrack(600)))).toBe(boardGridMinWidth(Array(15).fill('column')))
    expect(boardGridMinWidth([columnTrack(330, true)])).toBe(BOARD_GRID_MIN_WIDTH)
  })
})

// Lays `tracks` out the way the browser does: the grid wrapper is
// max(view, boardGridMinWidth) wide and the fr tracks share what the px tracks
// leave, in proportion to their weights.
function layout(tracks: BoardTrack[], view: number) {
  const tpl = boardGridTemplate(tracks)
  const width = Math.max(view, boardGridMinWidth(tracks))
  const parts = tpl.match(/minmax\(0, [\d.]+fr\)|\d+px/g)!
  const frs = parts.map((p) => (p.startsWith('minmax') ? Number(/([\d.]+)fr/.exec(p)![1]) : null))
  const fixed = parts.reduce((sum, p, i) => (frs[i] === null ? sum + parseFloat(p) : sum), 0)
  const frSum = frs.reduce<number>((sum, f) => sum + (f ?? 0), 0)
  const px = parts.map((p, i) => (frs[i] === null ? parseFloat(p) : ((width - fixed) * frs[i]!) / frSum))
  return { tpl, px, width }
}

/** Column i's rendered px in a layout. */
const colPx = (px: number[], i: number) => px[columnTrackLine(i) - 1]

// Mounts the board's DOM shape (scroll box > [data-track-floors] wrapper > grid
// row > separator) with the layout above faked into getComputedStyle and the
// box/wrapper sizes, then measures the track left of separator `sepIndex`.
function measureIn(tracks: BoardTrack[], view: number, sepIndex: number, withWrapper = true): TrackResizeMeasure | null {
  const { tpl, px, width } = layout(tracks, view)
  const box = document.createElement('div')
  const wrapper = document.createElement('div')
  const row = document.createElement('div')
  const sep = document.createElement('div')
  row.style.gridTemplateColumns = tpl
  row.appendChild(sep)
  if (withWrapper) {
    wrapper.dataset.trackFloors = tracks.map(trackFloor).join(' ')
    wrapper.appendChild(row)
    box.appendChild(wrapper)
  } else {
    box.appendChild(row)
  }
  document.body.appendChild(box)
  Object.defineProperty(box, 'clientWidth', { value: view, configurable: true })
  vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => (
    el === row
      ? ({ display: 'grid', gridTemplateColumns: px.map((v) => `${v}px`).join(' ') } as CSSStyleDeclaration)
      : ({ display: 'block', gridTemplateColumns: 'none', paddingLeft: '0px', paddingRight: '0px' } as CSSStyleDeclaration)
  ))
  try {
    return measureTrackLeftOf(sep, sepIndex)
  } finally {
    vi.restoreAllMocks()
    box.remove()
  }
}

const savedWidth = (t: BoardTrack) => (typeof t === 'object' ? t.width : 220)
const isSplit = (t: BoardTrack) => t === 'split' || (typeof t === 'object' && t.kind === 'split')

// Drags the separator right of column `col` by `delta` px and lays the result out.
function drag(tracks: BoardTrack[], view: number, col: number, delta: number) {
  const r = colPx(layout(tracks, view).px, col)
  const m = measureIn(tracks, view, col + 1)!
  const w = resizedColumnWidth(savedWidth(tracks[col]), m, delta)
  const next = tracks.slice()
  next[col] = columnTrack(w, isSplit(tracks[col]))
  return { r, m, w, rendered: colPx(layout(next, view).px, col) }
}

const cols = (n: number): BoardTrack[] => Array(n).fill('column')

describe('resizedColumnWidth', () => {
  // Shapes where the board fills its scroll box (fluid): the column renders at
  // C * f / (S_o + f), so the weight that keeps the edge under the pointer must
  // satisfy C * f' / (S_o + f') == r + d exactly.
  const fluid: [string, BoardTrack[], number, number, number][] = [
    ['2 columns', cols(2), 1400, 0, 100],
    ['3 columns', cols(3), 1400, 1, 150],
    ['7 columns', cols(7), 1600, 2, 120],
    ['7 columns, narrowing', cols(7), 1600, 4, -40],
    ['a split stage and stubs', ['column', 'split', 'narrow', 'column', 'narrow', 'column'], 1500, 0, 80],
    ['dragging the split stage', ['column', 'split', 'narrow', 'column', 'narrow', 'column'], 1500, 1, -40],
    ['an already resized column', [columnTrack(330), 'column', columnTrack(180), 'column'], 1500, 0, 60],
  ]
  it.each(fluid)('keeps the dragged edge under the pointer: %s', (_name, tracks, view, col, delta) => {
    const { r, m, w, rendered } = drag(tracks, view, col, delta)
    expect(w).toBeGreaterThan(160)
    expect(w).toBeLessThan(600)
    const f = (w * m.fr) / savedWidth(tracks[col])
    // The identity, up to rounding the saved width to whole px.
    expect(Math.abs((m.fluidFrSpace * f) / (m.otherFr + f) - (r + delta))).toBeLessThan(0.75)
    // And the browser-shaped layout agrees.
    expect(Math.abs(rendered - (r + delta))).toBeLessThan(0.75)
  })

  it('keeps the edge under the pointer once the min width holds the grid open', () => {
    // 7 columns at 1240px (fr space 1160): doubling column 0 from 165.7px to
    // 331.4px raises the min width past 1240, so the board starts to scroll and
    // each fr renders at 160px. The fluid inverse alone would ask for 528 and
    // render the column at 384px.
    const { r, w, rendered } = drag(cols(7), 1240, 0, 1160 / 7)
    expect(r).toBeCloseTo(165.71, 1)
    expect(w).toBe(456)
    expect(Math.abs(rendered - 2 * r)).toBeLessThan(0.75)
    // A 10-column board already scrolls (min width 1704 > 1300).
    const scrolled = drag(cols(10), 1300, 3, 100)
    expect(scrolled.r).toBe(160)
    expect(Math.abs(scrolled.rendered - 260)).toBeLessThan(0.75)
  })

  it('caps at 600 when the pointer passes what the other columns can give up', () => {
    expect(resizedColumnWidth(220, { rendered: 680, fr: 1, otherFr: 1, otherFloorPerFr: 0, fluidFrSpace: 1360 }, 700)).toBe(600)
    expect(drag(cols(2), 1400, 0, 2000).w).toBe(600)
  })

  it('never asks for less than 160 when dragged past the track start', () => {
    expect(drag(cols(3), 1400, 1, -2000).w).toBe(160)
  })

  it('leaves the width alone when the column is the only fr track', () => {
    expect(resizedColumnWidth(300, { rendered: 1200, fr: 1.3636, otherFr: 0, otherFloorPerFr: 0, fluidFrSpace: 1200 }, 50)).toBe(300)
  })

  it('adds the delta to the saved width when the track was not measured', () => {
    expect(resizedColumnWidth(200, null, 30)).toBe(230)
    expect(resizedColumnWidth(200, { rendered: 0, fr: 1, otherFr: 1, otherFloorPerFr: 0, fluidFrSpace: 0 }, 30)).toBe(230)
  })
})

describe('measureTrackLeftOf', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads the weights from the specified template and the px from the resolved one', () => {
    const tracks: BoardTrack[] = [columnTrack(330), 'narrow', 'split', 'column']
    const m = measureIn(tracks, 1500, 1)!
    const { px } = layout(tracks, 1500)
    expect(m.rendered).toBeCloseTo(colPx(px, 0), 6)
    expect(m.fr).toBe(1.5)
    expect(m.otherFr).toBe(3)
    // 1500 less 16+8+40+8+8+16 of px tracks.
    expect(m.fluidFrSpace).toBeCloseTo(1404, 6)
    // The split's 328px floor over 2fr beats a column's 160 over 1fr.
    expect(m.otherFloorPerFr).toBe(164)
  })

  it('takes the fluid fr space from the 1240px floor when the scroll box is narrower', () => {
    expect(measureIn(cols(7), 1000, 1)!.fluidFrSpace).toBeCloseTo(1240 - 80, 6)
  })

  it('falls back to the measured fr space with no board grid wrapper', () => {
    const m = measureIn(cols(3), 1400, 2, false)!
    expect(m.fluidFrSpace).toBeCloseTo(1400 - 48, 6)
    expect(m.otherFloorPerFr).toBe(0)
  })

  it('is null for a stub, the far-left separator, or no element', () => {
    expect(measureIn(['narrow', 'column', 'column'], 1400, 1)).toBeNull()
    expect(measureIn(cols(3), 1400, 0)).toBeNull()
    expect(measureTrackLeftOf(null, 1)).toBeNull()
  })

  it('is null with no grid ancestor or an unresolved template (jsdom)', () => {
    const lone = document.createElement('div')
    document.body.appendChild(lone)
    expect(measureTrackLeftOf(lone, 1)).toBeNull()
    const grid = document.createElement('div')
    grid.style.display = 'grid'
    grid.style.gridTemplateColumns = '16px minmax(0, 1fr) 16px'
    const sep = document.createElement('div')
    grid.appendChild(sep)
    document.body.appendChild(grid)
    expect(measureTrackLeftOf(sep, 1)).toBeNull()
    lone.remove()
    grid.remove()
  })
})

describe('startInsertGesture', () => {
  const press = { clientX: 100, preventDefault: () => {} }

  it('inserts on a release within 4px and never reports a drag', () => {
    const onInsert = vi.fn()
    const onDrag = vi.fn()
    startInsertGesture(press, onInsert, onDrag)
    fireEvent.mouseMove(window, { clientX: 104 })
    fireEvent.mouseUp(window)
    expect(onInsert).toHaveBeenCalledTimes(1)
    expect(onDrag).not.toHaveBeenCalled()
  })

  it('reports the offset past 4px and does not insert', () => {
    const onInsert = vi.fn()
    const onDrag = vi.fn()
    startInsertGesture(press, onInsert, onDrag)
    fireEvent.mouseMove(window, { clientX: 130 })
    fireEvent.mouseMove(window, { clientX: 90 })
    fireEvent.mouseUp(window)
    expect(onDrag.mock.calls).toEqual([[30], [-10]])
    expect(onInsert).not.toHaveBeenCalled()
    fireEvent.mouseMove(window, { clientX: 300 })
    expect(onDrag).toHaveBeenCalledTimes(2)
  })
})

describe('boardGridMinWidth', () => {
  it('is 1240px for the 7-column reference board', () => {
    expect(boardGridMinWidth(Array(7).fill('column'))).toBe(BOARD_GRID_MIN_WIDTH)
    expect(BOARD_GRID_MIN_WIDTH).toBe(1240)
  })

  it('is 1240px with no columns', () => {
    expect(boardGridMinWidth([])).toBe(1240)
  })

  it('grows past 1240px so a many-column board keeps 160px columns and scrolls instead', () => {
    // 10 x 160 + 9 x 8 + 2 x 16
    expect(boardGridMinWidth(Array(10).fill('column'))).toBe(1704)
  })

  it('floors a split stage at two columns plus a gap and a stub at 40px', () => {
    // The split's 328px floor over its 2fr is 164px per fr; 9fr x 164 = 1476 of fr
    // space, so the split renders at 328 and each column at 164. Plus the 40px
    // stub, 8 x 8 gaps and 32 of gutters.
    const tracks: BoardTrack[] = ['split', 'narrow', ...cols(7)]
    expect(boardGridMinWidth(tracks)).toBe(1476 + 40 + 96)
    const { px } = layout(tracks, 800)
    expect(colPx(px, 0)).toBeCloseTo(328, 6)
    expect(colPx(px, 2)).toBeCloseTo(164, 6)
  })

  it('keeps every column at 160px or wider once columns are resized', () => {
    // One column at 160 and six at 600: the 160 one has the most floor per fr.
    const narrowOne: BoardTrack[] = [columnTrack(160), ...Array(6).fill(columnTrack(600))]
    expect(boardGridMinWidth(narrowOne)).toBe(3840)
    // (The template rounds weights to 4 decimals, so "at 160" is to a few thousandths.)
    const narrowPx = colPx(layout(narrowOne, 1000).px, 0)
    expect(narrowPx).toBeGreaterThanOrEqual(160)
    expect(narrowPx).toBeLessThan(160.05)
    // One column at 600 and six at the default: the six keep 160, not 133.
    const wideOne: BoardTrack[] = [columnTrack(600), ...cols(6)]
    expect(boardGridMinWidth(wideOne)).toBe(1477)
    const { px } = layout(wideOne, 1000)
    for (let i = 1; i < 7; i++) expect(colPx(px, i)).toBeGreaterThanOrEqual(160)
  })

  it('is unchanged for an unresized board of plain columns', () => {
    for (const n of [1, 3, 7, 8, 10, 15]) {
      expect(boardGridMinWidth(cols(n))).toBe(Math.max(1240, n * 160 + 32 + 8 * (n - 1)))
    }
  })
})

describe('grid lines', () => {
  it('puts column i on line 2i+2 and separator i on line 2i+1', () => {
    expect(columnTrackLine(0)).toBe(2)
    expect(columnTrackLine(3)).toBe(8)
    expect(separatorTrackLine(0)).toBe(1)
    expect(separatorTrackLine(3)).toBe(7)
  })
})

describe('useBoardViewWidthVar (#2305)', () => {
  afterEach(() => vi.unstubAllGlobals())

  function Probe({ width }: { width: number }) {
    const [el, setEl] = useState<HTMLDivElement | null>(null)
    useBoardViewWidthVar(el)
    return (
      <div
        data-testid="scroll"
        ref={(node) => {
          if (node) Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => width })
          setEl(node)
        }}
      />
    )
  }

  it('publishes the scroll box client width and re-publishes on resize', () => {
    let callback: (() => void) | null = null
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { callback = cb }
      observe() {}
      disconnect() { disconnect() }
    })
    const { getByTestId, unmount } = render(<Probe width={1180} />)
    const el = getByTestId('scroll')
    expect(el.style.getPropertyValue(BOARD_VIEW_WIDTH_VAR)).toBe('1180px')
    Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => 900 })
    callback!()
    expect(el.style.getPropertyValue(BOARD_VIEW_WIDTH_VAR)).toBe('900px')
    unmount()
    expect(disconnect).toHaveBeenCalled()
  })

  it('still publishes once without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const { getByTestId } = render(<Probe width={640} />)
    expect(getByTestId('scroll').style.getPropertyValue(BOARD_VIEW_WIDTH_VAR)).toBe('640px')
  })

  it('caps a band at the visible width less both gutters, uncapped until published', () => {
    expect(BAND_MAX_WIDTH).toBe('calc(var(--board-view-w, 100%) - 32px)')
  })
})
