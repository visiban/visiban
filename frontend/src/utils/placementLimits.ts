/**
 * Client-side mirror of the server's placement-limit rules (#1150), for the
 * surfaces that must say what a drop would do before the request is sent (the
 * drop ring, the keyboard-move live region) and for naming every tripped limit
 * after a refusal (the server's 409 body names only the strictest one).
 *
 * The server stays authoritative: `boards.services.cards.enforce_column_limits`
 * decides, and these helpers only predict. Keep the two in step:
 *
 * - a column limit applies only when the card enters a different column;
 * - a swimlane limit applies only when the move adds to the swimlane's counted
 *   total: the target column counts for the swimlane, and the card does not
 *   already count there (another swimlane, an uncounted column of this one,
 *   or a create/restore). A move between two counted columns never trips it;
 * - modes: a swimlane with `limit_enforcement` null inherits the board flags,
 *   exactly as a column does; weight has no hard mode;
 * - strictest first: hard before block, then column before swimlane, then WIP
 *   before weight.
 */
import type { Card, Column, Swimlane } from "../types";

export interface LimitFlags {
  enforce_wip_limits: boolean;
  enforce_wip_hard: boolean;
  enforce_weight_limits: boolean;
}

export type LimitMode = "hard" | "block";

interface Modes {
  wip: LimitMode | null;
  weight: LimitMode | null;
}

export function columnLimitModes(flags: LimitFlags): Modes {
  return {
    wip: flags.enforce_wip_hard ? "hard" : flags.enforce_wip_limits ? "block" : null,
    weight: flags.enforce_weight_limits ? "block" : null,
  };
}

export function swimlaneLimitModes(flags: LimitFlags, lane: Swimlane): Modes {
  if (lane.limit_enforcement === "hard") return { wip: "hard", weight: "block" };
  if (lane.limit_enforcement === "block") return { wip: "block", weight: "block" };
  return columnLimitModes(flags);
}

/** Whether cards in `column` count toward `lane`'s limits. */
export function laneCountsColumn(lane: Swimlane, column: Pick<Column, "id" | "is_done">): boolean {
  const ids = lane.limit_column_ids ?? null;
  return ids === null ? !column.is_done : ids.includes(column.id);
}

/** Ids of the columns that count toward `lane`'s limits. */
export function laneCountedColumnIds(lane: Swimlane, columns: Column[]): Set<number> {
  return new Set(columns.filter((c) => laneCountsColumn(lane, c)).map((c) => c.id));
}

export interface LaneUsage {
  count: number;
  weight: number;
}

/** Active cards (and their weight) in `lane`'s counted columns, excluding `excludeCardId`. */
export function laneUsage(lane: Swimlane, columns: Column[], cards: Card[], excludeCardId?: number): LaneUsage {
  const counted = laneCountedColumnIds(lane, columns);
  let count = 0;
  let weight = 0;
  for (const c of cards) {
    if (c.swimlane !== lane.id || c.archived_at || c.id === excludeCardId || !counted.has(c.column)) continue;
    count += 1;
    weight += c.weight;
  }
  return { count, weight };
}

export type LaneLimitState = "under" | "at" | "overWip" | "overWeight";

/**
 * The row header's single state, worst offender first (Over WIP > Over weight
 * > At > Under), mirroring the column header (#973). Null when the lane has no
 * limit at all.
 */
export function laneLimitState(lane: Swimlane, usage: LaneUsage): LaneLimitState | null {
  const wip = lane.wip_limit ?? null;
  const weight = lane.weight_limit ?? null;
  if (wip === null && weight === null) return null;
  if (wip !== null && usage.count > wip) return "overWip";
  if (weight !== null && usage.weight > weight) return "overWeight";
  if ((wip !== null && usage.count === wip) || (weight !== null && usage.weight === weight)) return "at";
  return "under";
}

export interface TrippedLimit {
  scope: "column" | "swimlane";
  kind: "wip" | "weight";
  mode: LimitMode;
  name: string;
  /** Cards (wip) or weight (weight) already counted, the moved card excluded. */
  current: number;
  limit: number;
  cardWeight: number;
}

interface VerdictInput {
  flags: LimitFlags;
  columns: Column[];
  cards: Card[];
  /** The card being placed, as it is now (its current cell and weight). */
  card: Pick<Card, "id" | "column" | "swimlane" | "weight" | "archived_at">;
  column: Column;
  lane: Swimlane;
}

