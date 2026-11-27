/**
 * Lane sort (#2698): a per-viewer view of the swimlanes, never a mutation.
 *
 * Everything here is pure. Applying a sort only reorders what this viewer
 * renders; `Swimlane.position` changes only through manual reorder or the
 * explicit "Save as board order" action (#2699). The sort lives in the board
 * URL (#2318 conventions: replace, defaults never written, unknown values
 * ignored), never in browser storage or on the server. Phase B ("My view",
 * #2705) will add a server-side saved order; nothing here assumes there is none.
 */
import type { Card, Column, CustomFieldDefinition, HealthStatus, Swimlane, SwimlaneCustomFieldDefinition } from "../types";
import { parseMultiSelect } from "./customFieldValue";
import { laneUsage } from "./placementLimits";

/** `name`, `health`, `card_count`, `wip`, `f:<lane field id>`, `sum:<card number field id>`. */
export type LaneSortKey = string;

export interface LaneSort {
  key: LaneSortKey;
  /** false = the field type's default (first-listed) direction. */
  reverse: boolean;
  /** Tie-breaker, in its own default direction (no direction control). */
  then: LaneSortKey | null;
  /** Lanes with no value: last (default, in both directions) or first. */
  emptyFirst: boolean;
  /** Pinned lane ids; they ignore the sort and keep board order among themselves. */
  pins: number[];
  /** #2700 — "Keep sorted as things change", on by default. */
  keepSorted: boolean;
}

export const LANE_SORT_PARAMS = {
  key: "lsort",
  dir: "lsort_dir",
  then: "lsort_then",
  empty: "lsort_empty",
  pins: "lsort_pins",
  keep: "lsort_keep",
} as const;

const KEY_RE = /^(name|health|card_count|wip|f:\d{1,10}|sum:\d{1,10})$/;
const MAX_PINS = 200;

/** Parse the sort from the URL. Unknown or malformed values are ignored, never an error. */
export function parseLaneSortParams(params: URLSearchParams): LaneSort | null {
  const key = params.get(LANE_SORT_PARAMS.key);
  if (!key || !KEY_RE.test(key)) return null;
  const thenRaw = params.get(LANE_SORT_PARAMS.then);
  const then = thenRaw && KEY_RE.test(thenRaw) && thenRaw !== key ? thenRaw : null;
  const pins = [...new Set((params.get(LANE_SORT_PARAMS.pins) ?? "")
    .split(",")
    .filter((s) => /^\d{1,10}$/.test(s))
    .map(Number))].slice(0, MAX_PINS);
  return {
    key,
    reverse: params.get(LANE_SORT_PARAMS.dir) === "r",
    then,
    emptyFirst: params.get(LANE_SORT_PARAMS.empty) === "first",
    pins,
    keepSorted: params.get(LANE_SORT_PARAMS.keep) !== "0",
  };
}

/** Write the sort into `params` (mutates and returns it). Defaults are never written. */
export function writeLaneSortParams(params: URLSearchParams, sort: LaneSort | null): URLSearchParams {
  for (const p of Object.values(LANE_SORT_PARAMS)) params.delete(p);
  if (!sort) return params;
  params.set(LANE_SORT_PARAMS.key, sort.key);
  if (sort.reverse) params.set(LANE_SORT_PARAMS.dir, "r");
  if (sort.then) params.set(LANE_SORT_PARAMS.then, sort.then);
  if (sort.emptyFirst) params.set(LANE_SORT_PARAMS.empty, "first");
  if (sort.pins.length) params.set(LANE_SORT_PARAMS.pins, sort.pins.join(","));
  if (!sort.keepSorted) params.set(LANE_SORT_PARAMS.keep, "0");
  return params;
}

export function newLaneSort(key: LaneSortKey): LaneSort {
  return { key, reverse: false, then: null, emptyFirst: false, pins: [], keepSorted: true };
}

type Kind = "text" | "number" | "date" | "dropdown" | "multi_select" | "checkbox" | "health" | "count" | "wip" | "sum";

