import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HealthReviewDaysInput, { parseHealthReviewDays } from '../components/Common/HealthReviewDaysInput'

describe('HealthReviewDaysInput (#2244)', () => {
  it('parses empty as off and accepts only whole numbers 1..365', () => {
    expect(parseHealthReviewDays('')).toBeNull()
    expect(parseHealthReviewDays(' 7 ')).toBe(7)
    expect(parseHealthReviewDays('1')).toBe(1)
    expect(parseHealthReviewDays('365')).toBe(365)
    for (const bad of ['0', '366', '-1', '2.5', 'soon']) expect(parseHealthReviewDays(bad)).toBeUndefined()
  })

  it('saves on blur and Enter, and null when cleared', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(<HealthReviewDaysInput entityKind="board" value={null} onSave={onSave} />)
    const input = screen.getByLabelText('Review status every')
    expect(input).toHaveAttribute('placeholder', 'Off')
    await user.type(input, '14')
    await user.tab()
    expect(onSave).toHaveBeenCalledWith(14)
    expect(await screen.findByText('Saved')).toHaveAttribute('role', 'status')
    rerender(<HealthReviewDaysInput entityKind="board" value={14} onSave={onSave} />)
    await user.clear(input)
    await user.keyboard('{Enter}')
    expect(onSave).toHaveBeenLastCalledWith(null)
  })

  it('never sends an invalid value and shows an inline error', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<HealthReviewDaysInput entityKind="group" value={7} onSave={onSave} />)
    const input = screen.getByLabelText('Review status every')
    await user.clear(input)
    await user.type(input, '400')
    await user.tab()
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number from 1 to 365')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input.getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id)
    expect(screen.getByText(/subgroups and boards that inherit it/)).toBeInTheDocument()
  })

  it('restores the stored value when the save fails', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockRejectedValue(new Error('nope'))
    render(<HealthReviewDaysInput entityKind="board" value={7} onSave={onSave} />)
    const input = screen.getByLabelText('Review status every')
    await user.clear(input)
    await user.type(input, '30')
    await user.tab()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed to save'))
    expect(input).toHaveValue(7)
  })

  it('does not save an unchanged value and follows a remote change', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const { rerender } = render(<HealthReviewDaysInput entityKind="board" value={7} onSave={onSave} />)
    const input = screen.getByLabelText('Review status every')
    await user.click(input)
    await user.tab()
    expect(onSave).not.toHaveBeenCalled()
    rerender(<HealthReviewDaysInput entityKind="board" value={21} onSave={onSave} />)
    expect(input).toHaveValue(21)
  })
})
