/**
 * Legible chips for any user-chosen color (#2094). A label, column or lane
 * may carry any `#RRGGBB`, including near-white and near-black, so the raw color
 * can never be the text color over its own tint. This derives a `{bg, fg,
 * border}` pair per theme: bg uses the `choiceColors.ts` recipe (base mixed 14%
 * over white / 22% over the dark card surface `#1E293B`), then fg walks from
 * the color toward black (light) or white (dark) until it reaches
 * `MIN_CHIP_CONTRAST` against that bg.
 *
 * Components never inline the result: `colorChipStyle()` hands it to the
 * `cf-choice-badge` class (index.css) as `--cf-*` custom properties, which
 * picks the pair for the active `data-theme`, so no re-render on theme switch.
 */
import type { CSSProperties } from "react";

export const MIN_CHIP_CONTRAST = 6;

export interface ChipPair {
  bg: string;
  fg: string;
  border: string;
}

export interface ChipColors {
  light: ChipPair;
  dark: ChipPair;
}

const LIGHT_SURFACE = "#FFFFFF";
const DARK_SURFACE = "#1E293B";
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const SHORT_HEX_RE = /^#[0-9a-fA-F]{3}$/;

/** Legacy / unparseable values (named colors, rgb(), empty) get the slate pair. */
const NEUTRAL: ChipColors = {
  light: { bg: "#EAEBED", fg: "#334155", border: "#C9CCD2" },
  dark: { bg: "#2F394A", fg: "#CBD5E1", border: "#4B5563" },
};

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(rgb: number[]): string {
  return "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0").toUpperCase()).join("");
}

