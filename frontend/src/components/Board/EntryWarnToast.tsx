import { useEffect, useRef } from "react";
import { useToast } from "../../contexts/useToast";
import type { EntryWarning } from "../../hooks/useBoard";
import { entryNeedsLine, entryRequirementCount } from "./moveBlockedMessages";

/** Coalescing key: a later Warn move replaces the previous notice in place. */
export const ENTRY_WARN_TOAST_KEY = "entry-warn";

interface Props {
  warning: EntryWarning;
  onDismiss: () => void;
}

/**
 * The Warn-mode notice (#1923, owner decision 2026-11-24): the move went
 * through, and the server's `entry_unmet` says what the card still lacks.
 * A non-blocking `warning` toast for 12 s with one action, "Fill in", which
 * opens the card (the full fill-in dialog is #2571). Renders nothing.
 */
export default function EntryWarnToast({ warning, onDismiss }: Props) {
  const { notify, dismiss } = useToast();
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    const count = entryRequirementCount(warning.unmet.length);
    const title = warning.columnName ? `Moved to ${warning.columnName} · ${count} not met` : `Moved · ${count} not met`;
    notify({
      key: ENTRY_WARN_TOAST_KEY,
      variant: "warning",
      title,
      message: entryNeedsLine(warning.unmet),
      durationMs: 12000,
      action: {
        label: "Fill in",
        onAction: () => {
          window.dispatchEvent(new CustomEvent("visiban:open-card", { detail: { cardId: warning.cardId } }));
          dismiss(ENTRY_WARN_TOAST_KEY);
          dismissRef.current();
        },
      },
      onDismiss: () => dismissRef.current(),
      testId: "entry-warn-toast",
    });
  }, [warning, notify, dismiss]);

  useEffect(() => () => dismiss(ENTRY_WARN_TOAST_KEY), [dismiss]);
  return null;
}
