import { describe, it, expect } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { useFocusWhenPresent } from '../hooks/useFocusWhenPresent'

function Harness() {
  const request = useFocusWhenPresent()
  const [shown, setShown] = useState(false)
  return (
    <div>
      <button onClick={() => request(() => document.getElementById('target'))}>ask</button>
      <button onClick={() => setShown(true)}>show</button>
      <button onClick={() => setShown(false)}>hide</button>
      {shown && <button id="target">target</button>}
    </div>
  )
}

describe('useFocusWhenPresent (#2632)', () => {
  it('focuses a target that is already in the DOM in the same commit', () => {
    render(<Harness />)
    act(() => screen.getByText('show').click())
    act(() => screen.getByText('ask').click())
    expect(screen.getByText('target')).toHaveFocus()
  })

  it('focuses a target that mounts after the request, without polling frames', async () => {
    render(<Harness />)
    act(() => screen.getByText('ask').click())
    expect(document.body).toHaveFocus()
    // The MutationObserver callback is a microtask.
    await act(async () => { screen.getByText('show').click() })
    expect(screen.getByText('target')).toHaveFocus()
  })

  it('refocuses when the focused target is replaced and focus falls to body', async () => {
    render(<Harness />)
    act(() => screen.getByText('show').click())
    act(() => screen.getByText('ask').click())
    await act(async () => { screen.getByText('hide').click() })
    expect(document.body).toHaveFocus()
    await act(async () => { screen.getByText('show').click() })
    expect(screen.getByText('target')).toHaveFocus()
  })

  it('does not steal focus from a control the user moved to', async () => {
    render(<Harness />)
    act(() => screen.getByText('ask').click())
    act(() => screen.getByText('hide').focus())
    await act(async () => { screen.getByText('show').click() })
    expect(screen.getByText('hide')).toHaveFocus()
  })
})

describe('useFocusWhenPresent unmount (#2632)', () => {
  it('does not focus a target that mounts after the owner unmounted', async () => {
    const { unmount } = render(<Harness />)
    act(() => screen.getByText('ask').click())
    unmount()
    const late = document.createElement('button')
    late.id = 'target'
    await act(async () => { document.body.appendChild(late) })
    expect(late).not.toHaveFocus()
    late.remove()
  })
})

describe('useFocusWhenPresent stale focus (#2632)', () => {
  it('does not pull focus back after the user blurs to body', async () => {
    render(<Harness />)
    act(() => screen.getByText('show').click())
    act(() => screen.getByText('ask').click())
    expect(screen.getByText('target')).toHaveFocus()
    act(() => screen.getByText('target').blur())
    await act(async () => { screen.getByText('show').click(); document.body.appendChild(document.createElement('i')) })
    expect(document.body).toHaveFocus()
  })
})
