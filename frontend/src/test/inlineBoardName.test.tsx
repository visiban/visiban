import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import InlineBoardName from '../components/Board/InlineBoardName'

describe('InlineBoardName', () => {
  it('renders plain text for non-admins with no affordance', () => {
    render(<InlineBoardName name="My board" canEdit={false} onSave={vi.fn()} />)
    expect(screen.getByText('My board')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /rename board/i })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('shows rename pencil affordance for admins', () => {
    render(<InlineBoardName name="My board" canEdit={true} onSave={vi.fn()} />)
    expect(screen.getByRole('button', { name: /rename board/i })).toBeTruthy()
  })

  it('clicking the pencil enters edit mode with current value', async () => {
    const user = userEvent.setup()
    render(<InlineBoardName name="My board" canEdit={true} onSave={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /rename board/i }))
    const input = screen.getByRole('textbox', { name: /board name/i }) as HTMLInputElement
    expect(input.value).toBe('My board')
  })

  it('clicking the name enters edit mode', async () => {
    const user = userEvent.setup()
    render(<InlineBoardName name="My board" canEdit={true} onSave={vi.fn()} />)
    await user.click(screen.getByText('My board'))
    expect(screen.getByRole('textbox', { name: /board name/i })).toBeTruthy()
  })

  it('Enter saves the new name via onSave', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<InlineBoardName name="Old name" canEdit={true} onSave={onSave} />)
    await user.click(screen.getByRole('button', { name: /rename board/i }))
    const input = screen.getByRole('textbox', { name: /board name/i })
    await user.clear(input)
    await user.type(input, 'New name{Enter}')
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('New name'))
  })

  it('Escape cancels without calling onSave', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<InlineBoardName name="Old name" canEdit={true} onSave={onSave} />)
    await user.click(screen.getByRole('button', { name: /rename board/i }))
    const input = screen.getByRole('textbox', { name: /board name/i })
    await user.clear(input)
    await user.type(input, 'Different{Escape}')
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText('Old name')).toBeTruthy()
  })

  it('blur saves the new name', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<>
      <InlineBoardName name="Old name" canEdit={true} onSave={onSave} />
      <button>Outside</button>
    </>)
    await user.click(screen.getByRole('button', { name: /rename board/i }))
    const input = screen.getByRole('textbox', { name: /board name/i })
    await user.clear(input)
    await user.type(input, 'Blurred name')
    await user.click(screen.getByRole('button', { name: 'Outside' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Blurred name'))
  })

  it('does not call onSave when name is unchanged', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<InlineBoardName name="Same" canEdit={true} onSave={onSave} />)
    await user.click(screen.getByRole('button', { name: /rename board/i }))
    const input = screen.getByRole('textbox', { name: /board name/i })
    await user.type(input, '{Enter}')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('shows an error when the name is empty', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<InlineBoardName name="Old" canEdit={true} onSave={onSave} />)
    await user.click(screen.getByRole('button', { name: /rename board/i }))
    const input = screen.getByRole('textbox', { name: /board name/i })
    await user.clear(input)
    await user.type(input, '{Enter}')
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/cannot be empty/i)).toBeTruthy()
  })

  it('shows an error when onSave rejects', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockRejectedValue(new Error('boom'))
    render(<InlineBoardName name="Old" canEdit={true} onSave={onSave} />)
    await user.click(screen.getByRole('button', { name: /rename board/i }))
    const input = screen.getByRole('textbox', { name: /board name/i })
    await user.clear(input)
    await user.type(input, 'New{Enter}')
    await waitFor(() => expect(screen.getByText(/failed to rename/i)).toBeTruthy())
  })
})
