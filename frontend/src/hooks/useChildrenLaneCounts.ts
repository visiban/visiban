import { useEffect, useState } from "react";
import { getChildrenView } from "../api/cards";
import { shownInProgress } from "../utils/childrenMode";

/**
 * Each lane's in-progress child count (not done, not planned) for the ways into Children mode (#2370): the
 * "Children 12 in progress" lane action and the Children tab's "All children in {lane}" link. It reads the
 * server's per-viewer lane rollups from `children-view?counts_only=true`, no page of rows (Rule 19: never re-derived on the client). Disabled,
 * or on a failed read, it returns an empty map and the callers show their action without a count.
 */
export function useChildrenLaneCounts(boardId: number, enabled: boolean, laneId: number | null = null, refreshKey = 0): Map<number, number> {
  const [counts, setCounts] = useState<Map<number, number>>(new Map());
  useEffect(() => {
    // Keep the same empty Map when already empty, so a disabled hook never re-renders its board.
    if (!enabled) { setCounts((p) => (p.size ? new Map() : p)); return; }
    const ctrl = new AbortController();
    // Started inside a promise so any failure, even a synchronous one, lands in the catch: a count is never worth a crash.
    Promise.resolve().then(() => getChildrenView(boardId, { lane: laneId, countsOnly: true }, ctrl.signal))
      .then((d) => setCounts(new Map(d.lanes.map((l) => [l.id, shownInProgress(l)]))))
      .catch(() => { if (!ctrl.signal.aborted) setCounts((p) => (p.size ? new Map() : p)); });
    return () => ctrl.abort();
  }, [boardId, enabled, laneId, refreshKey]);
  return counts;
}
