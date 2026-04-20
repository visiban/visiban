import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import AutosaveIndicator from '../components/Common/AutosaveIndicator'
import { useAutosaveStatus } from '../hooks/useAutosaveStatus'

// ---------------------------------------------------------------------------
// AutosaveIndicator component
// ---------------------------------------------------------------------------

describe('AutosaveIndicator', () => {
  it('renders empty container in idle state', () => {
    const { container } = render(<AutosaveIndicator status="idle" />)
    const p = container.querySelector('p')
    expect(p).toBeInTheDocument()
    expect(p!.textContent).toBe('')
  })

  it('shows spinner and Saving text in saving state', () => {
    render(<AutosaveIndicator status="saving" />)
    expect(screen.getByText('Saving…')).toBeInTheDocument()
  })

  it('shows check and Saved text in saved state', () => {
    render(<AutosaveIndicator status="saved" />)
    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(screen.getByText('✓')).toBeInTheDocument()
  })

  it('shows error glyph and Couldn\'t save in error state', () => {
    render(<AutosaveIndicator status="error" />)
    expect(screen.getByText("Couldn't save")).toBeInTheDocument()
    expect(screen.getByText('!')).toBeInTheDocument()
  })

  it('applies opacity-0 to saved content when fadingOut is true', () => {
    render(<AutosaveIndicator status="saved" fadingOut />)
    const savedText = screen.getByText('Saved')
    expect(savedText.className).toContain('opacity-0')
  })

  it('applies opacity-100 to saved content when fadingOut is false', () => {
    render(<AutosaveIndicator status="saved" fadingOut={false} />)
    const savedText = screen.getByText('Saved')
    expect(savedText.className).toContain('opacity-100')
  })

  it('has aria-live="polite" on the container', () => {
    const { container } = render(<AutosaveIndicator status="idle" />)
    expect(container.querySelector('[aria-live="polite"]')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// useAutosaveStatus hook
// ---------------------------------------------------------------------------

describe('useAutosaveStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts in idle state', () => {
    const { result } = renderHook(() => useAutosaveStatus())
    expect(result.current.status).toBe('idle')
    expect(result.current.fadingOut).toBe(false)
  })

  it('transitions idle → saving → saved on successful runSave', async () => {
    const { result } = renderHook(() => useAutosaveStatus())
    const promise = Promise.resolve()

    act(() => { result.current.runSave(promise) })
    expect(result.current.status).toBe('saving')

    await act(async () => { await promise })
    expect(result.current.status).toBe('saved')
    expect(result.current.fadingOut).toBe(false)
  })

  it('sets fadingOut=true at 1700ms then resets to idle at 2000ms', async () => {
    const { result } = renderHook(() => useAutosaveStatus())

    await act(async () => { await result.current.runSave(Promise.resolve()) })
    expect(result.current.status).toBe('saved')

    act(() => { vi.advanceTimersByTime(1700) })
    expect(result.current.fadingOut).toBe(true)

    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.status).toBe('idle')
    expect(result.current.fadingOut).toBe(false)
  })

  it('transitions idle → saving → error on failed runSave', async () => {
    const { result } = renderHook(() => useAutosaveStatus())
    const promise = Promise.reject(new Error('fail'))

    act(() => { result.current.runSave(promise) })
    expect(result.current.status).toBe('saving')

    await act(async () => { await promise.catch(() => {}) })
    expect(result.current.status).toBe('error')
  })

  it('error state does not auto-reset', async () => {
    const { result } = renderHook(() => useAutosaveStatus())
    await act(async () => {
      await result.current.runSave(Promise.reject(new Error('fail'))).catch(() => {})
    })
    expect(result.current.status).toBe('error')

    act(() => { vi.advanceTimersByTime(5000) })
    expect(result.current.status).toBe('error')
  })

  it('clears pending timers when a new runSave is called', async () => {
    const { result } = renderHook(() => useAutosaveStatus())

    await act(async () => { await result.current.runSave(Promise.resolve()) })
    expect(result.current.status).toBe('saved')

    // Second runSave before first's timers fire — timers should be cleared and fadingOut reset
    await act(async () => { await result.current.runSave(Promise.resolve()) })
    expect(result.current.status).toBe('saved')
    expect(result.current.fadingOut).toBe(false)

    // Advance through the second save's timers
    act(() => { vi.advanceTimersByTime(2000) })
    expect(result.current.status).toBe('idle')
  })
})
