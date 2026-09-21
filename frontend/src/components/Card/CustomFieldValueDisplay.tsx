import type { FieldDefinitionShape } from "../../types";
import { choiceColor, formatCustomFieldValue, isValidForType } from "../../utils/customFieldValue";
import AdminOnlyFieldGlyph from "../Common/AdminOnlyFieldGlyph";

interface Props {
  definition: FieldDefinitionShape;
  /** `undefined` = no value row for this field on this card or swimlane. */
  value: string | undefined;
  /**
   * `chip` — the bordered card-face pill (#371 Direction A). `detail` — plain
   * text inside the card-detail read-only section. `row-chip` — the swimlane
   * label-panel chip (#1140). Peek-popover text does *not* go through this
   * component — it's a single joined line of plain strings, formatted
   * directly via `formatCustomFieldValue` in `CardPeekPopover`, not JSX.
   */
  variant: "chip" | "detail" | "row-chip";
  /**
   * #1140 — draws the admin-only padlock on `row-chip`. Ignored by the other
   * variants. Only an admin is ever sent an admin-only value, so this marks
   * "your team cannot see this", not "you cannot see this".
   */
  adminOnly?: boolean;
  userDateFormat?: string;
  className?: string;
}

/**
 * Read-only renderer for one custom field value, shared by the card-face
 * chip and the card-detail read-only section — the defensive-rendering
 * contract (#371 ux-design spec §5) lives here once rather than being
 * reimplemented per call site:
 *
 *  (a) a dropdown value no longer in the field's current `choices` still
 *      renders as plain text, no crash, no special treatment.
 *  (b) a value that doesn't parse for the field's current type (e.g. after a
 *      retype — see #1121, the backend gap this guard exists to survive)
 *      renders as plain `text-fg-secondary` text, never NaN/Invalid
 *      Date/a raw "true"/"false" leaking through as a broken boolean.
 *  (c) `value === undefined` (no row at all) renders nothing — the caller
 *      decides what "nothing" means for its context (omit vs. a ghost
 *      placeholder chip); this component never invents a placeholder.
 */
export default function CustomFieldValueDisplay({ definition, value, variant, adminOnly, userDateFormat = "MM/DD/YYYY", className }: Props) {
  if (value === undefined) return null;

  const valid = isValidForType(definition, value);
  const displayText = valid ? formatCustomFieldValue(definition, value, userDateFormat) : value;

  if (variant === "detail") {
    return <span className={`text-sm text-fg-secondary ${className ?? ""}`}>{displayText || "—"}</span>;
  }

  // chip
  const dot = valid && definition.field_type === "dropdown" && value !== "" ? (
    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: choiceColor(value) }} aria-hidden="true" />
  ) : null;

  if (variant === "row-chip") {
    // Same neutral bordered chip as the card face — not a fourth pill
    // treatment. Two deviations the surface forces: the swimlane label panel
    // is a ~220px *vertical* column, so chips stack and each owns a full
    // line (max-w-full, not max-w-[10rem]) and can afford 20 characters
    // rather than 16.
    return (
      <span
        className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border border-line max-w-full min-w-0 ${className ?? ""}`}
        title={
          adminOnly
            ? `${definition.name}: ${displayText} · Only board admins can see this`
            : `${definition.name}: ${displayText}`
        }
      >
        {adminOnly && <AdminOnlyFieldGlyph />}
        {dot}
        <span className="text-fg-muted truncate">{definition.name}:</span>
        <span className="text-fg-secondary truncate">
          {displayText.length > 20 ? `${displayText.slice(0, 20)}…` : displayText}
        </span>
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border border-line shrink-0 max-w-[10rem] ${className ?? ""}`}
      title={`${definition.name}: ${displayText}`}
    >
      {dot}
      <span className="text-fg-muted truncate">{definition.name}:</span>
      <span className="text-fg-secondary truncate">
        {displayText.length > 16 ? `${displayText.slice(0, 16)}…` : displayText}
      </span>
    </span>
  );
}
