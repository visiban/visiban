import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ColorSwatchPicker from '../components/Common/ColorSwatchPicker'
import { colorName, COLOR_NAMES, COLUMN_COLORS, PALETTE_COLORS, colorForPriority, PRIORITY_COLORS, PRIORITY_FALLBACK_COLOR } from '../constants/colors'

describe('ColorSwatchPicker', () => {
  it('renders one type=button per color, named by color name and never by hex', () => {
    render(<ColorSwatchPicker colors={COLUMN_COLORS} value={null} onChange={vi.fn()} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(COLUMN_COLORS.length)
    buttons.forEach(b => {
      expect(b).toHaveAttribute('type', 'button')
      expect(b.getAttribute('aria-label')).toMatch(/^Select color [A-Z][a-z]+$/)
      expect(b.getAttribute('aria-label')).not.toContain('#')
    })
    expect(screen.getByRole('button', { name: 'Select color Blue' })).toBeInTheDocument()
  })

  it('marks only the selected swatch pressed, with a themed ring and never border-white', () => {
    render(<ColorSwatchPicker colors={PALETTE_COLORS} value="#3B82F6" onChange={vi.fn()} />)
    const selected = screen.getByRole('button', { name: 'Select color Blue' })
    expect(selected).toHaveAttribute('aria-pressed', 'true')
    expect(selected.className).toContain('border-fg')
    expect(selected.className).toContain('ring-fg')
    expect(selected.className).toContain('ring-offset-surface')
    const others = screen.getAllByRole('button').filter(b => b !== selected)
    others.forEach(b => {
      expect(b).toHaveAttribute('aria-pressed', 'false')
      expect(b.className).not.toContain('ring-fg')
    })
    screen.getAllByRole('button').forEach(b => expect(b.className).not.toContain('border-white'))
  })

  it('calls onChange with the clicked hex', () => {
    const onChange = vi.fn()
    render(<ColorSwatchPicker colors={COLUMN_COLORS} value="#6B7280" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Select color Red' }))
    expect(onChange).toHaveBeenCalledWith('#EF4444')
  })

  it('has the standard focus ring and supports size sm and a custom label', () => {
    render(
      <ColorSwatchPicker
        colors={['#10B981']}
        value={null}
        size="sm"
        groupLabel="Label color"
        getAriaLabel={(_c, name) => `Pick ${name}`}
        onChange={vi.fn()}
      />
    )
    const b = screen.getByRole('button', { name: 'Pick Green' })
    expect(b.className).toContain('w-5')
    expect(b.className).toContain('focus:ring-primary-emphasis')
    expect(screen.getByRole('group', { name: 'Label color' })).toBeInTheDocument()
  })
})

describe('ColorSwatchPicker custom popover mousedown guard (#2224)', () => {
  // The hosts (AddColumnModal, EditSwimlaneModal, GroupDetail, the card sheet...) put the
  // picker inside a focusable scroll region or dialog. A press on a non-control part of
  // the panel must not move focus there, or the panel's blur closes it and drops the draft.
  const renderInFocusableHost = () => {
    render(
      <div role="region" aria-label="Host scroll region" tabIndex={0}>
        <ColorSwatchPicker colors={COLUMN_COLORS} value={null} onChange={vi.fn()} allowCustom />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Choose custom color' }))
    return screen.getByRole('dialog', { name: 'Custom color' })
  }

  it('default-prevents a press on the preview swatch and on the panel padding', () => {
    const panel = renderInFocusableHost()
    // fireEvent returns false when the handler called preventDefault().
    expect(fireEvent.mouseDown(screen.getByTestId('custom-color-preview'))).toBe(false)
    expect(fireEvent.mouseDown(panel)).toBe(false)
    expect(screen.getByRole('dialog', { name: 'Custom color' })).toBeInTheDocument()
  })

  it('lets a control inside the panel keep its own focus behavior', () => {
    renderInFocusableHost()
    expect(fireEvent.mouseDown(screen.getByRole('textbox', { name: 'Hex value' }))).toBe(true)
    expect(fireEvent.mouseDown(screen.getByRole('button', { name: 'Cancel' }))).toBe(true)
  })

  it('still closes when focus truly leaves to the host (Tab out)', () => {
    const panel = renderInFocusableHost()
    const host = screen.getByRole('region', { name: 'Host scroll region' })
    // The guard is what stops this blur from happening on a real press; a blur that does
    // reach the host (Tab out) still closes the panel.
    fireEvent.blur(screen.getByRole('textbox', { name: 'Hex value' }), { relatedTarget: host })
    expect(panel).not.toBeInTheDocument()
  })
})

describe('colorName', () => {
  it('names every palette color and falls back for unknown or lowercase hex', () => {
    PALETTE_COLORS.forEach(c => expect(COLOR_NAMES[c]).toBeTruthy())
    expect(colorName('#3b82f6')).toBe('Blue')
    expect(colorName('#123456')).toBe('Custom color')
  })
})

// One fallback for the card face, card peek and share page (#1892).
describe('colorForPriority', () => {
  it('returns the PRIORITY_COLORS entry for a known priority', () => {
    expect(colorForPriority('high')).toBe(PRIORITY_COLORS.high)
  })

  it('falls back to the palette Gray for an unknown priority', () => {
    expect(colorForPriority('none')).toBe(PRIORITY_FALLBACK_COLOR)
    expect(PRIORITY_FALLBACK_COLOR).toBe('#6B7280')
  })
})
