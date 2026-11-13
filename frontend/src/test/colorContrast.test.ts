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
