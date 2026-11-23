/**
 * Pure view-model helpers for the Home status page (#2474): the greeting, the summary line, the
 * per-board stale/blocked signals, the All boards filters and the Needs attention ranking. Kept
 * out of the page so each copy rule and ordering rule is unit-tested on its own.
 */
import type { Board, Group, User } from "../../types";
import { HEALTH_STATUS_LABELS } from "../../constants/healthStatus";
import { healthReviewCue } from "../../utils/healthStatus";
import type { RecentBoardEntry } from "../../hooks/useRecentBoardsPref";

export const NO_DATA_TITLE = "Turn on auto health in Board settings to see stale and blocked counts";

export type BoardFilter = "all" | "starred" | "personal" | "at_risk";

export const EMPTY_COPY: Record<BoardFilter, string> = {
  all: "No boards yet. Use New board, or Import one.",
  starred: "No starred boards yet. Star a board to pin it here and in the drawer.",
  personal: "No personal boards. Boards you create outside a group appear here.",
  at_risk: "No boards are at risk.",
};

export function greeting(user: Pick<User, "first_name" | "display_name" | "username">, now: Date = new Date()): string {
  const h = now.getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const name = user.first_name?.trim() || user.display_name?.trim() || user.username;
  return `${part}, ${name}`;
}

export function firstName(user: Pick<User, "first_name" | "display_name" | "username">): string {
  return user.first_name?.trim() || user.display_name?.trim() || user.username;
}

/** Stale and blocked counts, or null where auto health is off ("no data", never 0). */
export interface Signals {
  stale: number;
  blocked: number;
}

export function boardSignals(b: Pick<Board, "health_auto_enabled" | "health_computed_counts">): Signals | null {
  if (!b.health_auto_enabled || !b.health_computed_counts) return null;
  return { stale: b.health_computed_counts.stale, blocked: b.health_computed_counts.blocked };
}

