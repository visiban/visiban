import { useEffect, useRef } from "react";

/**
 * Minimum interval (ms) between tab-focus resyncs. Prevents hammering the
 * server when a user rapidly switches between tabs.
 */
export const RESYNC_THROTTLE_MS = 30_000;

/**
 * Run `callback` when the browser tab regains focus, at most once per
 * `throttleMs`.
 *
 * Extracted from `useBoardResync` (#783) once a second caller appeared. The
 * throttle is the whole point of sharing it: a bare `visibilitychange`
 * listener fires on every alt-tab, window restore, and notification
 * focus-steal, so an un-throttled refetch turns ordinary tab-switching into
 * unbounded request volume. Anything that refetches on focus should go through
 * here rather than re-implementing the listener and silently omitting the
 * guard.
 */
export function useVisibilityResync(
  callback: () => void,
  throttleMs: number = RESYNC_THROTTLE_MS,
): void {
  const lastResyncRef = useRef(0);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;

      const now = Date.now();
      if (now - lastResyncRef.current < throttleMs) return;

      lastResyncRef.current = now;
      callback();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [callback, throttleMs]);
}