/** `top` mixed `alpha` over `under`. */
function mix(top: string, under: string, alpha: number): string {
  const t = channels(top);
  const u = channels(under);
  return toHex(t.map((v, i) => alpha * v + (1 - alpha) * u[i]));
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#RRGGBB` values. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Expands `#RGB`; returns an uppercase `#RRGGBB`, or null for anything else. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (HEX_RE.test(v)) return v.toUpperCase();
  if (SHORT_HEX_RE.test(v)) return ("#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toUpperCase();
  return null;
}

const RGB_FN_RE = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;

/**
 * Like `normalizeHex`, but also reads the `rgb(r, g, b)` form a browser serializes a
 * `style="color: #123456"` to when Tiptap writes the description back out (#2097).
 * Returns an uppercase `#RRGGBB`, or null for anything else (channels over 255 included).
 */
export function cssColorToHex(value: unknown): string | null {
  const hex = normalizeHex(value);
  if (hex) return hex;
  if (typeof value !== "string") return null;
  const m = RGB_FN_RE.exec(value.trim());
  if (!m) return null;
  const channels = [m[1], m[2], m[3]].map(Number);
  return channels.every((c) => c <= 255) ? toHex(channels) : null;
}

/**
 * Surfaces that render a chip through an ancestor's `opacity` (#2102): the card
 * aging stages (`AGING_STAGE_CLASSES[stage].bodyOpacityClass` over the stage's
 * overlay on `bg-surface`) and the closed Lens issue card (`opacity-70` on the
 * card root over the lane's `bg-canvas`). Opacity blends the chip's fg and bg
 * toward the backdrop after the fact, so a pair that is 6:1 opaque can drop
 * below 4.5:1 on screen. `backdrop` is the color under the dimmed layer, per
 * theme. Values mirror index.css and agingTint.ts; `onTintTokens.test.ts`
 * recomputes them from those sources, so a token or stage change fails there.
 */
export const DIMMED_CHIP_SURFACES = {
  warning: { opacity: 0.9, light: "#FEF5E7", dark: "#343536" },
  stale: { opacity: 0.85, light: "#FCE6DB", dark: "#3F393B" },
  stale2x: { opacity: 0.85, light: "#FADEDE", dark: "#3F3443" },
  stale3x: { opacity: 0.85, light: "#E5D2D2", dark: "#482E3D" },
  "lens-closed": { opacity: 0.7, light: "#F1F5F9", dark: "#020617" },
} as const;

export type DimmedChipSurface = keyof typeof DIMMED_CHIP_SURFACES;

interface Dim {
  opacity: number;
  backdrop: string;
}

/** The pair as it renders: both colors blended toward the backdrop by the ancestor opacity. */
function renderedRatio(fg: string, bg: string, dim?: Dim): number {
  if (!dim) return contrastRatio(fg, bg);
  return contrastRatio(mix(fg, dim.backdrop, dim.opacity), mix(bg, dim.backdrop, dim.opacity));
}

function pairFor(base: string, surface: string, alpha: number, extreme: string, dim?: Dim): ChipPair {
  const bg = mix(base, surface, alpha);
  let fg = base;
  // 2% steps toward the extreme; t = 1 is pure black/white, which always clears 6:1
  // opaque. Under a dim the target is the rendered ratio; where pure black/white
  // cannot reach 6:1 there (dark closed Lens card), the loop ends at the extreme,
  // the most the chip can do, and the pinned floor in colorContrast.test.ts applies.
  for (let t = 0; t <= 1.0001 && renderedRatio(fg, bg, dim) < MIN_CHIP_CONTRAST; t += 0.02) {
    fg = mix(extreme, base, Math.min(t, 1));
  }
  // Border blends the legible fg over the bg (not the raw color), so a near-white
  // chip on a white surface still has an edge.
  return { bg, fg, border: mix(fg, bg, 0.4) };
}

function dimmedFg(pair: ChipPair, extreme: string, dim?: Dim): ChipPair {
  let fg = pair.fg;
  for (let t = 0; t <= 1.0001 && renderedRatio(fg, pair.bg, dim) < MIN_CHIP_CONTRAST; t += 0.02) {
    fg = mix(extreme, pair.fg, Math.min(t, 1));
  }
  return { bg: pair.bg, fg, border: pair.border };
}

const cache = new Map<string, ChipColors>();

/**
 * Memoized per normalized hex and dim. Non-hex input returns the neutral pair.
 * `dim` (#2102) names the dimmed surface the chip renders on; the fg is then
 * pushed further toward black/white so the pair holds 6:1 as rendered, not just
 * before the ancestor's opacity. The bg is unchanged, so a dimmed chip keeps
 * its hue. `"none"` / omitted is the opaque chip.
 */
export function chipColors(color: unknown, dim?: DimmedChipSurface | "none" | null): ChipColors {
  const hex = normalizeHex(color);
  const surface = dim && dim !== "none" ? DIMMED_CHIP_SURFACES[dim] : null;
  if (!hex && !surface) return NEUTRAL;
  const key = `${hex ?? "neutral"}|${surface ? dim : ""}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const lightDim = surface ? { opacity: surface.opacity, backdrop: surface.light } : undefined;
  const darkDim = surface ? { opacity: surface.opacity, backdrop: surface.dark } : undefined;
  const hit: ChipColors = hex
    ? { light: pairFor(hex, LIGHT_SURFACE, 0.14, "#000000", lightDim), dark: pairFor(hex, DARK_SURFACE, 0.22, "#FFFFFF", darkDim) }
    : // The legacy neutral pair under a dim gets the same treatment: its fg walks toward black/white.
      { light: dimmedFg(NEUTRAL.light, "#000000", lightDim), dark: dimmedFg(NEUTRAL.dark, "#FFFFFF", darkDim) };
  cache.set(key, hit);
  return hit;
}

/** Inline `--cf-*` custom properties for one `cf-choice-badge` element; `dim` as in `chipColors`. */
export function colorChipStyle(color: unknown, dim?: DimmedChipSurface | "none" | null): CSSProperties {
  const c = chipColors(color, dim);
  return {
    "--cf-bg-light": c.light.bg,
    "--cf-fg-light": c.light.fg,
    "--cf-border-light": c.light.border,
    "--cf-bg-dark": c.dark.bg,
    "--cf-fg-dark": c.dark.fg,
    "--cf-border-dark": c.dark.border,
  } as CSSProperties;
}

/**
 * Surfaces rich-text color spans render on (#2097): the description's view mode sits
 * on `--surface` and its editing view on `--surface-sunken`, so legibility is
 * measured against the worse of the two for each theme. Values mirror index.css.
 */
export const TEXT_SURFACES = {
  light: ["#FFFFFF", "#F8FAFC"],
  dark: ["#1E293B", "#0F172A"],
} as const;

/** WCAG AA for body text. */
export const MIN_TEXT_CONTRAST = 4.5;

/**
 * The stored hex mixed toward black (light theme) or white (dark theme) until it
 * reaches `MIN_TEXT_CONTRAST` against both surfaces for that theme. A color that
 * already clears it is returned unchanged (normalized); non-hex input returns null so
 * the caller can render the stored value untouched.
 */
export function readableTextColor(hex: string, theme: "light" | "dark"): string | null {
  const base = normalizeHex(hex);
  if (!base) return null;
  const extreme = theme === "light" ? "#000000" : "#FFFFFF";
  const worst = (c: string) => Math.min(...TEXT_SURFACES[theme].map((s) => contrastRatio(c, s)));
  let fg = base;
  // 2% steps toward the extreme; t = 1 is pure black/white, which always clears 4.5:1.
  for (let t = 0.02; t <= 1.0001 && worst(fg) < MIN_TEXT_CONTRAST; t += 0.02) {
    fg = mix(extreme, base, Math.min(t, 1));
  }
  return fg;
}

/** `--rt-fg-*` custom properties for one `.rt-color` span (index.css picks the theme). */
export function textColorStyle(hex: string): CSSProperties | null {
  const light = readableTextColor(hex, "light");
  const dark = readableTextColor(hex, "dark");
  if (!light || !dark) return null;
  return { "--rt-fg-light": light, "--rt-fg-dark": dark } as CSSProperties;
}
