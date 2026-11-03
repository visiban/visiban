/** Pins the applied CSS the contrast proof relies on (#2094). */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MIN_CHIP_CONTRAST, chipColors, contrastRatio } from '../utils/colorContrast'

const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8')

function block(selector: string): string {
  const i = css.indexOf(selector + ' {')
  expect(i, selector).toBeGreaterThan(-1)
  return css.slice(i, css.indexOf('}', i))
}

describe('index.css .cf-choice-badge rule shape (#2094)', () => {
  it('defaults to the dark pair and applies bg, fg and border from --cf-*', () => {
    const b = block('.cf-choice-badge')
    expect(b).toContain('--cf-bg: var(--cf-bg-dark)')
    expect(b).toContain('--cf-fg: var(--cf-fg-dark)')
    expect(b).toContain('--cf-border: var(--cf-border-dark, transparent)')
    expect(b).toContain('background-color: var(--cf-bg)')
    expect(b).toContain('color: var(--cf-fg)')
    expect(b).toContain('border-color: var(--cf-border)')
  })

  it('switches to the light pair under [data-theme="light"], with the transparent border fallback', () => {
    const b = block('[data-theme="light"] .cf-choice-badge')
    expect(b).toContain('--cf-bg: var(--cf-bg-light)')
    expect(b).toContain('--cf-fg: var(--cf-fg-light)')
    expect(b).toContain('--cf-border: var(--cf-border-light, transparent)')
  })

  it('.color-dot is a constant box-shadow ring', () => {
    expect(block('.color-dot')).toMatch(/box-shadow: 0 0 0 1px rgb\(128 128 128/)
  })

  it('the neutral legacy pair clears 6:1 in dark as well as light', () => {
    const n = chipColors('not-a-color')
    expect(contrastRatio(n.dark.fg, n.dark.bg)).toBeGreaterThanOrEqual(MIN_CHIP_CONTRAST)
    expect(contrastRatio(n.light.fg, n.light.bg)).toBeGreaterThanOrEqual(MIN_CHIP_CONTRAST)
  })
})
