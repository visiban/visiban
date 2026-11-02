import { forwardRef } from "react";
import { HEALTH_STATUS_STYLES, healthLabel, type HealthDisplayValue } from "../../constants/healthStatus";
import { getHealthDisplay, healthTitle, type HealthFields } from "../../utils/healthStatus";
import HealthStatusShape from "./HealthStatusShape";

interface Props {
  value: HealthDisplayValue;
  /** Ancestor group the value is inherited from: dashed border and an sr-only suffix. */
  inheritedFrom?: string | null;
  /** Below `md` show the shape only; the word stays in the accessible name. */
  collapseLabel?: boolean;
  /** Makes the pill a button (the trigger of the health popover). */
  onClick?: () => void;
  /** Popover open state, for `aria-expanded` and the open ring. */
  expanded?: boolean;
  busy?: boolean;
  /** Demo mode: focusable, but clicks do nothing (see `onClick` guard at the caller). */
  ariaDisabled?: boolean;
  title?: string;
  className?: string;
}

const BASE = "inline-flex items-center gap-1.5 min-h-6 px-2 py-0.5 text-xs font-medium rounded-full border shrink-0 max-w-full";

/**
 * A board or group health pill (#1133): tint + shape + word, never color alone.
 *
 * A `<button>` when `onClick` is given (the admin trigger), else a `<span>`
 * (listing rows, which are themselves buttons, and non-admin headers). The
 * accessible content is real text, not an `aria-label`, so the visible word
 * is always inside the name: "Health status: At risk, inherited from Eng".
 */
const HealthStatusPill = forwardRef<HTMLButtonElement, Props>(function HealthStatusPill(
  { value, inheritedFrom, collapseLabel, onClick, expanded, busy, ariaDisabled, title, className = "" },
  ref,
) {
  const label = healthLabel(value);
  const classes = [
    BASE,
    HEALTH_STATUS_STYLES[value],
    inheritedFrom ? "border-dashed" : "",
    onClick ? "focus:outline-none focus:ring-2 focus:ring-primary-emphasis" : "",
    // Hover is a ring, never a stronger fill: the /20 tint's text contrast is pinned.
    onClick && !ariaDisabled ? "cursor-pointer hover:ring-1 hover:ring-line-strong" : "",
    onClick && expanded ? "ring-1 ring-primary-soft" : "",
    ariaDisabled ? "opacity-40 cursor-not-allowed" : "",
    className,
  ].filter(Boolean).join(" ");
  const content = (
    <>
      <span className="sr-only">Health status: </span>
      <HealthStatusShape value={value} />
      <span className={collapseLabel ? "sr-only md:not-sr-only truncate" : "truncate"}>{label}</span>
      {inheritedFrom && <span className="sr-only">, inherited from {inheritedFrom}</span>}
    </>
  );
  if (onClick) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        className={classes}
        title={title}
        // A demo trigger never opens, so it does not advertise a popup.
        aria-haspopup={ariaDisabled ? undefined : "dialog"}
        aria-expanded={ariaDisabled ? undefined : (expanded ?? false)}
        aria-disabled={ariaDisabled ? true : undefined}
        aria-busy={busy ? true : undefined}
        data-health-status={value}
      >
        {content}
      </button>
    );
  }
  return (
    <span className={classes} title={title} data-health-status={value}>
      {content}
    </span>
  );
});

export default HealthStatusPill;

/**
 * The read-only pill on a listing row (board rows, subgroup cards, the group
 * tree). Rendered only when a status applies, for everyone: "No status" is
 * never listed. The row itself is the button, so this is always a `<span>`.
 */
export function HealthListingPill({ fields, className }: {
  fields: HealthFields & { navigation_only?: boolean };
  className?: string;
}) {
  if (fields.navigation_only || !fields.effective_health_status) return null;
  const display = getHealthDisplay(fields);
  return (
    <HealthStatusPill
      value={display.value}
      inheritedFrom={display.inheritedFrom}
      title={healthTitle(display, "static")}
      className={className}
    />
  );
}
