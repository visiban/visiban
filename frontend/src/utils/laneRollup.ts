import type { Card, Column, CustomFieldDefinition } from "../types";
import { NUMBER_DECIMALS_MAX, formatNumberValue } from "./customFieldValue";

/**
 * Swimlane number rollup (#2275): the band's "$413k open". The board picks one
 * card number field (`Board.swimlane_rollup_field`); each lane sums it over its
 * open cards. Computed here from the /full/ cards rather than by the server, so
 * every card create, move, update and archive event that already keeps the
 * card list current also keeps the rollup current, with no new event type.
 */

/**
 * The definition to sum, or null for no rollup: the setting is unset, the
 * field was deleted (the server nulls the setting, but a WS race can arrive
 * first), or the field was retyped away from number (the server keeps the id
 * so undoing the retype restores the rollup; until then there is nothing to sum).
 */
export function resolveRollupField(
  fieldId: number | null | undefined,
  definitions: CustomFieldDefinition[] | undefined,
): CustomFieldDefinition | null {
  if (fieldId == null) return null;
  const def = (definitions ?? []).find((d) => d.id === fieldId);
  return def && def.field_type === "number" ? def : null;
}

export interface LaneRollup {
  /** The sum, rounded to the most decimal places any summed value had. */
  total: number;
  /** The sum formatted with the field's prefix, suffix and decimals. */
  text: string;
  /** How many cards contributed a value. */
  count: number;
  fieldName: string;
}

/** Digits after the decimal point in a plain number string ("12.50" -> 2). */
function fractionDigits(raw: string): number {
  if (/e/i.test(raw)) return NUMBER_DECIMALS_MAX;
  const dot = raw.indexOf(".");
  return dot === -1 ? 0 : raw.length - dot - 1;
}

/**
 * Sum `field` over the lane's open cards: cards in `laneId`, not archived, and
 * not in a column marked done. Blank, missing and non-numeric values are
 * skipped, so a card without a value adds nothing rather than hiding the total.
 *
 * Deliberately NOT the lane's `limit_column_ids` (#1150): those choose what
 * counts toward a limit, while "open" here means "not done" on every board, as
 * the spec's "$413k open" reads. Independent of the active filter, like the
 * lane's WIP count (`laneUsage`).
 *
 * Returns null when there is no field to sum.
 */
export function laneRollup(
  laneId: number,
  field: CustomFieldDefinition | null | undefined,
  columns: Column[],
  cards: Card[],
): LaneRollup | null {
  if (!field || field.field_type !== "number") return null;
  const doneColumnIds = new Set(columns.filter((c) => c.is_done).map((c) => c.id));
  let total = 0;
  let places = 0;
  let count = 0;
  for (const card of cards) {
    if (card.swimlane !== laneId || card.archived_at || doneColumnIds.has(card.column)) continue;
    const entry = (card.custom_field_values ?? []).find((v) => v.field_definition === field.id);
    const raw = entry?.value.trim() ?? "";
    if (raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    total += n;
    count += 1;
    places = Math.max(places, fractionDigits(raw));
  }
  // Binary floats drift (0.1 + 0.2); no input had more places than this.
  const rounded = Number(total.toFixed(Math.min(places, NUMBER_DECIMALS_MAX)));
  // `-0` would print as "0" anyway; normalize so equality checks are plain.
  const clean = Object.is(rounded, -0) ? 0 : rounded;
  return {
    total: clean,
    text: formatNumberValue(String(clean), {
      prefix: field.number_prefix,
      suffix: field.number_suffix,
      decimals: field.number_decimals,
    }),
    count,
    fieldName: field.name,
  };
}
