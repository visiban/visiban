import { describe, it, expect, afterEach } from 'vitest'
import { useRef } from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { useFocusTrap } from '../hooks/useFocusTrap'

afterEach(() => {
  cleanup()
})

function Harness({ active, children }: { active: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, active)
  return (
    <div ref={ref} data-testid="container">
      {children}
    </div>
  )
}

describe('useFocusTrap', () => {
  it('wraps Tab from the last focusable element to the first', () => {
    const { getByTestId } = render(
      <Harness active>
        <button data-testid="first">first</button>
        <button data-testid="middle">middle</button>
        <button data-testid="last">last</button>
      </Harness>,
    )
    const first = getByTestId('first')
    const last = getByTestId('last')
    last.focus()
    expect(document.activeElement).toBe(last)

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
  })

  it('wraps Shift+Tab from the first focusable element to the last', () => {
    const { getByTestId } = render(
      <Harness active>
        <button data-testid="first">first</button>
        <button data-testid="middle">middle</button>
        <button data-testid="last">last</button>
      </Harness>,
    )
    const first = getByTestId('first')
    const last = getByTestId('last')
    first.focus()
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('skips elements inside an aria-hidden subtree when computing first/last', () => {
    const { getByTestId } = render(
      <Harness active>
        <button data-testid="first">first</button>
        <div aria-hidden="true">
          <button data-testid="hidden">hidden</button>
        </div>
        <button data-testid="last">last</button>
      </Harness>,
    )
    const first = getByTestId('first')
    const last = getByTestId('last')
    last.focus()

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    first.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('is a no-op when the container has no focusable elements', () => {
    const { getByTestId } = render(
      <Harness active>
        <span>not focusable</span>
      </Harness>,
    )
    const container = getByTestId('container')
    container.tabIndex = -1
    container.focus()
    const before = document.activeElement
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(before)
  })

  it('does nothing for non-Tab keys', () => {
    const { getByTestId } = render(
      <Harness active>
        <button data-testid="first">first</button>
        <button data-testid="last">last</button>
      </Harness>,
    )
    const last = getByTestId('last')
    last.focus()
    fireEvent.keyDown(document, { key: 'Enter' })
    fireEvent.keyDown(document, { key: 'a' })
    expect(document.activeElement).toBe(last)
  })

  it('does nothing when active is false', () => {
    const { getByTestId } = render(
      <Harness active={false}>
        <button data-testid="first">first</button>
        <button data-testid="last">last</button>
      </Harness>,
    )
    const last = getByTestId('last')
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(last)
  })

  it('does not wrap when focus is on a middle element (browser handles it)', () => {
    const { getByTestId } = render(
      <Harness active>
        <button data-testid="first">first</button>
        <button data-testid="middle">middle</button>
        <button data-testid="last">last</button>
      </Harness>,
    )
    const middle = getByTestId('middle')
    middle.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(middle)
  })
})
