import { useEffect, useState } from "react";
import type { ImportSummary } from "../../types";
import {
  formatImportSkipped,
  IMPORT_SKIPPED_TOAST_MS,
  IMPORT_WARNINGS_HEADLINE,
  countImportWarnings,
  importWarnings,
} from "../../utils/importSummary";

interface Props {
  summary: ImportSummary;
  onDismiss: () => void;
}

/**
 * Informational notice shown on the new board after an import left something
 * out (#119) or dropped values (CSV `import_summary.warnings`, #1526).
 * Informational tone, never amber: the import succeeded and there is nothing
 * for the user to act on, even when it reports dropped values. Renders nothing
 * when there is nothing to report.
 *
 * A notice that lists warnings persists until dismissed; the skipped-counts-only
 * notice auto-dismisses and its timer pauses while hovered or focused.
 *
 * Announcement lives in a separate sr-only `role="status"` that mounts empty
 * and receives its text one tick later (a live region that mounts already
 * holding text is not reliably announced). It carries the headline and a count,
 * never the list; the list stays a focusable, labelled region in the visible
 * notice so it is reachable by keyboard.
 */
export default function ImportSkippedToast({ summary, onDismiss }: Props) {
  const warnings = importWarnings(summary);
  const skippedMessage = formatImportSkipped(summary);
  const message = skippedMessage ?? (warnings.length > 0 ? IMPORT_WARNINGS_HEADLINE : null);
  const warningCount = countImportWarnings(warnings);
  const announcement = message
    ? warnings.length > 0
      ? `${skippedMessage ? `${skippedMessage} ` : "Board imported. "}${warningCount} ${warningCount === 1 ? "value was" : "values were"} not imported.`
      : message
    : null;
  const [shown, setShown] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  useEffect(() => {
    if (!message) return;
    const tick = setTimeout(() => setShown(true), 0);
    return () => clearTimeout(tick);
  }, [message]);

  useEffect(() => {
    // A notice carrying warnings is never timed out: the user needs time to read it.
    if (!message || paused || warnings.length > 0) return;
    // Restarts the full delay after a pause, rather than resuming mid-way.
    const timer = setTimeout(onDismiss, IMPORT_SKIPPED_TOAST_MS);
    return () => clearTimeout(timer);
  }, [message, paused, onDismiss, warnings.length]);

  if (!message) return null;
  return (
    <div
      data-testid="import-notice"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 w-max max-w-[min(24rem,calc(100%-2rem))] bg-surface rounded-lg shadow-xl overflow-hidden"
    >
      <div role="status" aria-live="polite" className="sr-only">
        {shown ? announcement : ""}
      </div>
      {shown && (
        <div className="flex items-start gap-3 bg-primary/15 border border-primary-emphasis/40 rounded-lg px-4 py-3 text-fg text-sm">
          <span className="text-info shrink-0 mt-px" aria-hidden="true">ℹ</span>
          <div className="flex-1 min-w-0">
            <p>{message}</p>
            {warnings.length > 0 && (
              <ul
                tabIndex={0}
                aria-label="Import warnings"
                className="mt-2 list-disc pl-4 space-y-1 text-xs text-fg-secondary max-h-40 overflow-y-auto rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
              >
                {warnings.map((w, i) => (
                  <li key={i} className="break-words">{w}</li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss notification"
            className="text-fg-tertiary hover:text-fg transition text-lg leading-none shrink-0 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
