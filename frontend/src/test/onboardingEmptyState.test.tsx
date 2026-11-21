import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OnboardingEmptyState from '../components/Dashboard/OnboardingEmptyState'

describe('OnboardingEmptyState (#2474)', () => {
  it('renders an h2 welcome (the header owns the h1) and no h1', () => {
    render(<OnboardingEmptyState name="Jane" onCreateBoard={vi.fn()} onJoinGroup={vi.fn()} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Welcome to Visiban, Jane' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(screen.getByText("You're not on a team yet, and you have no boards of your own.")).toBeInTheDocument()
  })

  it('omits the name when none is given', () => {
    render(<OnboardingEmptyState onCreateBoard={vi.fn()} onJoinGroup={vi.fn()} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Welcome to Visiban' })).toBeInTheDocument()
  })

  it('names the admin when the instance exposes a contact', () => {
    render(<OnboardingEmptyState adminContact="Alex Admin" onCreateBoard={vi.fn()} onJoinGroup={vi.fn()} />)
    expect(screen.getByText(/Alex Admin/)).toBeInTheDocument()
  })

  it('leads with joining a team, then the personal options', () => {
    render(<OnboardingEmptyState onCreateBoard={vi.fn()} onJoinGroup={vi.fn()} onImport={vi.fn()} />)
    const headings = screen.getAllByRole('heading').map((h) => h.textContent)
    expect(headings.indexOf('Waiting to join a team?')).toBeLessThan(headings.indexOf('Or start a board of your own'))
    expect(screen.getByText(/Boards you start here are personal/)).toBeInTheDocument()
  })

  it('wires the invite, template, blank and import actions', async () => {
    const onCreateBoard = vi.fn()
    const onJoinGroup = vi.fn()
    const onImport = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingEmptyState onCreateBoard={onCreateBoard} onJoinGroup={onJoinGroup} onImport={onImport} />)
    await user.click(screen.getByRole('button', { name: 'I have an invite link' }))
    await user.click(screen.getByRole('button', { name: 'Create a board' }))
    expect(screen.queryByRole('button', { name: /Blank board|Start from a template/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Import a board/ }))
    expect(onJoinGroup).toHaveBeenCalledOnce()
    expect(onCreateBoard).toHaveBeenCalledOnce()
    expect(onImport).toHaveBeenCalledOnce()
  })

  it('hosted demo: create and import are aria-disabled with the reason and do nothing', async () => {
    const onCreateBoard = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingEmptyState onCreateBoard={onCreateBoard} onJoinGroup={vi.fn()} onImport={vi.fn()} disabledReason="Demo only" />)
    const blank = screen.getByRole('button', { name: 'Create a board. Demo only' })
    expect(blank).toHaveAttribute('aria-disabled', 'true')
    await user.click(blank)
    expect(onCreateBoard).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'I have an invite link' })).not.toHaveAttribute('aria-disabled')
  })
})