export interface LaneSortOption {
  key: LaneSortKey;
  label: string;
  group: "Lane" | "Custom fields" | "Computed";
  kind: Kind;
  /** [default direction, reverse direction] labels, as the popover shows them. */
  directions: [string, string];
  /** Name and Card count always have a value: the "Lanes with no value" control is hidden. */
  alwaysHasValue: boolean;
  /** For dropdown / multi-select: the option order. */
  choices?: string[];
}

const TEXT_DIRS: [string, string] = ["A → Z", "Z → A"];

function directionsFor(kind: Kind, choices: string[]): [string, string] {
  switch (kind) {
    case "text": return TEXT_DIRS;
    case "number": return ["Highest first", "Lowest first"];
    case "date": return ["Newest first", "Oldest first"];
    case "dropdown": {
      const first = choices[0] ?? "";
      const last = choices[choices.length - 1] ?? "";
      return [`${first} → ${last}`, `${last} → ${first}`];
    }
    case "multi_select": return ["Option order", "Reverse option order"];
    case "checkbox": return ["Checked first", "Unchecked first"];
    case "health": return ["Off track → On track", "On track → Off track"];
    case "count": return ["Most first", "Fewest first"];
    case "wip": return ["Fullest first", "Emptiest first"];
    case "sum": return ["Highest first", "Lowest first"];
  }
}

function kindForLaneField(t: string): Kind {
  if (t === "number" || t === "date" || t === "dropdown" || t === "multi_select" || t === "checkbox") return t;
  // text, url and any type a newer server sends: sort as text.
  return "text";
}

/**
 * Every key this viewer may sort by. A lane field this viewer cannot read
 * (admin-only, for a member) is left out: its values are absent from the
 * payload, so sorting by it would silently sort by nothing.
 */
export function laneSortOptions(
  laneFields: readonly SwimlaneCustomFieldDefinition[],
  cardFields: readonly CustomFieldDefinition[],
  isAdmin: boolean,
): LaneSortOption[] {
  const opt = (key: string, label: string, group: LaneSortOption["group"], kind: Kind, alwaysHasValue: boolean, choices: string[] = []): LaneSortOption => ({
    key, label, group, kind, alwaysHasValue, directions: directionsFor(kind, choices), ...(choices.length ? { choices } : {}),
  });
  return [
    opt("name", "Name", "Lane", "text", true),
    opt("health", "Health", "Lane", "health", false),
    ...laneFields
      .filter((f) => isAdmin || !f.is_admin_only)
      .map((f) => opt(`f:${f.id}`, f.name, "Custom fields", kindForLaneField(f.field_type), false, f.choices ?? [])),
    opt("card_count", "Card count", "Computed", "count", true),
    opt("wip", "WIP usage", "Computed", "wip", false),
    ...cardFields
      .filter((f) => f.field_type === "number")
      .map((f) => opt(`sum:${f.id}`, `Sum of ${f.name}`, "Computed", "sum", false)),
  ];
}

/** What the sort can see of the board. `shownCardIds` null = no card filter. */
export interface LaneSortContext {
  cards: readonly Card[];
  columns: readonly Column[];
  shownCardIds: ReadonlySet<number> | null;
}

/** A comparable value, ordered ascending in the option's default direction; null = no value. */
type Rank = number | string | null;

const HEALTH_RANK: Record<HealthStatus, number> = { off_track: 0, at_risk: 1, on_track: 2 };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function cardsInLane(lane: Swimlane, ctx: LaneSortContext): Card[] {
  return ctx.cards.filter((c) => c.swimlane === lane.id && !c.archived_at && (ctx.shownCardIds === null || ctx.shownCardIds.has(c.id)));
}

function laneFieldRaw(lane: Swimlane, fieldId: number): string | null {
  const v = lane.custom_field_values?.find((x) => x.field_definition === fieldId)?.value;
  return v === undefined || v === null || v === "" ? null : v;
}

/**
 * The raw sort value of `lane` for `opt`, before direction is applied.
 * Card count and Sum read the shown cards while a card filter is on (owner
 * decision 2026-11-27), so the order always matches the totals on the band;
 * WIP usage always reads the whole lane, as the band's WIP line does.
 */
