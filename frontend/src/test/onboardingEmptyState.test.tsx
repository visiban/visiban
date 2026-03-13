import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OnboardingEmptyState from '../components/Dashboard/OnboardingEmptyState'

describe('OnboardingEmptyState', () => {
  it('renders the welcome heading', () => {
    render(<OnboardingEmptyState onCreateBoard={vi.fn()} onJoinGroup={vi.fn()} />)
    expect(screen.getByText('Welcome to Visiban')).toBeInTheDocument()
  })

  it('calls onCreateBoard when create button is clicked', async () => {
    const onCreateBoard = vi.fn()
    render(<OnboardingEmptyState onCreateBoard={onCreateBoard} onJoinGroup={vi.fn()} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /create my first board/i }))
    expect(onCreateBoard).toHaveBeenCalledOnce()
  })

  it('calls onJoinGroup when join button is clicked', async () => {
    const onJoinGroup = vi.fn()
    render(<OnboardingEmptyState onCreateBoard={vi.fn()} onJoinGroup={onJoinGroup} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /join a group/i }))
    expect(onJoinGroup).toHaveBeenCalledOnce()
  })
})
