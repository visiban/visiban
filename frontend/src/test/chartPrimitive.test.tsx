import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ChartBandHit, ChartFrame, ChartPanel, ChartPointHit, ChartReferenceLines, ChartTable } from '../components/Common/Chart'

const noTicks = () => []

describe('ChartFrame', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the interactive layer outside the role=img element (#2028)', () => {
    render(
      <ChartFrame
        label="Headline"
        xTicks={noTicks}
        yTicks={noTicks}
        marks={() => <circle r={1} />}
        hits={() => <ChartPointHit x={1} y={1} label="A mark" onSelect={() => {}} />}
      />,
    )
    const image = screen.getByRole('img', { name: 'Headline' })
    const mark = screen.getByRole('button', { name: 'A mark' })
    expect(image).not.toContainElement(mark)
    expect(mark).toHaveAttribute('tabindex', '-1')
  })

  it('tracks its real width so a viewBox unit stays one pixel and text keeps its size', () => {
    let notify: ResizeObserverCallback = () => {}
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { notify = callback }
      observe() {}
      disconnect = disconnect
    })
    const { unmount } = render(<ChartFrame label="H" xTicks={noTicks} yTicks={noTicks} marks={() => null} />)
    const image = screen.getByRole('img')
    expect(image).toHaveAttribute('viewBox', '0 0 480 260')
    act(() => notify([{ contentRect: { width: 612 } } as ResizeObserverEntry], {} as ResizeObserver))
    expect(image).toHaveAttribute('viewBox', '0 0 612 260')
    act(() => notify([{ contentRect: { width: 0 } } as ResizeObserverEntry], {} as ResizeObserver))
    expect(image).toHaveAttribute('viewBox', '0 0 612 260')
    unmount()
    expect(disconnect).toHaveBeenCalled()
  })
})

describe('ChartReferenceLines', () => {
  it('keeps two labels of nearly equal lines from overprinting', () => {
    const geometry = { width: 400, height: 200, margin: { top: 0, right: 0, bottom: 0, left: 0 }, x0: 0, x1: 400, y0: 0, y1: 200 }
    const { container } = render(
      <svg>
        <ChartReferenceLines geometry={geometry} lines={[{ y: 100, label: 'One' }, { y: 99, label: 'Two' }]} />
      </svg>,
    )
    const [lower, upper] = [...container.querySelectorAll('text')].map((t) => Number(t.getAttribute('y')))
    expect(Math.abs(lower - upper)).toBeGreaterThanOrEqual(14)
  })
})

describe('chart hit targets', () => {
  const geometry = { width: 400, height: 200, margin: { top: 0, right: 0, bottom: 0, left: 0 }, x0: 0, x1: 400, y0: 0, y1: 200 }

  it('a point takes Enter and Space, a tab stop only when asked, and other keys do nothing', () => {
    const onSelect = vi.fn()
    render(<svg><ChartPointHit x={1} y={1} label="Dot" tabbable onSelect={onSelect} /></svg>)
    const mark = screen.getByRole('button', { name: 'Dot' })
    expect(mark).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(mark, { key: 'Enter' })
    fireEvent.keyDown(mark, { key: ' ' })
    fireEvent.keyDown(mark, { key: 'a' })
    expect(onSelect).toHaveBeenCalledTimes(2)
    fireEvent.click(mark)
    expect(onSelect).toHaveBeenCalledTimes(3)
  })

  it('a band is a named button outside the tab order', () => {
    const onSelect = vi.fn()
    render(<svg><ChartBandHit x={0} width={10} geometry={geometry} label="Jun 1: 3 cards" onSelect={onSelect} /></svg>)
    const band = screen.getByRole('button', { name: 'Jun 1: 3 cards' })
    expect(band).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(band, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})

describe('ChartTable', () => {
  it('says so when it has no rows', () => {
    render(<ChartTable label="T" columns={[]} rows={[]} rowKey={String} emptyText="Nothing here." />)
    expect(screen.getByText('Nothing here.')).toBeInTheDocument()
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })
})

describe('ChartPanel', () => {
  const panel = (extra = {}) => (
    <ChartPanel title="T" summary="S" table={<p>the table</p>} {...extra}>
      {() => <p>the chart</p>}
    </ChartPanel>
  )

  it('keeps its own Chart | Table choice when no parent controls it', () => {
    render(panel())
    expect(screen.getByText('the chart')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'table' }))
    expect(screen.getByText('the table')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'table' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('marks the active view with a check as well as the fill (#2185)', () => {
    render(panel())
    const chart = screen.getByRole('button', { name: 'chart' })
    const table = screen.getByRole('button', { name: 'table' })
    expect(chart).toHaveAttribute('aria-pressed', 'true')
    expect(chart.querySelector('[data-testid="active-mark"]')).not.toBeNull()
    expect(table.querySelector('[data-testid="active-mark"]')).toBeNull()
    fireEvent.click(table)
    expect(table.querySelector('[data-testid="active-mark"]')).not.toBeNull()
    expect(chart.querySelector('[data-testid="active-mark"]')).toBeNull()
  })

  it('follows a parent that controls it, and reports the choice', () => {
    const onViewChange = vi.fn()
    render(panel({ view: 'table', onViewChange }))
    expect(screen.getByText('the table')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'chart' }))
    expect(onViewChange).toHaveBeenCalledWith('chart')
    expect(screen.getByText('the table')).toBeInTheDocument()
  })
})
