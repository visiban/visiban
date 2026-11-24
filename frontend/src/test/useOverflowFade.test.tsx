import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useRef } from 'react'
import { useOverflowFade } from '../hooks/useOverflowFade'

// #1900 — jsdom has no layout, so the scroll metrics are defined by hand.
function setMetrics(el: HTMLElement, m: { scrollTop: number; clientHeight: number; scrollHeight: number }) {
  for (const [k, v] of Object.entries(m)) Object.defineProperty(el, k, { configurable: true, value: v })
}

function Probe({ dep }: { dep: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const { moreBelow, onScroll } = useOverflowFade(ref, [dep])
  return (
    <div>
      <div ref={ref} data-testid="region" onScroll={onScroll} />
      <span data-testid="state">{String(moreBelow)}</span>
    </div>
  )
}

describe('useOverflowFade', () => {
  it('is false when the content fits', () => {
    render(<Probe dep={0} />)
    expect(screen.getByTestId('state')).toHaveTextContent('false')
  })

  it('turns on when content remains below the fold and off at the bottom (1px tolerance)', () => {
    render(<Probe dep={0} />)
    const region = screen.getByTestId('region')
    setMetrics(region, { scrollTop: 0, clientHeight: 100, scrollHeight: 300 })
    fireEvent.scroll(region)
    expect(screen.getByTestId('state')).toHaveTextContent('true')
    setMetrics(region, { scrollTop: 199, clientHeight: 100, scrollHeight: 300 })
    fireEvent.scroll(region)
    expect(screen.getByTestId('state')).toHaveTextContent('false')
  })

  it('re-measures when a dependency changes', () => {
    const { rerender } = render(<Probe dep={0} />)
    setMetrics(screen.getByTestId('region'), { scrollTop: 0, clientHeight: 100, scrollHeight: 300 })
    rerender(<Probe dep={1} />)
    expect(screen.getByTestId('state')).toHaveTextContent('true')
  })
})
