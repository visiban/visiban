import { useEffect, useState } from "react";
import type { SocketStatus } from "./useBoardSocket";

/**
 * Returns `true` when `status === "connected"` but no event has arrived within
 * `thresholdMs`. Drives the "Stale" variant of `ConnectionStatus` so Jordan
 * (power user running incident retros) can tell the difference between "healthy
 * but quiet" and "socket silently hung".
 *
 * Implementation note: a single `setTimeout` scheduled to the exact threshold
 * is cheaper than a polling `setInterval` — we know precisely when the state
 * could flip, and we reschedule whenever `lastEventAt` ticks. While the state
 * is not "connected", the hook short-circuits to `false` since staleness only
 * applies to an open connection (reconnecting/failed are their own states).
 */
export function useIsStale(
  status: SocketStatus,
  lastEventAt: number | null,
  thresholdMs = 60_000,
): boolean {
  const [isStale, setIsStale] = useState(false);

  useEffect(() => {
    if (status !== "connected") {
      setIsStale(false);
      return;
    }
    if (lastEventAt === null) {
      setIsStale(false);
      return;
    }
    const elapsed = Date.now() - lastEventAt;
    if (elapsed >= thresholdMs) {
      setIsStale(true);
      return;
    }
    setIsStale(false);
    const timer = setTimeout(() => setIsStale(true), thresholdMs - elapsed);
    return () => clearTimeout(timer);
  }, [status, lastEventAt, thresholdMs]);

  return isStale;
}
