/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'

// #1937: the card-sheet notch uses `primary-emphasis`; pin the >= 3:1 (WCAG 1.4.11) contrast that
// frontend/CLAUDE.md claims against the panel (surface) and the board (sunken, canvas) in both
// themes. Read from disk: Vitest stubs CSS imports.
const css = readFileSync('src/index.css', 'utf8')
const darkBlock = css.slice(css.indexOf(':root,'), css.indexOf('[data-theme="light"] {'))
const lightBlock = css.slice(css.indexOf('[data-theme="light"] {'))

const rgbOf = (block: string, name: string): number[] => {
  const line = block.split('\n').find((l) => l.trim().startsWith(`--${name}:`))
  if (!line) throw new Error(`--${name} missing`)
  return line.slice(line.indexOf(':') + 1).split(';')[0].trim().split(/\s+/).map(Number)
}
const lum = (c: number[]) => {
  const [r, g, b] = c.map((v) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('card-sheet notch contrast (#1937)', () => {
  // The light block does not redeclare --primary-emphasis (brand blue is identical in both themes),
  // so fall back to the :root value.
  const emphasis = (block: string) => {
    try { return rgbOf(block, 'primary-emphasis') } catch { return rgbOf(darkBlock, 'primary-emphasis') }
  }
  it.each([
    ['dark', darkBlock],
    ['light', lightBlock],
  ])('primary-emphasis holds >= 3:1 against surface, sunken and canvas in %s', (_theme, block) => {
    for (const surface of ['surface', 'surface-sunken', 'canvas']) {
      expect(ratio(emphasis(block), rgbOf(block, surface))).toBeGreaterThanOrEqual(3)
    }
  })
})

// #1946: the tail is an SVG painted with `fill-primary-emphasis`; there is no other `fill-<token>`
// in src, so prove Tailwind generates it (and the border utility) from the configured color.
describe('card-sheet tail utilities (#1946)', () => {
  it('generates fill-primary-emphasis and border-primary-emphasis', async () => {
    const result = await postcss([
      tailwindcss({
        config: 'tailwind.config.js',
        content: [{ raw: 'fill-primary-emphasis border-primary-emphasis', extension: 'html' }],
      }),
    ]).process('@tailwind utilities;', { from: undefined })
    expect(result.css).toMatch(/\.fill-primary-emphasis\s*\{[^}]*fill:\s*rgb\(var\(--primary-emphasis\)/)
    expect(result.css).toContain('.border-primary-emphasis')
    // Compiling Tailwind in-process takes ~1s idle but >10s on a loaded CI runner, past Vitest's 5s default.
  }, 30_000)
})
