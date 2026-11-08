import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import RowSeparator from '../components/Board/RowSeparator'
import ColumnSeparator from '../components/Board/ColumnSeparator'

// The hover "+" is purely decorative (the separator itself is the control), so
// it must be hidden from assistive tech or it is announced as a stray "+".
describe('separator hover glyphs are aria-hidden (#2012)', () => {
  it('ColumnSeparator "+" is aria-hidden when highlighted', () => {
    const { getByText } = render(
      <ColumnSeparator
        isAdmin
        onOpenAdd={() => {}}
        currentWidth={100}
        setWidth={() => {}}
        sepIndex={1}
        hoveredSepIndex={1}
        onSepHoverChange={() => {}}
      />,
    )
    expect(getByText('+')).toHaveAttribute('aria-hidden', 'true')
  })

  it('RowSeparator "+" glyphs are aria-hidden when hovered', () => {
    const { container, queryAllByText } = render(
      <RowSeparator isAdmin onInsert={() => {}} colCenterXs={[10, 50]} />,
    )
    fireEvent.mouseEnter(container.firstElementChild as HTMLElement)
    const glyphs = queryAllByText('+')
    expect(glyphs).toHaveLength(2)
    glyphs.forEach((g) => expect(g).toHaveAttribute('aria-hidden', 'true'))
  })
})
