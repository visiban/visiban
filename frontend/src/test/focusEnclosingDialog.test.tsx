import { describe, it, expect, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { focusEnclosingDialog } from '../utils/focusEnclosingDialog'

afterEach(() => { (document.activeElement as HTMLElement | null)?.blur() })

describe('focusEnclosingDialog (#2082)', () => {
  it('focuses the nearest focusable dialog ancestor of a nested input', () => {
    render(
      <div role="dialog" aria-label="Outer" tabIndex={-1}>
        <div role="dialog" aria-label="Inner" tabIndex={-1}>
          <div><input aria-label="field" /></div>
        </div>
      </div>,
    )
    const input = screen.getByLabelText('field')
    input.focus()
    focusEnclosingDialog(input)
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Inner' }))
    expect(document.activeElement).not.toBe(document.body)
  })

  it('skips a dialog without a tabindex and uses the next focusable one', () => {
    render(
      <div role="dialog" aria-label="Outer" tabIndex={-1}>
        <div role="dialog" aria-label="Inner"><input aria-label="field" /></div>
      </div>,
    )
    const input = screen.getByLabelText('field')
    input.focus()
    focusEnclosingDialog(input)
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Outer' }))
  })

  it('falls back to blur() when there is no focusable dialog ancestor', () => {
    render(<div><input aria-label="field" /></div>)
    const input = screen.getByLabelText('field')
    input.focus()
    focusEnclosingDialog(input)
    expect(input).not.toHaveFocus()
  })
})
