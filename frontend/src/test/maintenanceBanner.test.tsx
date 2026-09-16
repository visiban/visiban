import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import MaintenanceBanner from '../components/Common/MaintenanceBanner'

describe('MaintenanceBanner (#783)', () => {
  it('renders the operator notice', () => {
    render(<MaintenanceBanner message="Back by 14:00 UTC." isSiteAdmin={false} />)
    expect(screen.getByText('Maintenance mode is active.')).toBeInTheDocument()
    expect(screen.getByText('Back by 14:00 UTC.')).toBeInTheDocument()
  })

  it('is announced politely as a single unit', () => {
    // Not role="alert": the viewer did not cause this and has nothing to act
    // on, so it must not interrupt what they are doing.
    render(<MaintenanceBanner message="Back soon." isSiteAdmin={false} />)
    const banner = screen.getByRole('status')
    expect(banner).toHaveAttribute('aria-live', 'polite')
    expect(banner).toHaveAttribute('aria-atomic', 'true')
  })

  it('offers no dismiss control', () => {
    // It reflects live system state, not a preference. A banner that can be
    // dismissed is one that gets dismissed and then forgotten.
    render(<MaintenanceBanner message="Back soon." isSiteAdmin={false} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('tells a site admin they still have full access', () => {
    render(<MaintenanceBanner message="Back soon." isSiteAdmin />)
    expect(screen.getByText('You have full access as a site admin.')).toBeInTheDocument()
  })

  it('omits the admin clause for everyone else', () => {
    render(<MaintenanceBanner message="Back soon." isSiteAdmin={false} />)
    expect(screen.queryByText(/full access as a site admin/)).not.toBeInTheDocument()
  })

  it('renders an operator message as text, never as markup', () => {
    // The notice is admin-supplied. If it were ever piped through
    // dangerouslySetInnerHTML this would produce a real element.
    const hostile = '<img src=x onerror="alert(1)">'
    const { container } = render(<MaintenanceBanner message={hostile} isSiteAdmin={false} />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(hostile)).toBeInTheDocument()
  })

  it('exposes the full notice via title so truncation never hides it', () => {
    const long = `Upgrading the database.${' Please stand by.'.repeat(40)}`
    const { container } = render(<MaintenanceBanner message={long} isSiteAdmin={false} />)
    const notice = container.querySelector('[title]')
    expect(notice).toHaveAttribute('title', long)
    // truncate is CSS-only, so the complete notice is still in the DOM for
    // screen readers even though it is visually clipped.
    expect(notice?.textContent).toBe(long)
  })
})
