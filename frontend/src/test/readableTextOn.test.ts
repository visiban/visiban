import { describe, it, expect } from 'vitest'
import { PRIORITY_COLORS, readableTextOn } from '../constants/colors'

function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('readableTextOn (#2466)', () => {
  it('clears 4.5:1 on every priority color', () => {
    for (const bg of Object.values(PRIORITY_COLORS)) {
      expect(ratio(bg, readableTextOn(bg))).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('picks dark text on orange and white on dark red', () => {
    expect(readableTextOn('#F97316')).not.toBe('#FFFFFF')
    expect(readableTextOn('#B91C1C')).toBe('#FFFFFF')
  })
  it('falls back to white for a non-hex value', () => {
    expect(readableTextOn('rgb(0,0,0)')).toBe('#FFFFFF')
  })
})
