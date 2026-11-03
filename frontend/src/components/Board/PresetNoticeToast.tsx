import { useEffect, useState } from "react";

/** How long the notice stays when nobody is hovering or focusing it. */
export const PRESET_NOTICE_MS = 8000;

interface Props {
  /** Changes on every apply, which restarts the timer and the announcement. */
  noticeId: number;
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
  /**
   * Moves focus back to the control that applied the preset after Undo or ×,
   * whose buttons unmount with the notice (focus would otherwise drop to <body>).
   */
  onReturnFocus?: () => void;
}

/**
 * Info notice after a board preset is applied or reset (#1146): "Reset to
 * “Default”" with Undo. Informational tone (`bg-primary/15`, `ℹ`) like
 * `ImportSkippedToast`, because nothing went wrong. Auto-dismisses after 8s and
 * the timer pauses while the notice is hovered or holds focus, so a keyboard user
 * tabbing to Undo is never raced by it.
 *
 * Keyboard users are not left racing the timer to reach Undo: the picker offers the
 * same Undo as a menu action while the notice is up (`BoardView`), and Undo or ×
 * here returns focus to the picker trigger.
 *
 * The announcement is a separate sr-only `role="status"` that mounts empty and gets
 * its text one tick later; a live region that mounts already holding text is not
 * reliably announced.
 */
export default function PresetNoticeToast({ noticeId, message, onUndo, onDismiss, onReturnFocus }: Props) {
  const [announced, setAnnounced] = useState("");
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  useEffect(() => {
    setAnnounced("");
    const tick = setTimeout(() => setAnnounced(message), 0);
    return () => clearTimeout(tick);
  }, [noticeId, message]);

  useEffect(() => {
    if (paused) return;
    // Restarts the full delay after a pause, rather than resuming mid-way.
    const timer = setTimeout(onDismiss, PRESET_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [noticeId, paused, onDismiss]);

  return (
    <div
      data-testid="preset-notice"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 w-max max-w-[min(24rem,calc(100%-2rem))] bg-surface rounded-lg shadow-xl overflow-hidden"
    >
      <div role="status" aria-live="polite" className="sr-only">
        {announced}
      </div>
      <div className="flex items-center gap-3 bg-primary/15 border border-primary-emphasis/40 rounded-lg px-4 py-3 text-fg text-sm">
        <span className="text-info shrink-0" aria-hidden="true">ℹ</span>
        <p className="flex-1 min-w-0">{message}</p>
        <button
          type="button"
          onClick={() => {
            onUndo();
            onReturnFocus?.();
          }}
          className="text-info-on-tint hover:underline font-medium shrink-0 rounded px-1 -mx-1 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={() => {
            onDismiss();
            onReturnFocus?.();
          }}
          aria-label="Dismiss notification"
          className="text-fg-tertiary hover:text-fg transition text-lg leading-none shrink-0 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          ×
        </button>
      </div>
    </div>
  );
}
