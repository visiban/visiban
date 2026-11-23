import type { Column, FlowCumulativeFlow, FlowDwell, FlowWipAge } from "../../../types";
import { effectiveLimit, wipCount } from "./flowRowData";
import type { DrillSelection } from "./FlowDrillDrawer";

/**
 * The column drawer's contents (#2262), from the responses already on screen.
 * "Past 85th percentile" is the aging chart's line (cycle time), so the drawer
 * and the chart agree; a withheld percentile gives null, shown as a dash.
 * `count` is every card in the column (#2287), the count the WIP limit
 * applies to; `cards` lists only those with an age, so it can be shorter.
 */
export function buildColumnSelection(
  uid: string,
  { cumulative, dwell, wipAge, columns }: {
    cumulative: FlowCumulativeFlow | undefined;
    dwell: FlowDwell | undefined;
    wipAge: FlowWipAge | undefined;
    columns: Pick<Column, "uid" | "wip_limit">[];
  },
  filtered = false,
): Extract<DrillSelection, { kind: "column" }> {
  const name = cumulative?.columns.find((c) => c.column_uid === uid)?.column_name
    ?? wipAge?.columns.find((c) => c.column_uid === uid)?.column_name
    ?? "this column";
  const names = new Map(wipAge?.columns.map((c) => [c.column_uid, c.column_name]));
  const p85 = wipAge?.cycle_time_percentiles.p85 ?? null;
  const samples = (wipAge?.samples ?? [])
    .filter((s) => s.column_uid === uid)
    .sort((a, b) => b.value_days - a.value_days);
  // A capped response (#2429) downsamples the samples and states the column's counts from the whole set.
  const column = wipAge?.columns.find((c) => c.column_uid === uid);
  const aged = column?.sample_count ?? samples.length;
  return {
    kind: "column",
    uid,
    name,
    limit: effectiveLimit(columns.find((c) => c.uid === uid)?.wip_limit, filtered),
    count: wipCount(wipAge, uid),
    medianWait: dwell?.columns.find((c) => c.column_uid === uid)?.percentiles.p50 ?? null,
    pastP85: p85 === null ? null : (column?.past_p85_count ?? samples.filter((s) => s.value_days > p85).length),
    notSampled: Math.max(0, aged - samples.length),
    cards: samples.map((s) => ({
      uid: s.card_uid,
      days: s.value_days,
      inColumnDays: s.dwell_by_column.find((d) => d.column_uid === uid)?.value_days ?? 0,
      blocked: s.is_blocked,
      blockedDays: s.blocked_days,
      dwell: s.dwell_by_column.map((entry) => ({
        name: (entry.column_uid && names.get(entry.column_uid)) || "Deleted column",
        days: entry.value_days,
      })),
    })),
  };
}
