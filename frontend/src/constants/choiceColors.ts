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
 * Palette hex lives only here. Components never inline these values: they
 * read them through `choiceBadgeStyle()` into the `cf-choice-badge` CSS class
 * (index.css), which picks the pair for the active `data-theme`.
 *
 * Since #2096 a stored value may also be a custom `#RRGGBB` (the server stores
 * it upper-cased). Every reader goes through `resolveChoiceColor` (one
 * key-or-hex resolver), `choiceColorBase` and `choiceBadgeStyle`, which derive
 * a custom color's legible pair through the contrast helper (`colorChipStyle`,
 * #2094). Never index `CHOICE_COLORS` with a stored value: a hex is not a key.
 */
import type { CSSProperties } from "react";
import { colorChipStyle } from "../utils/colorContrast";

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

/** A custom choice color (#2096): canonical upper-case `#RRGGBB`. */
export type CustomChoiceColor = `#${string}`;

/** What a `choice_colors` value resolves to: a palette key or a custom hex. */
export type ChoiceColor = ChoiceColorKey | CustomChoiceColor;

const CHOICE_HEX_RE = /^#[0-9A-Fa-f]{6}$/;

/** True for a resolved custom (hex) color, false for a palette key. */
export function isCustomChoiceColor(color: ChoiceColor): color is CustomChoiceColor {
  return color.startsWith("#");
}

/**
 * The one key-or-hex resolver for a stored or drafted `choice_colors` value
 * (#2096). A known palette key is returned as is; a 6-digit hex is returned
 * upper-cased, matching what the server stores. Anything else (a key from a
 * newer server, `#RGB`, a CSS name, a non-string) is `null`, and the choice
 * renders as automatic, never as a guess and never by throwing.
 */
export function resolveChoiceColor(value: unknown): ChoiceColor | null {
  if (isChoiceColorKey(value)) return value;
  if (typeof value === "string" && CHOICE_HEX_RE.test(value)) return value.toUpperCase() as CustomChoiceColor;
  return null;
}

/** The swatch / dot color for a resolved choice color. */
export function choiceColorBase(color: ChoiceColor): string {
  return isCustomChoiceColor(color) ? color : CHOICE_COLORS[color].base;
}

/** The accessible name of a resolved color: "Violet", or "Custom color" for hex. */
export function choiceColorLabel(color: ChoiceColor): string {
  return isCustomChoiceColor(color) ? "Custom color" : choiceColorName(color);
}

/** "violet" → "Violet" — the swatch's accessible name. */
export function choiceColorName(key: ChoiceColorKey): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Inline custom properties for one `cf-choice-badge` element, for a palette
 * key or a custom hex. The CSS class
 * (index.css) resolves `--cf-bg` / `--cf-fg` from these per theme, so no
 * component needs a `dark:` duplicate or to know the active theme.
 */
export function choiceBadgeStyle(color: ChoiceColor): CSSProperties {
  // A custom hex has no recorded pair: the contrast helper derives one that
  // holds 6:1 in both themes, whatever the hex (near-white, near-black).
  if (isCustomChoiceColor(color)) return colorChipStyle(color);
  const spec = CHOICE_COLORS[color];
  return {
    "--cf-bg-light": spec.light.bg,
    "--cf-fg-light": spec.light.fg,
    "--cf-bg-dark": spec.dark.bg,
    "--cf-fg-dark": spec.dark.fg,
  } as CSSProperties;
}
