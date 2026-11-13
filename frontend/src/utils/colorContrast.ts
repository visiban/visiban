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

function pairFor(base: string, surface: string, alpha: number, extreme: string): ChipPair {
  const bg = mix(base, surface, alpha);
  let fg = base;
  // 2% steps toward the extreme; t = 1 is pure black/white, which always clears 6:1.
  for (let t = 0; t <= 1.0001 && contrastRatio(fg, bg) < MIN_CHIP_CONTRAST; t += 0.02) {
    fg = mix(extreme, base, Math.min(t, 1));
  }
  // Border blends the legible fg over the bg (not the raw color), so a near-white
  // chip on a white surface still has an edge.
  return { bg, fg, border: mix(fg, bg, 0.4) };
}

const cache = new Map<string, ChipColors>();

/** Memoized per normalized hex. Non-hex input returns the neutral pair. */
export function chipColors(color: unknown): ChipColors {
  const hex = normalizeHex(color);
  if (!hex) return NEUTRAL;
  let hit = cache.get(hex);
  if (!hit) {
    hit = {
      light: pairFor(hex, LIGHT_SURFACE, 0.14, "#000000"),
      dark: pairFor(hex, DARK_SURFACE, 0.22, "#FFFFFF"),
    };
    cache.set(hex, hit);
  }
  return hit;
}

/** Inline `--cf-*` custom properties for one `cf-choice-badge` element. */
export function colorChipStyle(color: unknown): CSSProperties {
  const c = chipColors(color);
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
