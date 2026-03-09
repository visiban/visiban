/** Shared color palettes used across board modals and card components. */

/** Default palette for columns and swimlane editing (6 colors). */
export const COLUMN_COLORS = [
  "#6B7280", "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6",
];

/** Extended palette for swimlane creation and labels (8 colors). */
export const PALETTE_COLORS = [
  "#6B7280", "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#14B8A6",
];

/** Priority colors keyed by priority level. */
export const PRIORITY_COLORS: Record<string, string> = {
  low:    "#6B7280",
  medium: "#3B82F6",
  high:   "#F59E0B",
  urgent: "#EF4444",
};
