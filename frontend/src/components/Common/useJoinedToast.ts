import { useEffect } from "react";
import { useToast } from "../../contexts/useToast";

export const JOINED_TOAST_KEY = "joined";

/**
 * Raises the "You've joined …" confirmation after an invite (group page #998,
 * board #1444) as a `success` toast in the shared region (#2107). It never
 * times out: it is the only confirmation the join produced, so it persists
 * until dismissed (or the page is left). Pass `null` to raise nothing.
 */
export function useJoinedToast(title: string | null) {
  const { notify, dismiss } = useToast();
  useEffect(() => {
    if (!title) return;
    notify({ key: JOINED_TOAST_KEY, variant: "success", title, durationMs: null, testId: "joined-notice" });
    return () => dismiss(JOINED_TOAST_KEY);
  }, [title, notify, dismiss]);
}
