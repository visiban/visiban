import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DemoInert from '../components/Common/DemoInert'

// #2011 — direct coverage of the demo-mode region (#1179); it was only exercised through Board Settings.
describe('DemoInert', () => {
  it('renders children untouched, with no wrapper, when inactive', () => {
    render(<DemoInert active={false} describedBy="why"><button>Go</button></DemoInert>)
    expect(screen.queryByTestId('demo-inert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument()
  })

  it('exposes a disabled group tied to the notice when active', () => {
    render(<DemoInert active describedBy="why"><button>Go</button></DemoInert>)
    const group = screen.getByRole('group')
    expect(group).toHaveAttribute('aria-disabled', 'true')
    expect(group).toHaveAttribute('aria-describedby', 'why')
  })

  it('blocks clicks and activation keys before the control handler, but keeps it focusable', async () => {
    const onClick = vi.fn()
    const onKeyDown = vi.fn()
    const user = userEvent.setup()
    render(<DemoInert active describedBy="why"><button onClick={onClick} onKeyDown={onKeyDown}>Go</button></DemoInert>)
    const btn = screen.getByRole('button', { name: 'Go' })
    expect(btn).not.toBeDisabled()
    await user.click(btn)
    expect(onClick).not.toHaveBeenCalled()
    btn.focus()
    expect(btn).toHaveFocus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onKeyDown).not.toHaveBeenCalled()
    expect(onClick).not.toHaveBeenCalled()
  })

  it('lets Tab and Escape through', () => {
    const onKeyDown = vi.fn()
    render(<DemoInert active describedBy="why"><button onKeyDown={onKeyDown}>Go</button></DemoInert>)
    const btn = screen.getByRole('button', { name: 'Go' })
    fireEvent.keyDown(btn, { key: 'Tab' })
    fireEvent.keyDown(btn, { key: 'Escape' })
    expect(onKeyDown).toHaveBeenCalledTimes(2)
  })

  it('blocks changes and stops blur and pointer-down from reaching the control', () => {
    const onChange = vi.fn(); const onBlur = vi.fn(); const onPointerDown = vi.fn()
    render(<DemoInert active describedBy="why"><input aria-label="f" onChange={onChange} onBlur={onBlur} onPointerDown={onPointerDown} /></DemoInert>)
    const input = screen.getByLabelText('f')
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.blur(input)
    fireEvent.pointerDown(input)
    expect(onChange).not.toHaveBeenCalled()
    expect(onBlur).not.toHaveBeenCalled()
    expect(onPointerDown).not.toHaveBeenCalled()
  })
})
