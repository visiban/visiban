import type { FlowFilters } from "../../../api/flowMetrics";
import type { Column, FlowCumulativeFlow, FlowDwell, FlowThroughput, FlowWipAge } from "../../../types";
import { ChartPanel } from "../../Common/Chart";
import type { ChartPanelView } from "../../Common/Chart";
import DwellTable, { ViewModeToggle } from "./DwellTable";
import FlowRow from "./FlowRow";
import { buildFlowRow } from "./flowRowData";
import { cumulativeFlowSummary } from "./flowFormat";
import type { AnalyticsData, ViewMode } from "./heatmap";
import { colorOfGroup, groupName } from "./breakdown";
import TimeBar from "./TimeBar";
import type { TimeBarGroup } from "./TimeBar";
import type { Result } from "./useAnalyticsOverviewData";

interface Props {
  /** Undefined until the first answer. */
  analytics: Result<AnalyticsData | null> | undefined;
  cumulative: FlowCumulativeFlow | undefined;
  dwell: FlowDwell | undefined;
  wipAge: FlowWipAge | undefined;
  throughput: FlowThroughput | undefined;
  columns: Pick<Column, "uid" | "wip_limit">[];
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  view: ChartPanelView;
  onViewChange: (view: ChartPanelView) => void;
  /** The period the numbers on screen were fetched for. */
  filters: FlowFilters;
  /** A swimlane or label filter is on: the board-wide WIP limit no longer applies to the counts shown. */
  filtered?: boolean;
  /** Every request has answered once: a missing response is then a failure, not a load. */
  settled: boolean;
  onOpenColumn: (uid: string) => void;
  /** The isolated group's index under a breakdown (#2268). */
  isolated?: number | null;
  /** What the breakdown colors by, for the section's sentence. */
  breakdownNoun?: string;
}

/** Names only the shapes on screen: hollow squares when a column is over its limit, the warning connectors when a bottleneck is drawn. */
function flowNote(row: ReturnType<typeof buildFlowRow>): string {
  const parts = ["Each square is a card in that column now."];
  if (row.some((c) => c.limit !== null && c.count > c.limit)) parts.push("Hollow squares are over the limit.");
  parts.push(row.some((c) => c.bottleneck)
    ? "Connectors show cards per week moving on; orange ones come after the bottleneck."
    : "Connectors show cards per week moving on.");
  parts.push("Select a column to see its cards.");
  return parts.join(" ");
}

function Loading({ failed }: { failed: boolean }) {
  return failed
    ? <p className="text-sm text-fg-tertiary py-8 text-center">Could not load how work flows.</p>
    : <div aria-hidden="true" className="h-40 rounded bg-surface-hover animate-pulse motion-reduce:animate-none" />;
}

function TableBody({ analytics, mode, onModeChange, days }: Pick<Props, "analytics" | "mode" | "onModeChange"> & { days: number }) {
  const data = analytics?.data?.swimlanes ? analytics.data : null;
  if (data) {
    return (
      <div className="flex flex-col gap-3 min-w-0">
        <ViewModeToggle mode={mode} onChange={onModeChange} />
        <DwellTable data={data} mode={mode} days={days} />
      </div>
    );
  }
  if (analytics === undefined) {
    return (
      <div className="flex items-center justify-center py-12 gap-2">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        <span className="text-sm text-fg-tertiary">Loading analytics…</span>
      </div>
    );
  }
  if (analytics.error !== undefined) return <p className="text-sm text-danger py-8 text-center">Failed to load analytics.</p>;
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8">
      <p className="text-fg-tertiary text-sm font-medium">No analytics data</p>
      <p className="text-fg-tertiary text-xs">Move cards between columns to start generating this table.</p>
    </div>
  );
}

/**
 * Region 6 (#2262): "How work flows" with "Where the time goes" under it. The
 * Table view is today's dwell heatmap, its modes renamed Current and In
 * period; its period, swimlane and label come from the page's filter bar.
 */
export default function FlowSection({
  analytics, cumulative, dwell, wipAge, throughput, columns, mode, onModeChange, view, onViewChange, filters, filtered = false, settled, onOpenColumn, isolated = null, breakdownNoun,
}: Props) {
  const grouping = dwell?.grouping;
  const groups: TimeBarGroup[] | undefined = grouping && grouping.groups.length > 0
    ? grouping.groups.map((g, i) => ({
      name: groupName(g),
      color: colorOfGroup(grouping.groups, i),
      medians: new Map(g.columns.map((c) => [c.column_uid, c.percentiles.p50])),
    }))
    : undefined;
  const row = cumulative ? buildFlowRow(cumulative, dwell, wipAge, columns, filtered) : [];
  return (
    <ChartPanel
      title="How work flows"
      summary={cumulative ? cumulativeFlowSummary(cumulative) : "Where cards queue and how long they wait."}
      notes={view === "chart" && cumulative ? [flowNote(row)] : []}
      testId="analytics-flow"
      view={view}
      onViewChange={onViewChange}
      table={<TableBody analytics={analytics} mode={mode} onModeChange={onModeChange} days={filters.days} />}
    >
      {() => cumulative ? (
        <div className="flex flex-col gap-5 min-w-0">
          <FlowRow columns={row} cumulative={cumulative} throughput={throughput} days={filters.days} onOpenColumn={onOpenColumn} />
          <section aria-labelledby="analytics-time-heading" className="flex flex-col gap-2">
            <h3 id="analytics-time-heading" className="text-sm font-semibold text-fg">Where the time goes</h3>
            <p className="text-sm text-fg-secondary">
              {groups
                ? `Median days a card spends in each column on the way to Done, split by ${breakdownNoun ?? "group"}. The longest bar is the slowest group.`
                : "Median days a card spends in each column on the way to Done."}
            </p>
            <TimeBar columns={row} groups={groups} isolated={isolated} />
          </section>
        </div>
      ) : <Loading failed={settled} />}
    </ChartPanel>
  );
}
