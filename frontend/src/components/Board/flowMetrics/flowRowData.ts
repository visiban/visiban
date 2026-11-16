import type { Column, FlowCumulativeColumn, FlowCumulativeFlow, FlowDwell, FlowWipAge } from "../../../types";

/** One in-progress column of the flow row (#2262), from numbers the server already returned. */
export interface FlowRowColumn {
  uid: string;
  name: string;
  /** Cards in the column now, the count its WIP limit applies to (`wipCount`). */
  count: number;
  limit: number | null;
  /** Median completed wait; null when withheld. */
  medianWait: number | null;
  /** Cards per week entering the column; null under two whole days. */
  enteredPerWeek: number | null;
  /** Change in queue over the period; null when either end is missing. */
  queueDelta: number | null;
  /** The connector's one- or two-word note. */
  note: string;
  bottleneck: boolean;
}

/**
 * Cards not archived in the column now, as the board's column header counts
 * them (#2287). The aging samples leave out cards that have not started and
 * cards with incomplete history, so they are not this count; they are only
 * the fallback for a server older than #2287, which sends no `wip_count`.
 */
export function wipCount(wipAge: Pick<FlowWipAge, "columns" | "samples"> | undefined, uid: string): number {
  if (!wipAge) return 0;
  return wipAge.columns.find((c) => c.column_uid === uid)?.wip_count
    ?? wipAge.samples.filter((s) => s.column_uid === uid).length;
}

export function connectorNote(index: number, col: Pick<FlowCumulativeColumn, "entered_per_week" | "left_per_week">): string {
  if (index === 0) return "started";
  const { entered_per_week: inRate, left_per_week: outRate } = col;
  if (inRate !== null && outRate !== null && outRate < inRate) return "fewer leave";
  return "move on";
}

/**
 * The WIP limit to compare a column's count with, or null for "no limit". A
 * limit of 0 means unlimited (as in ColumnHeader), and a swimlane or label
 * filter leaves a count that no longer matches the board-wide limit.
 */
export function effectiveLimit(wipLimit: number | null | undefined, filtered: boolean): number | null {
  return filtered || !wipLimit ? null : wipLimit;
}

export function buildFlowRow(
  cumulative: FlowCumulativeFlow,
  dwell: FlowDwell | undefined,
  wipAge: FlowWipAge | undefined,
  columns: Pick<Column, "uid" | "wip_limit">[],
  filtered = false,
): FlowRowColumn[] {
  return cumulative.columns
    .filter((c): c is FlowCumulativeColumn & { column_uid: string } => !c.is_done && c.column_uid !== null)
    .map((c, index) => ({
      uid: c.column_uid,
      name: c.column_name ?? "Column",
      count: wipCount(wipAge, c.column_uid),
      limit: effectiveLimit(columns.find((col) => col.uid === c.column_uid)?.wip_limit, filtered),
      medianWait: dwell?.columns.find((d) => d.column_uid === c.column_uid)?.percentiles.p50 ?? null,
      enteredPerWeek: c.entered_per_week,
      queueDelta: c.start_count !== null && c.end_count !== null ? c.end_count - c.start_count : null,
      note: connectorNote(index, c),
      bottleneck: c.column_uid === cumulative.bottleneck_column_uid,
    }));
}

/**
 * Done-band rate: first completions per week (#2307), the server's `completed_per_week`. Summing
 * the done columns' `entered_per_week` counts a card that moves Done A to Done B twice, and the
 * payload cannot tell those entries apart, so the sum is only the fallback for a server older
 * than #2307, which sends no `completed_per_week`. Null when no rate is available.
 */
export function doneRate(cumulative: FlowCumulativeFlow): number | null {
  if (cumulative.completed_per_week !== undefined) return cumulative.completed_per_week;
  const rates = cumulative.columns.filter((c) => c.is_done).map((c) => c.entered_per_week);
  if (rates.length === 0 || rates.every((r) => r === null)) return null;
  return rates.reduce<number>((sum, r) => sum + (r ?? 0), 0);
}

/** In-progress columns run from a light to a dark step of the chart hue, in board order (shared by the row and the bar). */
export const columnAlpha = (index: number, total: number) => (total <= 1 ? 0.7 : 0.55 + (0.45 * index) / (total - 1));

/** The bottleneck's hatch: the shared definition in `hatch.ts` (#2285), kept under this name for the HTML renderers. */
export { HATCH_CSS as HATCH } from "./hatch";