export function laneSortValue(lane: Swimlane, opt: LaneSortOption, ctx: LaneSortContext): number | string | null {
  switch (opt.kind) {
    case "health": return lane.effective_health_status ?? null;
    case "count": return cardsInLane(lane, ctx).length;
    case "wip": {
      if (!lane.wip_limit) return null;
      return laneUsage(lane, ctx.columns as Column[], ctx.cards as Card[]).count / lane.wip_limit;
    }
    case "sum": {
      const fieldId = Number(opt.key.slice(4));
      let total = 0;
      let any = false;
      for (const c of cardsInLane(lane, ctx)) {
        const raw = c.custom_field_values?.find((v) => v.field_definition === fieldId)?.value;
        const n = raw === undefined || raw === "" ? NaN : Number(raw);
        if (Number.isFinite(n)) { total += n; any = true; }
      }
      return any ? total : null;
    }
    default:
      if (opt.key === "name") return lane.name;
      return laneFieldRaw(lane, Number(opt.key.slice(2)));
  }
}

function rankOf(lane: Swimlane, opt: LaneSortOption, ctx: LaneSortContext): Rank {
  const v = laneSortValue(lane, opt, ctx);
  if (v === null) return null;
  switch (opt.kind) {
    case "text": return String(v);
    case "health": return HEALTH_RANK[v as HealthStatus] ?? null;
    // Biggest on top by default: negate so ascending puts it first.
    case "count": case "wip": case "sum": return -(v as number);
    case "number": { const n = Number(v); return Number.isFinite(n) ? -n : null; }
    case "date": { const t = Date.parse(String(v)); return Number.isFinite(t) ? -t : null; }
    case "checkbox": return v === "true" ? 0 : v === "false" ? 1 : null;
    case "dropdown": { const i = (opt.choices ?? []).indexOf(String(v)); return i < 0 ? null : i; }
    case "multi_select": {
      // The lane's first selected option in option order.
      const idx = parseMultiSelect(String(v)).map((s) => (opt.choices ?? []).indexOf(s)).filter((i) => i >= 0);
      return idx.length ? Math.min(...idx) : null;
    }
  }
}

function cmpRank(a: Rank, b: Rank): number {
  if (typeof a === "string" && typeof b === "string") return collator.compare(a, b);
  return (a as number) - (b as number);
}

export interface LaneSortResult {
  /** Every lane, in this viewer's order (hidden lanes keep their sorted place). */
  ordered: Swimlane[];
  /** Lane ids with no value for the main key (an empty set when the key always has one). */
  noValueIds: Set<number>;
  /** True when the key is valid but no lane has a value for it yet. */
  noValuesYet: boolean;
}

/**
 * Order `lanes` (already in board order) by `sort`. Pinned lanes first, in
 * board order; then, with "no value: First", the no-value group (never above
 * the pins, owner decision 2026-11-27); then the sorted lanes; then, by
 * default, the no-value group. Ties fall to the tie-breaker in its default
 * direction, then to board order, so the result is stable.
 */
export function sortLanes(lanes: readonly Swimlane[], sort: LaneSort, options: readonly LaneSortOption[], ctx: LaneSortContext): LaneSortResult {
  const main = options.find((o) => o.key === sort.key);
  if (!main) return { ordered: [...lanes], noValueIds: new Set(), noValuesYet: false };
  const then = sort.then ? options.find((o) => o.key === sort.then) ?? null : null;
  const boardIndex = new Map(lanes.map((l, i) => [l.id, i]));
  const pinSet = new Set(sort.pins);
  const pinned = lanes.filter((l) => pinSet.has(l.id));
  const rest = lanes.filter((l) => !pinSet.has(l.id));
  const ranks = new Map(lanes.map((l) => [l.id, rankOf(l, main, ctx)]));
  const thenRanks = then ? new Map(lanes.map((l) => [l.id, rankOf(l, then, ctx)])) : null;
  const noValueIds = new Set(lanes.filter((l) => ranks.get(l.id) === null).map((l) => l.id));
  const withValue = rest.filter((l) => !noValueIds.has(l.id));
  const empty = rest.filter((l) => noValueIds.has(l.id));
  const sign = sort.reverse ? -1 : 1;
  withValue.sort((a, b) => {
    const primary = sign * cmpRank(ranks.get(a.id)!, ranks.get(b.id)!);
    if (primary) return primary;
    if (thenRanks) {
      const ta = thenRanks.get(a.id)!;
      const tb = thenRanks.get(b.id)!;
      if (ta !== null && tb === null) return -1;
      if (ta === null && tb !== null) return 1;
      if (ta !== null && tb !== null) { const t = cmpRank(ta, tb); if (t) return t; }
    }
    return boardIndex.get(a.id)! - boardIndex.get(b.id)!;
  });
  const ordered = sort.emptyFirst ? [...pinned, ...empty, ...withValue] : [...pinned, ...withValue, ...empty];
  return { ordered, noValueIds, noValuesYet: lanes.length > 0 && noValueIds.size === lanes.length && !main.alwaysHasValue };
}

