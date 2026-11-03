import { useCallback, useSyncExternalStore } from "react";

/**
 * The grid overlay's coarse clock (#459): epoch ms floored to `refreshMs`, or 0 when
 * the active overlay declares no refresh.
 *
 * A dwell value goes stale on a mounted board even when nothing on the board changes,
 * and recomputing it per render or per second would rebuild every cell's overlay state
 * for a figure that reads to a tenth of a day. Flooring to the interval means the board
 * re-renders only when the bucket changes, so the overlay's `useMemo` holds between
 * buckets and turning the overlay on mid-session needs no catch-up effect.
 *
 * Coming back to a hidden tab re-reads the time at once: browsers throttle intervals
 * in the background, and the first thing someone sees on return must not be stale.
 */
export function useOverlayClock(refreshMs: number | null | undefined): number {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!refreshMs) return () => {};
      const interval = setInterval(onChange, refreshMs);
      document.addEventListener("visibilitychange", onChange);
      return () => {
        clearInterval(interval);
        document.removeEventListener("visibilitychange", onChange);
      };
    },
    [refreshMs],
  );
  const getSnapshot = useCallback(
    () => (refreshMs ? Math.floor(Date.now() / refreshMs) * refreshMs : 0),
    [refreshMs],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
