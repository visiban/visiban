import { describe, it, expect, afterEach, vi } from 'vitest'
import { isMacPlatform, modKeyLabel, shiftKeyLabel, formatShortcut, formatAriaKeyshortcuts } from '../utils/platform'

function setPlatform(value: string) {
  Object.defineProperty(navigator, 'platform', {
    value,
    configurable: true,
  })
  // userAgentData is preferred when present — explicitly unset so tests
  // exercise the navigator.platform fallback path.
  Object.defineProperty(navigator, 'userAgentData', {
    value: undefined,
    configurable: true,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('platform helpers', () => {
  it('isMacPlatform returns true for MacIntel', () => {
    setPlatform('MacIntel')
    expect(isMacPlatform()).toBe(true)
  })

  it('isMacPlatform returns true for iPhone and iPad', () => {
    setPlatform('iPhone')
    expect(isMacPlatform()).toBe(true)
    setPlatform('iPad')
    expect(isMacPlatform()).toBe(true)
  })

  it('isMacPlatform returns false for Linux', () => {
    setPlatform('Linux x86_64')
    expect(isMacPlatform()).toBe(false)
  })

  it('isMacPlatform returns false for Windows', () => {
    setPlatform('Win32')
    expect(isMacPlatform()).toBe(false)
  })

  it('modKeyLabel returns the Mac glyph on Mac', () => {
    setPlatform('MacIntel')
    expect(modKeyLabel()).toBe('⌘')
  })

  it('modKeyLabel returns "Ctrl" on non-Mac', () => {
    setPlatform('Win32')
    expect(modKeyLabel()).toBe('Ctrl')
  })

  it('shiftKeyLabel returns the glyph on Mac and "Shift" elsewhere', () => {
    setPlatform('MacIntel')
    expect(shiftKeyLabel()).toBe('⇧')
    setPlatform('Linux x86_64')
    expect(shiftKeyLabel()).toBe('Shift')
  })

  it('formatShortcut renders glyph-concatenated strings on Mac', () => {
    setPlatform('MacIntel')
    expect(formatShortcut({ mod: true, key: 'K' })).toBe('⌘K')
    expect(formatShortcut({ mod: true, shift: true, key: 'E' })).toBe('⌘⇧E')
    expect(formatShortcut({ mod: true, key: '\\' })).toBe('⌘\\')
    expect(formatShortcut({ alt: true, key: 'Tab' })).toBe('⌥Tab')
  })

  it('formatShortcut renders plus-separated strings off Mac', () => {
    setPlatform('Win32')
    expect(formatShortcut({ mod: true, key: 'K' })).toBe('Ctrl+K')
    expect(formatShortcut({ mod: true, shift: true, key: 'E' })).toBe('Ctrl+Shift+E')
    expect(formatShortcut({ mod: true, key: '\\' })).toBe('Ctrl+\\')
    expect(formatShortcut({ alt: true, key: 'Tab' })).toBe('Alt+Tab')
  })

  it('formatShortcut returns a bare key when no modifiers are set', () => {
    setPlatform('Linux x86_64')
    expect(formatShortcut({ key: 'Enter' })).toBe('Enter')
  })

  it('formatAriaKeyshortcuts emits the ARIA 1.2 canonical form on Mac', () => {
    setPlatform('MacIntel')
    // Bare letters uppercase; chord modifiers use the ARIA "Meta" spelling.
    expect(formatAriaKeyshortcuts({ key: 'b' })).toBe('B')
    expect(formatAriaKeyshortcuts({ mod: true, key: 'k' })).toBe('Meta+K')
    expect(formatAriaKeyshortcuts({ mod: true, shift: true, key: 'l' })).toBe('Meta+Shift+L')
  })

  it('formatAriaKeyshortcuts emits the Control+ form off Mac', () => {
    setPlatform('Win32')
    expect(formatAriaKeyshortcuts({ mod: true, key: 'k' })).toBe('Control+K')
    expect(formatAriaKeyshortcuts({ mod: true, shift: true, key: 'l' })).toBe('Control+Shift+L')
  })

  it('formatAriaKeyshortcuts leaves named keys un-uppercased', () => {
    setPlatform('MacIntel')
    // Named keys like Escape / Enter are canonicalised by the user agent, so
    // we must not mangle them into ESCAPE or ENTER.
    expect(formatAriaKeyshortcuts({ key: 'Escape' })).toBe('Escape')
    expect(formatAriaKeyshortcuts({ key: 'Enter' })).toBe('Enter')
  })

  it('prefers userAgentData.platform when available', () => {
    // Simulate Chromium exposing userAgentData with macOS while the
    // deprecated navigator.platform reports the legacy value.
    Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true })
    Object.defineProperty(navigator, 'userAgentData', {
      value: { platform: 'macOS' },
      configurable: true,
    })
    expect(isMacPlatform()).toBe(true)
  })
})