/** Summary direction: text fields show A→Z / Z→A; everything else ↓ (default) or ↑. */
function summaryDirection(opt: LaneSortOption, reverse: boolean): string {
  if (opt.kind === "text") return reverse ? "Z→A" : "A→Z";
  return reverse ? "↑" : "↓";
}

/** The number of rules the closed summary does not show: tie-breaker, any pins (one), no-value-first. */
export function laneSortExtraCount(sort: LaneSort, pinnedCount: number, main: LaneSortOption | undefined): number {
  return (sort.then ? 1 : 0) + (pinnedCount > 0 ? 1 : 0) + (sort.emptyFirst && main && !main.alwaysHasValue ? 1 : 0);
}

/** Visible summary of the closed control. */
export function laneSortSummary(sort: LaneSort | null, options: readonly LaneSortOption[], pinnedCount: number): string {
  const main = sort ? options.find((o) => o.key === sort.key) : undefined;
  if (!sort || !main) return "Lanes: Board order";
  const extra = laneSortExtraCount(sort, pinnedCount, main);
  return `Lanes: Sorted by ${main.label} ${summaryDirection(main, sort.reverse)}${extra ? ` +${extra}` : ""}`;
}

/** The full rule: "[Field], [direction]. Then [Field], [direction]. [N] lanes pinned. Lanes with no value [last / first]." */
export function laneSortRuleText(sort: LaneSort, options: readonly LaneSortOption[], pinnedCount: number): string {
  const main = options.find((o) => o.key === sort.key);
  if (!main) return "";
  const parts = [`${main.label}, ${main.directions[sort.reverse ? 1 : 0]}.`];
  const then = sort.then ? options.find((o) => o.key === sort.then) : undefined;
  if (then) parts.push(`Then ${then.label}, ${then.directions[0]}.`);
  if (pinnedCount > 0) parts.push(`${pinnedCount} ${pinnedCount === 1 ? "lane" : "lanes"} pinned.`);
  if (!main.alwaysHasValue) parts.push(`Lanes with no value ${sort.emptyFirst ? "first" : "last"}.`);
  return parts.join(" ");
}

/** Accessible name: the arrow is never the only cue, and "→" is read as "to". */
export function laneSortAccessibleName(sort: LaneSort | null, options: readonly LaneSortOption[], pinnedCount: number): string {
  if (!sort || !options.some((o) => o.key === sort.key)) return "Lanes: Board order. Change lane order";
  return `Lanes: Sorted by ${laneSortRuleText(sort, options, pinnedCount).replace(/ → /g, " to ")} Change lane order`;
}

/**
 * The value a lane is sorted on, as the band shows it while the sort is on
 * (#2698 "Sorted value on the band"). Only for keys the band does not already
 * show: Card count and Sum. Null when there is nothing to add.
 */
export function laneSortBandValue(lane: Swimlane, opt: LaneSortOption | undefined, ctx: LaneSortContext): string | null {
  if (!opt) return null;
  if (opt.kind === "count") {
    const n = laneSortValue(lane, opt, ctx) as number;
    const noun = n === 1 ? "card" : "cards";
    return ctx.shownCardIds === null ? `${n} ${noun}` : `${n} ${noun} shown`;
  }
  if (opt.kind === "sum") {
    const v = laneSortValue(lane, opt, ctx);
    return v === null ? null : `${opt.label.replace(/^Sum of /, "")}: ${(v as number).toLocaleString()}`;
  }
  return null;
}
