import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, renderHook } from '@testing-library/react'
import { ThemeProvider, useTheme } from '../context/ThemeContext'
import type { ThemePreference } from '../context/ThemeContext'

// ---------------------------------------------------------------------------
// matchMedia mock helpers
// ---------------------------------------------------------------------------

function makeMatchMedia(prefersDark: boolean) {
  const listeners: Array<() => void> = []
  const mq = {
    matches: prefersDark,
    addEventListener: vi.fn((_event: string, handler: () => void) => {
      listeners.push(handler)
    }),
    removeEventListener: vi.fn((_event: string, handler: () => void) => {
      const idx = listeners.indexOf(handler)
      if (idx !== -1) listeners.splice(idx, 1)
    }),
    // helper to simulate OS preference change
    _trigger: () => listeners.forEach((h) => h()),
  }
  return mq
}

let mockMq: ReturnType<typeof makeMatchMedia>

function setupMatchMedia(prefersDark = false) {
  mockMq = makeMatchMedia(prefersDark)
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockReturnValue(mockMq),
  })
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'visiban-theme'

function setStoredPreference(pref: ThemePreference) {
  localStorage.setItem(STORAGE_KEY, pref)
}

function clearStoredPreference() {
  localStorage.removeItem(STORAGE_KEY)
}

// ---------------------------------------------------------------------------
// Wrapper component
// ---------------------------------------------------------------------------

function wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThemeProvider — initial preference', () => {
  beforeEach(() => {
    setupMatchMedia(false)
    clearStoredPreference()
    document.documentElement.classList.remove('dark')
  })

  afterEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  it('defaults to "system" when no localStorage value', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current.preference).toBe('system')
  })

  it('writes "system" to localStorage when no stored value exists', () => {
    renderHook(() => useTheme(), { wrapper })
    expect(localStorage.getItem(STORAGE_KEY)).toBe('system')
  })

  it('reads initial preference from localStorage', () => {
    setStoredPreference('dark')
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current.preference).toBe('dark')
  })

  it('reads "system" preference from localStorage', () => {
    setStoredPreference('system')
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current.preference).toBe('system')
  })
})

describe('ThemeProvider — setPreference', () => {
  beforeEach(() => {
    setupMatchMedia(false)
    clearStoredPreference()
    document.documentElement.classList.remove('dark')
  })

  afterEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  it('setPreference("dark") updates localStorage', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    act(() => { result.current.setPreference('dark') })
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark')
  })

  it('setPreference("dark") applies dark class to documentElement', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    act(() => { result.current.setPreference('dark') })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('setPreference("light") removes dark class from documentElement', () => {
    document.documentElement.classList.add('dark')
    const { result } = renderHook(() => useTheme(), { wrapper })
    act(() => { result.current.setPreference('light') })
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('setPreference("light") updates localStorage', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    act(() => { result.current.setPreference('light') })
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light')
  })

  it('setPreference updates the returned preference value', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    act(() => { result.current.setPreference('dark') })
    expect(result.current.preference).toBe('dark')
  })
})

