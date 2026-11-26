import type { ReactNode } from "react";
import type {
  FlowAgeSample, FlowCard, FlowGroupBase, FlowCumulativeFlow, FlowCycleTime, FlowCycleTimeSample, FlowThroughput, FlowThroughputSample, FlowWipAge,
} from "../../../types";
import { ChartNullValue, ChartPanel, ChartTable } from "../../Common/Chart";
import type { ChartPanelView, ChartTableColumn } from "../../Common/Chart";
import CumulativeFlowChart from "./CumulativeFlowChart";
import CycleTimeChart from "./CycleTimeChart";
import {
  ageMarkColor, ageMarkLabel, bandKey, bandName, cumulativeFlowSummary, cycleTimeSummary, excludedNote, formatDate, formatDays,
  sampledNote, sparseNote, throughputSummary, wipAgeSummary,
} from "./flowFormat";
import { colorOfGroup, groupNamesOf } from "./breakdown";
import ThroughputChart from "./ThroughputChart";
import WipAgeChart from "./WipAgeChart";

/**
 * The four flow charts of the Analytics tab (#448), each a `ChartPanel`. They
 * moved here unchanged from the dashboard (#2261) so the page can place each
 * in its own row.
 */
export function CardButton({ label, title, onClick }: { label?: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={title}
      className="block max-w-full truncate text-left text-fg-secondary hover:text-fg rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
    >
      {title}
    </button>
  );
}

/** What a breakdown colors by ("swimlane", "label" or a field name) and the isolated group's index (#2268). */
export interface BreakdownProps {
  noun?: string;
  isolated?: number | null;
}

export interface PanelViewProps {
  view: ChartPanelView;
  onViewChange: (view: ChartPanelView) => void;
}

/** The group column of a table view (#2268): the group's name next to its color dot, `—` when the card is in none. */
function GroupCell({ groups, keys }: { groups: FlowGroupBase[]; keys: string[] | undefined }) {
  const names = groupNamesOf(groups, keys);
  if (names.length === 0) return <ChartNullValue />;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      {groups.filter((g) => keys?.some((k) => g.member_keys.includes(k))).map((g) => (
        <span key={g.key ?? "other"} className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="w-2 h-2 rounded-full" style={{ backgroundColor: colorOfGroup(groups, groups.indexOf(g)) }} />
          {groupNamesOf([g], g.member_keys)[0]}
        </span>
      ))}
    </span>
  );
}

const withMeaning = (summary: string, noun: string | undefined, verb: string) => (noun ? `${summary} ${verb} ${noun}.` : summary);

const compact = (notes: (string | null)[]) => notes.filter((note): note is string => note !== null);

export function CycleTimePanel({
  data, cards, days, onSelect, view, onViewChange, noun, isolated, timeZone = "UTC",
}: PanelViewProps & BreakdownProps & {
  data: FlowCycleTime; cards: Map<string, FlowCard>; days: number; onSelect: (s: FlowCycleTimeSample) => void;
  /** The resolved board zone (#2051): a completion is an instant, so it is dated there, not in UTC. */
  timeZone?: string;
}) {
  const groups = data.grouping?.groups ?? [];
  const columns: ChartTableColumn<FlowCycleTimeSample>[] = [
    {
      key: "card",
      header: "Card",
      render: (s) => <CardButton title={cards.get(s.card_uid)?.title ?? s.card_uid} onClick={() => onSelect(s)} />,
    },
    { key: "days", header: "Cycle time", numeric: true, render: (s) => formatDays(s.value_days) },
    { key: "end", header: "Finished", render: (s) => formatDate(s.end, timeZone) },
    {
      key: "owner",
      header: "Owner",
      render: (s) => {
        const owner = cards.get(s.card_uid)?.assignee;
        return owner ? owner.display_name || owner.username : <ChartNullValue />;
      },
    },
    { key: "reopened", header: "Reopened", render: (s) => (s.reopened ? "Yes" : <ChartNullValue />) },
    ...(groups.length > 0 ? [{ key: "group", header: noun ? `Group (${noun})` : "Group", render: (s: FlowCycleTimeSample) => <GroupCell groups={groups} keys={s.group_keys} /> }] : []),
  ];
  const hasReopened = data.samples.some((s) => s.reopened);
  return (
    <ChartPanel
      view={view}
      onViewChange={onViewChange}
      title="Cycle time"
      help="analytics.cycle-time"
      summary={withMeaning(cycleTimeSummary(data), groups.length > 0 ? noun : undefined, "Dots are colored by")}
      definition={`Cycle time: ${data.definition}`}
      notes={compact([
        data.sample_size > 0 ? `${data.sample_size} ${data.sample_size === 1 ? "card" : "cards"}.` : null,
        data.sample_size > 0 ? sparseNote(data.percentiles) : null,
        excludedNote(data.excluded_incomplete_history),
        hasReopened ? "Hollow points were reopened after finishing." : null,
        sampledNote(data, "longest"),
      ])}
      testId="flow-cycle-time"
      table={<ChartTable label="Cycle time per card" columns={columns} rows={data.samples} rowKey={(s) => s.card_uid} />}
    >
      {(labelledBy) => <CycleTimeChart data={data} cards={cards} days={days} labelledBy={labelledBy} onSelect={onSelect} isolated={isolated} timeZone={timeZone} />}
    </ChartPanel>
  );
}

