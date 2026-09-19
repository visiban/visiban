import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import { getLensBoard } from "../api/gitLens";
import { serializeLensLabels } from "../components/Board/Lens/lensDims";
import type { LensData } from "../types";

/**
 * Error codes the lens board endpoint can return. ``unknown`` is the
 * client-side fallback for any error without a recognized ``code`` field
 * (e.g. a network failure before the response is received).
 */
export type LensErrorCode =
  | "auth_required"
  | "rate_limited"
  | "repo_not_found"
  | "lens_error"
  | "unknown";

export interface LensError {
  code: LensErrorCode;
  /** Human-readable detail from the server, when present. */
  detail: string;
  /** Seconds to wait before retrying — only set for ``rate_limited``. */
  retryAfter?: number;
}

export interface UseLensDataResult {
  data: LensData | null;
  error: LensError | null;
  /** True on the very first load (no data yet). */
  loading: boolean;
  /** True while re-fetching with data already on screen (keep the grid up). */
  refetching: boolean;
  refresh: () => void;
}

interface ServerErrorBody {
  detail?: string;
  code?: string;
  retry_after?: number;
}

function toLensError(err: unknown): LensError {
  if (axios.isAxiosError(err)) {
    const body = (err.response?.data ?? {}) as ServerErrorBody;
    const code = body.code;
    if (
      code === "auth_required" ||
      code === "rate_limited" ||
      code === "repo_not_found" ||
      code === "lens_error"
    ) {
      return {
        code,
        detail: body.detail ?? "",
        ...(typeof body.retry_after === "number" ? { retryAfter: body.retry_after } : {}),
      };
    }
    // 404 with no code → no lens configured / repo not found.
    if (err.response?.status === 404) {
      return { code: "repo_not_found", detail: body.detail ?? "" };
    }
  }
  return { code: "unknown", detail: "Something went wrong loading the lens." };
}

/**
 * The server-side filters the lens board endpoint accepts.
 *
 * This is a CLIENT-SIDE type, not a serializer mirror — the "keep TypeScript
 * interfaces in lockstep with the backend serializer" rule in the root CLAUDE.md
 * applies to response shapes (`LensData`, `NormalizedIssue`), not to this. These
 * are query params, and every one is optional with a no-filter default.
 */
export interface LensFilterState {
  /** "open" | "closed"; omit for all. */
  state?: string;
  /** Milestone title, or the `__none__` sentinel for "no milestone". */
  milestone?: string;
  /** AND-ed label names. Serialized sorted/deduped/capped before the request. */
  labels?: string[];
  /** A single username. */
  assignee?: string;
}

export interface UseLensDataOptions {
  columnDim?: string;
  swimlaneDim?: string;
  filters?: LensFilterState;
}

/**
 * Fetch/refetch state machine for the read-only issue board lens.
 *
 * Distinguishes ``loading`` (first paint, no data) from ``refetching`` (a manual
 * refresh or pivot change while data is already on screen) so the view can keep
 * the grid mounted and show only a spinner in the freshness control. A stale
 * in-flight request never clobbers a newer one (guarded by a request id).
 *
 * Takes an options object rather than positional arguments: #1067 took the filter
 * set from two values to four, and five-plus positional parameters of the same
 * type is a call site nobody can read or safely reorder.
 */
export function useLensData(
  boardId: number,
  { columnDim, swimlaneDim, filters }: UseLensDataOptions = {},
): UseLensDataResult {
  const state = filters?.state;
  const milestone = filters?.milestone;
  const assignee = filters?.assignee;
  // Depend on the canonical STRING, not the array: a fresh `labels` array every
  // render would re-create `run` every render and refetch in a loop. This is also
  // exactly the value sent upstream, so the dependency and the request cannot drift.
  const labels = serializeLensLabels(filters?.labels ?? []);

  const [data, setData] = useState<LensData | null>(null);
  const [error, setError] = useState<LensError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refetching, setRefetching] = useState(false);

  // Monotonic request id — only the most recent request is allowed to commit
  // its result, so a slow earlier fetch cannot overwrite a faster later one.
  const reqIdRef = useRef(0);
  // Track whether we currently have data on screen without reading `data` in the
  // fetch callback (which would force it to re-create on every data change).
  const hasDataRef = useRef(false);
  hasDataRef.current = data !== null;

  const run = useCallback((force = false) => {
    const id = ++reqIdRef.current;
    if (hasDataRef.current) {
      setRefetching(true);
    } else {
      setLoading(true);
    }
    getLensBoard(boardId, {
      column_dim: columnDim,
      swimlane_dim: swimlaneDim,
      state,
      milestone,
      labels: labels || undefined,
      assignee,
      // The Refresh button forces a re-fetch past the per-repo cache's soft-TTL.
      refresh: force ? 1 : undefined,
    })
      .then((d) => {
        if (id !== reqIdRef.current) return;
        setData(d);
        setError(null);
      })
      .catch((err) => {
        if (id !== reqIdRef.current) return;
        setError(toLensError(err));
      })
      .finally(() => {
        if (id !== reqIdRef.current) return;
        setLoading(false);
        setRefetching(false);
      });
  }, [boardId, columnDim, swimlaneDim, state, milestone, labels, assignee]);

  useEffect(() => {
    run();
  }, [run]);

  // The manual Refresh forces a re-fetch (bypasses the soft-TTL cache); the
  // automatic fetch above does not.
  const refresh = useCallback(() => run(true), [run]);

  return { data, error, loading, refetching, refresh };
}
