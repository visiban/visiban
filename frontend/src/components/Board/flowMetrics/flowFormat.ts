import { LINE_DASH } from "../../../utils/chartScale";
import type { ReferenceLine } from "../../Common/Chart";
import type {
  FlowAgeSample, FlowCumulativeColumn, FlowCumulativeFlow, FlowCycleTime, FlowPercentiles, FlowThroughput, FlowWipAge,
} from "../../../types";

/**
 * Display text for the flow dashboard (#448). Durations are rounded here and
 * only here: the server sends full precision, because percentiles are taken
 * before rounding (ADR #1532).
 */
export const formatDays = (days: number) => `${days.toFixed(1)}d`;

const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A calendar day or instant, in UTC, the zone every bucket and window uses (ADR). */
export const formatDate = (value: string | number) => SHORT_DATE.format(new Date(value));

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** `85th · 8.1d`: a percentile line's direct label. */
export const percentileLabel = (ordinal: string, value: number) => `${ordinal} · ${formatDays(value)}`;

/** Whether any line is missing, and a note that names no number (#2028). */
export function sparseNote(percentiles: FlowPercentiles): string | null {
  const present = [percentiles.p50, percentiles.p85, percentiles.p95].filter((p) => p !== null).length;
  if (present === 3) return null;
  return present === 0
    ? "Too few cards to draw percentile lines."
    : "Too few cards to draw the higher percentile lines.";
}

export function excludedNote(excluded: number): string | null {
  if (excluded === 0) return null;
  return `${plural(excluded, "card")} left out for missing or broken history.`;
}

export function cycleTimeSummary({ sample_size: n, percentiles }: FlowCycleTime): string {
  if (n === 0) return "No card with a measurable cycle time finished in this range.";
  if (percentiles.p85 !== null) return `85% of ${n} cards finished within ${formatDays(percentiles.p85)}.`;
  if (percentiles.p50 !== null) return `Half of ${n} cards finished within ${formatDays(percentiles.p50)}.`;
  return `${plural(n, "card")} finished in this range.`;
}

export function throughputSummary({ total, median, samples, period }: FlowThroughput): string {
  const unit = period === "week" ? "week" : "day";
  if (samples.length === 0) return `No whole ${unit} in this range yet.`;
  if (total === 0) return `No cards finished in the whole ${unit}s of this range.`;
  const latest = samples[samples.length - 1].count;
  const last = `${plural(latest, "card")} finished in the last whole ${unit}`;
  return median !== null ? `${last}, against a median of ${median}.` : `${last}.`;
}

export function cumulativeFlowSummary({ columns, bottleneck_column_uid: bottleneck, days }: FlowCumulativeFlow): string {
  if (days.length === 0) return "No whole day in this range yet.";
  const column = columns.find((c) => c.column_uid === bottleneck);
  return column?.column_name
    ? `${column.column_name} grew the most in this range.`
    : "No column that is not done grew in this range.";
}

export function wipAgeSummary({ sample_size: n, samples, cycle_time_percentiles: zones }: FlowWipAge): string {
  if (n === 0) return "No cards are in progress.";
  if (zones.p85 === null) return `${plural(n, "card")} in progress.`;
  const past = samples.filter((s) => s.value_days > (zones.p85 as number)).length;
  return `${past} of ${plural(n, "card")} in progress ${past === 1 ? "is" : "are"} past the 85th percentile.`;
}

/** The key of a column's count in a day: the deleted-columns band is "null". */
export const bandKey = (column: FlowCumulativeColumn) => column.column_uid ?? "null";

export const bandName = (column: FlowCumulativeColumn) => column.column_name ?? "Deleted columns";

/**
 * Percentile lines, in the encoding every flow chart shares: P50 dashed, P85
 * solid and heavier, P95 dotted. A null percentile has no line (ADR #1532).
 */
export function percentileLines(percentiles: FlowPercentiles, y: (days: number) => number): ReferenceLine[] {
  const lines: ReferenceLine[] = [];
  if (percentiles.p50 !== null) {
    lines.push({ y: y(percentiles.p50), label: percentileLabel("50th", percentiles.p50), dash: LINE_DASH.dashed });
  }
  if (percentiles.p85 !== null) {
    lines.push({ y: y(percentiles.p85), label: percentileLabel("85th", percentiles.p85), strokeWidth: 2.5 });
  }
  if (percentiles.p95 !== null) {
    lines.push({ y: y(percentiles.p95), label: percentileLabel("95th", percentiles.p95), dash: LINE_DASH.dotted });
  }
  return lines;
}

/** The accessible name of an aging dot, and of its table row's button. */
export function ageMarkLabel(sample: FlowAgeSample, title: string, zones: FlowPercentiles) {
  const parts = [title, `${sample.value_days.toFixed(1)} days in progress`];
  if (zones.p95 !== null && sample.value_days > zones.p95) parts.push("beyond 95th percentile");
  else if (zones.p85 !== null && sample.value_days > zones.p85) parts.push("beyond 85th percentile");
  if (sample.is_blocked) parts.push("blocked");
  return parts.join(", ");
}
