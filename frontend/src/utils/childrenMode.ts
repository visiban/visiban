import { movementLine } from "../components/Card/childrenRollup";
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

/**
 * The `?lane=` Children mode uses: the parsed id only when it names a lane on this board the viewer was
 * served, else null (#2370 checklist item 1). A lane the viewer can't see is simply absent: the mode renders
 * with the default expansion and never asks the server about it, so a missing lane and another board's lane
 * read the same, and nothing about either leaks.
 */
export function resolveLaneParam(raw: string | null, laneIds: readonly number[]): number | null {
  const id = parseLaneParam(raw);
  return id != null && laneIds.includes(id) ? id : null;
}

/** The lane action's in-progress chip (#2370 way in 1): "12 in progress". */
export const inProgressChip = (n: number) => `${n} in progress`;

/** The Children tab's link to the parent's lane (#2370 way in 2): "All children in Acme Corp (12 in progress)". */
export function allChildrenLinkText(laneName: string, inProgress: number | null): string {
  return inProgress == null ? `All children in ${laneName}` : `All children in ${laneName} (${inProgress} in progress)`;
}

/**
 * A child-board column head's caption (artboard 6a): "3 of 4 on Delivery · limit 5" for a column with children
 * here, its whole-column count and limit; the Done column reads "Count per row · Show opens them" while done
 * cards are folded.
 */
export function columnHeadCaption(
  col: { is_done: boolean; card_count: number; wip_limit: number | null },
  shownHere: number, boardName: string, showDone: boolean, padded = false,
): string {
  // A narrower child board's Done head only names itself: the first board's already explains the counts (canvas 6a).
  if (col.is_done && !showDone) return padded ? "Done column" : "Count per row · Show opens them";
  return `${shownHere} of ${col.card_count} on ${boardName}${col.wip_limit != null ? ` · limit ${col.wip_limit}${columnOverLimit(col) ? " over" : ""}` : ""}`;
}

/** A column past its WIP limit (#2370 ruling): warning tone and the word "over", never danger (frontend/CLAUDE.md § Column headers). */
export function columnOverLimit(col: { card_count: number; wip_limit: number | null }): boolean {
  return col.wip_limit != null && col.wip_limit > 0 && col.card_count > col.wip_limit;
}

/**
 * Live updates (#2370 item 9): rows never re-sort under a viewer whose focus is in the grid. The fresh rows are
 * drawn in the order already on screen (counts and cards update in place); rows new to the page go last and rows
 * the server dropped go away.
 */
export function holdRowOrder<T extends { id: number }>(shown: T[], fresh: T[]): T[] {
  const byId = new Map(fresh.map((r) => [r.id, r]));
  const kept = shown.filter((r) => byId.has(r.id)).map((r) => byId.get(r.id)!);
  const seen = new Set(kept.map((r) => r.id));
  return [...kept, ...fresh.filter((r) => !seen.has(r.id))];
}

/** How many of a lane's row slots differ between the order on screen and the server's: the pill's "N changes". */
export function pendingRowChanges(shown: { id: number; swimlane_id: number }[], fresh: { id: number; swimlane_id: number }[], laneId: number): number {
  const a = shown.filter((r) => r.swimlane_id === laneId).map((r) => r.id);
  const b = fresh.filter((r) => r.swimlane_id === laneId).map((r) => r.id);
  let n = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
}

/** The live pill (#2370 clarifications): desktop "3 changes in Acme Corp · Show", phone "3 changes · Show" (the "· Show" is drawn). */
export function changesPillText(n: number, laneName: string, phone: boolean): string {
  return `${n} ${n === 1 ? "change" : "changes"}${phone ? "" : ` in ${laneName}`}`;
}

/** The column meter's fill, the whole column against its WIP limit (0-100), or null with no limit. */
export function columnMeterPct(col: { card_count: number; wip_limit: number | null }): number | null {
  if (col.wip_limit == null || col.wip_limit <= 0) return null;
  return Math.min(100, Math.round((col.card_count / col.wip_limit) * 100));
}

/** The shareable link to one lane in Children mode: `?show=children&lane=<lane id>`. */
export function laneLink(origin: string, boardId: number, laneId: number): string {
  return `${origin}/boards/${boardId}?show=children&lane=${laneId}`;
}

/**
 * "In progress" as the board shows it: not done and not planned (#2370 clarification 3, #2550). The ONE place the
 * frontend reads it: every count shown in Children mode, the lane action and the Children tab link come from here.
 * The server's `in_progress` is already `todo + doing + blocked` with planned children in their own `planned`
 * bucket (#2551 owner ruling), so this never subtracts `planned` and never re-derives the rule.
 */
