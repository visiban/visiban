import { useState } from "react";
import { BOTTLENECK_DOCS_URL } from "../../utils/intakeColumn";

/** Shared by the Edit callout and the Add take-over note so the two cannot drift. */
export function IntakeNoteIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
  <svg viewBox="0 0 16 16" className={`${className} shrink-0 text-fg-tertiary`} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1.5 8h7M6 5.5 8.5 8 6 10.5" />
    <rect x="9.5" y="3" width="5" height="10" rx="1" />
  </svg>
  );
}

/**
 * Neutral note on the board's intake column (#2298). The wording is exact: the
 * column still appears in every Analytics view; the only thing it is never
 * given is the bottleneck pick (backend `_bottleneck`, #2290). Never say
 * "excluded from analytics".
 */
export default function IntakeColumnCallout({ idPrefix }: { idPrefix: string }) {
  const [open, setOpen] = useState(false);
  const bodyId = `${idPrefix}-intake-more-body`;
  return (
    <div
      role="note"
      aria-label="Intake column"
      data-testid="intake-column-callout"
      className="mt-3 flex gap-3 rounded-lg border border-line bg-sunken px-3 py-3 text-sm text-fg-secondary"
    >
      <IntakeNoteIcon />
      <div className="flex flex-col gap-1.5 min-w-0">
        <p>
          <span className="font-medium text-fg">This is the board's intake column.</span> Analytics doesn't name it as the bottleneck.
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
          className="self-start inline-flex items-center min-h-6 text-xs text-info underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          {open ? "Less" : "More"}
        </button>
        {/* `hidden` sits on this wrapper, not the flex div: preflight's [hidden] is not !important, so a display utility on the same element would win. */}
        <div id={bodyId} hidden={!open}>
        <div className="flex flex-col gap-1.5 text-xs text-fg-secondary">
          <p>New work arrives here, so a growing queue is demand, not a hold-up. This column still appears in the cumulative flow, WIP, WIP aging, dwell, and cycle-time charts.</p>
          <p>The role follows position. If you move this column, or add a new not-done column to its left, the first not-done column becomes the intake column.</p>
          <a
            href={BOTTLENECK_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="self-start inline-flex items-center min-h-6 text-info underline rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            How bottleneck detection works<span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
        </div>
      </div>
    </div>
  );
}