/**
 * Every limit a move of `card` into (`column`, `lane`) would trip, strictest
 * first. Empty when the move is allowed (or not checked at all).
 */
export function placementVerdict({ flags, columns, cards, card, column, lane }: VerdictInput): TrippedLimit[] {
  const tripped: TrippedLimit[] = [];
  const others = cards.filter((c) => c.id !== card.id && !c.archived_at);

  if (card.column !== column.id) {
    const modes = columnLimitModes(flags);
    const inColumn = others.filter((c) => c.column === column.id);
    if (modes.wip && column.wip_limit !== null && inColumn.length >= column.wip_limit) {
      tripped.push({ scope: "column", kind: "wip", mode: modes.wip, name: column.name, current: inColumn.length, limit: column.wip_limit, cardWeight: card.weight });
    }
    const weight = inColumn.reduce((sum, c) => sum + c.weight, 0);
    if (modes.weight && column.weight_limit !== null && weight + card.weight > column.weight_limit) {
      tripped.push({ scope: "column", kind: "weight", mode: modes.weight, name: column.name, current: weight, limit: column.weight_limit, cardWeight: card.weight });
    }
  }

  const sourceColumn = columns.find((c) => c.id === card.column);
  const alreadyCounted = card.swimlane === lane.id && sourceColumn !== undefined && laneCountsColumn(lane, sourceColumn);
  if (laneCountsColumn(lane, column) && !alreadyCounted) {
    const modes = swimlaneLimitModes(flags, lane);
    const usage = laneUsage(lane, columns, others);
    const wipLimit = lane.wip_limit ?? null;
    const weightLimit = lane.weight_limit ?? null;
    if (modes.wip && wipLimit !== null && usage.count >= wipLimit) {
      tripped.push({ scope: "swimlane", kind: "wip", mode: modes.wip, name: lane.name, current: usage.count, limit: wipLimit, cardWeight: card.weight });
    }
    if (modes.weight && weightLimit !== null && usage.weight + card.weight > weightLimit) {
      tripped.push({ scope: "swimlane", kind: "weight", mode: modes.weight, name: lane.name, current: usage.weight, limit: weightLimit, cardWeight: card.weight });
    }
  }

  // Array.prototype.sort is stable: the push order above (column before
  // swimlane, WIP before weight) breaks ties, as on the server.
  return tripped.sort((a, b) => Number(a.mode !== "hard") - Number(b.mode !== "hard"));
}

/** One sentence per tripped limit, for live regions and the toast's second line. */
export function trippedLimitSentence(t: TrippedLimit): string {
  const subject = t.scope === "swimlane" ? `Swimlane "${t.name}"` : `Column "${t.name}"`;
  const override = t.mode === "hard" ? "no one can override it" : "admins can override";
  if (t.kind === "wip") {
    return `${subject} is at its WIP limit (${t.current}/${t.limit}), ${override}.`;
  }
  return `${subject} would go over its weight limit (${t.current + t.cardWeight}/${t.limit}), ${override}.`;
}

/** Short visible label for a blocked drop target. */
export function trippedLimitLabel(t: TrippedLimit): string {
  const what = t.kind === "wip" ? "WIP" : "weight";
  const value = t.kind === "wip" ? `${t.current}/${t.limit}` : `${t.current + t.cardWeight}/${t.limit}`;
  return `${t.name} at ${what} limit · ${value}`;
}

/**
 * Drop a deleted column's id from every swimlane's `limit_column_ids` (#1150),
 * as the server's column-delete cleanup does: a list left empty becomes null
 * (the default). The server sends no swimlane frame for it, so the client
 * applies it on `column.deleted` itself. Returns the same array when no lane
 * named the column.
 */
export function pruneLaneLimitColumn(swimlanes: Swimlane[], columnId: number): Swimlane[] {
  if (!swimlanes.some((s) => s.limit_column_ids?.includes(columnId))) return swimlanes;
  return swimlanes.map((s) => {
    if (!s.limit_column_ids?.includes(columnId)) return s;
    const kept = s.limit_column_ids.filter((id) => id !== columnId);
    return { ...s, limit_column_ids: kept.length > 0 ? kept : null };
  });
}
