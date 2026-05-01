import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import RoleInfoTooltip from '../components/Common/RoleInfoTooltip'

describe('RoleInfoTooltip', () => {
  it('renders the trigger button with the default aria-label', () => {
    render(<RoleInfoTooltip>content</RoleInfoTooltip>)
    expect(screen.getByRole('button', { name: 'Role information' })).toBeInTheDocument()
  })

  it('renders the trigger button with a custom label', () => {
    render(<RoleInfoTooltip label="View role details">content</RoleInfoTooltip>)
    expect(screen.getByRole('button', { name: 'View role details' })).toBeInTheDocument()
  })

  it('does not show the tooltip initially', () => {
    render(<RoleInfoTooltip>tooltip content</RoleInfoTooltip>)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('shows the tooltip on mouseenter', () => {
    render(<RoleInfoTooltip>tooltip content</RoleInfoTooltip>)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Role information' }))
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })

  it('hides the tooltip on mouseleave', () => {
    render(<RoleInfoTooltip>tooltip content</RoleInfoTooltip>)
    const btn = screen.getByRole('button', { name: 'Role information' })
    fireEvent.mouseEnter(btn)
    fireEvent.mouseLeave(btn)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('shows the tooltip on focus', () => {
    render(<RoleInfoTooltip>tooltip content</RoleInfoTooltip>)
    fireEvent.focus(screen.getByRole('button', { name: 'Role information' }))
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })

  it('hides the tooltip on blur', () => {
    render(<RoleInfoTooltip>tooltip content</RoleInfoTooltip>)
    const btn = screen.getByRole('button', { name: 'Role information' })
    fireEvent.focus(btn)
    fireEvent.blur(btn)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('renders children inside the tooltip', () => {
    render(
      <RoleInfoTooltip>
        <span>Role explanation text</span>
      </RoleInfoTooltip>,
    )
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Role information' }))
    expect(screen.getByText('Role explanation text')).toBeInTheDocument()
  })
})
