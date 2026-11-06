import { useEffect, useRef } from "react";
import { useToast } from "../../contexts/useToast";

/** How long the notice stays when nobody is hovering or focusing the region. */
export const PRESET_NOTICE_MS = 8000;
/**
 * A notice for a change the member did not start (a `?preset=` link) stays longer:
 * focus is on the page, not on a control, so the region's pause-on-focus never engages.
 */
export const PRESET_LINK_NOTICE_MS = 20000;
/** Said after the message, so a screen-reader user knows where Undo also lives. */
export const PRESET_NOTICE_UNDO_HINT = "Undo is also in the Preset menu.";
export const PRESET_TOAST_KEY = "preset-notice";

interface Notice {
  /** Changes on every apply, which restarts the timer. */
  id: number;
  message: string;
  reason?: string;
}

interface Options {
  notice: Notice | null;
  onUndo: () => void;
  onDismiss: () => void;
  /**
   * Moves focus back to the control that applied the preset after Undo or ×,
   * whose buttons unmount with the toast (focus would otherwise drop to <body>).
   */
  onReturnFocus?: () => void;
}

/**
 * Info toast after a board preset is applied or reset (#1146, moved onto the
 * shared region in #2107): "Reset to “Default”" with Undo. Not an `undo: true`
 * action: the Preset menu offers the same Undo while the notice is up, so the
 * toast is not the only path and needs no 5 s dismissal guard. Timing is the
 * shipped 8 s (20 s for a link-applied preset); the region pauses it while
 * hovered or focused.
 */
export function usePresetNoticeToast({ notice, onUndo, onDismiss, onReturnFocus }: Options) {
  const { notify, dismiss } = useToast();
  const latest = useRef({ onUndo, onDismiss, onReturnFocus });
  latest.current = { onUndo, onDismiss, onReturnFocus };
  const id = notice?.id;
  const message = notice?.message;
  const link = notice?.reason === "link";

  useEffect(() => {
    if (id === undefined || message === undefined) {
      dismiss(PRESET_TOAST_KEY);
      return;
    }
    notify({
      key: PRESET_TOAST_KEY,
      variant: "info",
      title: message,
      durationMs: link ? PRESET_LINK_NOTICE_MS : PRESET_NOTICE_MS,
      action: {
        label: "Undo",
        onAction: () => {
          latest.current.onUndo();
          dismiss(PRESET_TOAST_KEY);
          latest.current.onReturnFocus?.();
        },
      },
      announceText: `${message}. ${PRESET_NOTICE_UNDO_HINT}`,
      onDismiss: (reason) => {
        // Any removal ends the notice, eviction included: the menu's Undo has the toast's
        // lifetime, so a late Undo cannot restore a stale snapshot over newer changes.
        latest.current.onDismiss();
        if (reason === "user") latest.current.onReturnFocus?.();
      },
      testId: "preset-notice",
    });
  }, [id, message, link, notify, dismiss]);

  useEffect(() => () => dismiss(PRESET_TOAST_KEY), [dismiss]);
}
