import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import CustomFieldValueInput from '../components/Card/CustomFieldValueInput'
import type { FieldDefinitionShape } from '../types'

/**
 * #1236 — CustomFieldValueInput owns real, documented state logic (per-type
 * commit timing, a re-sync-on-external-change effect, and the `debounceMs=0`
 * caller contract for #1140) that had zero direct or indirect test coverage.
 * See the component's own JSDoc for the contract this file asserts.
 */

function textDef(overrides: Partial<FieldDefinitionShape> = {}): FieldDefinitionShape {
  return { name: 'Notes', field_type: 'text', choices: [], help_text: '', ...overrides }
}

function numberDef(overrides: Partial<FieldDefinitionShape> = {}): FieldDefinitionShape {
  return { name: 'Score', field_type: 'number', choices: [], help_text: '', ...overrides }
}

function dateDef(overrides: Partial<FieldDefinitionShape> = {}): FieldDefinitionShape {
  return { name: 'Due', field_type: 'date', choices: [], help_text: '', ...overrides }
}

function dropdownDef(overrides: Partial<FieldDefinitionShape> = {}): FieldDefinitionShape {
  return { name: 'Status', field_type: 'dropdown', choices: ['Red', 'Green', 'Blue'], help_text: '', ...overrides }
}

function checkboxDef(overrides: Partial<FieldDefinitionShape> = {}): FieldDefinitionShape {
  return { name: 'Approved', field_type: 'checkbox', choices: [], help_text: '', ...overrides }
}

