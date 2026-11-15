import { LINE_DASH } from "../../../utils/chartScale";
import type { ChartColor } from "../../../utils/chartScale";
import { effectiveLimit, wipCount } from "./flowRowData";
import type { ReferenceLine } from "../../Common/Chart";
import type {
  FlowAgeSample, FlowBlocked, FlowCumulativeColumn, FlowCumulativeFlow, FlowCycleTime, FlowDwell, FlowPercentiles, FlowThroughput, FlowWipAge,
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

export function wipAgeSummary({ sample_size: n, samples, columns, cycle_time_percentiles: zones }: FlowWipAge): string {
  if (n === 0) {
    // Live WIP (#2287) counts unstarted cards too, so no ages does not mean no work in progress.
    const live = columns.reduce((sum, c) => sum + (c.wip_count ?? 0), 0);
    return live > 0 ? "No card in progress has an age yet." : "No cards are in progress.";
  }
  if (zones.p85 === null) return `${plural(n, "card")} in progress.`;
  const past = cardsPastP85({ samples, cycle_time_percentiles: zones });
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

/**
 * The named color of an aging mark (#2264): neutral up to the 50th percentile,
 * `warning` past it, `danger` past the 85th. A withheld percentile (null) adds
 * no tier. Color repeats what the ring and the zone lines already say.
 */
export function ageMarkColor(sample: FlowAgeSample, zones: FlowPercentiles): ChartColor {
  if (zones.p85 !== null && sample.value_days > zones.p85) return "danger";
  if (zones.p50 !== null && sample.value_days > zones.p50) return "warning";
  return "neutral";
}

/** The accessible name of an aging dot, and of its table row's button. */
export function ageMarkLabel(sample: FlowAgeSample, title: string, zones: FlowPercentiles) {
  const parts = [title, `${sample.value_days.toFixed(1)} days in progress`];
  if (zones.p95 !== null && sample.value_days > zones.p95) parts.push("beyond 95th percentile");
  else if (zones.p85 !== null && sample.value_days > zones.p85) parts.push("beyond 85th percentile");
  if (sample.is_blocked) parts.push("blocked");
  return parts.join(", ");
}

/**
 * The finished-card count at which the server starts returning each
 * percentile: `MIN_PERCENTILE_SAMPLE_SIZE` (5) and the nearest-rank rule that
 * withholds a percentile whose rank would be the largest value
 * (`backend/boards/services/flow_metrics.py`, `percentile`). Text only, for a
 * tile that says when a value will appear ("appears at 7"). Whether a value is
 * shown is decided by the server's null, never by comparing to this.
 */
export const PERCENTILE_APPEARS_AT = { p50: 5, p85: 7, p95: 20 } as const;

/** `n card` / `n cards`. */
export const pluralize = plural;

/** A number for a tile: whole numbers as is, others to one decimal. */
export const formatNumber = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

/**
 * The bottleneck column's share of the cycle (#2261): the column's median
 * completed dwell (`metrics/dwell` p50) divided by the median cycle time
 * (`metrics/cycle-time` p50), both as the server returned them. A browser-side
 * ratio of two server medians, not a percentile: it says roughly how much of a
 * typical card's cycle is spent waiting in that one column. Null, so the
 * sentence leaves the clause out, when either median is withheld or the cycle
 * median is 0.
 */
export function shareOfCycle(dwellP50: number | null, cycleP50: number | null): number | null {
  if (dwellP50 === null || cycleP50 === null || cycleP50 === 0) return null;
  return dwellP50 / cycleP50;
}

/** The share in words, never as a precise percentage: two medians do not add up exactly. */
export function shareOfCyclePhrase(share: number): string {
  if (share >= 0.9) return "nearly all of the whole cycle";
  if (share >= 0.65) return "most of the whole cycle";
  if (share >= 0.4) return "about half of the whole cycle";
  if (share >= 0.28) return "about a third of the whole cycle";
  if (share >= 0.18) return "about a quarter of the whole cycle";
  return "a small part of the whole cycle";
}

/**
 * How many board columns hold more cards than their WIP limit. Counts every
 * card not archived in the column (`wipCount`), as the column header does, so
 * cards that have not started count too (#2287).
 */
export function columnsOverLimit(
  wipAge: Pick<FlowWipAge, "columns" | "samples">,
  columns: { uid: string; wip_limit: number | null }[],
): number {
  return columns.filter(
    (column) => !!column.wip_limit && wipCount(wipAge, column.uid) > column.wip_limit,
  ).length;
}

/** Cards in progress past the 85th percentile of cycle time; 0 without a P85. */
export function cardsPastP85({ samples, cycle_time_percentiles: zones }: Pick<FlowWipAge, "samples" | "cycle_time_percentiles">): number {
  if (zones.p85 === null) return 0;
  return samples.filter((s) => s.value_days > (zones.p85 as number)).length;
}

const daysText = (days: number) => `${formatNumber(days)} ${days === 1 ? "day" : "days"}`;

/** "Cards wait 6.2 days here, about half of the whole cycle. The queue grew …" from returned numbers only. */
export function bottleneckSentence(
  uid: string,
  { cumulative, dwell, cycle, columns, filtered = false }: {
    cumulative: FlowCumulativeFlow | undefined; dwell: FlowDwell | undefined; cycle: FlowCycleTime | undefined;
    columns: { uid: string; wip_limit: number | null }[];
    /** A swimlane or label filter is on: a filtered queue against the board-wide limit is meaningless, so the limit is left out. */
    filtered?: boolean;
  },
): string {
  const parts: string[] = [];
  const wait = dwell?.columns.find((c) => c.column_uid === uid)?.percentiles.p50 ?? null;
  if (wait === null) {
    parts.push("The median wait here is not available yet.");
  } else {
    const share = shareOfCycle(wait, cycle?.percentiles.p50 ?? null);
    parts.push(`Cards wait ${daysText(wait)} here${share === null ? "" : `, ${shareOfCyclePhrase(share)}`}.`);
  }
  const band = cumulative?.columns.find((c) => c.column_uid === uid);
  if (band && band.start_count !== null && band.end_count !== null) {
    const limit = effectiveLimit(columns.find((c) => c.uid === uid)?.wip_limit, filtered);
    let queue = `The queue grew from ${band.start_count} to ${pluralize(band.end_count, "card")}`;
    if (limit !== null) queue += ` against a limit of ${limit}`;
    if (band.entered_per_week !== null && band.left_per_week !== null) {
      queue += `, because ${formatNumber(band.entered_per_week)} cards arrive each week and ${formatNumber(band.left_per_week)} leave`;
    }
    parts.push(`${queue}.`);
  }
  return parts.join(" ");
}

/**
 * Subtitle for "Why cards get blocked" (#2282). Owner rule: each share is the
 * unrounded `days / total.days`, compared before any rounding, so 49.99% never
 * reads as "half". A zero total (nothing to take a share of) and a modest top
 * reason keep the fixed sentence.
 */
export function blockedSubtitle(
  { reasons, reason_count: reasonCount, total }: Pick<FlowBlocked, "reasons" | "reason_count" | "total">,
  days: number,
): string {
  const fixed = `Block reasons over the last ${days} days, longest first.`;
  if (total.days <= 0 || reasons.length === 0) return fixed;
  // `reasons` is capped, so the uncapped distinct count decides "exactly one".
  if ((reasonCount ?? reasons.length) === 1) return "Every blocked day had the same reason.";
  const topShare = Math.max(...reasons.map((r) => r.days)) / total.days;
  if (topShare >= 0.5) return "One reason accounts for more than half of all blocked time.";
  if (topShare >= 0.4) return "One reason accounts for nearly half of all blocked time.";
  return fixed;
}