export function ThroughputPanel({
  data, onSelect, view, onViewChange, noun, isolated,
}: PanelViewProps & BreakdownProps & { data: FlowThroughput; onSelect: (s: FlowThroughputSample) => void }) {
  const groups = data.grouping?.groups ?? [];
  const columns: ChartTableColumn<FlowThroughputSample>[] = [
    { key: "start", header: "Week of", render: (s) => formatDate(s.start) },
    {
      key: "count",
      header: "Cards",
      numeric: true,
      render: (s) => s.count === 0 ? <ChartNullValue /> : (
        <button
          type="button"
          onClick={() => onSelect(s)}
          aria-label={`${s.count} ${s.count === 1 ? "card" : "cards"} the week of ${formatDate(s.start)}`}
          className="rounded underline focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          {s.count}
        </button>
      ),
    },
    { key: "started", header: "Started", numeric: true, render: (s) => (s.started === 0 ? <ChartNullValue /> : s.started) },
    // One count column per group, so a stacked segment is never only a color.
    ...groups.map((g, gi) => ({
      key: `group-${g.key ?? "other"}`,
      header: `${groupNamesOf([g], g.member_keys)[0]}${noun ? ` (${noun})` : ""}`,
      numeric: true,
      render: (s: FlowThroughputSample) => s.by_group?.[gi]?.count || <ChartNullValue />,
    })),
  ];
  return (
    <ChartPanel
      view={view}
      onViewChange={onViewChange}
      title="Throughput"
      help="analytics.throughput"
      summary={withMeaning(throughputSummary(data), groups.length > 0 ? noun : undefined, "Bars are stacked by")}
      definition={`Throughput: ${data.definition}`}
      notes={compact([
        data.median === null && data.samples.length > 0 ? "Too few whole weeks to draw a median." : null,
        data.samples.length > 0 ? "Diamonds are cards started that week. Started under-reports on imported boards." : null,
      ])}
      testId="flow-throughput"
      table={<ChartTable label="Cards finished per week" columns={columns} rows={data.samples} rowKey={(s) => s.start} />}
    >
      {(labelledBy) => <ThroughputChart data={data} labelledBy={labelledBy} onSelect={onSelect} isolated={isolated} />}
    </ChartPanel>
  );
}

export function CumulativeFlowPanel({
  data, onSelectDay, view, onViewChange,
}: PanelViewProps & { data: FlowCumulativeFlow; onSelectDay: (date: string) => void }) {
  type Day = FlowCumulativeFlow["days"][number];
  const shown = data.columns.filter(
    (column) => column.column_uid !== null || data.days.some((day) => (day.counts[bandKey(column)] ?? 0) > 0),
  );
  const columns: ChartTableColumn<Day>[] = [
    {
      key: "date",
      header: "Day",
      render: (day) => <CardButton title={formatDate(day.date)} label={`Cards on ${formatDate(day.date)}`} onClick={() => onSelectDay(day.date)} />,
    },
    ...shown.map((column) => ({
      key: bandKey(column),
      header: column.column_uid === data.bottleneck_column_uid ? `${bandName(column)} (bottleneck)` : bandName(column),
      numeric: true,
      render: (day: Day) => day.counts[bandKey(column)] || <ChartNullValue />,
    })),
  ];
  return (
    <ChartPanel
      view={view}
      onViewChange={onViewChange}
      title="Cumulative flow"
      help="analytics.cumulative-flow"
      summary={cumulativeFlowSummary(data)}
      definition={`Cumulative flow: ${data.definition}`}
      notes={compact([data.bottleneck_column_uid ? "The hatched band is the bottleneck." : null])}
      testId="flow-cumulative"
      table={<ChartTable label="Cards per column per day" columns={columns} rows={data.days} rowKey={(day) => day.date} />}
    >
      {(labelledBy) => <CumulativeFlowChart data={data} labelledBy={labelledBy} onSelectDay={onSelectDay} />}
    </ChartPanel>
  );
}

