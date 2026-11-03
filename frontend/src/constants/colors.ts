/** Shared color palettes used across board modals and card components. */

/** Default palette for columns and swimlane editing (6 colors). */
export const COLUMN_COLORS = [
  "#6B7280", "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6",
];

/** Extended palette for swimlane creation and labels (8 colors). */
export const PALETTE_COLORS = [
  "#6B7280", "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#14B8A6",
];

/** Priority colors keyed by priority level.
 *  Matches the card border and pill spec in frontend/CLAUDE.md:
 *  low=blue-500, medium=orange-500, high=red-500, urgent=red-700 (dark-red). */
export const PRIORITY_COLORS: Record<string, string> = {
  low:    "#3B82F6",
  medium: "#F97316",
  high:   "#EF4444",
  urgent: "#B91C1C",
};

/** Human-readable names for the swatch colors in COLUMN_COLORS / PALETTE_COLORS.
 *  Swatch pickers use these as the accessible name ("Select color Blue"); a raw hex
 *  tells a screen-reader user nothing. Keys are uppercase hex. */
export const COLOR_NAMES: Record<string, string> = {
  "#6B7280": "Gray",
  "#3B82F6": "Blue",
  "#10B981": "Green",
  "#F59E0B": "Amber",
  "#EF4444": "Red",
  "#8B5CF6": "Purple",
  "#EC4899": "Pink",
  "#14B8A6": "Teal",
};

/** Name for a swatch hex; falls back to "Custom color" for a value outside the palette. */
export function colorName(hex: string): string {
  return COLOR_NAMES[hex.toUpperCase()] ?? "Custom color";
}
