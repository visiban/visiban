// #1923: the picker offers only the admin override; it has no field for the
// reason an assignee override requires.
import { isAdminRole } from "../../utils/forceOverride";
import { useCallback, useEffect, useState } from "react";
import { getCardChildren } from "../../api/cards";
import type { CardChildrenColumn, CardChildrenRead } from "../../types";
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
/**
 * At or above this width of the tab's own container the scoped board shows its columns side by side (canvas 2a).
 * It is compared with the measured container, so side by side needs a Children tab at least this wide. The
 * current 540px sheet never gives that, so today it shows one column at a time; 800 leaves slack under a
 * hypothetical 880px sheet's 840px content width (less ~16 for a scrollbar).
 */
export const WIDE_MIN_PX = 800;

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

/**
 * The tab's count: visible, unarchived children; a hidden board's count as the server gives it.
 * Zero is left out like an unknown count: a hidden board whose children are all archived reports
 * 0, and a "Children, 0" chip would tell the viewer a child board was once linked.
 */
export function childrenCount(d: CardChildrenRead | null): number | undefined {
  if (!d) return undefined;
  const n = d.visible ? d.results.length : d.count;
  return n > 0 ? n : undefined;
}


/**
 * What to announce, politely and once, when the children re-read after a change made elsewhere (#2209 row 13,
 * spec "Announcements"): one move reads "<title> moved to <column>. N of M done."; any other change, or several,
 * reads "Children updated. N of M done.". Empty when nothing changed, on the first read, or when either read is
 * not visible: a board the viewer cannot open never yields a title, column or state, only what the tab already
 * shows (the `card.children_changed` frame itself carries ids only and is never read for content).
 */
export function describeChildrenChange(prev: CardChildrenRead | null, next: CardChildrenRead | null): string {
  if (!prev?.visible || !next?.visible) return "";
  const columns = next.board?.columns ?? [];
  const before = new Map(prev.results.map((r) => [r.id, r]));
  const nextIds = new Set(next.results.map((r) => r.id));
  const moved = next.results.filter((r) => before.has(r.id) && before.get(r.id)!.column_id !== r.column_id);
  const other =
    next.results.some((r) => !before.has(r.id) || before.get(r.id)!.blocked !== r.blocked || before.get(r.id)!.title !== r.title)
    || prev.results.some((r) => !nextIds.has(r.id));
  if (moved.length === 0 && !other) return "";
  const doneIds = new Set(columns.filter((c) => c.is_done).map((c) => c.id));
  const done = next.results.filter((r) => doneIds.has(r.column_id)).length;
  const tally = `${done} of ${next.results.length} done.`;
  if (moved.length === 1 && !other) {
    const m = moved[0];
    return `${m.title} moved to ${columns.find((c) => c.id === m.column_id)?.name ?? m.column_name}. ${tally}`;
  }
  return `Children updated. ${tally}`;
}

export interface MoveTargetState {
  /** The row cannot be chosen; `reason` says why. */
  disabled: boolean;
  /** Visible words next to the row, or "" when the column has room. */
  reason: string;
  /** The move must send `?force=true` (an admin moving past an enforced limit). */
  force: boolean;
}

/**
 * What the in-sheet Move picker does with a column (#2209: the picker honors the child board's WIP mode).
 * It mirrors the move endpoint for this viewer, so a disabled row is exactly a move the server would refuse:
 * advisory limits (neither flag) never block; enforced limits block every role but a board admin, who
 * moves with `?force=true`; a hard limit blocks every role. A `wip_limit` of 0 is a real limit (the server treats any non-null limit as one), unlike the board's header display.
 * The server still re-checks; its refusal is shown as the picker's error line.
 */
export function moveTargetState(
  col: CardChildrenColumn,
  board: { role: string; enforce_wip_limits?: boolean; enforce_wip_hard?: boolean },
): MoveTargetState {
  const limit = col.wip_limit;
  if (limit == null || col.card_count < limit) return { disabled: false, reason: "", force: false };
  if (board.enforce_wip_hard) return { disabled: true, reason: `At its limit of ${limit}`, force: false };
  if (board.enforce_wip_limits) {
    return isAdminRole(board.role)
      ? { disabled: false, reason: `At its limit of ${limit} · admin override`, force: true }
      : { disabled: true, reason: `At its limit of ${limit}`, force: false };
  }
  return { disabled: false, reason: `At its limit of ${limit} · not enforced`, force: false };
}
