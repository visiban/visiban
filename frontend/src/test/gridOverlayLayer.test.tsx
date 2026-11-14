import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import GridOverlayLayer from '../components/Board/GridOverlay/GridOverlayLayer'
import { encodeOverlayLevel } from '../gridOverlays/scale'
import type { GridOverlayCellState } from '../gridOverlays/slot'

function cell(level: number): GridOverlayCellState {
  return { value: 3, label: '3 cards', display: '3', encoding: encodeOverlayLevel(level) }
}

describe('GridOverlayLayer (#1147)', () => {
  it('exposes the reading as an image with overlay, value and level wording', () => {
    const c = cell(2)
    render(<GridOverlayLayer overlayLabel="Card count" cell={c} />)
    expect(screen.getByRole('img', { name: `Card count: 3 cards, ${c.encoding.levelLabel}` })).toHaveTextContent('3')
  })

  it('draws the tint and the non-color bar (hidden from AT) at level 1 and above', () => {
    const c = cell(3)
    const { container } = render(<GridOverlayLayer overlayLabel="Card count" cell={c} />)
    const shading = container.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(shading).not.toBeNull()
    expect(shading.innerHTML).toContain(c.encoding.tintClass)
    expect(shading.innerHTML).toContain(c.encoding.barHeightClass)
    expect(shading.innerHTML).toContain(c.encoding.barToneClass)
  })

  it('draws no shading at level 0 but still shows the value', () => {
    const { container } = render(<GridOverlayLayer overlayLabel="Card count" cell={cell(0)} />)
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull()
    expect(screen.getByRole('img')).toHaveTextContent('3')
  })

  it('hides the badge from AT when the cell already carries the reading', () => {
    render(<GridOverlayLayer overlayLabel="Card count" cell={cell(2)} valueAnnouncedByCell />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('3')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText('3')).not.toHaveAttribute('aria-label')
  })
})
