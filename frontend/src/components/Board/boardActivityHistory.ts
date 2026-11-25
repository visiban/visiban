import { useCallback, useEffect, useState } from "react";
import { getBoardMovements } from "../../api/boards";
import type { CardMovement } from "../../types";
import { activityActorName } from "../../types";
import type { ActivityEntry } from "./BoardActivityDrawer";

/**
 * Days of saved history the Recent tab opens with: its widest window (7d).
 *
 * Why the drawer reads saved history at all (#2596): it used to show only the
 * socket events this tab had received since the board loaded, so on every
 * fresh page load it read "No activity yet" however busy the board had been,
 * and its 24h/7d windows could only ever fill if the tab stayed open that long.
 * The hosted demo made this obvious: every seeded card carries moves, and the
 * drawer showed none of them.
 */
export const ACTIVITY_HISTORY_DAYS = 7;

/** Most rows the drawer keeps, saved and live together. */
export const ACTIVITY_FEED_LIMIT = 100;

/** The drawer row id of a movement, shared by its saved and live copies so one move never shows twice. */
export const movementEntryId = (movementId: number) => `mv-${movementId}`;

/** The drawer row id of a card's creation, keyed by card uid so the saved creation movement and the live `card.created` event are one row. */
export const createEntryId = (cardUid: string) => `create-${cardUid}`;

/** A saved board movement as a drawer row, worded like the live socket rows it sits beside. */
export function movementActivityEntry(m: CardMovement): ActivityEntry {
  const actor = activityActorName(m.moved_by);
  const title = m.card_title || "a card";
  // The creation movement is the only one with no origin column.
  if (!m.from_column_uid && !m.from_column_name) {
    return {
      id: m.card_uid ? createEntryId(m.card_uid) : movementEntryId(m.id),
      timestamp: new Date(m.moved_at),
      kind: "create",
      actor,
      headline: `created ${title}`,
      subject: m.card_title || undefined,
      detail: "",
    };
  }
  return {
    id: movementEntryId(m.id),
    timestamp: new Date(m.moved_at),
    kind: "move",
    actor,
    headline: `moved ${title}`,
    subject: m.card_title || undefined,
    detail: `${m.from_column_name} → ${m.to_column_name}`,
  };
}

/**
 * Live rows merged over saved ones, newest first, one row per id, capped at
 * {@link ACTIVITY_FEED_LIMIT}. `truncated` is true when the cap dropped rows.
 *
 * On an id collision the live row's wording is kept but the SAVED timestamp
 * wins: the server's `moved_at` is when the move happened, the live row's is
 * when this tab received it (#2596). Ties on time sort by id so the order
 * never depends on which feed a row came from.
 */
export function mergeActivityFeeds(saved: ActivityEntry[], live: ActivityEntry[]): { entries: ActivityEntry[]; truncated: boolean } {
  const savedById = new Map(saved.map((e) => [e.id, e]));
  const byId = new Map<string, ActivityEntry>();
  for (const e of live) {
    if (byId.has(e.id)) continue;
    const s = savedById.get(e.id);
    byId.set(e.id, s ? { ...e, timestamp: s.timestamp } : e);
  }
  for (const e of saved) if (!byId.has(e.id)) byId.set(e.id, e);
  const all = [...byId.values()].sort(
    (a, b) => b.timestamp.getTime() - a.timestamp.getTime() || b.id.localeCompare(a.id, undefined, { numeric: true }),
  );
  return { entries: all.slice(0, ACTIVITY_FEED_LIMIT), truncated: all.length > ACTIVITY_FEED_LIMIT };
}

function isoDateDaysAgo(days: number, now: number): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// One stable empty list, so the host's merge memo does not recompute on every render before the load.
const NO_ENTRIES: ActivityEntry[] = [];

/** Where the saved history stands: still fetching, fetched, or failed (Retry refetches). */
export type ActivityHistoryStatus = "loading" | "ready" | "error";

export interface ActivityHistory {
  entries: ActivityEntry[];
  status: ActivityHistoryStatus;
  /** The board has more saved rows in the window than {@link ACTIVITY_FEED_LIMIT}; the oldest were not fetched. */
  truncated: boolean;
  /** Refetch after a failure. */
  retry: () => void;
}

/**
 * The board's saved moves and creations from the last {@link ACTIVITY_HISTORY_DAYS}
 * days, fetched the first time `enabled` is true for a board (the drawer's first
 * open). Later changes reach the drawer as live socket rows, so one successful
 * fetch per board is enough. The endpoint pages at 50, so pages are followed up
 * to {@link ACTIVITY_FEED_LIMIT} rows. Archive and unarchive movements are left
 * out, as the live feed has no row for them.
 *
 * `status` keeps "not loaded yet" apart from "loaded and empty" (frontend/CLAUDE.md,
 * async-loaded lists). A failure is never recorded as loaded, so `retry` (or the
 * next open) fetches again.
 */
export function useBoardActivityHistory(boardId: number, enabled: boolean, now: () => number = Date.now): ActivityHistory {
  const [state, setState] = useState<{ boardId: number; entries: ActivityEntry[]; truncated: boolean } | null>(null);
  const [failed, setFailed] = useState<{ boardId: number; attempt: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loaded = state?.boardId === boardId;
  useEffect(() => {
    if (!enabled || loaded) return;
    let canceled = false;
    // A reopen after a failure fetches again; show it as loading, not as the old error.
    setFailed(null);
    const params = { moved_after: isoDateDaysAgo(ACTIVITY_HISTORY_DAYS, now()), exclude_type: "archived,unarchived" };
    (async () => {
      const rows: CardMovement[] = [];
      let count = 0;
      while (rows.length < ACTIVITY_FEED_LIMIT) {
        const page = await getBoardMovements(boardId, rows.length ? { ...params, offset: String(rows.length) } : params);
        count = page.count;
        rows.push(...page.results);
        if (page.results.length === 0 || rows.length >= count) break;
      }
      return { rows: rows.slice(0, ACTIVITY_FEED_LIMIT), truncated: count > ACTIVITY_FEED_LIMIT };
    })()
      .then(({ rows, truncated }) => {
        if (!canceled) setState({ boardId, entries: rows.map((m) => movementActivityEntry(m)), truncated });
      })
      .catch(() => {
        if (!canceled) setFailed({ boardId, attempt });
      });
    return () => { canceled = true; };
  }, [boardId, enabled, loaded, now, attempt]);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  if (loaded) return { entries: state.entries, status: "ready", truncated: state.truncated, retry };
  const status = failed?.boardId === boardId && failed.attempt === attempt ? "error" : "loading";
  return { entries: NO_ENTRIES, status, truncated: false, retry };
}
