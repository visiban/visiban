import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ErrorBoundary from '../components/ErrorBoundary'

// ---------------------------------------------------------------------------
// Helper: component that optionally throws
// ---------------------------------------------------------------------------

function Thrower({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('Test error')
  return <div>OK</div>
}

// ---------------------------------------------------------------------------
// Setup: suppress React's error boundary console.error noise
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ErrorBoundary', () => {
  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <Thrower shouldThrow={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('OK')).toBeInTheDocument()
  })

  it('renders error UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <Thrower shouldThrow={true} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
  })

  it('shows the error message in a <pre> element', () => {
    render(
      <ErrorBoundary>
        <Thrower shouldThrow={true} />
      </ErrorBoundary>,
    )
    const pre = screen.getByText('Test error')
    expect(pre.tagName).toBe('PRE')
  })

  it('shows "Something went wrong" heading', () => {
    render(
      <ErrorBoundary>
        <Thrower shouldThrow={true} />
      </ErrorBoundary>,
    )
    const heading = screen.getByText('Something went wrong')
    expect(heading.tagName).toBe('H1')
  })

  it('shows the Reload button', () => {
    render(
      <ErrorBoundary>
        <Thrower shouldThrow={true} />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
  })

  it('clicking Reload calls window.location.reload', async () => {
    const reloadMock = vi.fn()
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, reload: reloadMock },
    })

    const user = userEvent.setup()
    render(
      <ErrorBoundary>
        <Thrower shouldThrow={true} />
      </ErrorBoundary>,
    )
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reloadMock).toHaveBeenCalledTimes(1)
  })

  it('does not render error UI when children are healthy', () => {
    render(
      <ErrorBoundary>
        <div data-testid="healthy">All good</div>
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('healthy')).toBeInTheDocument()
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument()
  })

  it('shows descriptive message asking user to refresh', () => {
    render(
      <ErrorBoundary>
        <Thrower shouldThrow={true} />
      </ErrorBoundary>,
    )
    expect(
      screen.getByText(/please refresh the page/i),
    ).toBeInTheDocument()
  })

  it('console.error is called when boundary catches an error', () => {
    render(
      <ErrorBoundary>
        <Thrower shouldThrow={true} />
      </ErrorBoundary>,
    )
    // ErrorBoundary calls console.error in componentDidCatch
    expect(console.error).toHaveBeenCalled()
  })
})
