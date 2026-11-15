import { forwardRef, useId } from "react";
import { HEALTH_STATUS_STYLES, healthLabel, type HealthDisplayValue } from "../../constants/healthStatus";
import { getHealthDisplay, healthReviewCue, healthTitle, type HealthReviewFields } from "../../utils/healthStatus";
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
  /**
   * `"lane"` (#2243): tighter padding for the swimlane label panel. Same
   * hue, shape and word as a board pill; a lane value is never inherited, so
   * the caller never passes `inheritedFrom` and the border is never dashed.
   */
  scope?: "header" | "lane";
  /** Shape only at every width (the collapsed lane row); the word stays in the accessible name. */
  shapeOnly?: boolean;
  /** Screen-reader text before the word. Default `Health status: `. */
  srPrefix?: string;
  /**
   * #2245: on an auto-health board, a 12px glyph after the word says where the
   * value comes from: a pin for a status set by hand, a sparkle for a computed
   * one. Never the only signal: `srSuffix` carries the meaning.
   */
  origin?: "manual" | "computed" | null;
  /** Screen-reader text after the word, e.g. ", set by hand" (#2245). */
  srSuffix?: string;
  /**
   * #2245: a longer description (computed time, counts) for the button's
   * `aria-describedby`, so it is not carried by `title` alone.
   */
  description?: string;
}

/** 12px pin: a status set by hand on an auto-health board (#2245). */
export function PinGlyph() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0 text-fg-tertiary" data-health-origin-glyph="manual">
      <path d="M4.5 1.5h3l-.5 3 2 2H3l2-2-.5-3zM6 6.5V11" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 12px sparkle: a status calculated automatically (#2245). */
export function AutoGlyph() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0 text-fg-tertiary" data-health-origin-glyph="computed">
      <path d="M6 1.5l1.1 2.9L10 5.5 7.1 6.6 6 9.5 4.9 6.6 2 5.5l2.9-1.1z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}

const BASE = "inline-flex items-center min-h-6 py-0.5 text-xs font-medium rounded-full border shrink-0 max-w-full";
const SCOPE_SPACING = { header: "gap-1.5 px-2", lane: "gap-1 px-1.5" } as const;

/**
 * A board or group health pill (#1133): tint + shape + word, never color alone.
 *
 * A `<button>` when `onClick` is given (the admin trigger), else a `<span>`
 * (listing rows, which are themselves buttons, and non-admin headers). The
 * accessible content is real text, not an `aria-label`, so the visible word
 * is always inside the name: "Health status: At risk, inherited from Eng".
 */
const HealthStatusPill = forwardRef<HTMLButtonElement, Props>(function HealthStatusPill(
  {
    value, inheritedFrom, collapseLabel, onClick, expanded, busy, ariaDisabled, title, className = "",
    scope = "header", shapeOnly = false, srPrefix = "Health status: ", origin = null, srSuffix = "", description,
  },
  ref,
) {
  const descriptionId = useId();
  const label = healthLabel(value);
  const classes = [
    BASE,
    SCOPE_SPACING[scope],
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
      <span className="sr-only">{srPrefix}</span>
      <HealthStatusShape value={value} />
      <span className={shapeOnly ? "sr-only" : collapseLabel ? "sr-only md:not-sr-only truncate" : "truncate"}>{label}</span>
      {inheritedFrom && <span className="sr-only">, inherited from {inheritedFrom}</span>}
      {origin === "manual" && !shapeOnly && <PinGlyph />}
      {origin === "computed" && !shapeOnly && <AutoGlyph />}
      {srSuffix && <span className="sr-only">{srSuffix}</span>}
    </>
  );
  if (onClick) {
    // The description sits outside the button (hidden, still referenced), so
    // it describes the trigger without becoming part of its name.
    return (
      <>
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
        aria-describedby={description ? descriptionId : undefined}
        data-health-status={value}
      >
        {content}
      </button>
      {description && <span id={descriptionId} hidden>{description}</span>}
      </>
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
export function HealthListingPill({ fields, className, compactCue = false }: {
  fields: HealthReviewFields & { navigation_only?: boolean };
  className?: string;
  /** Narrow rows (the group tree): the review cue shows "18d" with the full text sr-only. */
  compactCue?: boolean;
}) {
  if (fields.navigation_only || !fields.effective_health_status) return null;
  const display = getHealthDisplay(fields);
  const cue = healthReviewCue(fields);
  const pill = (
    <HealthStatusPill
      value={display.value}
      inheritedFrom={display.inheritedFrom}
      title={healthTitle(display, "static")}
      className={cue ? "" : className}
    />
  );
  if (!cue) return pill;
  return (
    <span className={`inline-flex items-center gap-1.5 min-w-0 max-w-full ${className ?? ""}`}>
      {pill}
      <HealthReviewCueBadge cue={cue} compact={compactCue} />
    </span>
  );
}

/** 12px clock, in currentColor: the review cue's icon (#2244). */
function ReviewClockIcon() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0">
      <circle cx="6" cy="6" r="4.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 3.5V6l1.75 1.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The "Not reviewed in 18 days" cue (#2244) beside a health pill: a clock and
 * the words, in `text-warning` on the solid surface (never color alone, no
 * fill). `compact`: `true` shows "18d" at every width (the narrow group tree),
 * `"below-md"` only below `md`, like a header pill's `collapseLabel`. The full
 * sentence is always in the accessible text, after a ", " so a row button's
 * name reads "…At risk, Not reviewed in 18 days". `actionable` adds the
 * "Confirm or change" hint to the tooltip, only where the viewer can act.
 * Build `cue` only with `healthReviewCue`.
 */
export function HealthReviewCueBadge({ cue, compact = false, actionable = false, className = "" }: {
  cue: { days: number; text: string };
  compact?: boolean | "below-md";
  actionable?: boolean;
  className?: string;
}) {
  const title = actionable ? `${cue.text}. Confirm or change the status to clear this.` : cue.text;
  const short = <span aria-hidden="true" className={compact === "below-md" ? "md:hidden" : undefined}>{cue.days}d</span>;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium text-warning shrink-0 ${className}`}
      title={title}
      data-health-review-cue=""
    >
      <ReviewClockIcon />
      <span className="sr-only">, </span>
      {compact === true ? (
        <>
          {short}
          <span className="sr-only">{cue.text}</span>
        </>
      ) : compact === "below-md" ? (
        <>
          {short}
          <span className="sr-only md:not-sr-only">{cue.text}</span>
        </>
      ) : (
        <span>{cue.text}</span>
      )}
    </span>
  );
}
