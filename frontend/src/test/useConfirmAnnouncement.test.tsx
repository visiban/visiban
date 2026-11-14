import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useConfirmAnnouncement } from '../hooks/useConfirmAnnouncement'
import { announced } from './confirmAnnouncer'

function Host({ message }: { message: string | null }) {
  useConfirmAnnouncement(message)
  return <div>host</div>
}

const region = () => document.querySelector('[data-confirm-announcer]') as HTMLElement | null

describe('useConfirmAnnouncement (#1435)', () => {
  it('mounts its region inside the topmost aria-modal dialog so modal-scoped AT reads it', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('aria-modal', 'true')
    document.body.appendChild(dialog)
    const { rerender } = render(<Host message={null} />)
    rerender(<Host message="Remove it?" />)
    expect(dialog.querySelector('[data-confirm-announcer]')?.textContent).toBe('Remove it?')
    dialog.remove()
  })

  it('mounts an empty, persistent polite region before any prompt opens', () => {
    render(<Host message={null} />)
    const el = region()
    expect(el).not.toBeNull()
    expect(el).toHaveAttribute('aria-live', 'polite')
    expect(el).toHaveAttribute('aria-atomic', 'true')
    expect(el).not.toHaveAttribute('role')
    expect(el?.textContent).toBe('')
  })

  it('writes the prompt into the already-mounted region on open, in the same node', () => {
    const { rerender } = render(<Host message={null} />)
    const before = region()
    rerender(<Host message="Delete this comment?" />)
    expect(region()).toBe(before)
    expect(announced()).toBe('Delete this comment?')
  })

  it('clears on close so reopening the same prompt announces it again', () => {
    const { rerender } = render(<Host message="Remove it?" />)
    expect(announced()).toBe('Remove it?')
    rerender(<Host message={null} />)
    expect(announced()).toBe('')
    rerender(<Host message="Remove it?" />)
    expect(announced()).toBe('Remove it?')
  })

  it('clears when the host unmounts mid-prompt', () => {
    const { unmount } = render(<Host message="Remove it?" />)
    unmount()
    expect(announced()).toBe('')
  })

  it('lets a later prompt win and does not wipe it when an earlier one closes', () => {
    const first = render(<Host message="First?" />)
    render(<Host message="Second?" />)
    expect(announced()).toBe('Second?')
    first.unmount()
    expect(announced()).toBe('Second?')
  })

  it('is hidden from text queries by default but reachable with ignore: ""', () => {
    render(<Host message="Delete this comment?" />)
    expect(screen.queryByText('Delete this comment?')).toBeNull()
    expect(screen.getByText('Delete this comment?', { ignore: '' })).toBeInTheDocument()
  })
})