export const shownInProgress = (c: { in_progress: number }) => c.in_progress;

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

/** The band total split for drawing: the bold in-progress count, then " of 16" or " · 2 planned". */
export function laneTotalParts(lane: Pick<ChildrenViewLane, "in_progress" | "planned" | "total">): { active: string; rest: string } {
  const active = `${shownInProgress(lane)} in progress`;
  return { active, rest: laneTotalLabel(lane).slice(active.length) };
}

/**
 * A collapsed band's "Work idle 9d" (canvas 6a): the card rollup's own idle rule (`movementLine`) over the lane's
 * server counts, so planned children never make a lane idle. Null when not idle.
 */
export function laneIdleLabel(
  lane: Pick<ChildrenViewLane, "total" | "done" | "doing" | "todo" | "blocked" | "planned" | "last_moved_at">,
  stalenessDays: number, now: number = Date.now(),
): string | null {
  const total = lane.total - lane.planned;
  if (total <= 0) return null;
  const m = movementLine({ visible: true, total, done: lane.done, doing: lane.doing, todo: lane.todo, blocked: lane.blocked, last_moved_at: lane.last_moved_at }, stalenessDays, now);
  return m.idle ? m.text : null;
}

/** The phone band's hidden count (#2370 phone text): shorter than the desktop's "on a board you can't open". */
export const phoneHiddenLabel = (n: number) => `+${n} you can't open`;

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

/**
 * The fold button, the same everywhere (#2370 clarification 1, #2550). `folded` is every folded parent and
 * `plannedOnly` the subset of them whose open work is all planned (the server's lane `folded` and `planned_only`).
 */
export function foldLabel(folded: number, plannedOnly: number): string {
  const n = folded;
  const base = `${n} ${n === 1 ? "parent" : "parents"} with nothing in progress`;
  return plannedOnly > 0 ? `${base} · ${plannedOnly} with only planned work` : base;
}

export const lockedRowText = (n: number) =>
  `${n} ${n === 1 ? "child" : "children"} on a board you can't open. Their columns and titles are not shown.`;

/** "+9 more parents · loads 20 rows at a time" (desktop) or "+9 more parents · load 20" (phone). */
export function moreParentsLabel(remaining: number, phone: boolean): string {
  return `+${remaining} more ${remaining === 1 ? "parent" : "parents"} · ${phone ? "load 20" : "loads 20 rows at a time"}`;
}

/**
 * A row folds when nothing is in progress (the server's `folded`), except that "Only planned" unfolds the rows whose
 * only open work is planned (`planned_only`, a subset of `folded`; #2370 clarification 1).
 */
