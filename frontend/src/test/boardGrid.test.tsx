import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import {
  BAND_MAX_WIDTH, BOARD_GRID_MIN_WIDTH, BOARD_VIEW_WIDTH_VAR, boardGridMinWidth, boardGridTemplate,
  clampColumnWidth, columnTrack, columnTrackLine, renderedTrackLeftOf, resizedColumnWidth, separatorTrackLine,
  startInsertGesture, useBoardViewWidthVar,
} from '../components/Board/boardGrid'

// #2300: one grid template shared by the header row, every lane and every row separator.
describe('boardGridTemplate', () => {
  it('interleaves 16px outer gutters, minmax(0, 1fr) columns and 8px gaps', () => {
    expect(boardGridTemplate(['column', 'column', 'column'])).toBe(
      '16px minmax(0, 1fr) 8px minmax(0, 1fr) 8px minmax(0, 1fr) 16px',
    )
  })

  it('gives a split stage a double-width track and a hidden or collapsed column a 40px stub', () => {
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

  it('doubles a resized split stage on top of its weight (#2278)', () => {
    expect(boardGridTemplate([columnTrack(330, true)])).toBe('16px minmax(0, 3fr) 16px')
  })

  it('floors a weighted column like a plain one, so a resize never changes the scroll threshold', () => {
    expect(boardGridMinWidth(Array(7).fill(columnTrack(600)))).toBe(BOARD_GRID_MIN_WIDTH)
    expect(boardGridMinWidth(Array(15).fill(columnTrack(600)))).toBe(boardGridMinWidth(Array(15).fill('column')))
    expect(boardGridMinWidth([columnTrack(330, true)])).toBe(BOARD_GRID_MIN_WIDTH)
  })
})

describe('resizedColumnWidth', () => {
  it('scales the saved width by how much the drag grows the rendered track', () => {
    // Saved 220 rendered at 200px; dragging +100px asks for 1.5x the weight.
    expect(resizedColumnWidth(220, 200, 100)).toBe(330)
    expect(resizedColumnWidth(220, 200, -50)).toBe(165)
  })

  it('never asks for a zero or negative width when dragged past the track start', () => {
    expect(resizedColumnWidth(220, 200, -500)).toBeGreaterThan(0)
  })

  it('adds the delta to the saved width when the track was not measured', () => {
    expect(resizedColumnWidth(200, 0, 30)).toBe(230)
  })
})

describe('renderedTrackLeftOf', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads the px width of the column track left of a separator from the resolved template', () => {
    const grid = document.createElement('div')
    const sep = document.createElement('div')
    grid.appendChild(sep)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => (
      el === grid
        ? ({ display: 'grid', gridTemplateColumns: '16px 204.5px 8px 300px 16px' } as CSSStyleDeclaration)
        : ({ display: 'flex', gridTemplateColumns: 'none' } as CSSStyleDeclaration)
    ))
    expect(renderedTrackLeftOf(sep, 1)).toBe(204.5)
    expect(renderedTrackLeftOf(sep, 2)).toBe(300)
    expect(renderedTrackLeftOf(sep, 0)).toBe(0)
  })

  it('is 0 with no grid ancestor, no element, or an unresolved template (jsdom)', () => {
    const lone = document.createElement('div')
    document.body.appendChild(lone)
    expect(renderedTrackLeftOf(lone, 1)).toBe(0)
    expect(renderedTrackLeftOf(null, 1)).toBe(0)
    const grid = document.createElement('div')
    grid.style.display = 'grid'
    grid.style.gridTemplateColumns = '16px minmax(0, 1fr) 16px'
    const sep = document.createElement('div')
    grid.appendChild(sep)
    document.body.appendChild(grid)
    expect(renderedTrackLeftOf(sep, 1)).toBe(0)
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
    // 328 + 40 + 7 x 160 = 1488 of tracks; 8 x 8 gaps + 32 of gutters = 96
    expect(boardGridMinWidth(['split', 'narrow', ...Array(7).fill('column')])).toBe(1488 + 96)
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
