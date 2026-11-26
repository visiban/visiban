import type { ChildrenViewChild, ChildrenViewLane, ChildrenViewRow } from "../types";

/**
 * Children mode on the Board tab (#2370, planned sections #2550): the pure rules, kept out of the components so
 * they stay fast-refresh clean and are unit-testable. Every count here is a server count from
 * `GET /boards/{id}/children-view/`; nothing re-derives "planned" or "blocked" (Rule 19, #449).
 */

export type BoardShowMode = "cards" | "children";
export type PlannedOption = "any" | "hide" | "only";

export interface ChildrenModeOptions {
  showDone: boolean;
  blockedOnly: boolean;
  planned: PlannedOption;
}

export const DEFAULT_CHILDREN_OPTIONS: ChildrenModeOptions = { showDone: false, blockedOnly: false, planned: "any" };

/**
 * The grid's board-tier Escape slot (frontend/CLAUDE.md § Escape priority): below the View menu's 25 and the
 * dropdowns, above BoardView's focus-exit (12), so one Escape leaves the grid before it exits lane focus. Returns
 * `false` unless focus is inside a Children grid.
 */
export const CHILDREN_MODE_ESCAPE_PRIORITY = 14;

/** Past this many parents a lane's rows shrink to one line (#2370 "Large lanes"). */
export const LARGE_LANE_PARENTS = 8;

/** The live pill announces at most this often (#2370 "Live updates"). */
export const LIVE_PILL_THROTTLE_MS = 10_000;

const modeKey = (boardId: number) => `board:${boardId}:show-mode`;
const optionsKey = (boardId: number) => `board:${boardId}:children-options`;

/** The remembered Show choice for this board, per browser user; anything unreadable decays to Cards. */
export function loadShowMode(boardId: number): BoardShowMode {
  try {
    return localStorage.getItem(modeKey(boardId)) === "children" ? "children" : "cards";
  } catch {
    return "cards";
  }
}

export function saveShowMode(boardId: number, mode: BoardShowMode): void {
  try {
    if (mode === "children") localStorage.setItem(modeKey(boardId), "children");
    else localStorage.removeItem(modeKey(boardId));
  } catch {
    // Storage unavailable (private window, quota): the URL still carries the mode.
  }
}

export function loadChildrenOptions(boardId: number): ChildrenModeOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(optionsKey(boardId)) ?? "null") as Partial<ChildrenModeOptions> | null;
    if (!raw || typeof raw !== "object") return DEFAULT_CHILDREN_OPTIONS;
    return {
      showDone: raw.showDone === true,
      blockedOnly: raw.blockedOnly === true,
      planned: raw.planned === "hide" || raw.planned === "only" ? raw.planned : "any",
    };
  } catch {
    return DEFAULT_CHILDREN_OPTIONS;
  }
}

export function saveChildrenOptions(boardId: number, options: ChildrenModeOptions): void {
  try {
    localStorage.setItem(optionsKey(boardId), JSON.stringify(options));
  } catch {
    // Storage unavailable: the choice lasts for this visit only.
  }
}

/** `?lane=` as a numeric lane id, else null (the canvas slug is superseded by the numeric id). */
export function parseLaneParam(raw: string | null): number | null {
  if (!raw || !/^\d{1,12}$/.test(raw)) return null;
  return Number(raw);
}

/** The shareable link to one lane in Children mode: `?show=children&lane=<lane id>`. */
export function laneLink(origin: string, boardId: number, laneId: number): string {
  return `${origin}/boards/${boardId}?show=children&lane=${laneId}`;
}

/** "In progress" as the board shows it: not done and not planned (#2370 clarification 3, #2550). */
export const shownInProgress = (c: { in_progress: number; planned: number }) => Math.max(0, c.in_progress - c.planned);

/**
 * The lane band's total: "12 in progress of 16", or with planned children "2 in progress · 2 planned" (planned
 * never counts as to do or in progress).
 */
export function laneTotalLabel(lane: Pick<ChildrenViewLane, "in_progress" | "planned" | "total">): string {
  const active = shownInProgress(lane);
  if (lane.planned > 0) return `${active} in progress · ${lane.planned} planned`;
  return `${active} in progress of ${lane.total}`;
}

/** Collapsed band status in the rollup wording: "All blocked", "none blocked" or "3 blocked". */
export function laneBlockedLabel(lane: Pick<ChildrenViewLane, "blocked" | "in_progress" | "planned">): string {
  if (lane.blocked === 0) return "none blocked";
  if (lane.blocked >= shownInProgress(lane) && shownInProgress(lane) > 0) return "All blocked";
  return `${lane.blocked} blocked`;
}

