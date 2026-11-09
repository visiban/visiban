import { useCallback, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";

/**
 * Re-read one piece of page state (a group, a member list, a subgroup list)
 * and apply the answer over the value on screen (#2136), generalizing the
 * boards-list handling of #2088, #2139 and #2150 in GroupDetail.
 *
 * The server reads the value at some point while the request is in flight, so
 * a write applied meanwhile (a socket frame, or this session's own edit) may be
 * newer than the answer. Applying the answer wholesale would undo it: a
 * group.deleted for a subgroup would bring the row back and no later frame
 * removes it again. So every write made through `write` during a re-read is
 * recorded and replayed, in order, over the answer. Writes must be idempotent
 * updater functions, so replaying one the answer already reflects changes
 * nothing. An appending write must add its row only when the id is missing, or
 * a row the answer already lists would appear twice.
 *
 * Only the most recently STARTED read applies: a superseded read's writes need
 * no carrying over, since the newer read was sent after they committed.
 *
 * The initial load is not a `read`: it calls `reset` when it starts and
 * `applyLoad` with its answer. It yields only to a re-read that actually
 * applied (a re-read that failed must not discard the load), and carries the
 * writes recorded while a re-read is still in flight over its own answer.
 */
type Write<T> = (prev: T) => T;

export function useResyncedState<T>(setValue: Dispatch<SetStateAction<T>>) {
  const seqRef = useRef(0);
  const replayRef = useRef<Write<T>[] | null>(null);
  const appliedRef = useRef(false);
  const loadPendingRef = useRef(false);
  const failedRef = useRef(false);

  /** Apply an update and record it for the re-read in flight, if any. */
  const write = useCallback((w: Write<T>) => {
    replayRef.current?.push(w);
    setValue(w);
  }, [setValue]);

  /** Start of an initial load (or, with load=false, a plain invalidation). */
  const reset = useCallback((load = true) => {
    ++seqRef.current; // drops any read still in flight for the previous group
    replayRef.current = null;
    appliedRef.current = false;
    failedRef.current = false;
    loadPendingRef.current = load;
  }, []);

  /** The initial load answered. Returns false when it yielded to an applied re-read. */
  const applyLoad = useCallback((value: T): boolean => {
    loadPendingRef.current = false;
    if (appliedRef.current) return false; // a re-read already applied a newer answer
    const pending = replayRef.current;
    setValue(pending ? pending.reduce((v, w) => w(v), value) : value);
    // A re-read that failed left its array open only for this load.
    if (failedRef.current) {
      replayRef.current = null;
      failedRef.current = false;
    }
    return true;
  }, [setValue]);

  const read = useCallback((
    fetch: () => Promise<T>,
    options?: { onError?: () => void; onSettled?: () => void; onApplied?: (answer: T) => void },
  ) => {
    const seq = ++seqRef.current;
    // While the initial load is pending, a newer read inherits the writes
    // recorded since the earlier one started: if it fails, the load still needs
    // them. Afterwards each read starts empty.
    const replay: Write<T>[] = loadPendingRef.current ? [...(replayRef.current ?? [])] : [];
    replayRef.current = replay;
    failedRef.current = false;
    fetch()
      .then((value) => {
        if (seq !== seqRef.current) return;
        replayRef.current = null; // later writes land on top of the answer
        appliedRef.current = true;
        setValue(replay.reduce((v, w) => w(v), value));
        options?.onApplied?.(value);
        options?.onSettled?.();
      })
      .catch(() => {
        // Stay with the current value.
        if (seq !== seqRef.current) return;
        if (loadPendingRef.current) failedRef.current = true; // keep the array for the load
        else replayRef.current = null;
        options?.onError?.();
        options?.onSettled?.();
      });
  }, [setValue]);

  return { write, reset, applyLoad, read };
}
