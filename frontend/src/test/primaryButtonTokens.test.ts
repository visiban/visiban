/// <reference types="node" />
/**
 * #484: a primary button darkens on hover in both themes, and white text keeps WCAG AA
 * (>= 4.5:1) at rest and on hover. Light mode used blue-900 at rest and blue-800 on hover,
 * so light-mode primary buttons lightened on hover. Read from disk: Vitest stubs CSS imports.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from '../utils/colorContrast'

const css = readFileSync('src/index.css', 'utf8')
const blocks = {
  dark: css.slice(css.indexOf(':root,'), css.indexOf('[data-theme="light"] {')),
  light: css.slice(css.indexOf('[data-theme="light"] {')),
}

function token(block: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+);`).exec(block)
  if (!m) throw new Error(`--${name} not declared`)
  return '#' + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase()
}

describe.each(Object.entries(blocks))('primary button tokens (%s theme)', (_theme, block) => {
  const rest = token(block, 'button-primary')
  const hover = token(block, 'button-primary-hover')

  it('hover is darker than rest', () => {
    // Darker = more contrast against white.
    expect(contrastRatio(hover, '#FFFFFF')).toBeGreaterThan(contrastRatio(rest, '#FFFFFF'))
  })

  it('white text clears 4.5:1 at rest and on hover', () => {
    expect(contrastRatio(rest, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(hover, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
  })
})

it('light-mode primary keeps blue-900 at rest (#855) and darkens to blue-950 on hover (#484)', () => {
  expect(token(blocks.light, 'button-primary')).toBe('#1E3A8A')
  expect(token(blocks.light, 'button-primary-hover')).toBe('#172554')
})
