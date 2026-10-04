import { describe, it, expect } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useConfirmFocusReturn } from '../hooks/useConfirmFocusReturn'

// Mirrors the real call sites: the trigger is swapped out while the prompt is
// open (so it is re-mounted on dismiss), keyed per row.
function SwapHarness() {
  const [open, setOpen] = useState<number | null>(null)
  const triggerRef = useConfirmFocusReturn(open)
  return (
    <div>
      <button>before</button>
      {[1, 2].map((id) =>
        open === id ? (
          <div key={id}>
            <button onClick={() => setOpen(null)}>Cancel {id}</button>
            <button onClick={() => setOpen(null)}>Confirm {id}</button>
          </div>
        ) : (
          <button key={id} ref={triggerRef(id)} onClick={() => setOpen(id)}>
            Remove {id}
          </button>
        ),
      )}
    </div>
  )
}

// Trigger stays mounted; only the focused Cancel button unmounts.
function StayHarness() {
  const [open, setOpen] = useState(false)
  const triggerRef = useConfirmFocusReturn(open ? 'x' : null)
  return (
    <div>
      <button ref={triggerRef('x')} onClick={() => setOpen(true)}>Toggle</button>
      <button>elsewhere</button>
      {open && <button onClick={() => setOpen(false)}>Cancel</button>}
    </div>
  )
}

describe('useConfirmFocusReturn (#1367)', () => {
  it('returns focus to the re-mounted trigger of the right row on Cancel', async () => {
    const user = userEvent.setup()
    render(<SwapHarness />)
    await user.click(screen.getByRole('button', { name: 'Remove 2' }))
    await user.click(screen.getByRole('button', { name: 'Cancel 2' }))
    expect(screen.getByRole('button', { name: 'Remove 2' })).toHaveFocus()
  })

  it('returns focus when the trigger stayed mounted and the focused Cancel unmounts', async () => {
    const user = userEvent.setup()
    render(<StayHarness />)
    await user.click(screen.getByRole('button', { name: 'Toggle' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Toggle' })).toHaveFocus()
  })

  it('does not steal focus the user has already moved to another control', async () => {
    function ElsewhereHarness() {
      const [open, setOpen] = useState<number | null>(null)
      const triggerRef = useConfirmFocusReturn(open)
      return (
        <div>
          <button ref={triggerRef(1)} onClick={() => setOpen(1)}>Open</button>
          <button onClick={() => setOpen(null)}>Close programmatically</button>
          <input aria-label="other" />
        </div>
      )
    }
    const user = userEvent.setup()
    render(<ElsewhereHarness />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    const other = screen.getByLabelText('other')
    other.focus()
    // Close via a handler that does not move focus (simulates an external close).
    await user.click(screen.getByRole('button', { name: 'Close programmatically' }))
    // The click focused "Close programmatically", which is still mounted, so
    // focus must stay there rather than jumping to the trigger.
    expect(screen.getByRole('button', { name: 'Close programmatically' })).toHaveFocus()
  })

  it('is a no-op when the trigger no longer exists (row removed)', async () => {
    function RemovedHarness() {
      const [open, setOpen] = useState<number | null>(null)
      const [rows, setRows] = useState([1])
      const triggerRef = useConfirmFocusReturn(open)
      return (
        <div>
          {rows.map((id) =>
            open === id ? (
              <button
                key={id}
                onClick={() => {
                  setRows([])
                  setOpen(null)
                }}
              >
                Confirm
              </button>
            ) : (
              <button key={id} ref={triggerRef(id)} onClick={() => setOpen(id)}>Remove</button>
            ),
          )}
        </div>
      )
    }
    const user = userEvent.setup()
    render(<RemovedHarness />)
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(document.body).toHaveFocus()
  })
})
