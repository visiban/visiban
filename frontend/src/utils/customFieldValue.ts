/**
 * Shared logic for rendering and validating custom field values (#371).
 *
 * `CustomFieldValueDisplay` and `CustomFieldValueInput` both call into this
 * module rather than duplicating per-type logic, so the defensive-rendering
 * contract (a stale dropdown choice, a value that no longer parses for its
 * field's current type, a missing value) lives in exactly one place.
 */
import type { CustomFieldDefinition } from "../types";
import { PALETTE_COLORS } from "../constants/colors";
import { formatDateStr } from "./date";

/**
 * Deterministic string → palette color, same hashing technique as
 * `Avatar.tsx`'s `hashUsername`, applied to a dropdown choice string instead
 * of a username. `CustomFieldDefinition.choices` carries no stored color
 * (see the model — a per-choice color field would be a backend change, out
 * of scope for this frontend-only phase), so the color must be derivable
 * from the string alone and stay stable across renders without one.
 */
export function choiceColor(choice: string): string {
  let hash = 0;
  for (let i = 0; i < choice.length; i++) {
    hash = (hash * 31 + choice.charCodeAt(i)) >>> 0;
  }
  return PALETTE_COLORS[hash % PALETTE_COLORS.length];
}

/**
 * Does `value` parse cleanly for `definition.field_type`? Used to gate the
 * defensive-rendering contract's item (b): a stored value that no longer
 * matches its field's current type (e.g. after a type change — see #1121,
 * which is the backend gap this frontend guard exists to survive).
 *
 * Dropdown is intentionally not validated against `choices` here — an
 * orphaned choice (no longer in the current choice set, which the server
 * allows by design) is a display concern handled directly in
 * `CustomFieldValueDisplay`/`CustomFieldValueInput`, not an invalid-value
 * concern; the stored string is always "valid enough" to display as text.
 */
export function isValidForType(definition: CustomFieldDefinition, value: string): boolean {
  if (value === "") return true; // empty is always valid — it means "no value", never "invalid value"
  switch (definition.field_type) {
    case "number":
      return Number.isFinite(Number(value)) && value.trim() !== "";
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
    case "checkbox":
      return value === "true" || value === "false";
    case "text":
    case "dropdown":
    default:
      return true;
  }
}

/**
 * Format `value` for read-only display, per type. Assumes `isValidForType`
 * already passed — callers must check validity separately and fall back to
 * the raw string for an invalid value (see the defensive-rendering contract,
 * ux-design spec §5b — display always shows *something*, never NaN/Invalid
 * Date/a broken boolean).
 */
export function formatCustomFieldValue(
  definition: CustomFieldDefinition,
  value: string,
  userDateFormat: string
): string {
  switch (definition.field_type) {
    case "date":
      return formatDateStr(value, userDateFormat);
    case "checkbox":
      return value === "true" ? "Yes" : "No";
    case "number":
    case "text":
    case "dropdown":
    default:
      return value;
  }
}

/**
 * Rebuild a card's full `custom_field_values` array with one field's value
 * set (or cleared). Every write goes through this — `CardPatch` sends the
 * whole array, not a delta (matches every other list field on `CardPatch`),
 * so every call site needs the same "replace this entry, or insert it, or
 * drop it" logic rather than reimplementing the merge inline.
 *
 * Clearing a field always sends `value: ""` for its entry rather than
 * removing the entry outright — this matches the existing JSDoc contract on
 * `CustomFieldValue` (no entry = no value; sending `""` clears one) and
 * keeps the write path indifferent to whether the card previously had a
 * populated or already-empty value for this field.
 */
export function withCustomFieldValue(
  current: { field_definition: number; value: string }[],
  fieldDefinitionId: number,
  value: string
): { field_definition: number; value: string }[] {
  const idx = current.findIndex((v) => v.field_definition === fieldDefinitionId);
  if (idx === -1) {
    return [...current, { field_definition: fieldDefinitionId, value }];
  }
  const next = current.slice();
  next[idx] = { field_definition: fieldDefinitionId, value };
  return next;
}
