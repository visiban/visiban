import { useEffect } from "react";
import type { DemoWriteBlockedDetail } from "../../api/client";
import { DEMO_LEAD } from "../../constants/demoCopy";
import { useToast } from "../../contexts/useToast";
import { TOAST_DURATION_MS } from "../../utils/toastQueue";

/**
 * How long the toast stays up before clearing itself: the shared `warning`
 * duration (8 s; it was 5 s before the shared region, #2060, which was short
 * for a full sentence).
 */
export const DEMO_TOAST_MS = TOAST_DURATION_MS.warning as number;

export const DEMO_TOAST_KEY = "demo-write-blocked";

/**
 * Fallback explanation for a hosted-demo refusal (#1179).
 *
 * A SAFETY NET, not the primary mechanism: every surface the demo fence
 * refuses is meant to be aria-disabled up front with its reason, so nothing is
 * ever sent. This catches whatever still sends a refused write (a background
 * preference save, a surface added later) so the refusal explains itself
 * instead of failing silently. Listens for `auth:demoWriteBlocked`, which
 * api/client.ts dispatches on a 403 carrying `code: "demo_read_only"`.
 *
 * A `warning` toast in the shared region (frontend/CLAUDE.md § Toasts): fixed
 * title, server `detail` as the body, amber `⚠` like the move refusal, polite
 * (the visitor needs to know, but it must not interrupt). Renders nothing.
 */
export default function DemoWriteBlockedToast() {
  const { notify } = useToast();

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<DemoWriteBlockedDetail>).detail;
      const raw = detail?.message ?? "";
      // DEMO_LEAD is "This is a shared demo — "; the title is its clause,
      // and a server detail that already carries the lead is not doubled.
      const title = DEMO_LEAD.replace(/ — $/, "");
      const message = raw ? (raw.startsWith(DEMO_LEAD) ? raw.slice(DEMO_LEAD.length) : raw) : undefined;
      notify({
        key: DEMO_TOAST_KEY,
        variant: "warning",
        title,
        message,
        // One sentence, as it reads on screen.
        announceText: message ? `${title} — ${message}` : `${title}.`,
        durationMs: DEMO_TOAST_MS,
        testId: "demo-write-blocked-toast",
      });
    };
    window.addEventListener("auth:demoWriteBlocked", handler);
    return () => window.removeEventListener("auth:demoWriteBlocked", handler);
  }, [notify]);

  return null;
}
