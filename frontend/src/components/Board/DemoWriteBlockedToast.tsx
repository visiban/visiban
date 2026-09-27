import { useEffect, useState } from "react";
import type { DemoWriteBlockedDetail } from "../../api/client";
import { DEMO_LEAD } from "../../constants/demoCopy";

/** How long the toast stays up before clearing itself. */
export const DEMO_TOAST_MS = 5_000;

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
 * Fixed title, server `detail` as the body, amber `⚠` like MoveBlockedToast.
 * role="status"/polite: the visitor needs to know, but it must not interrupt.
 */
export default function DemoWriteBlockedToast() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<DemoWriteBlockedDetail>).detail;
      setMessage(detail?.message ?? "");
    };
    window.addEventListener("auth:demoWriteBlocked", handler);
    return () => window.removeEventListener("auth:demoWriteBlocked", handler);
  }, []);

  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(() => setMessage(null), DEMO_TOAST_MS);
    return () => clearTimeout(timer);
  }, [message]);

  if (message === null) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="demo-write-blocked-toast"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-start gap-3 bg-surface border border-warning text-fg text-sm rounded-lg px-4 py-3 shadow-xl max-w-sm"
    >
      <span aria-hidden="true" className="text-warning shrink-0 mt-0.5">⚠</span>
      <p className="flex-1 min-w-0">
        {/* DEMO_LEAD is "This is a shared demo — "; the title is its clause,
            and a server detail that already carries the lead is not doubled. */}
        <span className="font-medium">{DEMO_LEAD.replace(/ — $/, "")}</span>
        {message && <> — {message.startsWith(DEMO_LEAD) ? message.slice(DEMO_LEAD.length) : message}</>}
      </p>
      <button
        onClick={() => setMessage(null)}
        className="text-fg-muted hover:text-fg transition shrink-0 text-lg leading-none focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
