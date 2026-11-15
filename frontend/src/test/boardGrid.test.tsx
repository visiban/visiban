import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { useState } from 'react'
import {
  BAND_MAX_WIDTH, BOARD_GRID_MIN_WIDTH, BOARD_VIEW_WIDTH_VAR, boardGridMinWidth, boardGridTemplate,
  columnTrackLine, separatorTrackLine, useBoardViewWidthVar,
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