describe('CustomFieldValueInput', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  describe('text — 600ms debounce (default)', () => {
    it('does not commit before 600ms', () => {
      vi.useFakeTimers()
      const onCommit = vi.fn()
      render(<CustomFieldValueInput definition={textDef()} value="" onCommit={onCommit} />)
      act(() => {
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
      })
      expect(onCommit).not.toHaveBeenCalled()
      act(() => {
        vi.advanceTimersByTime(599)
      })
      expect(onCommit).not.toHaveBeenCalled()
    })

    it('commits at exactly 600ms', () => {
      vi.useFakeTimers()
      const onCommit = vi.fn()
      render(<CustomFieldValueInput definition={textDef()} value="" onCommit={onCommit} />)
      act(() => {
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
      })
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(onCommit).toHaveBeenCalledTimes(1)
      expect(onCommit).toHaveBeenCalledWith('hello')
    })

    it('rapid typing resets the debounce — only the final value commits once', () => {
      vi.useFakeTimers()
      const onCommit = vi.fn()
      render(<CustomFieldValueInput definition={textDef()} value="" onCommit={onCommit} />)
      const input = screen.getByRole('textbox')
      act(() => {
        fireEvent.change(input, { target: { value: 'h' } })
        vi.advanceTimersByTime(400)
        fireEvent.change(input, { target: { value: 'he' } })
        vi.advanceTimersByTime(400)
        fireEvent.change(input, { target: { value: 'hel' } })
        vi.advanceTimersByTime(400)
      })
      // Each keystroke was < 600ms after the last, so nothing has committed yet.
      expect(onCommit).not.toHaveBeenCalled()
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(onCommit).toHaveBeenCalledTimes(1)
      expect(onCommit).toHaveBeenCalledWith('hel')
    })

    it('debounceMs=0 commits immediately (#1140 explicit-Save-button contract)', () => {
      vi.useFakeTimers()
      const onCommit = vi.fn()
      render(<CustomFieldValueInput definition={textDef()} value="" onCommit={onCommit} debounceMs={0} />)
      act(() => {
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
      })
      expect(onCommit).toHaveBeenCalledTimes(1)
      expect(onCommit).toHaveBeenCalledWith('hello')
    })
  })

  describe('number — 600ms debounce (default)', () => {
    it('does not commit before 600ms', () => {
      vi.useFakeTimers()
      const onCommit = vi.fn()
      render(<CustomFieldValueInput definition={numberDef()} value="" onCommit={onCommit} />)
      act(() => {
        fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '42' } })
        vi.advanceTimersByTime(599)
      })
      expect(onCommit).not.toHaveBeenCalled()
    })

    it('commits at exactly 600ms', () => {
      vi.useFakeTimers()
      const onCommit = vi.fn()
      render(<CustomFieldValueInput definition={numberDef()} value="" onCommit={onCommit} />)
      act(() => {
        fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '42' } })
        vi.advanceTimersByTime(600)
      })
      expect(onCommit).toHaveBeenCalledTimes(1)
      expect(onCommit).toHaveBeenCalledWith('42')
    })

    it('debounceMs=0 commits immediately', () => {
      vi.useFakeTimers()
      const onCommit = vi.fn()
      render(<CustomFieldValueInput definition={numberDef()} value="" onCommit={onCommit} debounceMs={0} />)
      act(() => {
        fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '42' } })
      })
      expect(onCommit).toHaveBeenCalledTimes(1)
      expect(onCommit).toHaveBeenCalledWith('42')
    })
  })

  describe('date — commits immediately, no debounce', () => {
    it('calls onCommit synchronously on change, with no timer involved', () => {
      vi.useFakeTimers()
      const onCommit = vi.fn()
      const { container } = render(<CustomFieldValueInput definition={dateDef()} value="" onCommit={onCommit} />)
      const input = container.querySelector('input[type="date"]')!
      act(() => {
        fireEvent.change(input, { target: { value: '2026-10-01' } })
      })
      // No advanceTimersByTime call at all — if this were debounced, it would
      // still be pending here.
      expect(onCommit).toHaveBeenCalledTimes(1)
      expect(onCommit).toHaveBeenCalledWith('2026-10-01')
    })

    it('clear button commits an empty string immediately', () => {
      const onCommit = vi.fn()
      render(<CustomFieldValueInput definition={dateDef()} value="2026-10-01" onCommit={onCommit} />)
      fireEvent.click(screen.getByTitle('Clear date'))
      expect(onCommit).toHaveBeenCalledWith('')
    })
  })

  describe('dropdown — commits immediately, no debounce', () => {
    it('portals the menu out of its container so a scrolling ancestor cannot clip it (#1478)', () => {
      const { container } = render(<CustomFieldValueInput definition={dropdownDef()} value="" onCommit={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /— No value —/ }))
      const menu = screen.getByRole('menu')
      expect(container.contains(menu)).toBe(false)
      expect(menu.style.position).toBe('fixed')
    })

    it('selecting an option calls onCommit synchronously', async () => {
      vi.useFakeTimers()
      const onCommit = vi.fn()
      render(<CustomFieldValueInput definition={dropdownDef()} value="" onCommit={onCommit} />)
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: /— No value —/ }))
      })
      act(() => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Green' }))
      })
      expect(onCommit).toHaveBeenCalledTimes(1)
      expect(onCommit).toHaveBeenCalledWith('Green')
    })
  })

  describe('checkbox — commits immediately, no debounce', () => {
    it('toggling calls onCommit synchronously with "true"/"false" strings', () => {
      // ToggleField's wrapper div and its inner switch button both carry an
      // onClick, so a click on the switch bubbles into a second onChange
      // call (pre-existing Toggle.tsx behavior, not something this
      // component introduces) — assert the resulting value, not the count.
      vi.useFakeTimers()
      const onCommit = vi.fn()
      render(<CustomFieldValueInput definition={checkboxDef()} value="false" onCommit={onCommit} />)
      act(() => {
        fireEvent.click(screen.getByRole('switch'))
      })
      expect(onCommit).toHaveBeenCalled()
      expect(onCommit).toHaveBeenLastCalledWith('true')
      // No timer needed — the commit already happened synchronously.
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe('re-sync on external value change', () => {
    it('updates the displayed value when `value` changes from outside mid-edit', () => {
      const onCommit = vi.fn()
      const { rerender } = render(
        <CustomFieldValueInput definition={textDef()} value="original" onCommit={onCommit} />,
      )
      expect(screen.getByRole('textbox')).toHaveValue('original')

      // Simulate a WS update replacing the whole card with a new value for
      // this field while the input isn't mid-edit.
      rerender(<CustomFieldValueInput definition={textDef()} value="from server" onCommit={onCommit} />)
      expect(screen.getByRole('textbox')).toHaveValue('from server')
    })

    it('re-syncs to empty when the external value is cleared', () => {
      const onCommit = vi.fn()
      const { rerender } = render(
        <CustomFieldValueInput definition={textDef()} value="something" onCommit={onCommit} />,
      )
      rerender(<CustomFieldValueInput definition={textDef()} value={undefined} onCommit={onCommit} />)
      expect(screen.getByRole('textbox')).toHaveValue('')
    })

    it('re-syncs a dropdown selection when the external value changes', () => {
      const onCommit = vi.fn()
      const { rerender } = render(
        <CustomFieldValueInput definition={dropdownDef()} value="Red" onCommit={onCommit} />,
      )
      expect(screen.getByRole('button', { name: /Red/ })).toBeInTheDocument()
      rerender(<CustomFieldValueInput definition={dropdownDef()} value="Blue" onCommit={onCommit} />)
      expect(screen.getByRole('button', { name: /Blue/ })).toBeInTheDocument()
    })
  })

  describe('§5(b) defensive-rendering contract', () => {
    it('shows a fallback text input when the stored value does not parse for the current type', () => {
      const onCommit = vi.fn()
      render(<CustomFieldValueInput definition={numberDef()} value="not-a-number" onCommit={onCommit} />)
      expect(screen.getByText(/Stored value doesn't match this field's current type/)).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Enter a new value')).toBeInTheDocument()
    })
  })
})

describe('CustomFieldValueInput date — picker owned by the input (#1376)', () => {
  it('clicking/activating the focusable date input opens the picker, not a wrapper div', () => {
    const showPicker = vi.fn()
    const proto = HTMLInputElement.prototype as HTMLInputElement & { showPicker?: () => void }
    const original = proto.showPicker
    proto.showPicker = showPicker
    try {
      const { container } = render(<CustomFieldValueInput definition={dateDef()} value="" onCommit={vi.fn()} />)
      const input = container.querySelector('input[type="date"]') as HTMLInputElement
      expect(input).toHaveAccessibleName('Due')
      input.focus()
      expect(input).toHaveFocus()
      fireEvent.click(input)
      expect(showPicker).toHaveBeenCalledTimes(1)
    } finally {
      proto.showPicker = original
    }
  })
})

describe('CustomFieldValueInput — url (#1390)', () => {
  const urlDef = (): FieldDefinitionShape => ({ name: 'Runbook', field_type: 'url', choices: [], help_text: '' })

  afterEach(() => {
    cleanup()
  })

  it('renders a url input with the specified attributes', () => {
    render(<CustomFieldValueInput definition={urlDef()} value="" onCommit={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: 'Runbook' })
    expect(input).toHaveAttribute('type', 'url')
    expect(input).toHaveAttribute('inputmode', 'url')
    expect(input).toHaveAttribute('placeholder', 'https://example.com')
    expect(input).toHaveAttribute('maxlength', '500')
    expect(input).toHaveAttribute('autocomplete', 'off')
  })

  it('does not commit per keystroke, even with debounceMs=0', () => {
    const onCommit = vi.fn()
    render(<CustomFieldValueInput definition={urlDef()} value="" onCommit={onCommit} debounceMs={0} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://example.com' } })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('normalizes a bare domain and commits on blur', () => {
    const onCommit = vi.fn()
    render(<CustomFieldValueInput definition={urlDef()} value="" onCommit={onCommit} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('https://example.com')
    expect(input).toHaveValue('https://example.com')
  })

  it('commits on Enter, and a following blur does not save twice', () => {
    const onCommit = vi.fn()
    render(<CustomFieldValueInput definition={urlDef()} value="" onCommit={onCommit} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'https://example.com/a' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('https://example.com/a')
  })

  it('does not commit an invalid scheme, keeps the typed text and shows the error', () => {
    const onCommit = vi.fn()
    render(<CustomFieldValueInput definition={urlDef()} value="https://saved.example" onCommit={onCommit} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'javascript:alert(1)' } })
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
    expect(input).toHaveValue('javascript:alert(1)')
    expect(screen.getByText('Enter a web address starting with http:// or https://')).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input.className).toContain('border-danger')
    // The danger indicator survives focus.
    expect(input.className).toContain('focus:ring-danger-emphasis')
    expect(input.className).not.toContain('focus:border-transparent')
    expect(input.className).not.toContain('focus:ring-primary-emphasis')
    const slot = document.getElementById(input.getAttribute('aria-describedby')!)
    expect(slot).toHaveTextContent('Enter a web address starting with http:// or https://')
  })

  it('shows the generic copy for an unparseable address', () => {
    const onCommit = vi.fn()
    render(<CustomFieldValueInput definition={urlDef()} value="" onCommit={onCommit} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'https://exa mple.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByText('Enter a valid web address')).toBeInTheDocument()
  })

  it('Escape reverts to the saved value and clears the error', () => {
    const onCommit = vi.fn()
    render(<CustomFieldValueInput definition={urlDef()} value="https://saved.example" onCommit={onCommit} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'ftp://nope' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('Enter a web address starting with http:// or https://')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('https://saved.example')
    expect(screen.queryByText('Enter a web address starting with http:// or https://')).not.toBeInTheDocument()
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('commits "" when cleared', () => {
    const onCommit = vi.fn()
    render(<CustomFieldValueInput definition={urlDef()} value="https://saved.example" onCommit={onCommit} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith('')
  })

  it('always renders the reserved slot, with an Open link helper for a saved value', () => {
    render(<CustomFieldValueInput definition={urlDef()} value="https://saved.example/x" onCommit={vi.fn()} />)
    const link = screen.getByRole('link', { name: 'Open link in new tab' })
    expect(link).toHaveTextContent('Open link ↗')
    expect(link).toHaveAttribute('href', 'https://saved.example/x')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('shows a server error only while the rejected value is still in the input', () => {
    const onCommit = vi.fn()
    const { rerender } = render(<CustomFieldValueInput definition={urlDef()} value="" onCommit={onCommit} />)
    const input = screen.getByRole('textbox')
    // A value the client accepts but the server (hypothetically) refuses.
    fireEvent.change(input, { target: { value: 'https://example.com' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith('https://example.com')
    rerender(<CustomFieldValueInput definition={urlDef()} value="" onCommit={onCommit} serverError="Enter a valid web address" />)
    expect(screen.getByText('Enter a valid web address')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'https://example.com/other' } })
    expect(screen.queryByText('Enter a valid web address')).not.toBeInTheDocument()
  })

  it('hides the Open link helper while the input holds unsaved text', () => {
    render(<CustomFieldValueInput definition={urlDef()} value="https://saved.example" onCommit={vi.fn()} />)
    expect(screen.getByRole('link', { name: 'Open link in new tab' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://typed.example' } })
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('points aria-describedby at the error only while one is shown, and announces it', () => {
    render(<CustomFieldValueInput definition={urlDef()} value="https://saved.example" onCommit={vi.fn()} />)
    const input = screen.getByRole('textbox')
    // The helper link is not the input's description.
    expect(input).not.toHaveAttribute('aria-describedby')
    fireEvent.change(input, { target: { value: 'ftp://nope' } })
    fireEvent.blur(input)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Enter a web address starting with http:// or https://')
    expect(input).toHaveAttribute('aria-describedby', alert.id)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).not.toHaveAttribute('aria-describedby')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('edits a legacy javascript: value through the blur/Enter editor, never per keystroke', () => {
    const onCommit = vi.fn()
    render(<CustomFieldValueInput definition={urlDef()} value="javascript:alert(1)" onCommit={onCommit} debounceMs={0} />)
    expect(screen.getByText(/Stored value doesn't match/)).toBeInTheDocument()
    const input = screen.getByRole('textbox', { name: 'Runbook' })
    expect(input).toHaveAttribute('type', 'url')
    // No link for the legacy value.
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'example.com' } })
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('https://example.com')
  })

  it('shows a server error in the legacy editor too', () => {
    const onCommit = vi.fn()
    const { rerender } = render(<CustomFieldValueInput definition={urlDef()} value="javascript:alert(1)" onCommit={onCommit} />)
    const input = screen.getByRole('textbox', { name: 'Runbook' })
    fireEvent.change(input, { target: { value: 'https://example.com' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith('https://example.com')
    // The save is refused; the stored legacy value is unchanged.
    rerender(<CustomFieldValueInput definition={urlDef()} value="javascript:alert(1)" onCommit={onCommit} serverError="Enter a valid web address" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid web address')
    expect(input).toHaveValue('https://example.com')
  })
})
