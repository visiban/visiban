import { useCallback, useEffect, useState } from "react";
import { getCardChildren } from "../../api/cards";
import type { CardChildrenRead } from "../../types";
import { PARENT_PICKER_ESCAPE_PRIORITY } from "./ParentCardPicker";

/**
 * Children tab (#2209): shared constants and the children read, kept out of the component files so they
 * stay fast-refresh clean.
 */

/**
 * Link existing shares the "Link a parent" picker's slot: that picker opens only on a child-tier board and
 * this one only on a parent-tier board, so they are never open together (frontend/CLAUDE.md § Escape priority).
 */
export const CHILD_PICKER_ESCAPE_PRIORITY = PARENT_PICKER_ESCAPE_PRIORITY;

/** Escape slot of the scoped board (frontend/CLAUDE.md § Escape priority inside the card detail panel). */
export const CHILDREN_BOARD_ESCAPE_PRIORITY = 30.5;
/** The in-sheet Move popover shares the card panel's move-popover slot; the two are never open together. */
export const CHILD_MOVE_ESCAPE_PRIORITY = 36;
/** At or above this sheet width the scoped board shows its columns side by side (canvas 2a). */
export const WIDE_MIN_PX = 880;

export const WRITE_ROLES = new Set(["member", "admin", "site_admin"]);

export interface ChildrenState {
  data: CardChildrenRead | null;
  error: boolean;
  loading: boolean;
  reload: () => void;
}

/**
 * The parent's children for the viewer, every page (a parent holds at most 100, two pages of 50), with
 * archived children dropped (#2209 States: an archived child leaves the tab). Fetched when the card opens on
 * a parent-tier board, so the tab can show its count without being opened. `refreshSignal` re-reads it.
 */
export function useCardChildren(boardId: number, cardId: number, enabled: boolean, refreshSignal = 0): ChildrenState {
  const [data, setData] = useState<CardChildrenRead | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    // Aborted on every re-run, so overlapping refreshes never pile up (perf-check).
    const controller = new AbortController();
    const { signal } = controller;
    // Stale-while-revalidate: only a first read shows the skeleton.
    setLoading((was) => was || data === null);
    (async () => {
      const first = await getCardChildren(boardId, cardId, 0, signal);
      const rows = [...first.results];
      while (first.visible && rows.length < first.count && rows.length > 0 && !signal.aborted) {
        const page = await getCardChildren(boardId, cardId, rows.length, signal);
        if (page.results.length === 0) break;
        rows.push(...page.results);
      }
      return { ...first, results: rows.filter((r) => !r.archived) };
    })()
      .then((d) => { if (!signal.aborted) { setData(d); setError(false); setLoading(false); } })
      .catch(() => { if (!signal.aborted) { setError(true); setLoading(false); } });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `data` only decides whether to show the skeleton; re-reading on it would loop
  }, [boardId, cardId, enabled, n, refreshSignal]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, error, loading, reload };
}

/** The tab's count: visible, unarchived children; a hidden board's count as the server gives it. */
export function childrenCount(d: CardChildrenRead | null): number | undefined {
  if (!d) return undefined;
  return d.visible ? d.results.length : d.count;
}