/** "At risk" covers both worse-than-on-track states, so an off-track board is never hidden from it. */
export function isAtRisk(b: Pick<Board, "effective_health_status">): boolean {
  return b.effective_health_status === "at_risk" || b.effective_health_status === "off_track";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface SummaryParts {
  boards: number;
  groups: number;
  atRisk: number;
  stale: number;
  blocked: number;
  autoBoards: number;
}

export function summarize(boards: Board[], groups: Group[]): SummaryParts {
  let stale = 0;
  let blocked = 0;
  let autoBoards = 0;
  for (const b of boards) {
    const s = boardSignals(b);
    if (!s) continue;
    autoBoards += 1;
    stale += s.stale;
    blocked += s.blocked;
  }
  return {
    boards: boards.length,
    groups: groups.filter((g) => !g.navigation_only).length,
    atRisk: boards.filter((board) => isAtRisk(board)).length,
    stale,
    blocked,
    autoBoards,
  };
}

/** Desktop clauses. Any clause whose count is 0 is left out; never "this week" (a snapshot). */
export function summaryClauses(s: SummaryParts): { lead: string; atRisk: string | null; signals: string | null } {
  const lead = s.groups > 0 ? `${plural(s.boards, "board", "boards")} across ${plural(s.groups, "group", "groups")}.` : `${plural(s.boards, "board", "boards")}.`;
  const atRisk = s.atRisk > 0 ? `${plural(s.atRisk, "board", "boards")} ${s.atRisk === 1 ? "is" : "are"} at risk.` : null;
  const counted: string[] = [];
  if (s.stale > 0) counted.push(`${s.stale} stale`);
  if (s.blocked > 0) counted.push(`${s.blocked} blocked`);
  const signals =
    counted.length > 0 && s.autoBoards > 0
      ? `${counted.join(" and ")} ${s.stale + s.blocked === 1 ? "card" : "cards"} on the ${plural(s.autoBoards, "board", "boards")} with auto health on.`
      : null;
  return { lead, atRisk, signals };
}

/** Phone summary: "N board at risk · N stale, N blocked on boards with auto health". */
export function phoneSummary(s: SummaryParts): string | null {
  const parts: string[] = [];
  if (s.atRisk > 0) parts.push(`${s.atRisk} ${s.atRisk === 1 ? "board" : "boards"} at risk`);
  const counted: string[] = [];
  if (s.stale > 0) counted.push(`${s.stale} stale`);
  if (s.blocked > 0) counted.push(`${s.blocked} blocked`);
  if (counted.length > 0 && s.autoBoards > 0) parts.push(`${counted.join(", ")} on boards with auto health`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function filterBoards(boards: Board[], filter: BoardFilter): Board[] {
  switch (filter) {
    case "starred": return boards.filter((b) => b.is_starred);
    case "personal": return boards.filter((b) => !b.group);
    case "at_risk": return boards.filter((board) => isAtRisk(board));
    default: return boards;
  }
}

export function filterCounts(boards: Board[]): Record<BoardFilter, number> {
  return {
    all: boards.length,
    starred: filterBoards(boards, "starred").length,
    personal: filterBoards(boards, "personal").length,
    at_risk: filterBoards(boards, "at_risk").length,
  };
}

/** All boards order: starred first, then most recently updated. */
export function sortBoards(boards: Board[]): Board[] {
  return boards.slice().sort((a, b) => {
    if (a.is_starred !== b.is_starred) return a.is_starred ? -1 : 1;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || a.name.localeCompare(b.name);
  });
}

export interface AttentionItem {
  kind: "board" | "group";
  id: number;
  name: string;
  meta: string;
  severity: "danger" | "warning";
  blocked: number;
  stale: number;
  overdueDays: number;
}

/**
 * Boards and subgroups with stale or blocked cards, or overdue for a health review, worst
 * first: blocked count, then stale count, then days overdue, each highest first. Board- and
 * subgroup-level only; card-level rows wait for #1358. A top-level group is not listed: the
 * Groups card already shows it.
 */
export function needsAttention(boards: Board[], groups: Group[], now: number = Date.now()): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const b of boards) {
    const s = boardSignals(b);
    const cue = healthReviewCue(b, now);
    const stale = s?.stale ?? 0;
    const blocked = s?.blocked ?? 0;
    if (stale === 0 && blocked === 0 && !cue) continue;
    const counts = [stale > 0 ? `${stale} stale` : null, blocked > 0 ? `${blocked} blocked` : null].filter(Boolean).join(", ");
    const status = b.effective_health_status ? HEALTH_STATUS_LABELS[b.effective_health_status] : null;
    let meta: string;
    if (counts) {
      meta = [counts, status].filter(Boolean).join(" · ");
      if (cue) meta += ` · ${cue.text.replace(/^Not/, "not")}`;
    } else {
      meta = `Health status ${cue!.text.replace(/^Not/, "not")}`;
    }
    items.push({ kind: "board", id: b.id, name: b.name, meta, severity: blocked > 0 ? "danger" : "warning", blocked, stale, overdueDays: cue?.days ?? 0 });
  }
  for (const g of groups) {
    if (g.parent === null || g.navigation_only) continue;
    const cue = healthReviewCue(g, now);
    if (!cue) continue;
    items.push({ kind: "group", id: g.id, name: g.name, meta: `Health status ${cue.text.replace(/^Not/, "not")}`, severity: "warning", blocked: 0, stale: 0, overdueDays: cue.days });
  }
  return items.sort((a, b) => b.blocked - a.blocked || b.stale - a.stale || b.overdueDays - a.overdueDays || a.name.localeCompare(b.name));
}

/** "<N> ago" for a Jump back in tile; "" when the entry predates `openedAt`. */
export function openedAgo(openedAt: number | undefined, now: number = Date.now()): string {
  if (typeof openedAt !== "number") return "";
  const mins = Math.max(0, Math.floor((now - openedAt) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export interface RecentTile {
  board: Board;
  entry: RecentBoardEntry;
}

/** Up to 3 recents that still resolve to a board in the loaded list (deleted ones drop out). */
export function recentTiles(recents: RecentBoardEntry[], boards: Board[]): RecentTile[] {
  const byId = new Map(boards.map((b) => [b.id, b]));
  const out: RecentTile[] = [];
  for (const entry of recents) {
    const board = byId.get(entry.id);
    if (board) out.push({ board, entry });
    if (out.length === 3) break;
  }
  return out;
}

/** Side lists (Needs attention, Groups) show this many rows until "Show all" (#2487). */
export const SIDE_LIST_CAP = 5;

/** The rows a capped side list shows: the first `SIDE_LIST_CAP`, or every row once expanded. */
export function capSideList<T>(items: readonly T[], expanded: boolean, cap: number = SIDE_LIST_CAP): T[] {
  return expanded ? items.slice() : items.slice(0, cap);
}

/** The "Show all" toggle's text: "Show all N" while capped, "Show fewer" once expanded (#2487). */
export function sideListToggleLabel(total: number, expanded: boolean): string {
  return expanded ? "Show fewer" : `Show all ${total}`;
}

/** Avatars a group row's stack draws before its "+N" badge (#2487). */
export const GROUP_AVATAR_LIMIT = 3;

/**
 * A group row's avatar stack (#2487): the members the server previewed (`member_preview`, first
 * by join date), or the owner alone on an older server that sends none, capped at
 * `GROUP_AVATAR_LIMIT`; `more` is how many members the "+N" badge stands for. Never negative.
 */
export function groupAvatarStack(group: Pick<Group, "owner" | "member_count" | "member_preview">): { users: Group["owner"][]; more: number } {
  const preview = group.member_preview && group.member_preview.length > 0 ? group.member_preview : [group.owner];
  const users = preview.slice(0, GROUP_AVATAR_LIMIT);
  return { users, more: Math.max(0, group.member_count - users.length) };
}
