import { useDemoCountdown } from "../../hooks/useDemoCountdown";
import { formatClockTime } from "../../utils/date";

interface DemoModeBarProps {
  /** Next reset instant, ISO 8601 UTC, from the server (`User.demo_next_reset_at`). */
  nextResetAt: string;
}

/**
 * Persistent shell bar on the public hosted demo (#1179).
 *
 * Normal state uses the mode-indicator tone (`bg-primary/15`), NOT
 * MaintenanceBanner's amber: the visitor opted into the demo, so it is a mode
 * they chose, not an operator-imposed degraded state. From 5 minutes before the
 * reset it flips to the amber degraded-state tone with `⚠` and one fixed
 * sentence, because at that point it IS about to be imposed on them. See
 * "Hosted demo surfaces" in frontend/CLAUDE.md.
 *
 * Non-modal and never intercepts pointer events, so it cannot block a drag.
 * No exit control: demo mode has no in-app off switch.
 *
 * Screen readers get state TRANSITIONS only, through the sr-only live region:
 * making the visible bar itself live would re-announce the minute label on
 * every tick.
 */
/** "25 min" below an hour; "13 h 5 min" for a longer (e.g. nightly) cadence. */
function formatRemaining(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function DemoModeBar({ nextResetAt }: DemoModeBarProps) {
  const { minutesRemaining, isWarning } = useDemoCountdown(nextResetAt);
  const resetLabel = formatClockTime(nextResetAt);

  const announcement = isWarning
    ? "Demo resets in 5 minutes — you'll be signed out"
    : `Shared demo. Resets at ${resetLabel}. Your changes and session will be cleared.`;

  return (
    <>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
      {isWarning ? (
        <div
          data-testid="demo-mode-bar"
          data-state="warning"
          className="bg-warning/10 border-b border-warning/30 px-4 py-2 flex items-center gap-3 text-sm text-warning shrink-0"
        >
          <span aria-hidden="true" className="text-base leading-none shrink-0">⚠</span>
          <span className="font-medium shrink-0">Demo resets in 5 minutes — you'll be signed out</span>
        </div>
      ) : (
        <div
          data-testid="demo-mode-bar"
          data-state="normal"
          className="bg-primary/15 border-b border-primary-emphasis/40 px-4 py-2 flex items-center gap-3 text-sm text-info shrink-0"
        >
          <span className="font-medium shrink-0">Shared demo</span>
          <span aria-hidden="true" className="text-info/50">·</span>
          <span className="truncate min-w-0 flex-1">
            Resets at {resetLabel}
            {minutesRemaining !== null && <> (in {formatRemaining(minutesRemaining)})</>} · your changes and session will be cleared
          </span>
        </div>
      )}
    </>
  );
}

export default DemoModeBar;
