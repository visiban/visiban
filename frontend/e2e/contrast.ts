import type { Locator } from '@playwright/test'

/** WCAG relative luminance of an sRGB `rgb()`/`rgba()` string. */
function luminance([r, g, b]: number[]): number {
  const c = [r, g, b].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

export function parseRgb(css: string): number[] {
  const m = css.match(/rgba?\(([^)]+)\)/)
  if (m) return m[1].split(/[ ,/]+/).filter(Boolean).slice(0, 3).map(Number)
  // Chromium serializes color-mix / oklab results as `color(srgb r g b)`.
  const s = css.match(/color\(srgb ([^)]+)\)/)
  if (s) return s[1].split(/[ /]+/).slice(0, 3).map((v) => Math.round(Number(v) * 255))
  throw new Error(`unparseable color: ${css}`)
}

export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(parseRgb(a)), luminance(parseRgb(b))]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** First non-transparent background walking up from the element (the surface it sits on). */
export function surfaceColor(el: Locator): Promise<string> {
  return el.evaluate((node) => {
    let cur: Element | null = node
    while (cur) {
      const bg = getComputedStyle(cur).backgroundColor
      if (bg && !/rgba?\(.*,\s*0\)$|transparent/.test(bg)) return bg
      cur = cur.parentElement
    }
    return 'rgb(255, 255, 255)'
  })
}

export const textColor = (el: Locator) => el.evaluate((n) => getComputedStyle(n).color)
export const borderColor = (el: Locator) => el.evaluate((n) => getComputedStyle(n).borderTopColor)
export const fillColor = (el: Locator) => el.evaluate((n) => getComputedStyle(n).backgroundColor)