export const parentsLabel = (n: number) => `${n} ${n === 1 ? "parent" : "parents"}`;

export function laneSubtitle(lane: Pick<ChildrenViewLane, "parents" | "child_boards">): string {
  return `${parentsLabel(lane.parents)} · ${lane.child_boards} child ${lane.child_boards === 1 ? "board" : "boards"}`;
}

/** The band group's accessible name (canvas 6a). */
export function laneBandName(lane: ChildrenViewLane): string {
  const states = `${lane.total} you can open, ${lane.done} done, ${lane.doing} doing, ${lane.blocked} blocked, ${lane.todo} to do`;
  const planned = lane.planned > 0 ? `, ${lane.planned} planned` : "";
  const hidden = lane.hidden > 0 ? `; ${lane.hidden} more on a board you can't open` : "";
  return `${lane.name} children: ${states}${planned}${hidden}`;
}

/** A row header's rollup: "1/6 done", or "No work started" when nothing has started. */
export function rowDoneLabel(row: ChildrenViewRow): string {
  const r = row.rollup;
  if (!r.visible) return "";
  if (r.done === 0 && r.doing === 0 && r.blocked === 0) return "No work started";
  return `${r.done}/${r.total} done`;
}

/** A one-line (large lane) row's summary: "3 blocked", else "3/5 done". */
export function compactRowLabel(row: ChildrenViewRow): string {
  const r = row.rollup;
  if (r.visible && r.blocked > 0) return `${r.blocked} blocked`;
  return rowDoneLabel(row);
}

/** The fold button, the same everywhere (#2370 clarification 1, #2550). */
export function foldLabel(folded: number, plannedOnly: number): string {
  const n = folded + plannedOnly;
  const base = `${n} ${n === 1 ? "parent" : "parents"} with nothing in progress`;
  return plannedOnly > 0 ? `${base} · ${plannedOnly} with only planned work` : base;
}

export const lockedRowText = (n: number) =>
  `${n} ${n === 1 ? "child" : "children"} on a board you can't open. Their columns and titles are not shown.`;

/** "+9 more parents · loads 20 rows at a time" (desktop) or "+9 more parents · load 20" (phone). */
export function moreParentsLabel(remaining: number, phone: boolean): string {
  return `+${remaining} more ${remaining === 1 ? "parent" : "parents"} · ${phone ? "load 20" : "loads 20 rows at a time"}`;
}

/** A row folds when nothing is in progress, or (unless "Only planned") when its only work is planned. */
export function isFoldedRow(row: ChildrenViewRow, planned: PlannedOption): boolean {
  if (!row.rollup.visible) return false;
  if (row.folded) return true;
  return row.planned_only && planned !== "only";
}

/** Which of a row's children the grid draws under the Planned and Blocked only options. */
export function visibleChildren(children: ChildrenViewChild[], options: ChildrenModeOptions): ChildrenViewChild[] {
  return children.filter((c) => {
    if (options.planned === "hide" && c.planned) return false;
    if (options.planned === "only" && !c.planned) return false;
    if (options.blockedOnly && !c.blocked) return false;
    return true;
  });
}

/** A compact child card's accessible name: "title, column, owner, blocked". */
export function childCardName(child: ChildrenViewChild, columnName: string): string {
  const parts = [child.title, columnName];
  if (child.assignee) parts.push(child.assignee.display_name || child.assignee.username);
  if (child.blocked) parts.push("blocked");
  if (child.planned) parts.push("planned");
  return parts.join(", ");
}

/** A grid cell's accessible name: "Acme: analytics module, Blocked, 2 cards". */
export function cellName(parentTitle: string, columnName: string, count: number): string {
  return `${parentTitle}, ${columnName}, ${count} ${count === 1 ? "card" : "cards"}`;
}

/** Days since a manual block started, for the "⊘ 4d" line; null when not blocked or unknown. */
export function blockedDays(child: ChildrenViewChild, now: number = Date.now()): number | null {
  if (!child.blocked || !child.blocked_at) return null;
  return Math.max(0, Math.floor((now - Date.parse(child.blocked_at)) / 86_400_000));
}

/**
 * Rows never re-sort under the viewer (#2370 "Live updates"): while focus is in the grid, keep the previous order
 * and append rows that are new, dropping rows that left. Returns the order to draw and how many rows would move.
 */
export function stableOrder(previous: number[], next: number[]): { order: number[]; changes: number } {
  const present = new Set(next);
  const kept = previous.filter((id) => present.has(id));
  const known = new Set(kept);
  const order = [...kept, ...next.filter((id) => !known.has(id))];
  let changes = 0;
  order.forEach((id, i) => { if (next[i] !== id) changes += 1; });
  return { order, changes };
}
