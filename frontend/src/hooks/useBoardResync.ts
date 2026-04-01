import { useEffect, useRef } from "react";

/**
 * Minimum interval (ms) between tab-focus resyncs.  Prevents hammering the
 * server when a user rapidly switches between tabs.
 */
const RESYNC_THROTTLE_MS = 30_000;

/**
 * Re-fetches the full board state when the browser tab regains focus.
 *
 * WebSocket events that arrive while the tab is suspended (laptop sleep,
 * mobile background, etc.) are silently lost. This hook bridges the gap by
 * calling the existing `reload()` function — which hits GET /full/ — whenever
 * `document.visibilityState` transitions back to "visible".
 *
 * The resync is throttled so it fires at most once per `RESYNC_THROTTLE_MS`.
 *
 * Source of change: Gemini Pro external codebase review (2026-04-01).
 */
export function useBoardResync(reload: () => void): void {
  const lastResyncRef = useRef(0);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;

      const now = Date.now();
      if (now - lastResyncRef.current < RESYNC_THROTTLE_MS) return;

      lastResyncRef.current = now;
      reload();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [reload]);
}
