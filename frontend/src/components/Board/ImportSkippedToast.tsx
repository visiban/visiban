import { useEffect, useState } from "react";
import type { ImportSummary } from "../../types";
import {
  formatImportSkipped,
  IMPORT_SKIPPED_TOAST_MS,
  IMPORT_WARNINGS_HEADLINE,
  IMPORT_WARNINGS_TOAST_MS,
  importWarnings,
} from "../../utils/importSummary";

interface Props {
  summary: ImportSummary;
  onDismiss: () => void;
}

/**
 * Informational notice shown on the new board after a selective import left
 * something out (#119). Informational tone, never amber: skipping was the
 * user's choice, not a failure. Renders nothing when nothing was skipped.
 *
 * A CSV import can also return `warnings` (dropped custom-field values,
 * swimlane conflicts; #1526). They are listed under the message and keep the
 * notice open longer. With no warnings the notice is unchanged.
 *
 * The `role="status"` wrapper mounts empty and the text arrives one tick
 * later: a live region that mounts already holding its text is not reliably
 * announced. The auto-dismiss timer pauses while the notice is hovered or
 * holds focus, so it never disappears from under the reader.
 */
export default function ImportSkippedToast({ summary, onDismiss }: Props) {
  const warnings = importWarnings(summary);
  const skippedMessage = formatImportSkipped(summary);
  const message = skippedMessage ?? (warnings.length > 0 ? IMPORT_WARNINGS_HEADLINE : null);
  const dismissMs = warnings.length > 0 ? IMPORT_WARNINGS_TOAST_MS : IMPORT_SKIPPED_TOAST_MS;
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
    if (!message || paused) return;
    // Restarts the full delay after a pause, rather than resuming mid-way.
    const timer = setTimeout(onDismiss, dismissMs);
    return () => clearTimeout(timer);
  }, [message, paused, onDismiss, dismissMs]);

  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 w-max max-w-[min(24rem,calc(100%-2rem))] bg-surface rounded-lg shadow-xl overflow-hidden"
    >
      {shown && (
        <div className="flex items-start gap-3 bg-primary/15 border border-primary-emphasis/40 rounded-lg px-4 py-3 text-fg text-sm">
          <span className="text-info shrink-0 mt-px" aria-hidden="true">ℹ</span>
          <div className="flex-1 min-w-0">
            <p>{message}</p>
            {warnings.length > 0 && (
              <ul className="mt-2 list-disc pl-4 space-y-1 text-xs text-fg-secondary max-h-40 overflow-y-auto">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
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
