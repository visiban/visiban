import { useEffect, useState } from "react";
import { getBoardMovements } from "../../api/boards";
import type { CardMovement } from "../../types";
import { userDisplayName } from "../../types";
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
  const actor = m.moved_by ? userDisplayName(m.moved_by) : "Someone";
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

/** Live rows over saved ones, newest first, one row per id, capped at {@link ACTIVITY_FEED_LIMIT}. */
export function mergeActivityFeeds(saved: ActivityEntry[], live: ActivityEntry[]): ActivityEntry[] {
  const seen = new Set<string>();
  const out: ActivityEntry[] = [];
  for (const e of [...live, ...saved]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  out.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return out.slice(0, ACTIVITY_FEED_LIMIT);
}

function isoDateDaysAgo(days: number, now: number): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The board's saved moves and creations from the last {@link ACTIVITY_HISTORY_DAYS}
 * days, fetched the first time `enabled` is true for a board (the drawer's first
 * open). Later changes reach the drawer as live socket rows, so one fetch per
 * board is enough. A failed fetch leaves the list empty: the live rows still show.
 * Archive and unarchive movements are left out, as the live feed has no row for them.
 */
export function useBoardActivityHistory(boardId: number, enabled: boolean, now: () => number = Date.now): ActivityEntry[] {
  const [state, setState] = useState<{ boardId: number; entries: ActivityEntry[] } | null>(null);
  const loaded = state?.boardId === boardId;
  useEffect(() => {
    if (!enabled || loaded) return;
    let canceled = false;
    getBoardMovements(boardId, {
      moved_after: isoDateDaysAgo(ACTIVITY_HISTORY_DAYS, now()),
      exclude_type: "archived,unarchived",
    })
      .then((page) => {
        if (!canceled) setState({ boardId, entries: page.results.map((m) => movementActivityEntry(m)) });
      })
      .catch(() => {
        if (!canceled) setState({ boardId, entries: [] });
      });
    return () => { canceled = true; };
  }, [boardId, enabled, loaded, now]);
  return loaded ? state.entries : [];
}
