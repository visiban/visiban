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
