import { useId, useRef, useState } from "react";
import { HEALTH_STATUS_LABELS, HEALTH_STATUS_TEXT, type HealthStatus } from "../../constants/healthStatus";
import {
  healthComputedLabel, healthCountsLine, healthRecomputeErrorMessage, type HealthAutoInfo,
} from "../../utils/healthStatus";
import { formatDateTimeUser, formatRelativeTime, type UserDatePrefs } from "../../utils/date";
import HealthStatusShape from "./HealthStatusShape";

/**
 * "Computed 3h ago" with the exact time in `title`, or "Never computed"
 * (#2245). A value is never shown as current when the job has not run.
 */
export function HealthComputedTime({ computedAt, prefs, prefix = "Computed" }: {
  computedAt: string | null;
  prefs?: UserDatePrefs | null;
  prefix?: string;
}) {
  const rel = computedAt ? formatRelativeTime(computedAt) : "";
  if (!computedAt || !rel) return <>Never computed</>;
  return (
    <>
      {prefix}{" "}
      <time dateTime={computedAt} title={formatDateTimeUser(computedAt, prefs)}>{rel}</time>
    </>
  );
}

/**
 * The "Recompute now" button (#2245): board admins only (the caller decides),
 * disabled with a hint while auto health is off. Not optimistic: `onRecompute`
 * resolves once the server's `{board, swimlanes}` has been merged. Success is
 * announced in a polite live region; errors are inline alerts.
 */
export function HealthRecomputeButton({ onRecompute, autoEnabled, className = "" }: {
  onRecompute: () => Promise<void>;
  autoEnabled: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const busyRef = useRef(false);
  const hintId = `health-recompute-hint-${useId()}`;
  const disabled = !autoEnabled;

  const run = async () => {
    if (busyRef.current || disabled) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setAnnouncement("");
    try {
      await onRecompute();
      setAnnouncement("Health status recomputed.");
    } catch (err) {
      setError(healthRecomputeErrorMessage(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <button
        type="button"
        onClick={() => { void run(); }}
        disabled={disabled}
        aria-busy={busy ? true : undefined}
        aria-disabled={busy ? true : undefined}
        aria-describedby={disabled ? hintId : undefined}
        className="btn-secondary text-sm self-start"
      >
        {busy ? "Recomputing…" : "Recompute now"}
      </button>
      {disabled && <span id={hintId} className="text-xs text-fg-tertiary">Turn on automatic health status first.</span>}
      <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
      {error && <span role="alert" className="text-danger text-xs">{error}</span>}
    </div>
  );
}

/**
 * The auto health block at the top of the health popover (#2245): what the
 * rule calculated, the pin if one is set (with "Clear pin (use calculated)"),
 * when it was computed, the open-card counts, and, for board admins, the
 * Recompute now button.
 */
export default function HealthComputedBlock({
  auto, pinned, canEdit, onClearPin, onRecompute, datePrefs,
}: {
  auto: HealthAutoInfo;
  /** The pin (the entity's own `health_status`), null when not pinned. */
  pinned: HealthStatus | null;
  canEdit: boolean;
  /** Clears the pin; given only where the viewer can edit. */
  onClearPin?: () => void;
  /** Board admins on the board header only. */
  onRecompute?: () => Promise<void>;
  datePrefs?: UserDatePrefs | null;
}) {
  const counts = healthCountsLine(auto.counts);
  const computedShape = auto.computed ?? "none";
  return (
    <div className="mt-2 rounded border border-line px-2 py-1.5 text-xs flex flex-col gap-0.5" data-testid="health-computed-block">
      <p className="flex items-center gap-1 text-fg-secondary">
        <span>Calculated:{" "}</span>
        {auto.computed && <span className={HEALTH_STATUS_TEXT[computedShape]}><HealthStatusShape value={computedShape} /></span>}
        <span className={auto.computed ? "text-fg font-medium" : "text-fg-tertiary"}>{healthComputedLabel(auto)}</span>
      </p>
      {pinned && (
        <p className="text-fg-secondary">
          Set by hand: <span className="text-fg font-medium">{HEALTH_STATUS_LABELS[pinned]}</span>
          {canEdit && onClearPin && (
            <>
              {" "}
              <button
                type="button"
                onClick={onClearPin}
                className="text-primary-emphasis hover:underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
              >
                Clear pin (use calculated)
              </button>
            </>
          )}
        </p>
      )}
      <p className="text-fg-tertiary">
        <HealthComputedTime computedAt={auto.computedAt} prefs={datePrefs} />
        {!auto.computedAt && canEdit && onRecompute ? ". Run it with Recompute now." : ""}
      </p>
      {counts && <p className="text-fg-secondary">{counts}</p>}
      {canEdit && onRecompute && <HealthRecomputeButton onRecompute={onRecompute} autoEnabled className="mt-1" />}
    </div>
  );
}
