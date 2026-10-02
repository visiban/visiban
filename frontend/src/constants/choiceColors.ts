/**
 * The closed palette a dropdown or multi-select choice may be colored from
 * (#1391). The server stores only the *key* (`choice_colors: {choice: key}`);
 * this file owns how each key renders, so a contrast fix never needs a data
 * migration.
 *
 * Mirrors `CHOICE_COLOR_KEYS` in `backend/boards/custom_field_types.py`
 * exactly, in order — `ChoiceColorKeyParityTests` (backend) parses the array
 * below and fails on drift, so keep it a single-line-per-array literal with
 * double-quoted keys.
 *
 * Each key has a `{light, dark}` pair for the tinted badge:
 *  - `base` is the matching `PALETTE_COLORS` value — the swatch / dot color.
 *  - light `bg` = base mixed 14% over white; dark `bg` = base mixed 22% over
 *    the dark card surface `#1E293B` (slate-800).
 *  - `fg` is the darker (light theme) / lighter (dark theme) Tailwind step
 *    of the same hue, chosen so every pair clears WCAG AA 4.5:1 with margin
 *    (all are at least 6.0:1; asserted in `choiceColors.test.ts`). A new key
 *    must record its ratio there and in frontend/CLAUDE.md.
 *
 * Hex lives only here. Components never inline these values: they read them
 * through `choiceBadgeStyle()` into the `cf-choice-badge` CSS class
 * (index.css), which picks the pair for the active `data-theme`.
 */
import type { CSSProperties } from "react";

export const CHOICE_COLOR_KEYS = ["slate", "blue", "green", "amber", "red", "violet", "pink", "teal"] as const;

export type ChoiceColorKey = (typeof CHOICE_COLOR_KEYS)[number];

export interface ChoiceColorPair {
  bg: string;
  fg: string;
}

export interface ChoiceColorSpec {
  /** Swatch and dot color — the `PALETTE_COLORS` entry for this hue. */
  base: string;
  light: ChoiceColorPair;
  dark: ChoiceColorPair;
}

export const CHOICE_COLORS: Record<ChoiceColorKey, ChoiceColorSpec> = {
  slate:  { base: "#6B7280", light: { bg: "#EAEBED", fg: "#334155" }, dark: { bg: "#2F394A", fg: "#CBD5E1" } },
  blue:   { base: "#3B82F6", light: { bg: "#E4EEFE", fg: "#1E40AF" }, dark: { bg: "#243D64", fg: "#93C5FD" } },
  green:  { base: "#10B981", light: { bg: "#DEF5ED", fg: "#065F46" }, dark: { bg: "#1B494A", fg: "#6EE7B7" } },
  amber:  { base: "#F59E0B", light: { bg: "#FEF1DD", fg: "#92400E" }, dark: { bg: "#4D4330", fg: "#FCD34D" } },
  red:    { base: "#EF4444", light: { bg: "#FDE5E5", fg: "#991B1B" }, dark: { bg: "#4C2F3D", fg: "#FCA5A5" } },
  violet: { base: "#8B5CF6", light: { bg: "#EFE8FE", fg: "#5B21B6" }, dark: { bg: "#363464", fg: "#C4B5FD" } },
  pink:   { base: "#EC4899", light: { bg: "#FCE5F1", fg: "#9D174D" }, dark: { bg: "#4B3050", fg: "#F9A8D4" } },
  teal:   { base: "#14B8A6", light: { bg: "#DEF5F3", fg: "#115E59" }, dark: { bg: "#1C4853", fg: "#5EEAD4" } },
};

/** Narrow an arbitrary string (e.g. a key added by a newer server) to a known key. */
export function isChoiceColorKey(key: unknown): key is ChoiceColorKey {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(CHOICE_COLORS, key);
}

/** "violet" → "Violet" — the swatch's accessible name. */
export function choiceColorName(key: ChoiceColorKey): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Inline custom properties for one `cf-choice-badge` element. The CSS class
 * (index.css) resolves `--cf-bg` / `--cf-fg` from these per theme, so no
 * component needs a `dark:` duplicate or to know the active theme.
 */
export function choiceBadgeStyle(key: ChoiceColorKey): CSSProperties {
  const spec = CHOICE_COLORS[key];
  return {
    "--cf-bg-light": spec.light.bg,
    "--cf-fg-light": spec.light.fg,
    "--cf-bg-dark": spec.dark.bg,
    "--cf-fg-dark": spec.dark.fg,
  } as CSSProperties;
}
