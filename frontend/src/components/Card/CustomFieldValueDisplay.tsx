import type { CustomFieldDefinition } from "../../types";
import { choiceColor, formatCustomFieldValue, isValidForType } from "../../utils/customFieldValue";

interface Props {
  definition: CustomFieldDefinition;
  /** `undefined` = no `CustomFieldValue` row for this field on this card. */
  value: string | undefined;
  /**
   * `chip` — the bordered card-face pill (#371 Direction A). `detail` — plain
   * text inside the card-detail read-only section. Peek-popover text does
   * *not* go through this component — it's a single joined line of plain
   * strings, formatted directly via `formatCustomFieldValue` in
   * `CardPeekPopover`, not JSX.
   */
  variant: "chip" | "detail";
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
export default function CustomFieldValueDisplay({ definition, value, variant, userDateFormat = "MM/DD/YYYY", className }: Props) {
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