describe('ThemeProvider — system preference', () => {
  afterEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  it('applies dark class when OS prefers dark and preference is "system"', () => {
    setupMatchMedia(true)
    clearStoredPreference()
    renderHook(() => useTheme(), { wrapper })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('removes dark class when OS does not prefer dark and preference is "system"', () => {
    setupMatchMedia(false)
    document.documentElement.classList.add('dark')
    clearStoredPreference()
    renderHook(() => useTheme(), { wrapper })
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('adds a mediaQuery change listener when preference is "system"', () => {
    setupMatchMedia(false)
    clearStoredPreference()
    renderHook(() => useTheme(), { wrapper })
    expect(mockMq.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('removes mediaQuery change listener when preference changes away from "system"', () => {
    setupMatchMedia(false)
    clearStoredPreference()
    const { result } = renderHook(() => useTheme(), { wrapper })
    // When we switch from system to dark, the cleanup effect should remove the listener
    act(() => { result.current.setPreference('dark') })
    expect(mockMq.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('does NOT add mediaQuery listener when preference is "dark"', () => {
    setupMatchMedia(false)
    setStoredPreference('dark')
    renderHook(() => useTheme(), { wrapper })
    expect(mockMq.addEventListener).not.toHaveBeenCalled()
  })
})

describe('ThemeProvider — setPreference("system")', () => {
  beforeEach(() => {
    clearStoredPreference()
    document.documentElement.classList.remove('dark')
  })

  afterEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  it('when OS prefers dark, sets dark class', () => {
    setupMatchMedia(true)
    const { result } = renderHook(() => useTheme(), { wrapper })
    // Start with dark, then switch to system
    act(() => { result.current.setPreference('dark') })
    act(() => { result.current.setPreference('system') })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('when OS does not prefer dark, removes dark class', () => {
    setupMatchMedia(false)
    document.documentElement.classList.add('dark')
    const { result } = renderHook(() => useTheme(), { wrapper })
    act(() => { result.current.setPreference('dark') })
    act(() => { result.current.setPreference('system') })
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})

describe('useTheme', () => {
  beforeEach(() => {
    setupMatchMedia(false)
    clearStoredPreference()
    document.documentElement.classList.remove('dark')
    document.documentElement.removeAttribute('data-theme')
  })

  afterEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    document.documentElement.removeAttribute('data-theme')
  })

  it('returns the context value with preference and setPreference', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current).toHaveProperty('preference')
    expect(result.current).toHaveProperty('setPreference')
    expect(typeof result.current.setPreference).toBe('function')
  })

  it('returns the default context when used outside ThemeProvider', () => {
    // Without wrapper, returns the default context value (preference: "system")
    const { result } = renderHook(() => useTheme())
    expect(result.current.preference).toBe('system')
  })

  it('ThemeProvider renders children', () => {
    render(
      <ThemeProvider>
        <div data-testid="child">Hello</div>
      </ThemeProvider>,
    )
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })
})

describe('ThemeProvider — data-theme attribute', () => {
  beforeEach(() => {
    setupMatchMedia(false)
    clearStoredPreference()
    document.documentElement.classList.remove('dark')
    document.documentElement.removeAttribute('data-theme')
  })

  afterEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    document.documentElement.removeAttribute('data-theme')
  })

  it('sets data-theme="dark" when preference is dark', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    act(() => { result.current.setPreference('dark') })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('sets data-theme="light" when preference is light', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    act(() => { result.current.setPreference('light') })
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('sets data-theme to the resolved system mode (dark when OS prefers dark)', () => {
    setupMatchMedia(true)
    renderHook(() => useTheme(), { wrapper })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('sets data-theme to the resolved system mode (light when OS prefers light)', () => {
    setupMatchMedia(false)
    renderHook(() => useTheme(), { wrapper })
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})

describe('ThemeProvider — resolved field', () => {
  beforeEach(() => {
    setupMatchMedia(false)
    clearStoredPreference()
  })

  afterEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    document.documentElement.removeAttribute('data-theme')
  })

  it('exposes resolved="dark" when preference is dark', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    act(() => { result.current.setPreference('dark') })
    expect(result.current.resolved).toBe('dark')
  })

  it('exposes resolved="light" when preference is light', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    act(() => { result.current.setPreference('light') })
    expect(result.current.resolved).toBe('light')
  })

  it('exposes resolved="dark" when preference is system and OS prefers dark', () => {
    setupMatchMedia(true)
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current.resolved).toBe('dark')
  })
})

describe('ThemeProvider — cross-tab storage sync', () => {
  beforeEach(() => {
    setupMatchMedia(false)
    clearStoredPreference()
    document.documentElement.classList.remove('dark')
    document.documentElement.removeAttribute('data-theme')
  })

  afterEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    document.documentElement.removeAttribute('data-theme')
  })

  it('updates preference when another tab writes to localStorage', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current.preference).toBe('system')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: STORAGE_KEY,
        newValue: 'dark',
        oldValue: 'system',
      }))
    })
    expect(result.current.preference).toBe('dark')
  })

  it('ignores storage events for unrelated keys', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'unrelated-pref',
        newValue: 'dark',
      }))
    })
    expect(result.current.preference).toBe('system')
  })

  it('ignores storage events with invalid theme values', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: STORAGE_KEY,
        newValue: 'midnight',
      }))
    })
    expect(result.current.preference).toBe('system')
  })

  it('ignores storage events with null newValue', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: STORAGE_KEY,
        newValue: null,
      }))
    })
    expect(result.current.preference).toBe('system')
  })
})
