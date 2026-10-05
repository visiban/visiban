import { useCallback, useEffect, useRef } from "react";

/**
 * Returns a `trigger` that runs `resync` immediately, unless `blocked` is true
 * (e.g. a drag is in progress). A blocked trigger is remembered and `resync`
 * runs exactly once when `blocked` returns to false (#1463).
 *
 * Why: a reconnect resync replaces board state wholesale, which would yank the
 * card out from under an in-flight drag. Multiple triggers while blocked
 * collapse into a single resync. `trigger` keeps a stable identity.
 */
export function useDeferredResync(resync: () => void, blocked: boolean): () => void {
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const resyncRef = useRef(resync);
  resyncRef.current = resync;
  const pendingRef = useRef(false);

  useEffect(() => {
    if (!blocked && pendingRef.current) {
      pendingRef.current = false;
      resyncRef.current();
    }
  }, [blocked]);

  return useCallback(() => {
    if (blockedRef.current) {
      pendingRef.current = true;
      return;
    }
    resyncRef.current();
  }, []);
}
