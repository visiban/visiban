/** Pure helpers for the parent card's child-progress footer (#2210). */
import type { CardChildrenRollup as Rollup, CardChildrenRollupVisible } from "../../types";

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
      text: age ? `Last work done ${age}` : "All done",
      spoken: age ? `last done ${age}` : "all done",
      tone: "success", idle: false,
    };
  }
  if (r.todo === r.total) return { text: "No work started", spoken: "none started", tone: "neutral", idle: false };
  if (r.last_moved_at) {
    const days = Math.floor((now - new Date(r.last_moved_at).getTime()) / DAY_MS);
    if (stalenessDays > 0 && days >= stalenessDays) {
      const text = `work idle ${days} ${days === 1 ? "day" : "days"}`;
      return { text: `W${text.slice(1)}`, spoken: text, tone: "warning", idle: true };
    }
    const age = relativeAge(r.last_moved_at, now);
    return { text: `Work moved ${age}`, spoken: `work moved ${age}`, tone: "neutral", idle: false };
  }
  return { text: "No work started", spoken: "none started", tone: "neutral", idle: false };
}

/** The footer's one accessible sentence; always begins "Children: " (#2210 § Accessibility). */
export function rollupSentence(r: Rollup, movement: Movement | null): string {
  if (!r.visible) {
    return `Children: ${r.total} on a board you can't open`;
  }
  if (r.total === 0) return "Children: none";
  if (r.done === r.total) return `Children: all ${r.total} done${movement ? `, ${movement.spoken}` : ""}`;
  const head = r.blocked === r.total
    ? `Children: all ${r.total} blocked`
    : [
        `Children: ${r.done} of ${r.total} done`,
        r.doing ? `${r.doing} doing` : null,
        r.blocked ? `${r.blocked} blocked` : "none blocked",
        r.todo ? `${r.todo} to do` : null,
      ].filter(Boolean).join(", ");
  return movement ? `${head}, ${movement.spoken}` : head;
}

