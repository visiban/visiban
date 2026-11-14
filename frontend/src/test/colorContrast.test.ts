/** Legible chips for any hex color (#2094). */
import { describe, it, expect } from "vitest";
import {
  MIN_CHIP_CONTRAST,
  MIN_TEXT_CONTRAST,
  TEXT_SURFACES,
  readableTextColor,
  textColorStyle,
  chipColors,
  colorChipStyle,
  contrastRatio,
  cssColorToHex,
  normalizeHex,
  DIMMED_CHIP_SURFACES,
  type DimmedChipSurface,
} from "../utils/colorContrast";

const SAMPLES = ["#FFFFFF", "#000000", "#FEFEFE", "#010101", "#FFFF00", "#00FFFF", "#0000FF", "#FF0000", "#808080", "#3B82F6", "#F59E0B", "#7F7F7F"];

describe("contrastRatio known answers (#2094)", () => {
  it("matches independently known WCAG values", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#336699", "#336699")).toBeCloseTo(1, 5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });
});

describe("chipColors (#2094)", () => {
  it.each(SAMPLES)("%s reaches 6:1 as a chip in both themes", (hex) => {
    const c = chipColors(hex);
    expect(contrastRatio(c.light.fg, c.light.bg)).toBeGreaterThanOrEqual(MIN_CHIP_CONTRAST);
    expect(contrastRatio(c.dark.fg, c.dark.bg)).toBeGreaterThanOrEqual(MIN_CHIP_CONTRAST);
  });

  it("holds 6:1 across a sampled sweep of the RGB cube", () => {
    const steps = [0, 51, 102, 153, 204, 255];
    for (const r of steps) for (const g of steps) for (const b of steps) {
      const hex = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
      const c = chipColors(hex);
      expect(contrastRatio(c.light.fg, c.light.bg), hex).toBeGreaterThanOrEqual(MIN_CHIP_CONTRAST);
      expect(contrastRatio(c.dark.fg, c.dark.bg), hex).toBeGreaterThanOrEqual(MIN_CHIP_CONTRAST);
    }
  });

  it("is case-insensitive, expands #RGB and memoizes", () => {
    expect(normalizeHex("#abc")).toBe("#AABBCC");
    expect(chipColors("#3b82f6")).toBe(chipColors("#3B82F6"));
  });

  it.each(["", "red", "rgb(1,2,3)", "#12", "#GGGGGG", "3B82F6", null, undefined, 42])("legacy value %j does not throw and gets neutral tokens", (v) => {
    expect(() => chipColors(v)).not.toThrow();
    expect(chipColors(v)).toBe(chipColors("not-a-color"));
    expect(contrastRatio(chipColors(v).light.fg, chipColors(v).light.bg)).toBeGreaterThanOrEqual(MIN_CHIP_CONTRAST);
  });

  it("emits the six --cf-* custom properties", () => {
    const style = colorChipStyle("#FFFFFF") as Record<string, string>;
    expect(Object.keys(style).sort()).toEqual([
      "--cf-bg-dark", "--cf-bg-light", "--cf-border-dark", "--cf-border-light", "--cf-fg-dark", "--cf-fg-light",
    ]);
  });
});

// #2102: a chip on a dimmed surface (aging stage body opacity, closed Lens card) is blended
// toward the backdrop after the fact. Model the rendered pair the same way and pin the floor
// per surface in both themes over the sampled cube, the samples and the legacy neutral pair.
describe("dimmed chips (#2102)", () => {
  const hexMix = (top: string, under: string, a: number) => {
    const ch = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
    const t = ch(top)
    const u = ch(under)
    return "#" + t.map((v, i) => Math.round(a * v + (1 - a) * u[i]).toString(16).padStart(2, "0")).join("")
  }
  const steps = [0, 51, 102, 153, 204, 255]
  const cube = steps.flatMap((r) => steps.flatMap((g) => steps.map((b) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join(""))))
  const colors = [...cube, ...SAMPLES, "not-a-color"]
  const rendered = (hex: string, dim: DimmedChipSurface, theme: "light" | "dark") => {
    const { opacity, [theme]: backdrop } = DIMMED_CHIP_SURFACES[dim]
    const p = chipColors(hex, dim)[theme]
    return contrastRatio(hexMix(p.fg, backdrop, opacity), hexMix(p.bg, backdrop, opacity))
  }
  // Worst rendered ratio per surface [light, dark]. 6:1 in light mode and on the dark warning
  // stage; on the other dark surfaces pure white is the most the fg can do (dark stale stages
  // 5.91-5.92). Every floor clears AA. The closed Lens card had a dim here (opacity 0.7, dark
  // floor 5.08) until #2238 replaced its whole-card opacity with a bg-sunken face.
  const FLOORS: Record<DimmedChipSurface, [number, number]> = {
    warning: [6, 6],
    stale: [6, 5.91],
    stale2x: [6, 5.91],
    stale3x: [6, 5.92],
  }
  it.each(Object.keys(FLOORS) as DimmedChipSurface[])("%s: every chip holds its pinned floor as rendered, in both themes", (dim) => {
    for (const [i, theme] of (["light", "dark"] as const).entries()) {
      const worst = Math.min(...colors.map((c) => rendered(c, dim, theme)))
      expect(worst, `${dim} ${theme}`).toBeGreaterThanOrEqual(4.5)
      expect(worst, `${dim} ${theme}`).toBeGreaterThanOrEqual(FLOORS[dim][i] - 0.01)
    }
  })

  // The #2102 defect this dim fixed: an undimmed chip under the closed Lens card's opacity-70
  // over bg-canvas fell below AA. #2238 removed that opacity, so the closed card no longer dims.
  it("an undimmed chip under the old closed-Lens opacity-70 over light canvas falls below AA", () => {
    const [opacity, light] = [0.7, "#F1F5F9"]
    const undimmed = Math.min(...cube.map((c) => {
      const p = chipColors(c).light
      return contrastRatio(hexMix(p.fg, light, opacity), hexMix(p.bg, light, opacity))
    }))
    expect(undimmed).toBeLessThan(4.5)
    expect(Object.keys(DIMMED_CHIP_SURFACES)).not.toContain("lens-closed")
  })

  it("keeps the hue: only the fg moves, further toward black/white, so the opaque pair still clears 6:1", () => {
    for (const c of cube) {
      for (const dim of Object.keys(FLOORS) as DimmedChipSurface[]) {
        const d = chipColors(c, dim)
        expect(d.light.bg).toBe(chipColors(c).light.bg)
        expect(d.dark.bg).toBe(chipColors(c).dark.bg)
        expect(contrastRatio(d.light.fg, d.light.bg)).toBeGreaterThanOrEqual(MIN_CHIP_CONTRAST)
        expect(contrastRatio(d.dark.fg, d.dark.bg)).toBeGreaterThanOrEqual(MIN_CHIP_CONTRAST)
      }
    }
  })

  it('"none", null and omitted are the opaque chip; a dim is memoized separately', () => {
    expect(chipColors("#3B82F6", "none")).toBe(chipColors("#3B82F6"))
    expect(chipColors("#3B82F6", null)).toBe(chipColors("#3B82F6"))
    expect(chipColors("#3B82F6", "stale")).toBe(chipColors("#3b82f6", "stale"))
    expect(colorChipStyle("#3B82F6", "stale3x")).toMatchObject({ "--cf-fg-light": chipColors("#3B82F6", "stale3x").light.fg })
  })
})

describe('readableTextColor (#2097)', () => {
  const surfacesOf = (theme: 'light' | 'dark') => TEXT_SURFACES[theme]

  it('clears 4.5:1 against both surfaces in both themes across the RGB cube', () => {
    const steps = [0, 51, 102, 153, 204, 255]
    const hex = (n: number) => n.toString(16).padStart(2, '0')
    for (const r of steps) for (const g of steps) for (const b of steps) {
      const input = `#${hex(r)}${hex(g)}${hex(b)}`
      for (const theme of ['light', 'dark'] as const) {
        const out = readableTextColor(input, theme)!
        for (const surface of surfacesOf(theme)) {
          expect(contrastRatio(out, surface), `${input} ${theme} on ${surface}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
        }
      }
    }
  })

  it('leaves an already legible color unchanged and darkens near-white on light', () => {
    expect(readableTextColor('#f87171', 'dark')).toBe('#F87171')
    expect(readableTextColor('#f1f5f9', 'light')).not.toBe('#F1F5F9')
  })

  it('expands #RGB and returns null for non-hex input', () => {
    expect(readableTextColor('#fff', 'dark')).toBe('#FFFFFF')
    expect(readableTextColor('red', 'light')).toBeNull()
    expect(textColorStyle('red')).toBeNull()
  })
})

describe('cssColorToHex (#2097)', () => {
  it('reads hex and the rgb() form a browser serializes', () => {
    expect(cssColorToHex('#abc')).toBe('#AABBCC')
    expect(cssColorToHex('rgb(18, 52, 86)')).toBe('#123456')
    expect(cssColorToHex('rgb(18,52,86)')).toBe('#123456')
  })
  it('rejects out-of-range channels, alpha forms and non-strings', () => {
    expect(cssColorToHex('rgb(256, 0, 0)')).toBeNull()
    expect(cssColorToHex('rgba(1, 2, 3, 1)')).toBeNull()
    expect(cssColorToHex(undefined)).toBeNull()
  })
})
