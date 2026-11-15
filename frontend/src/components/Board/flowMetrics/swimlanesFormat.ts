import type { FlowSwimlaneComparison, FlowSwimlaneRow } from "../../../types";

/** Spec constants the server also applies (#2266); the page only words them. */
export const MEDIAN_APPEARS_AT = 5;
export const P85_APPEARS_AT = 7;

export type SwimlaneSort = "slowest" | "fastest" | "blocked" | "name" | "board";

export const SORT_OPTIONS: { value: SwimlaneSort; label: string }[] = [
  { value: "slowest", label: "Slowest first" },
  { value: "fastest", label: "Fastest first" },
  { value: "blocked", label: "Most blocked first" },
  { value: "name", label: "Name" },
  { value: "board", label: "Board order" },
];

/** A day count for words: whole above 10, one decimal below, no trailing ".0". */
export function dayText(days: number): string {
  if (days >= 10) return String(Math.round(days));
  return String(Number(days.toFixed(1)));
}

/** Rounds DOWN to one decimal, so "N days or more" is true of the smaller median. */
function floorDays(days: number): string {
  return String(Math.floor(days * 10 + 1e-9) / 10);
}

/** Rounds up to 1, 2, 5 or 10 times a power of ten, so the shared bar scale has a round end. */
export function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

/** The bar scale shared by every row: 0 to the largest 85th percentile (or median) on the page, rounded up. */
export function barScale({ swimlanes, board }: Pick<FlowSwimlaneComparison, "swimlanes" | "board">): number {
  const values = swimlanes.flatMap((s) => [s.p85_days, s.median_days]).concat([board.median_days])
    .filter((v): v is number => v !== null);
  return niceCeil(Math.max(0, ...values));
}

export function sortRows(rows: FlowSwimlaneRow[], sort: SwimlaneSort): FlowSwimlaneRow[] {
  // Rows with no median always sort last: they have nothing to rank.
  const med = (r: FlowSwimlaneRow, missing: number) => r.median_days ?? missing;
  const key: Record<SwimlaneSort, (r: FlowSwimlaneRow) => number> = {
    slowest: (r) => -med(r, -Infinity),
    fastest: (r) => med(r, Infinity),
    blocked: (r) => -(r.blocked_share ?? -1),
    name: () => 0,
    board: (r) => r.position,
  };
  return [...rows].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    const d = key[sort](a) - key[sort](b);
    return Number.isNaN(d) || d === 0 ? a.position - b.position : d;
  });
}

export function statusText(row: FlowSwimlaneRow): string | null {
  if (row.finished < MEDIAN_APPEARS_AT) return "Too few finished cards";
  if (row.status === "slower") return "Slower than the board";
  if (row.status === "faster") return "Faster than the board";
  if (row.status === "in_line") return "In line with the board";
  return null; // 5 to 9 finished: a median but no status line
}

export function cycleText(row: FlowSwimlaneRow): string {
  if (row.median_days === null) {
    return row.finished === 0
      ? "No median yet: no cards finished."
      : `No median yet: only ${row.finished} ${row.finished === 1 ? "card" : "cards"} finished.`;
  }
  const median = `${row.median_days.toFixed(1)} days median`;
  return row.p85_days === null
    ? `${median} · 85% line needs ${P85_APPEARS_AT} finished cards`
    : `${median} · 85% finish within ${dayText(row.p85_days)} days`;
}

export function trendText(row: FlowSwimlaneRow): string {
  const t = row.trend;
  if (!t) return "Not enough cards";
  if (t.direction === "steady") return "Steady";
  const word = t.direction === "slower" ? "Slower" : "Faster";
  return `${word}, ${dayText(t.first_days)} to ${dayText(t.last_days)} days`;
}

export function blockedText(row: FlowSwimlaneRow): string {
  return `${Math.round((row.blocked_share ?? 0) * 100)}% of elapsed time`;
}

/** The finding panel: up to two slower swimlanes, slowest first, in one heading and one sentence. */
export function findingText(data: FlowSwimlaneComparison): { heading: string; sentence: string } {
  const slower = sortRows(data.swimlanes.filter((s) => s.status === "slower"), "slowest").slice(0, 2);
  const boardMedian = data.board.median_days;
  if (slower.length === 0) {
    return {
      heading: "No swimlane is slower than the board",
      sentence: boardMedian === null
        ? "The board has too few finished cards to compare swimlanes yet."
        : `Every swimlane with at least ${data.status_min_finished} finished cards is within ${data.status_threshold_pct}% of the board median of ${dayText(boardMedian)} days, or faster.`,
    };
  }
  const names = slower.map((s) => s.name);
  const heading = `${names.join(" and ")} ${names.length > 1 ? "are" : "is"} where cards slow down`;
  const medians = slower.map((s) => s.median_days ?? 0);
  const against = boardMedian === null ? "" : ` against a board median of ${dayText(boardMedian)}`;
  let sentence = slower.length > 1
    ? `Both take ${floorDays(Math.min(...medians))} days or more${against}.`
    : `${names[0]} takes ${dayText(medians[0])} days at the median${against}.`;
  const first = slower[0];
  if (first.trend?.direction === "slower") {
    sentence += ` ${first.name} is also getting slower: its median rose from ${dayText(first.trend.first_days)} to ${dayText(first.trend.last_days)} days across the period`;
    sentence += first.blocked_share !== null && first.blocked_share >= 0.1
      ? `, and ${Math.round(first.blocked_share * 100)}% of its time was spent blocked.`
      : ".";
  }
  return { heading, sentence };
}