export function WipAgePanel({
  data, cards, onSelect, view, onViewChange, noun, isolated,
}: PanelViewProps & BreakdownProps & { data: FlowWipAge; cards: Map<string, FlowCard>; onSelect: (s: FlowAgeSample) => void }) {
  const groups = data.grouping?.groups ?? [];
  const zones = data.cycle_time_percentiles;
  const names = new Map(data.columns.map((c) => [c.column_uid, c.column_name]));
  const columns: ChartTableColumn<FlowAgeSample>[] = [
    {
      key: "card",
      header: "Card",
      render: (s) => {
        const title = cards.get(s.card_uid)?.title ?? s.card_uid;
        return <CardButton title={title} label={ageMarkLabel(s, title, zones)} onClick={() => onSelect(s)} />;
      },
    },
    { key: "column", header: "Column", render: (s) => names.get(s.column_uid) ?? <ChartNullValue /> },
    { key: "age", header: "In progress", numeric: true, render: (s) => formatDays(s.value_days) },
    { key: "blocked", header: "Blocked", numeric: true, render: (s) => (s.blocked_days > 0 ? formatDays(s.blocked_days) : <ChartNullValue />) },
    {
      key: "owner",
      header: "Owner",
      render: (s) => {
        const owner = cards.get(s.card_uid)?.assignee;
        return owner ? owner.display_name || owner.username : <ChartNullValue />;
      },
    },
    ...(groups.length > 0 ? [{ key: "group", header: noun ? `Group (${noun})` : "Group", render: (s: FlowAgeSample) => <GroupCell groups={groups} keys={s.group_keys} /> }] : []),
  ];
  const hasBlocked = data.samples.some((s) => s.is_blocked);
  // Name a color only when a mark of that color is drawn (ageMarkColor is what the chart paints).
  const hasOrange = data.samples.some((s) => ageMarkColor(s, zones) === "warning");
  const hasRed = data.samples.some((s) => ageMarkColor(s, zones) === "danger");
  const hasRinged = zones.p85 !== null && data.samples.some((s) => s.value_days > (zones.p85 as number));
  return (
    <ChartPanel
      view={view}
      onViewChange={onViewChange}
      title="WIP age"
      help="analytics.wip-age"
      summary={withMeaning(wipAgeSummary(data), groups.length > 0 ? noun : undefined, "Marks are colored by")}
      definition={`Age: ${data.definition}`}
      notes={compact([
        data.sample_size > 0 ? sparseNote(zones) : null,
        excludedNote(data.excluded_incomplete_history),
        hasBlocked ? "Squares are blocked cards." : null,
        hasRinged ? "Ringed cards are past the 85th percentile." : null,
        groups.length > 0 ? null : agingColorNote(hasOrange, hasRed),
        sampledNote(data, "oldest"),
      ])}
      testId="flow-wip-age"
      table={<ChartTable label="Age per in-progress card" columns={columns} rows={data.samples} rowKey={(s) => s.card_uid} emptyText="No cards are in progress. Move a card into an in-progress column to see its age." />}
    >
      {(labelledBy) => <WipAgeChart data={data} cards={cards} labelledBy={labelledBy} onSelect={onSelect} isolated={isolated} />}
    </ChartPanel>
  );
}


/** The color note names only the colors on screen: orange (past P50), red (past P85), or both. */
function agingColorNote(orange: boolean, red: boolean): string | null {
  if (orange && red) return "Orange marks are older than half of finished cards; red marks are past the 85th percentile.";
  if (orange) return "Orange marks are older than half of finished cards.";
  if (red) return "Red marks are past the 85th percentile.";
  return null;
}

const PULSE = "bg-surface-hover animate-pulse motion-reduce:animate-none";
/** The chart frame's height in `ChartFrame` (260px), so a skeleton chart block is as tall as the real one. */
const CHART_BLOCK = "h-[260px]";

/**
 * A region's frame while it has no data to draw: the skeleton on first load,
 * or what failed. A chart-sized skeleton (the default) has the shape of a
 * `ChartPanel`: title, summary line, the 260px chart, two note lines. A shorter
 * one (`height`) stands in for a list panel. Both are sized like the panel
 * they replace, so the page does not jump when the data arrives (#2264).
 * `loadingNote` shows the visible "Loading flow metrics..." line in the
 * summary's place; the pulse stops under `prefers-reduced-motion`.
 */
export function PanelPlaceholder({ title, failed, height = CHART_BLOCK, loadingNote = false }: {
  title: string; failed: boolean; height?: string; loadingNote?: boolean;
}) {
  const chart = height === CHART_BLOCK;
  return (
    <div className="bg-surface border border-line rounded-lg p-4 flex flex-col gap-2 min-w-0" data-testid="panel-skeleton">
      <h2 className="text-sm font-semibold text-fg">{title}</h2>
      {failed ? (
        <p className={`text-sm text-fg-tertiary ${chart ? "min-h-[320px]" : ""}`}>Could not load this panel.</p>
      ) : (
        <div aria-hidden="true" className="flex flex-col gap-2">
          {chart && (loadingNote
            ? <p className="text-sm text-fg-secondary">Loading flow metrics…</p>
            : <div className={`h-5 w-2/3 rounded ${PULSE}`} />)}
          <div className={`${height} rounded ${PULSE}`} />
          {chart && (
            <>
              <div className={`h-4 w-3/4 rounded ${PULSE}`} />
              <div className={`h-4 w-1/2 rounded ${PULSE}`} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The slot one region always renders into (#2261). It stays in the tree
 * whatever the region's state, and marks itself busy while a newer answer is
 * on its way, so a refetch dims the region instead of replacing it.
 */
export function RegionSlot({ busy, className = "", testId, children }: {
  busy: boolean; className?: string; testId?: string; children: ReactNode;
}) {
  return (
    <div
      aria-busy={busy}
      data-testid={testId}
      className={`min-w-0 transition-opacity motion-reduce:transition-none ${busy ? "opacity-60" : ""} ${className}`}
    >
      {children}
    </div>
  );
}
