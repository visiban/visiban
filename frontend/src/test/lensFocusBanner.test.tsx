import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LensFocusBanner from '../components/Board/Lens/LensFocusBanner'

// LensFocusBanner had zero test coverage (#1350) — lensView.test.tsx only asserts
// the ABSENCE of the "Exit focus" button when no lane is focused, never this
// component's own label rendering or onExit wiring.

describe('LensFocusBanner', () => {
  it('renders the focused swimlane label', () => {
    render(<LensFocusBanner label="v1" onExit={vi.fn()} />)
    expect(screen.getByText('Focused on:')).toBeInTheDocument()
    expect(screen.getByText('v1')).toBeInTheDocument()
  })

  it('calls onExit once when Exit focus is clicked', async () => {
    const user = userEvent.setup()
    const onExit = vi.fn()
    render(<LensFocusBanner label="v1" onExit={onExit} />)

    await user.click(screen.getByRole('button', { name: 'Exit focus' }))

    expect(onExit).toHaveBeenCalledTimes(1)
  })
})
