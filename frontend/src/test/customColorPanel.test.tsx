import { version as reactVersion, useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ColorSwatchPicker, { CUSTOM_COLOR_ESCAPE_PRIORITY } from '../components/Common/ColorSwatchPicker'
import CustomColorPanel from '../components/Common/CustomColorPanel'
import ModalWrapper from '../components/shared/ModalWrapper'
import { COLUMN_COLORS } from '../constants/colors'
import ActivityFilterDropdown from '../components/Card/ActivityFilterDropdown'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { shouldIgnoreShortcut } from '../utils/keyboard'

const square = () => screen.getByRole('slider', { name: 'Saturation and brightness' })
const hexField = () => screen.getByRole('textbox', { name: 'Hex value' }) as HTMLInputElement
const channel = (name: 'Red' | 'Green' | 'Blue') => screen.getByRole('textbox', { name }) as HTMLInputElement
const status = () => screen.getByRole('status')
const applyButton = (name = 'Apply') => screen.getByRole('button', { name })
const preview = () => screen.getByTestId('custom-color-preview')

function renderPanel(overrides: Partial<React.ComponentProps<typeof CustomColorPanel>> = {}) {
  const onChange = vi.fn()
  const onCancel = vi.fn()
  render(<CustomColorPanel value="#123ABC" fallbackColor="#6B7280" onChange={onChange} onCancel={onCancel} {...overrides} />)
  return { onChange, onCancel }
}

function setHex(value: string) {
  fireEvent.input(hexField(), { target: { value } })
}

describe('shouldIgnoreShortcut', () => {
  it('treats a role="slider" as owning its keys', () => {
    const slider = document.createElement('div')
    slider.setAttribute('role', 'slider')
    expect(shouldIgnoreShortcut(slider)).toBe(true)
    expect(shouldIgnoreShortcut(document.createElement('div'))).toBe(false)
  })
})

describe('CustomColorPanel', () => {
  it('names its controls for a screen reader, in the specified Tab order', async () => {
    renderPanel()
    const user = userEvent.setup()
    const order = [
      square(),
      screen.getByRole('slider', { name: 'Hue' }),
      hexField(),
      channel('Red'),
      channel('Green'),
      channel('Blue'),
      screen.getByRole('button', { name: 'Cancel' }),
      applyButton(),
    ]
    for (const el of order) {
      await user.tab()
      expect(el).toHaveFocus()
    }
    expect(screen.queryByRole('slider', { name: 'Color' })).toBeNull()
  })

  it('seeds the draft from a valid value, else from the fallback', () => {
    const { unmount } = render(<CustomColorPanel value="#abc" fallbackColor="#6B7280" onChange={vi.fn()} onCancel={vi.fn()} />)
    expect(channel('Red').value).toBe('170')
    unmount()
    render(<CustomColorPanel value="nonsense" fallbackColor="#6B7280" onChange={vi.fn()} onCancel={vi.fn()} />)
    expect(hexField().value).toBe('#6B7280')
    expect(channel('Red').value).toBe('107')
  })

  it('fires onChange only on Apply, never while the draft changes', () => {
    const { onChange } = renderPanel()
    setHex('#00FF00')
    fireEvent.change(channel('Red'), { target: { value: '10' } })
    fireEvent.keyDown(square(), { key: 'ArrowRight', keyCode: 39 })
    expect(onChange).not.toHaveBeenCalled()
    expect(preview().style.backgroundColor).not.toBe('')
    fireEvent.click(applyButton())
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('moves the draft from a slider arrow key, through the library', () => {
    const { onChange } = renderPanel({ value: '#808080' })
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Hue' }), { key: 'ArrowRight', keyCode: 39 })
    fireEvent.keyDown(square(), { key: 'ArrowRight', keyCode: 39 })
    expect(hexField().value).not.toBe('#808080')
    fireEvent.click(applyButton())
    expect(onChange).toHaveBeenCalledWith(expect.stringMatching(/^#[0-9A-F]{6}$/))
    expect(onChange).not.toHaveBeenCalledWith('#808080')
  })

  it('keeps 3-digit hex raw while typing and applies it expanded and uppercased', () => {
    const { onChange } = renderPanel()
    setHex('#abc')
    expect(hexField().value).toBe('#abc')
    expect(channel('Red').value).toBe('170')
    expect(preview().style.backgroundColor).toBe('rgb(170, 187, 204)')
    fireEvent.click(applyButton())
    expect(onChange).toHaveBeenCalledWith('#AABBCC')
  })

  it('updates the hex and preview from valid R/G/B', () => {
    const { onChange } = renderPanel()
    fireEvent.change(channel('Red'), { target: { value: '255' } })
    fireEvent.change(channel('Green'), { target: { value: '0' } })
    fireEvent.change(channel('Blue'), { target: { value: '16' } })
    expect(hexField().value).toBe('#FF0010')
    fireEvent.click(applyButton())
    expect(onChange).toHaveBeenCalledWith('#FF0010')
  })

  it('a partial hex disables Apply at once and reports on blur, keeping what was typed', () => {
    const { onChange } = renderPanel()
    setHex('#ABCD')
    expect(applyButton()).toHaveAttribute('aria-disabled', 'true')
    expect(status()).toHaveTextContent('')
    fireEvent.blur(hexField())
    expect(status()).toHaveTextContent('Use 3 or 6 hex digits.')
    expect(hexField().value).toBe('#ABCD')
    expect(hexField()).toHaveAttribute('aria-invalid', 'true')
    expect(hexField().className).toContain('border-danger')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a click on a blocked Apply keeps focus in the field and reports instead of applying', () => {
    const { onChange } = renderPanel()
    hexField().focus()
    setHex('#AB')
    const notPrevented = fireEvent.mouseDown(applyButton())
    expect(notPrevented).toBe(false)
    fireEvent.click(applyButton())
    expect(status()).toHaveTextContent('Use 3 or 6 hex digits.')
    expect(onChange).not.toHaveBeenCalled()
    expect(hexField()).toHaveFocus()
  })

  it('clears the hex message once the hex is valid again', () => {
    renderPanel()
    setHex('#AB')
    fireEvent.blur(hexField())
    expect(status()).toHaveTextContent('Use 3 or 6 hex digits.')
    setHex('#ABCDEF')
    expect(status()).toHaveTextContent('')
    expect(applyButton()).not.toHaveAttribute('aria-disabled')
  })

  it('R/G/B over 255 reports immediately and is not clamped', () => {
    const { onChange } = renderPanel()
    const before = hexField().value
    fireEvent.change(channel('Green'), { target: { value: '300' } })
    expect(channel('Green').value).toBe('300')
    expect(status()).toHaveTextContent('R, G and B go from 0 to 255.')
    expect(channel('Green')).toHaveAttribute('aria-invalid', 'true')
    expect(channel('Green').className).toContain('border-danger')
    expect(channel('Red')).not.toHaveAttribute('aria-invalid')
    expect(applyButton()).toHaveAttribute('aria-disabled', 'true')
    expect(hexField().value).toBe(before)
    fireEvent.click(applyButton())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('an empty R/G/B blocks Apply at once and reports only on blur', () => {
    renderPanel()
    fireEvent.change(channel('Blue'), { target: { value: '' } })
    expect(applyButton()).toHaveAttribute('aria-disabled', 'true')
    expect(status()).toHaveTextContent('')
    fireEvent.blur(channel('Blue'))
    expect(status()).toHaveTextContent('R, G and B go from 0 to 255.')
    expect(channel('Blue')).toHaveAttribute('aria-invalid', 'true')
  })

  it('an Apply attempt reports an empty R/G/B that was never blurred', () => {
    const { onChange } = renderPanel()
    fireEvent.change(channel('Blue'), { target: { value: '' } })
    fireEvent.keyDown(channel('Blue'), { key: 'Enter' })
    expect(status()).toHaveTextContent('R, G and B go from 0 to 255.')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('drops non-digits from R/G/B', () => {
    renderPanel()
    fireEvent.change(channel('Red'), { target: { value: '1a2' } })
    expect(channel('Red').value).toBe('12')
    expect(channel('Red')).toHaveAttribute('maxLength', '3')
    expect(channel('Red')).toHaveAttribute('inputMode', 'numeric')
  })

  it('Enter in a field or slider applies when valid, without submitting a host form', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    const onChange = vi.fn()
    render(
      <form onSubmit={onSubmit}>
        <CustomColorPanel value="#123ABC" fallbackColor="#6B7280" onChange={onChange} onCancel={vi.fn()} />
      </form>
    )
    for (const el of [hexField(), channel('Red'), square()]) {
      const notPrevented = fireEvent.keyDown(el, { key: 'Enter' })
      expect(notPrevented).toBe(false)
    }
    expect(onChange).toHaveBeenCalledTimes(3)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('Enter on a blocked draft reports and does not apply', () => {
    const { onChange } = renderPanel()
    setHex('#A')
    fireEvent.keyDown(hexField(), { key: 'Enter' })
    expect(status()).toHaveTextContent('Use 3 or 6 hex digits.')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a repeating Enter (held from the trigger) does not apply', () => {
    const { onChange } = renderPanel()
    fireEvent.keyDown(square(), { key: 'Enter', repeat: true })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('leaves Enter on Cancel and Apply to the buttons themselves', () => {
    const { onChange, onCancel } = renderPanel()
    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Enter' })).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('keeps keys from document-level shortcuts, except Escape and Tab', () => {
    const seen: string[] = []
    const onDoc = (e: KeyboardEvent) => seen.push(e.key)
    document.addEventListener('keydown', onDoc)
    renderPanel()
    for (const key of ['ArrowLeft', 'k', 'Enter', 'Escape', 'Tab']) fireEvent.keyDown(square(), { key })
    document.removeEventListener('keydown', onDoc)
    expect(seen).toEqual(['Escape', 'Tab'])
  })

  it('takes the host wording for its primary button', () => {
    const { onChange } = renderPanel({ applyLabel: 'Create label' })
    fireEvent.click(applyButton('Create label'))
    expect(onChange).toHaveBeenCalledWith('#123ABC')
  })

  it('moves focus to the square only when the host says so', () => {
    const props = { value: '#123ABC', fallbackColor: '#6B7280', onChange: vi.fn(), onCancel: vi.fn() }
    const { rerender } = render(<CustomColorPanel {...props} focusSquare={false} />)
    expect(square()).not.toHaveFocus()
    rerender(<CustomColorPanel {...props} focusSquare />)
    expect(square()).toHaveFocus()
  })
})

describe('ColorSwatchPicker allowCustom', () => {
  function Host({ initial = null as string | null, spy = vi.fn() as (c: string) => void, applyLabel = undefined as string | undefined }) {
    const [color, setColor] = useState<string | null>(initial)
    return (
      <>
        <button type="button">Before</button>
        <ColorSwatchPicker
          colors={COLUMN_COLORS}
          value={color}
          onChange={(c) => { setColor(c); spy(c) }}
          allowCustom
          applyLabel={applyLabel}
        />
        <button type="button">After</button>
      </>
    )
  }
  const emptyTrigger = () => screen.getByRole('button', { name: 'Choose custom color' })
  const filledTrigger = () => screen.getByRole('button', { name: 'Custom color, selected' })
  const dialog = () => screen.getByRole('dialog', { name: 'Custom color' })

  afterEach(() => { vi.restoreAllMocks() })

  it('does not render a trigger unless asked', () => {
    render(<ColorSwatchPicker colors={COLUMN_COLORS} value={null} onChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Choose custom color' })).toBeNull()
  })

  it('renders an empty dashed trigger last in the group, with popup semantics', () => {
    render(<ColorSwatchPicker colors={COLUMN_COLORS} value="#3B82F6" onChange={vi.fn()} allowCustom groupLabel="Color" />)
    const group = screen.getByRole('group', { name: 'Color' })
    const buttons = Array.from(group.querySelectorAll('button'))
    const trigger = emptyTrigger()
    expect(buttons[buttons.length - 1]).toBe(trigger)
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveAttribute('title', 'Custom color')
    expect(trigger.className).toContain('border-dashed')
    expect(trigger.className).toContain('w-7')
    expect(trigger.className).toContain('[@media(pointer:coarse)]:before:-inset-2.5')
    expect(trigger.querySelector('svg')).not.toBeNull()
  })

  it('sizes the trigger with the row', () => {
    render(<ColorSwatchPicker colors={COLUMN_COLORS} value={null} onChange={vi.fn()} size="sm" allowCustom />)
    expect(emptyTrigger().className).toContain('w-5')
    expect(emptyTrigger().className).toContain('[@media(pointer:coarse)]:before:-right-2')
  })

  it('a persisted custom value fills the trigger, selected, with no glyph', () => {
    render(<ColorSwatchPicker colors={COLUMN_COLORS} value="#123abc" onChange={vi.fn()} allowCustom />)
    const trigger = filledTrigger()
    expect(trigger.style.backgroundColor).toBe('rgb(18, 58, 188)')
    expect(trigger.className).toContain('ring-fg')
    expect(trigger.className).not.toContain('border-dashed')
    expect(trigger.querySelector('svg')).toBeNull()
    screen.getAllByRole('button', { pressed: false }).forEach(b => expect(b).toHaveAttribute('aria-pressed', 'false'))
  })

  it('a legacy non-hex value paints nothing: empty trigger, no preset, seeded from colors[0]', () => {
    render(<ColorSwatchPicker colors={COLUMN_COLORS} value="red" onChange={vi.fn()} allowCustom />)
    const trigger = emptyTrigger()
    expect(trigger.style.backgroundColor).toBe('')
    expect(trigger.querySelector('svg')).not.toBeNull()
    screen.getAllByRole('button', { name: /Select color/ }).forEach(b => expect(b).toHaveAttribute('aria-pressed', 'false'))
    fireEvent.click(trigger)
    expect(hexField().value).toBe(COLUMN_COLORS[0])
  })

  it('paints a 3-digit persisted value in its canonical form', () => {
    render(<ColorSwatchPicker colors={COLUMN_COLORS} value="#abc" onChange={vi.fn()} allowCustom />)
    expect(filledTrigger().style.backgroundColor).toBe('rgb(170, 187, 204)')
  })

  it('selects a preset case-insensitively and leaves the trigger empty', () => {
    render(<ColorSwatchPicker colors={COLUMN_COLORS} value="#3b82f6" onChange={vi.fn()} allowCustom />)
    expect(screen.getByRole('button', { name: 'Select color Blue' })).toHaveAttribute('aria-pressed', 'true')
    expect(emptyTrigger()).toBeInTheDocument()
  })

  it('opens hidden-until-placed and focuses the square only once visible', async () => {
    const seen: string[] = []
    const realFocus = HTMLElement.prototype.focus
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, ...args) {
      if (this.getAttribute('role') === 'slider') {
        seen.push((this.closest('[role="dialog"]') as HTMLElement).style.visibility)
      }
      return realFocus.apply(this, args)
    })
    render(<Host />)
    fireEvent.click(emptyTrigger())
    expect(emptyTrigger()).toHaveAttribute('aria-expanded', 'true')
    expect(square()).toHaveFocus()
    expect(seen).toEqual([''])
    expect(dialog().className).toContain('fixed')
  })

  it('clamps the panel inside the viewport', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(226)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 300, right: 328, top: 100, bottom: 128, width: 28, height: 28, x: 300, y: 100, toJSON: () => ({}) },
    )
    const width = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    render(<Host />)
    fireEvent.click(emptyTrigger())
    expect(dialog().style.left).toBe('86px')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  })

  it('leaves the row unchanged until Apply, then emits uppercase and fills the trigger', () => {
    const spy = vi.fn()
    render(<Host spy={spy} />)
    fireEvent.click(emptyTrigger())
    setHex('#abcdef')
    expect(spy).not.toHaveBeenCalled()
    expect(emptyTrigger()).toBeInTheDocument()
    fireEvent.click(applyButton())
    expect(spy).toHaveBeenCalledWith('#ABCDEF')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(filledTrigger()).toHaveFocus()
  })

  it('a draft landing on a preset emits the preset literal and selects the swatch', () => {
    const spy = vi.fn()
    render(<Host spy={spy} initial="#123ABC" />)
    fireEvent.click(filledTrigger())
    setHex('#3b82f6')
    fireEvent.click(applyButton())
    expect(spy).toHaveBeenCalledWith('#3B82F6')
    expect(screen.getByRole('button', { name: 'Select color Blue' })).toHaveAttribute('aria-pressed', 'true')
    expect(emptyTrigger()).toHaveFocus()
  })

  it('emits the literal spelling of a lowercase palette preset', () => {
    const onChange = vi.fn()
    render(<ColorSwatchPicker colors={['#3b82f6', '#ef4444']} value={null} onChange={onChange} allowCustom />)
    fireEvent.click(emptyTrigger())
    setHex('#3B82F6')
    fireEvent.click(applyButton())
    expect(onChange).toHaveBeenCalledWith('#3b82f6')
  })

  it('seeds from colors[0] when there is no valid value', () => {
    render(<Host />)
    fireEvent.click(emptyTrigger())
    expect(hexField().value).toBe(COLUMN_COLORS[0])
  })

  it('passes the host wording through to the panel', () => {
    render(<Host applyLabel="Create label" />)
    fireEvent.click(emptyTrigger())
    expect(applyButton('Create label')).toBeInTheDocument()
  })

  it('Cancel discards the draft and returns focus to the trigger', () => {
    const spy = vi.fn()
    render(<Host spy={spy} />)
    fireEvent.click(emptyTrigger())
    setHex('#ABCDEF')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(spy).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(emptyTrigger()).toHaveFocus()
    fireEvent.click(emptyTrigger())
    expect(hexField().value).toBe(COLUMN_COLORS[0])
  })

  it('a click outside discards silently, with no refocus', () => {
    const spy = vi.fn()
    render(<Host spy={spy} />)
    fireEvent.click(emptyTrigger())
    setHex('#ABCDEF')
    fireEvent.mouseDown(screen.getByRole('button', { name: 'After' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
    expect(emptyTrigger()).not.toHaveFocus()
  })

  it('Tab out discards silently, with no refocus', async () => {
    const user = userEvent.setup()
    render(<Host />)
    fireEvent.click(emptyTrigger())
    applyButton().focus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a blur with a null relatedTarget (app switch, Safari click) keeps it open', () => {
    render(<Host />)
    fireEvent.click(emptyTrigger())
    fireEvent.blur(square(), { relatedTarget: null })
    expect(dialog()).toBeInTheDocument()
  })

  it('pressing the trigger while open closes it instead of reopening', () => {
    render(<Host />)
    fireEvent.click(emptyTrigger())
    const notPrevented = fireEvent.mouseDown(emptyTrigger())
    expect(notPrevented).toBe(false)
    expect(dialog()).toBeInTheDocument()
    fireEvent.click(emptyTrigger())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(emptyTrigger()).toHaveFocus()
  })

  it('dismisses on resize and outside scroll, unless a panel input has focus', () => {
    render(<Host />)
    fireEvent.click(emptyTrigger())
    hexField().focus()
    act(() => { window.dispatchEvent(new Event('resize')) })
    act(() => { window.dispatchEvent(new Event('scroll')) })
    expect(dialog()).toBeInTheDocument()
    square().focus()
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stays open on a scroll inside the panel, and shows a fade only while overflowing', () => {
    render(<Host />)
    fireEvent.click(emptyTrigger())
    const panel = dialog()
    vi.spyOn(panel, 'scrollHeight', 'get').mockReturnValue(400)
    vi.spyOn(panel, 'clientHeight', 'get').mockReturnValue(200)
    fireEvent.scroll(panel)
    expect(dialog()).toBeInTheDocument()
    expect(panel.querySelector('.bg-gradient-to-t')).not.toBeNull()
  })

  // #2179: focus scrolls a field clear of the fade only if the scroll padding covers the
  // fade's height plus the panel's bottom padding, because the sticky fade pins to the
  // inside of that padding, not to the scrollport edge. jsdom has no layout, so pin the
  // arithmetic on the classes; the short-viewport Playwright spec measures the real thing.
  it('reserves scroll padding for the fade plus the panel padding, so focus clears the fade', () => {
    render(<Host />)
    fireEvent.click(emptyTrigger())
    const panel = dialog()
    vi.spyOn(panel, 'scrollHeight', 'get').mockReturnValue(400)
    vi.spyOn(panel, 'clientHeight', 'get').mockReturnValue(200)
    fireEvent.scroll(panel)
    const fade = panel.querySelector('.bg-gradient-to-t') as HTMLElement
    const step = (el: Element, prefix: string) => {
      const values = Array.from(el.classList)
        .filter((c) => c.startsWith(prefix))
        .map((c) => Number(c.slice(prefix.length)))
        .filter((n) => Number.isInteger(n))
      expect(values, `one ${prefix}* class on ${el.className}`).toHaveLength(1)
      return values[0]
    }
    expect(fade.className).toContain('sticky')
    expect(fade.className).toContain('bottom-0')
    expect(step(panel, 'scroll-pb-')).toBe(step(fade, 'h-') + step(panel, 'p-'))
  })

  describe('Escape priority', () => {
    function Stack({ priority, handler }: { priority: number; handler: () => void }) {
      useEscapeStack(handler, priority)
      return null
    }

    it('sits between the Activity filter at 59 and the command palette at 60', () => {
      expect(CUSTOM_COLOR_ESCAPE_PRIORITY).toBeGreaterThan(59)
      expect(CUSTOM_COLOR_ESCAPE_PRIORITY).toBeLessThan(60)
    })

    // The filter opened first registers first, so an equal priority would close it instead.
    // The other order cannot happen: opening the filter takes focus and closes the picker.
    it('Escape closes the picker, not an open Activity filter', () => {
      render(
        <>
          <ActivityFilterDropdown label="Filter" options={[{ value: 'a', label: 'A' }]} selected={[]} onChange={vi.fn()} />
          <Host />
        </>
      )
      const filter = () => screen.getByRole('button', { name: /Filter/ })
      fireEvent.click(filter())
      fireEvent.click(emptyTrigger())
      expect(filter()).toHaveAttribute('aria-expanded', 'true')
      expect(dialog()).toBeInTheDocument()

      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(screen.queryByRole('dialog', { name: 'Custom color' })).toBeNull()
      expect(filter()).toHaveAttribute('aria-expanded', 'true')

      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(filter()).toHaveAttribute('aria-expanded', 'false')
    })

    it('leaves the command palette at 60 on top', () => {
      const palette = vi.fn()
      render(
        <>
          <Host />
          <Stack priority={60} handler={palette} />
        </>
      )
      fireEvent.click(emptyTrigger())
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(palette).toHaveBeenCalledTimes(1)
      expect(dialog()).toBeInTheDocument()
    })
  })

  describe('inside a ModalWrapper', () => {
    function ModalHost({ onClose = vi.fn(), onSpy = vi.fn() as (c: string) => void }) {
      const [name, setName] = useState('Draft name')
      const [color, setColor] = useState<string | null>(null)
      return (
        <ModalWrapper open onClose={onClose} title="Add Column">
          <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <ColorSwatchPicker colors={COLUMN_COLORS} value={color} onChange={(c) => { setColor(c); onSpy(c) }} allowCustom />
          <button type="button">Save</button>
        </ModalWrapper>
      )
    }

    it('renders under React 19.2, with the library mounted and its sliders live', () => {
      expect(reactVersion).toMatch(/^19\.2\./)
      render(<ModalHost />)
      fireEvent.click(emptyTrigger())
      expect(square()).toHaveAttribute('tabindex', '0')
      expect(screen.getByRole('slider', { name: 'Hue' })).toHaveAttribute('aria-valuemax', '360')
      expect(screen.getByRole('dialog', { name: 'Add Column' })).toContainElement(dialog())
    })

    it('Escape closes only the picker, keeps the modal and its form, and refocuses the trigger', () => {
      const onClose = vi.fn()
      render(<ModalHost onClose={onClose} />)
      fireEvent.click(emptyTrigger())
      fireEvent.keyDown(square(), { key: 'Escape' })
      expect(screen.queryByRole('dialog', { name: 'Custom color' })).toBeNull()
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Draft name')
      expect(emptyTrigger()).toHaveFocus()
      // With the picker gone, the next Escape is the modal's.
      fireEvent.keyDown(emptyTrigger(), { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('a keyboard-only user can open, set and dismiss it without losing form state', async () => {
      const user = userEvent.setup()
      const onSpy = vi.fn()
      render(<ModalHost onSpy={onSpy} />)
      emptyTrigger().focus()
      await user.keyboard('{Enter}')
      expect(square()).toHaveFocus()
      await user.tab()
      await user.tab()
      expect(hexField()).toHaveFocus()
      await user.clear(hexField())
      await user.keyboard('abc')
      await user.keyboard('{Enter}')
      expect(onSpy).toHaveBeenCalledWith('#AABBCC')
      expect(filledTrigger()).toHaveFocus()
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Draft name')
      expect(screen.getByRole('dialog', { name: 'Add Column' })).toBeInTheDocument()
    })

    it('the first press on the backdrop closes only the picker; the second closes the modal', () => {
      const onClose = vi.fn()
      const { container } = render(<ModalHost onClose={onClose} />)
      const backdrop = container.firstChild as HTMLElement
      fireEvent.click(emptyTrigger())
      fireEvent.mouseDown(backdrop)
      fireEvent.mouseUp(backdrop)
      fireEvent.click(backdrop)
      expect(screen.queryByRole('dialog', { name: 'Custom color' })).toBeNull()
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Draft name')

      fireEvent.mouseDown(backdrop)
      fireEvent.mouseUp(backdrop)
      fireEvent.click(backdrop)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('a press on a preset swatch closes the picker and still selects the swatch', () => {
      const onSpy = vi.fn()
      render(<ModalHost onSpy={onSpy} />)
      fireEvent.click(emptyTrigger())
      const red = screen.getByRole('button', { name: 'Select color Red' })
      fireEvent.mouseDown(red)
      fireEvent.click(red)
      expect(screen.queryByRole('dialog', { name: 'Custom color' })).toBeNull()
      expect(onSpy).toHaveBeenCalledWith('#EF4444')
    })

    it('a drag from the square released on the backdrop keeps the modal open', () => {
      const onClose = vi.fn()
      const { container } = render(<ModalHost onClose={onClose} />)
      fireEvent.click(emptyTrigger())
      const backdrop = container.firstChild as HTMLElement
      fireEvent.mouseDown(square())
      fireEvent.mouseUp(backdrop)
      fireEvent.click(backdrop)
      expect(onClose).not.toHaveBeenCalled()
    })
  })
})
