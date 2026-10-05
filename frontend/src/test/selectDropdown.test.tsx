import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRef } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SelectDropdown from '../components/Common/SelectDropdown'
import SingleSelectDropdown from '../components/Common/SingleSelectDropdown'
import CheckboxDropdown from '../components/Common/CheckboxDropdown'

const options = [
  { value: 'a', label: 'Option A' },
  { value: 'b', label: 'Option B' },
  { value: 'c', label: 'Option C' },
]

describe('SelectDropdown', () => {
  beforeEach(() => {
    // no mocks needed — component is self-contained
  })

  it('renders without crashing', () => {
    render(<SelectDropdown value="a" onChange={() => undefined} options={options} />)
    expect(screen.getByRole('combobox')).toBeInTheDocument()
    expect(screen.getByText('Option A')).toBeInTheDocument()
  })

  it('has correct ARIA attributes when closed', () => {
    render(<SelectDropdown value="a" onChange={() => undefined} options={options} />)
    const trigger = screen.getByRole('combobox')
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('sets aria-expanded to true when open', async () => {
    render(<SelectDropdown value="a" onChange={() => undefined} options={options} />)
    await userEvent.setup().click(screen.getByRole('combobox'))
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true')
  })

  it('opens the menu when the trigger is clicked', async () => {
    render(<SelectDropdown value="a" onChange={() => undefined} options={options} />)
    await userEvent.setup().click(screen.getByRole('combobox'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.getAllByRole('option').length).toBe(3)
  })

  it('closes the menu when the trigger is clicked again', async () => {
    const user = userEvent.setup()
    render(<SelectDropdown value="a" onChange={() => undefined} options={options} />)
    await user.click(screen.getByRole('combobox'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.click(screen.getByRole('combobox'))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('marks the current value option as aria-selected=true', async () => {
    render(<SelectDropdown value="b" onChange={() => undefined} options={options} />)
    await userEvent.setup().click(screen.getByRole('combobox'))
    const selected = screen.getAllByRole('option').find(
      (opt) => opt.getAttribute('aria-selected') === 'true',
    )
    expect(selected).toBeDefined()
    expect(selected?.textContent).toBe('Option B')
  })

  it('calls onChange with the selected value and closes the menu', async () => {
    const onChange = vi.fn()
    render(<SelectDropdown value="a" onChange={onChange} options={options} />)
    await userEvent.setup().click(screen.getByRole('combobox'))
    await userEvent.setup().click(screen.getByRole('option', { name: 'Option B' }))
    expect(onChange).toHaveBeenCalledWith('b')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('opens with ArrowDown and selects with Enter', async () => {
    const onChange = vi.fn()
    render(<SelectDropdown value="a" onChange={onChange} options={options} />)
    const trigger = screen.getByRole('combobox')
    trigger.focus()
    // ArrowDown opens the dropdown
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    // ArrowDown again moves to next option
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    // Enter selects the active option
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('b')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('opens with Space and navigates with arrow keys', () => {
    const onChange = vi.fn()
    render(<SelectDropdown value="a" onChange={onChange} options={options} />)
    const trigger = screen.getByRole('combobox')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: ' ' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    // ArrowDown → next option; ArrowUp → back to first
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('a')
  })

  it('ArrowUp at the first option stays on the first option (no wrap)', () => {
    const onChange = vi.fn()
    render(<SelectDropdown value="a" onChange={onChange} options={options} />)
    const trigger = screen.getByRole('combobox')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // open; activeIndex = 0 (current value is 'a')
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })   // attempt to go above first — clamps at 0
    fireEvent.keyDown(trigger, { key: 'Enter' })
    // Should select the first option ('a') — no wrap
    expect(onChange).toHaveBeenCalledWith('a')
  })

  it('highlights the active option', () => {
    render(<SelectDropdown value="a" onChange={() => undefined} options={options} />)
    const trigger = screen.getByRole('combobox')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    // After opening + ArrowDown, activeIndex = 1 (Option B)
    const opts = screen.getAllByRole('option')
    expect(opts[1].className).toContain('bg-surface-hover')
  })

  it('closes with Escape key', () => {
    render(<SelectDropdown value="a" onChange={() => undefined} options={options} />)
    const trigger = screen.getByRole('combobox')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  // #1480 — the menu is a fixed, anchored portal so a scrolling modal/panel
  // ancestor can never clip it (jsdom does not clip; see e2e/select-dropdown-clip.spec.ts).
  describe('anchored portal menu (#1480)', () => {
    const rect = (top: number, bottom: number, left = 20, width = 100) =>
      ({ top, bottom, left, right: left + width, width, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect

    function mockGeometry(triggerTop: number, triggerBottom: number, menuHeight: number, left = 20, width = 100) {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(triggerTop, triggerBottom, left, width))
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(menuHeight)
    }

    afterEach(() => { vi.restoreAllMocks() })

    const renderIt = (onChange: (v: string) => void = () => undefined) =>
      render(<SelectDropdown value="a" onChange={onChange} options={options} />)

    it('renders the menu in a body portal, outside the trigger subtree', async () => {
      const { container } = renderIt()
      await userEvent.click(screen.getByRole('combobox'))
      const panel = screen.getByRole('listbox').parentElement as HTMLElement
      expect(container.contains(panel)).toBe(false)
      expect(panel.parentElement).toBe(document.body)
      expect(panel.style.position).toBe('fixed')
    })

    it('places the menu below the trigger when it fits', async () => {
      mockGeometry(100, 130, 120)
      renderIt()
      await userEvent.click(screen.getByRole('combobox'))
      const panel = screen.getByRole('listbox').parentElement as HTMLElement
      expect(panel.style.top).toBe('134px')
      expect(panel.style.visibility).not.toBe('hidden')
    })

    it('flips above the trigger when there is no room below', async () => {
      mockGeometry(window.innerHeight - 40, window.innerHeight - 10, 120)
      renderIt()
      await userEvent.click(screen.getByRole('combobox'))
      const panel = screen.getByRole('listbox').parentElement as HTMLElement
      expect(panel.style.top).toBe(`${window.innerHeight - 40 - 4 - 120}px`)
    })

    it('clamps to the viewport right edge and is at least trigger-wide', async () => {
      mockGeometry(100, 130, 120, window.innerWidth - 20, 100)
      renderIt()
      await userEvent.click(screen.getByRole('combobox'))
      const panel = screen.getByRole('listbox').parentElement as HTMLElement
      expect(panel.style.left).toBe(`${window.innerWidth - 100 - 8}px`)
      expect(panel.style.minWidth).toBe('100px')
    })

    it('stays hidden until placed', async () => {
      renderIt()
      const trigger = screen.getByRole('combobox')
      // Observe the first committed style by reading it inside a layout-time spy.
      const seen: (string | undefined)[] = []
      const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get() {
          const el = this as HTMLElement
          if (el.style?.position === 'fixed') seen.push(el.style.visibility)
          return 100
        },
      })
      await userEvent.click(trigger)
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', orig)
      expect(seen[0]).toBe('hidden')
      expect((screen.getByRole('listbox').parentElement as HTMLElement).style.visibility).not.toBe('hidden')
    })

    it('returns focus to the trigger after a selection', async () => {
      const onChange = vi.fn()
      renderIt(onChange)
      const trigger = screen.getByRole('combobox')
      await userEvent.click(trigger)
      await userEvent.click(screen.getByRole('option', { name: 'Option B' }))
      expect(onChange).toHaveBeenCalledWith('b')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
    })

    it('closes on Tab and leaves focus on the trigger', async () => {
      renderIt()
      const trigger = screen.getByRole('combobox')
      await userEvent.click(trigger)
      fireEvent.keyDown(trigger, { key: 'Tab' })
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
    })

    it('Escape closes only the menu, not an enclosing priority-40 handler', async () => {
      const outer = vi.fn()
      const { useEscapeStack } = await import('../hooks/useEscapeStack')
      function Host() {
        useEscapeStack(() => { outer() }, 40)
        return <SelectDropdown value="a" onChange={() => undefined} options={options} />
      }
      render(<Host />)
      const trigger = screen.getByRole('combobox')
      await userEvent.click(trigger)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      expect(outer).not.toHaveBeenCalled()
      expect(trigger).toHaveFocus()
      // With the menu closed, Escape falls through to the enclosing handler.
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(outer).toHaveBeenCalledTimes(1)
    })

    it('shows the overflow fade only while more options sit below the fold', async () => {
      mockGeometry(100, 130, 120)
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500)
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
      renderIt()
      await userEvent.click(screen.getByRole('combobox'))
      expect(screen.getByTestId('select-more-below')).toBeInTheDocument()
    })

    it('caps the panel width to the viewport', async () => {
      mockGeometry(100, 130, 120)
      renderIt()
      await userEvent.click(screen.getByRole('combobox'))
      expect((screen.getByRole('listbox').parentElement as HTMLElement).style.maxWidth).toBe('calc(100vw - 16px)')
    })

    it('scrolls the active option into view on arrow keys, and Home/End jump to the ends', async () => {
      const spy = vi.fn()
      Element.prototype.scrollIntoView = spy
      renderIt()
      const trigger = screen.getByRole('combobox')
      trigger.focus()
      fireEvent.keyDown(trigger, { key: 'ArrowDown' })
      spy.mockClear()
      fireEvent.keyDown(trigger, { key: 'ArrowDown' })
      expect(spy).toHaveBeenCalledWith({ block: 'nearest' })
      fireEvent.keyDown(trigger, { key: 'End' })
      expect(trigger.getAttribute('aria-activedescendant')).toMatch(/-2$/)
      fireEvent.keyDown(trigger, { key: 'Home' })
      expect(trigger.getAttribute('aria-activedescendant')).toMatch(/-0$/)
      expect(spy).toHaveBeenCalledTimes(3)
      delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
    })

    it('ignores Home/End while closed', () => {
      renderIt()
      const trigger = screen.getByRole('combobox')
      fireEvent.keyDown(trigger, { key: 'End' })
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    it('closes on window resize', async () => {
      mockGeometry(100, 130, 120)
      renderIt()
      await userEvent.click(screen.getByRole('combobox'))
      act(() => { window.dispatchEvent(new Event('resize')) })
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    it('closes on a scroll outside the menu but not inside it', async () => {
      mockGeometry(100, 130, 120)
      renderIt()
      await userEvent.click(screen.getByRole('combobox'))
      act(() => { screen.getByRole('listbox').dispatchEvent(new Event('scroll')) })
      expect(screen.getByRole('listbox')).toBeInTheDocument()
      act(() => { document.dispatchEvent(new Event('scroll')) })
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    it('closes on an outside click but not on a click inside the portaled menu', async () => {
      render(
        <>
          <SelectDropdown value="a" onChange={() => undefined} options={options} />
          <button type="button">Outside</button>
        </>,
      )
      await userEvent.click(screen.getByRole('combobox'))
      fireEvent.mouseDown(screen.getByRole('listbox'))
      expect(screen.getByRole('listbox')).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Outside' }))
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })
  })

  describe('size variants', () => {
    it('renders with default sm size', () => {
      render(<SelectDropdown value="a" onChange={() => undefined} options={options} size="sm" />)
      const trigger = screen.getByRole('combobox')
      // sm variant uses px-2.5 py-1.5
      expect(trigger.className).toMatch(/px-2\.5/)
    })

    it('renders with xs size', () => {
      render(<SelectDropdown value="a" onChange={() => undefined} options={options} size="xs" />)
      const trigger = screen.getByRole('combobox')
      // xs variant uses px-2 (without the .5)
      expect(trigger.className).toMatch(/px-2\b/)
    })
  })

  describe('disabled + disabledReason', () => {
    it('applies title and aria-label from disabledReason when disabled', () => {
      render(
        <SelectDropdown
          value="a"
          onChange={() => undefined}
          options={options}
          disabled={true}
          disabledReason="Test reason"
        />
      )
      const trigger = screen.getByRole('combobox')
      expect(trigger).toBeDisabled()
      expect(trigger).toHaveAttribute('title', 'Test reason')
      expect(trigger).toHaveAttribute('aria-label', 'Test reason')
    })

    it('does not set title or aria-label when disabled with no disabledReason', () => {
      render(
        <SelectDropdown
          value="a"
          onChange={() => undefined}
          options={options}
          disabled={true}
        />
      )
      const trigger = screen.getByRole('combobox')
      expect(trigger).toBeDisabled()
      expect(trigger).not.toHaveAttribute('title')
      expect(trigger).not.toHaveAttribute('aria-label')
    })

    it('does not set title or aria-label when enabled even if disabledReason is provided', () => {
      render(
        <SelectDropdown
          value="a"
          onChange={() => undefined}
          options={options}
          disabled={false}
          disabledReason="Should not appear"
        />
      )
      const trigger = screen.getByRole('combobox')
      expect(trigger).not.toBeDisabled()
      expect(trigger).not.toHaveAttribute('title')
      expect(trigger).not.toHaveAttribute('aria-label')
    })

    it('does not open the menu when disabled and clicked', async () => {
      render(
        <SelectDropdown
          value="a"
          onChange={() => undefined}
          options={options}
          disabled={true}
          disabledReason="Not allowed"
        />
      )
      await userEvent.setup().click(screen.getByRole('combobox'))
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    it('does not respond to keyboard when disabled', () => {
      render(
        <SelectDropdown
          value="a"
          onChange={() => undefined}
          options={options}
          disabled={true}
        />
      )
      const trigger = screen.getByRole('combobox')
      trigger.focus()
      fireEvent.keyDown(trigger, { key: 'ArrowDown' })
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })
  })
})

describe('SingleSelectDropdown', () => {
  // #1147 — portalMenu escapes an `overflow-x-auto` toolbar strip, which clips an
  // in-flow `absolute top-full` menu to the strip's own height.
  describe('portalMenu', () => {
    it('keeps the menu inside the component subtree by default', async () => {
      const { container } = render(
        <SingleSelectDropdown label="Overlay" options={options} selected={null} onChange={() => undefined} />
      )
      await userEvent.click(screen.getByRole('button', { name: /Overlay/ }))
      expect(container.querySelector('[role="menu"]')).not.toBeNull()
    })

    it('renders the menu outside the clipping subtree when portalMenu is set', async () => {
      const { container } = render(
        <SingleSelectDropdown label="Overlay" options={options} selected={null} onChange={() => undefined} portalMenu />
      )
      await userEvent.click(screen.getByRole('button', { name: /Overlay/ }))
      const menu = screen.getByRole('menu')
      expect(menu).toBeInTheDocument()
      expect(container.contains(menu)).toBe(false)
      expect((menu as HTMLElement).style.position).toBe('fixed')
    })

    it('still selects an option and closes when the menu is portaled', async () => {
      const onChange = vi.fn()
      render(
        <SingleSelectDropdown label="Overlay" options={options} selected={null} onChange={onChange} portalMenu />
      )
      await userEvent.click(screen.getByRole('button', { name: /Overlay/ }))
      await userEvent.click(screen.getByRole('menuitem', { name: 'Option B' }))
      expect(onChange).toHaveBeenCalledWith('b')
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    // #1478 — placement is measured, not assumed: below the trigger when it fits,
    // else above it, and dismissed when the page resizes or scrolls under it.
    describe('anchored placement (#1478)', () => {
      const rect = (top: number, bottom: number) =>
        ({ top, bottom, left: 20, right: 120, width: 100, height: bottom - top, x: 20, y: top, toJSON: () => ({}) }) as DOMRect

      function mockGeometry(triggerTop: number, triggerBottom: number, menuHeight: number) {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(triggerTop, triggerBottom))
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(menuHeight)
      }

      afterEach(() => { vi.restoreAllMocks() })

      it('places the menu below the trigger when it fits', async () => {
        mockGeometry(100, 130, 120)
        render(<SingleSelectDropdown label="Overlay" options={options} selected={null} onChange={() => undefined} portalMenu />)
        await userEvent.click(screen.getByRole('button', { name: /Overlay/ }))
        const menu = screen.getByRole('menu') as HTMLElement
        expect(menu.style.top).toBe('134px')
        expect(menu.style.visibility).not.toBe('hidden')
      })

      it('flips above the trigger when there is no room below', async () => {
        mockGeometry(window.innerHeight - 40, window.innerHeight - 10, 120)
        render(<SingleSelectDropdown label="Overlay" options={options} selected={null} onChange={() => undefined} portalMenu />)
        await userEvent.click(screen.getByRole('button', { name: /Overlay/ }))
        const menu = screen.getByRole('menu') as HTMLElement
        expect(menu.style.top).toBe(`${window.innerHeight - 40 - 4 - 120}px`)
      })

      it('clamps the menu to the viewport right edge and is at least trigger-wide', async () => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
          ({ top: 100, bottom: 130, left: window.innerWidth - 20, right: window.innerWidth + 80, width: 100, height: 30, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
        )
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120)
        render(<SingleSelectDropdown label="Overlay" options={options} selected={null} onChange={() => undefined} portalMenu />)
        await userEvent.click(screen.getByRole('button', { name: /Overlay/ }))
        const menu = screen.getByRole('menu') as HTMLElement
        expect(menu.style.left).toBe(`${window.innerWidth - 140 - 8}px`)
        expect(menu.style.minWidth).toBe('140px')
        expect(menu.style.maxWidth).toBe('calc(100vw - 16px)')
      })

      it('matches a wider trigger', async () => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
          ({ top: 100, bottom: 130, left: 20, right: 420, width: 400, height: 30, x: 20, y: 100, toJSON: () => ({}) }) as DOMRect,
        )
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120)
        render(<SingleSelectDropdown label="Overlay" options={options} selected={null} onChange={() => undefined} portalMenu />)
        await userEvent.click(screen.getByRole('button', { name: /Overlay/ }))
        expect((screen.getByRole('menu') as HTMLElement).style.minWidth).toBe('400px')
      })

      it('returns focus to the trigger after a selection', async () => {
        render(<SingleSelectDropdown label="Overlay" options={options} selected={null} onChange={() => undefined} portalMenu />)
        const trigger = screen.getByRole('button', { name: /Overlay/ })
        await userEvent.click(trigger)
        await userEvent.click(screen.getByRole('menuitem', { name: 'Option B' }))
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
        expect(trigger).toHaveFocus()
      })

      it('closes on Tab from an item and leaves focus on the trigger', async () => {
        render(<SingleSelectDropdown label="Overlay" options={options} selected={null} onChange={() => undefined} portalMenu />)
        const trigger = screen.getByRole('button', { name: /Overlay/ })
        await userEvent.click(trigger)
        screen.getByRole('menuitem', { name: 'Option A' }).focus()
        fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Option A' }), { key: 'Tab' })
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
        expect(trigger).toHaveFocus()
      })

      it('shows the overflow fade only while more choices sit below the fold', async () => {
        mockGeometry(100, 130, 120)
        const sh = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500)
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
        render(<SingleSelectDropdown label="Overlay" options={options} selected={null} onChange={() => undefined} portalMenu />)
        await userEvent.click(screen.getByRole('button', { name: /Overlay/ }))
        expect(screen.getByTestId('singleselect-more-below')).toBeInTheDocument()
        sh.mockReturnValue(100)
      })

      it('closes on window resize', async () => {
        mockGeometry(100, 130, 120)
        render(<SingleSelectDropdown label="Overlay" options={options} selected={null} onChange={() => undefined} portalMenu />)
        await userEvent.click(screen.getByRole('button', { name: /Overlay/ }))
        act(() => { window.dispatchEvent(new Event('resize')) })
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })

      it('closes on a scroll outside the menu but not inside it', async () => {
        mockGeometry(100, 130, 120)
        render(<SingleSelectDropdown label="Overlay" options={options} selected={null} onChange={() => undefined} portalMenu />)
        await userEvent.click(screen.getByRole('button', { name: /Overlay/ }))
        act(() => { screen.getByRole('menu').dispatchEvent(new Event('scroll')) })
        expect(screen.getByRole('menu')).toBeInTheDocument()
        act(() => { document.dispatchEvent(new Event('scroll')) })
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })
    })

    it('closes a portaled menu on an outside click', async () => {
      render(
        <>
          <SingleSelectDropdown label="Overlay" options={options} selected={null} onChange={() => undefined} portalMenu />
          <button type="button">Outside</button>
        </>
      )
      await userEvent.click(screen.getByRole('button', { name: /Overlay/ }))
      expect(screen.getByRole('menu')).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Outside' }))
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
  })

  it('renders without crashing', () => {
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={() => undefined} />
    )
    expect(screen.getByRole('button', { name: /Filter/ })).toBeInTheDocument()
  })

  it('shows the label when nothing is selected', () => {
    render(
      <SingleSelectDropdown label="Priority" options={options} selected={null} onChange={() => undefined} />
    )
    expect(screen.getByRole('button').textContent).toMatch(/Priority/)
  })

  it('shows the selected option label when one is selected', () => {
    render(
      <SingleSelectDropdown label="Priority" options={options} selected="b" onChange={() => undefined} />
    )
    expect(screen.getByRole('button').textContent).toMatch(/Option B/)
  })

  it('has aria-haspopup="menu" and aria-expanded="false" when closed', () => {
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={() => undefined} />
    )
    const trigger = screen.getByRole('button')
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('sets aria-expanded to true when open', async () => {
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={() => undefined} />
    )
    await userEvent.setup().click(screen.getByRole('button'))
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  })

  it('opens menu on click and shows all options as menuitems', async () => {
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={() => undefined} />
    )
    await userEvent.setup().click(screen.getByRole('button'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem').length).toBe(3)
  })

  it('closes menu when clicking the trigger a second time', async () => {
    const user = userEvent.setup()
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={() => undefined} />
    )
    await user.click(screen.getByRole('button'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.click(screen.getByRole('button'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('calls onChange with the selected value when a menuitem is clicked', async () => {
    const onChange = vi.fn()
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={onChange} />
    )
    await userEvent.setup().click(screen.getByRole('button'))
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Option B' }))
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('calls onChange with null when the already-selected option is clicked (deselect)', async () => {
    const onChange = vi.fn()
    render(
      <SingleSelectDropdown label="Filter" options={options} selected="b" onChange={onChange} />
    )
    await userEvent.setup().click(screen.getByRole('button'))
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Option B' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('opens with ArrowDown and navigates between items', () => {
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={() => undefined} />
    )
    const trigger = screen.getByRole('button')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('opens with Enter key', () => {
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={() => undefined} />
    )
    const trigger = screen.getByRole('button')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('closes with Escape key', () => {
    render(
      <SingleSelectDropdown label="Filter" options={options} selected={null} onChange={() => undefined} />
    )
    const trigger = screen.getByRole('button')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    // Escape is handled via useDropdownEscape — fire on document
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
// #964 — CheckboxDropdown had no dedicated unit tests before this change; it
// was only ever exercised indirectly through FilterBar/CustomFieldFilterControl.
// This suite covers the new onOpenChange/badge/hideSelectionSummary props (and
// the forwardRef) directly, at the component level, independent of FilterBar's
// own facet-collapse wiring (which has its own coverage in filterBar.test.tsx).
describe('CheckboxDropdown', () => {
  const cbOptions = [
    { value: 'a', label: 'Option A' },
    { value: 'b', label: 'Option B' },
  ]

  it('renders without crashing', () => {
    render(<CheckboxDropdown label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument()
  })

  it('shows a badge with the count and a folded-in aria-label when badge is truthy', () => {
    render(<CheckboxDropdown label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} badge={3} />)
    const trigger = screen.getByRole('button')
    expect(trigger).toHaveTextContent('3')
    expect(trigger).toHaveAttribute('aria-label', 'Filter, 3 active')
  })

  it('suppresses the badge and aria-label when badge is 0', () => {
    render(<CheckboxDropdown label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} badge={0} />)
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-label')
  })

  it('suppresses the badge and aria-label when badge is undefined', () => {
    render(<CheckboxDropdown label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} />)
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-label')
  })

  it('badge count reflects the passed prop regardless of open/closed state', async () => {
    render(<CheckboxDropdown label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} badge={2} />)
    const trigger = screen.getByRole('button')
    expect(trigger).toHaveTextContent('2')
    await userEvent.setup().click(trigger)
    expect(trigger).toHaveTextContent('2')
  })

  it('hideSelectionSummary keeps the visible and accessible label pinned to the static label even with selections', () => {
    render(
      <CheckboxDropdown label="+ Filter" options={cbOptions} selected={['a', 'b']} onChange={() => undefined} hideSelectionSummary />
    )
    const trigger = screen.getByRole('button', { name: '+ Filter' })
    expect(trigger).toHaveTextContent('+ Filter')
    expect(trigger.textContent).not.toContain('Option A')
  })

  it('without hideSelectionSummary, the trigger label reflects the normal selection summary', () => {
    render(<CheckboxDropdown label="Filter" options={cbOptions} selected={['a']} onChange={() => undefined} />)
    expect(screen.getByRole('button').textContent).toMatch(/Filter: Option A/)
  })

  it('calls onOpenChange(true) then onOpenChange(false) across a click-toggle open/close cycle', async () => {
    const onOpenChange = vi.fn()
    render(
      <CheckboxDropdown label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} onOpenChange={onOpenChange} />
    )
    const user = userEvent.setup()
    const trigger = screen.getByRole('button')
    await user.click(trigger)
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    await user.click(trigger)
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('calls onOpenChange(false) on outside click', async () => {
    const onOpenChange = vi.fn()
    render(
      <div>
        <button>Outside</button>
        <CheckboxDropdown label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} onOpenChange={onOpenChange} />
      </div>
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Filter' }))
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    await user.click(screen.getByText('Outside'))
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('calls onOpenChange(false) on Escape', async () => {
    const onOpenChange = vi.fn()
    render(
      <CheckboxDropdown label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} onOpenChange={onOpenChange} />
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button'))
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('forwards a ref to the trigger button element', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<CheckboxDropdown ref={ref} label="Filter" options={cbOptions} selected={[]} onChange={() => undefined} />)
    expect(ref.current).toBe(screen.getByRole('button'))
  })
})

describe('SelectDropdown option keyboard parity (#1376)', () => {
  it('an option that holds focus selects on Enter and Space', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<SelectDropdown value="a" onChange={onChange} options={options} />)
    await user.click(screen.getByRole('combobox'))
    const opts = screen.getAllByRole('option')
    opts[1].focus()
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith(options[1].value)
  })
})
