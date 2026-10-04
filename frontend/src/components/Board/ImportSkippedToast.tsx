import { useEffect, useState } from "react";
import type { ImportSummary } from "../../types";
import { formatImportSkipped, IMPORT_SKIPPED_TOAST_MS } from "../../utils/importSummary";

interface Props {
  summary: ImportSummary;
  onDismiss: () => void;
}

/**
 * Informational notice shown on the new board after a selective import left
 * something out (#119). Informational tone, never amber: skipping was the
 * user's choice, not a failure. Renders nothing when nothing was skipped.
 *
 * The `role="status"` wrapper mounts empty and the text arrives one tick
 * later: a live region that mounts already holding its text is not reliably
 * announced. The auto-dismiss timer pauses while the notice is hovered or
 * holds focus, so it never disappears from under the reader.
 */
export default function ImportSkippedToast({ summary, onDismiss }: Props) {
  const message = formatImportSkipped(summary);
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
    const timer = setTimeout(onDismiss, IMPORT_SKIPPED_TOAST_MS);
    return () => clearTimeout(timer);
  }, [message, paused, onDismiss]);

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
          <p className="flex-1 min-w-0">{message}</p>
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