export function isFoldedRow(row: ChildrenViewRow, planned: PlannedOption): boolean {
  if (!row.rollup.visible) return false;
  if (row.planned_only) return planned !== "only";
  return row.folded;
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

/**
 * A compact child card's accessible name: "title, column, owner, blocked", and for a manual block its age and reason
 * as the card draws them ("4d, blocked: IdP access", #2370 fix A13). A relation block has no reason and no age.
 */
export function childCardName(child: ChildrenViewChild, columnName: string, now: number = Date.now()): string {
  const parts = [child.title, columnName];
  if (child.assignee) parts.push(child.assignee.display_name || child.assignee.username);
  if (child.blocked) {
    const days = blockedDays(child, now);
    const reason = child.blocked_reason?.trim();
    parts.push(`${days != null ? `${days}d, ` : ""}blocked${reason ? `: ${reason}` : ""}`);
  }
  if (child.planned) parts.push("planned");
  return parts.join(", ");
}

/** A grid cell's accessible name: "Acme: analytics module, Blocked, 2 cards". */
export function cellName(parentTitle: string, columnName: string, count: number): string {
  return `${parentTitle}, ${columnName}, ${count} ${count === 1 ? "card" : "cards"}`;
}

/**
 * Phone (#2370 item 12, canvas 6b): a parent with nothing in the shown column says so in plain words. The canvas
 * draws only "Nothing blocked" (the Blocked column); every other column reads "Nothing in {column}".
 */
export function phoneEmptyCellText(columnName: string): string {
  return isBlockedColumnName(columnName) ? "Nothing blocked" : `Nothing in ${columnName}`;
}

/** A child-board column named Blocked (any case): the column, not the #449 blocked flag the band counts. */
export const isBlockedColumnName = (name: string) => name.trim().toLowerCase() === "blocked";

/** Under the phone column buttons when Blocked is shown (canvas 6b): why the band's count can differ from the column's. */
export const phoneBlockedColumnNote = (boardName: string) => `${boardName}'s columns. Blocked here is the column; the band counts the flag.`;

/**
 * A phone column button's count: the children the rows draw in that column under the options. The folded Done
 * column (Show done cards off) counts the rows' done rollups, the same number its "3 done · Show" cells say.
 */
export function phoneColumnCount(
  rows: ChildrenViewRow[],
  col: { id: number; is_done: boolean },
  options: ChildrenModeOptions,
): number {
  return rows.reduce((n, r) => {
    if (!r.rollup.visible) return n;
    if (col.is_done && !options.showDone) return n + r.rollup.done;
    return n + visibleChildren(r.children, options).filter((k) => k.column_id === col.id).length;
  }, 0);
}

/** The phone switch to a lane's other child board: "Onboarding · 2 children" (its rows' visible rollup totals). */
export function childBoardSwitchLabel(boardName: string, rows: ChildrenViewRow[]): string {
  const n = rows.reduce((sum, r) => sum + (r.rollup.visible ? r.rollup.total : 0), 0);
  return `${boardName} · ${n} ${n === 1 ? "child" : "children"}`;
}

/**
 * The switch's accessible name: "Show Onboarding, 2 children, columns". It keeps the visible words in order
 * ("Onboarding · 2 children · Columns ›") so WCAG 2.5.3 label-in-name holds.
 */
export function childBoardSwitchName(boardName: string, rows: ChildrenViewRow[]): string {
  const n = rows.reduce((sum, r) => sum + (r.rollup.visible ? r.rollup.total : 0), 0);
  return `Show ${boardName}, ${n} ${n === 1 ? "child" : "children"}, columns`;
}

/** Days since a manual block started, for the "⊘ 4d" line; null when not blocked or unknown. */
export function blockedDays(child: ChildrenViewChild, now: number = Date.now()): number | null {
  if (!child.blocked || !child.blocked_at) return null;
  return Math.max(0, Math.floor((now - Date.parse(child.blocked_at)) / 86_400_000));
}

/**
 * One lane's loaded parent rows in Children mode (#2370 fix A1/A5): rows are read per lane, so a collapsed lane can
 * open later and a lane past the first board-wide page still loads. `cursor` is the `next_cursor` that continues this
 * lane (null when every row is loaded). `owner` says which read keeps it fresh on a live re-read: "page" lanes come
 * from the main read (board-wide, or the focused or linked lane), "lane" lanes from their own `?lane=` read.
 */
export interface LaneRows { rows: ChildrenViewRow[]; cursor: string | null; owner: "page" | "lane" }
export type LaneStore = Readonly<Record<number, LaneRows>>;

/**
 * Adds one page of `children-view` rows (server order) to the store. A read limited to `scope` fills that lane. A
 * board-wide page fills every lane from `fromLane` (the lane its cursor continued, or the first lane) to the lane of
 * its last row: lanes it passed are complete, the last one keeps the cursor, and with no next cursor every later lane
 * is complete too. Lanes with their own read ("lane") are left to it. Rows already loaded are never added twice.
 */
export function addPage(
  store: LaneStore, laneIds: readonly number[], page: { rows: ChildrenViewRow[]; next_cursor: string | null },
  scope: number | null, owner: LaneRows["owner"], fromLane: number | null = null,
): LaneStore {
  const out: Record<number, LaneRows> = { ...store };
  const add = (id: number, rows: ChildrenViewRow[], cursor: string | null) => {
    const prev = out[id]?.rows ?? [];
    const seen = new Set(prev.map((r) => r.id));
    out[id] = { rows: [...prev, ...rows.filter((r) => !seen.has(r.id))], cursor, owner };
  };
  if (scope != null) {
    add(scope, page.rows, page.next_cursor);
    return out;
  }
  const last = page.rows.length ? page.rows[page.rows.length - 1].swimlane_id : null;
  const start = fromLane != null ? Math.max(0, laneIds.indexOf(fromLane)) : 0;
  const end = page.next_cursor == null ? laneIds.length - 1 : laneIds.indexOf(last as number);
  for (let i = start; i <= end; i++) {
    const id = laneIds[i];
    if (out[id]?.owner === "lane") continue;
    add(id, page.rows.filter((r) => r.swimlane_id === id), i === end ? page.next_cursor : null);
  }
  return out;
}

/** The lane the main board-wide read continues from ("+N more parents" there reads the next board-wide page). */
export function frontierLane(store: LaneStore): number | null {
  for (const [id, v] of Object.entries(store)) if (v.owner === "page" && v.cursor != null) return Number(id);
  return null;
}

/** How many rows the main read had loaded: a live re-read follows next_cursor until it covers them again. */
export const pageRowCount = (store: LaneStore) => Object.values(store).reduce((n, v) => n + (v.owner === "page" ? v.rows.length : 0), 0);
