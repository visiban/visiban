import type { Swimlane, SwimlaneCustomFieldDefinition } from "../types";

export const DEFAULT_SWIMLANE_WIDTH = 220;
export const MAX_AUTO_SWIMLANE_WIDTH = 400;

// Rough glyph widths for the label panel's text-sm name and text-xs chips, plus
// the fixed chrome around them (color bar, expand chevron, chip border/padding).
const NAME_CHAR_PX = 7.5;
const NAME_CHROME_PX = 64;
const CHIP_CHAR_PX = 6.6;
const CHIP_CHROME_PX = 40;
// CustomFieldValueDisplay's row-chip truncates values at 20 characters.
const CHIP_VALUE_MAX_CHARS = 20;
const MAX_PINNED = 8; // mirrors SwimlaneCustomFieldDefinition.MAX_PINNED_PER_BOARD

/**
 * Initial width of the swimlane label column when the user has not resized it:
 * wide enough that the longest lane name and every pinned custom-field chip
 * (one per line) read without truncation, within the column's resize bounds.
 * An estimate from character counts, not a DOM measurement — it only picks the
 * starting width, and the user can drag the separator from there.
 */
export function computeAutoSwimlaneWidth(
  swimlanes: Pick<Swimlane, "name" | "custom_field_values">[],
  definitions: SwimlaneCustomFieldDefinition[] | undefined,
): number {
  const defsById = new Map((definitions ?? []).map((d) => [d.id, d]));
  let width = DEFAULT_SWIMLANE_WIDTH;
  for (const lane of swimlanes) {
    width = Math.max(width, lane.name.length * NAME_CHAR_PX + NAME_CHROME_PX);
    const pinned = (lane.custom_field_values ?? [])
      .filter((v) => v.value !== "")
      .map((v) => ({ def: defsById.get(v.field_definition), value: v.value }))
      .filter((x): x is { def: SwimlaneCustomFieldDefinition; value: string } => !!x.def && x.def.show_on_row)
      .sort((a, b) => a.def.position - b.def.position)
      .slice(0, MAX_PINNED);
    for (const { def, value } of pinned) {
      const chars = def.name.length + 2 + Math.min(value.length, CHIP_VALUE_MAX_CHARS);
      width = Math.max(width, chars * CHIP_CHAR_PX + CHIP_CHROME_PX);
    }
  }
  return Math.min(MAX_AUTO_SWIMLANE_WIDTH, Math.ceil(width));
}
