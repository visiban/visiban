import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ActiveUnderline from '../components/Common/ActiveUnderline'

// Non-color active cue for icon-only toggles (#2188, WCAG 1.4.1).
describe('ActiveUnderline', () => {
  it('renders nothing while inactive, so the host keeps its layout', () => {
    const { container } = render(<ActiveUnderline active={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a decorative themed bar inside the bottom padding by default', () => {
    render(<ActiveUnderline active />)
    const bar = screen.getByTestId('active-underline')
    expect(bar).toHaveAttribute('aria-hidden', 'true')
    expect(bar).toHaveClass('absolute', 'bg-fg', 'h-0.5', 'w-3', 'bottom-px')
  })

  it('hangs below a bare glyph button with placement="below"', () => {
    render(<ActiveUnderline active placement="below" testId="bar" />)
    const bar = screen.getByTestId('bar')
    expect(bar).toHaveClass('-bottom-1')
    expect(bar).not.toHaveClass('bottom-px')
  })
})
