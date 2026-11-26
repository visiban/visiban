/** Pure helpers for the parent card's child-progress footer (#2210). */
import type { CardChildrenRollup as Rollup, CardChildrenRollupVisible } from "../../types";
import { formatShortMonthDay } from "../../utils/cardStatusLine";

/** Above this many children the segment bar becomes one proportional meter (#2210). */
export const ROLLUP_SEGMENT_MAX = 8;

const DAY_MS = 86_400_000;

/** "just now", "3 hours ago", "1 day ago", "9 days ago" (canvas v24 wording, #2210). */
export function relativeAge(iso: string, now: number): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(ms / DAY_MS);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** The visible short form (canvas v24 ruling): "just now", "3h ago", "2d ago". The spoken text keeps `relativeAge`. */
export function shortAge(iso: string, now: number): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(ms / DAY_MS)}d ago`;
}

export type Tone = "neutral" | "warning" | "success";

export interface Movement {
  text: string;
  /** The movement clause of the accessible sentence. */
  spoken: string;
  tone: Tone;
  idle: boolean;
}

/** Row 2 of the footer: which movement case applies (#2210 movement-line table). */
export function movementLine(r: CardChildrenRollupVisible, stalenessDays: number, now: number): Movement {
  const allDone = r.done === r.total;
  if (allDone) {
    const age = r.last_moved_at ? relativeAge(r.last_moved_at, now) : "";
    return {
      text: age ? `Last work done ${shortAge(r.last_moved_at!, now)}` : "All done",
      spoken: age ? `last done ${age}` : "all done",
      tone: "success", idle: false,
    };
  }
  if (r.todo === r.total) return { text: "No work started", spoken: "none started", tone: "neutral", idle: false };
  if (r.last_moved_at) {
    const days = Math.floor((now - new Date(r.last_moved_at).getTime()) / DAY_MS);
    if (stalenessDays > 0 && days >= stalenessDays) {
      return { text: `Work idle ${days}d`, spoken: `work idle ${days} ${days === 1 ? "day" : "days"}`, tone: "warning", idle: true };
    }
    const age = relativeAge(r.last_moved_at, now);
    return { text: `Work moved ${shortAge(r.last_moved_at, now)}`, spoken: `work moved ${age}`, tone: "neutral", idle: false };
  }
  return { text: "No work started", spoken: "none started", tone: "neutral", idle: false };
}

/**
 * The rollup without its planned children (#2551, #2371 § 3): "No work started", "Work idle" and "All done"
 * describe only the work needed now, so the movement line reads this. The server already leaves planned children
 * out of every state and `last_moved_at`; only `total` still counts them.
 */
export function neededNow(r: CardChildrenRollupVisible): CardChildrenRollupVisible {
  return { ...r, total: r.total - (r.planned ?? 0) };
}

/** A row-2 warning (#2551): warning text, no glyph (the clock means Stale or idle only, #2206 rule 4). */
export interface RollupWarning {
  text: string;
  spoken: string;
}

/**
 * The two parent warnings, not started first: "Qualify: 1 child not started" for children the parent's move
 * released that have not moved, and "1 planned date has passed: Dec 4" (the earliest) for planned children whose
 * stored date is before `today` (YYYY-MM-DD, the same comparison as the child's "passed while planned" line).
 */
export function rollupWarnings(r: CardChildrenRollupVisible, today: string): RollupWarning[] {
  const out: RollupWarning[] = [];
  for (const { column_name, count } of r.needed_not_started ?? []) {
    const text = `${column_name}: ${count} ${count === 1 ? "child" : "children"} not started`;
    out.push({ text, spoken: text });
  }
  const passed = (r.planned_due_dates ?? []).filter((d) => d < today);
  if (passed.length > 0) {
    const day = formatShortMonthDay(passed[0]);
    const head = `${passed.length} planned ${passed.length === 1 ? "date has" : "dates have"} passed`;
    out.push({ text: `${head}: ${day}`, spoken: `${head}, ${day}` });
  }
  return out;
}

/** Row 2's visible text when it is not a warning: "2 planned · work moved 1d ago", or "2 planned" alone. */
export function plannedPrefix(planned: number, movement: Movement | null): string | null {
  if (!planned) return null;
  if (!movement) return `${planned} planned`;
  return `${planned} planned · ${movement.text.charAt(0).toLowerCase()}${movement.text.slice(1)}`;
}

/** The footer's one accessible sentence; always begins "Children: " (#2210 § Accessibility). */
export function rollupSentence(r: Rollup, movement: Movement | null, warnings: RollupWarning[] = []): string {
  if (!r.visible) {
    return `Children: ${r.total} on a board you can't open`;
  }
  if (r.total === 0) return "Children: none";
  const planned = r.planned ?? 0;
  if (r.done === r.total) return `Children: all ${r.total} done${movement ? `, ${movement.spoken}` : ""}`;
  const head = r.blocked === r.total
    ? `Children: all ${r.total} blocked`
    : [
        `Children: ${r.done} of ${r.total} done`,
        r.doing ? `${r.doing} doing` : null,
        r.blocked ? `${r.blocked} blocked` : "none blocked",
        r.todo ? `${r.todo} to do` : null,
        planned ? `${planned} planned for later columns` : null,
      ].filter(Boolean).join(", ");
  // A warning replaces the movement clause, as it replaces the visible movement line (canvas v24 § 3).
  if (warnings.length > 0) return `${head}; ${warnings.map((w) => w.spoken).join("; ")}`;
  return movement ? `${head}, ${movement.spoken}` : head;
}
