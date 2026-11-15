import type { ReactNode } from "react";
import type {
  FlowAgeSample, FlowCard, FlowCumulativeFlow, FlowCycleTime, FlowCycleTimeSample, FlowThroughput, FlowThroughputSample, FlowWipAge,
} from "../../../types";
import { ChartNullValue, ChartPanel, ChartTable } from "../../Common/Chart";
import type { ChartPanelView, ChartTableColumn } from "../../Common/Chart";
import CumulativeFlowChart from "./CumulativeFlowChart";
import CycleTimeChart from "./CycleTimeChart";
import {
  ageMarkLabel, bandKey, bandName, cumulativeFlowSummary, cycleTimeSummary, excludedNote, formatDate, formatDays,
  sparseNote, throughputSummary, wipAgeSummary,
} from "./flowFormat";
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

export interface PanelViewProps {
  view: ChartPanelView;
  onViewChange: (view: ChartPanelView) => void;
}

const compact = (notes: (string | null)[]) => notes.filter((note): note is string => note !== null);

export function CycleTimePanel({
  data, cards, days, onSelect, view, onViewChange,
}: PanelViewProps & { data: FlowCycleTime; cards: Map<string, FlowCard>; days: number; onSelect: (s: FlowCycleTimeSample) => void }) {
  const columns: ChartTableColumn<FlowCycleTimeSample>[] = [
    {
      key: "card",
      header: "Card",
      render: (s) => <CardButton title={cards.get(s.card_uid)?.title ?? s.card_uid} onClick={() => onSelect(s)} />,
    },
    { key: "days", header: "Cycle time", numeric: true, render: (s) => formatDays(s.value_days) },
    { key: "end", header: "Finished", render: (s) => formatDate(s.end) },
    {
      key: "owner",
      header: "Owner",
      render: (s) => {
        const owner = cards.get(s.card_uid)?.assignee;
        return owner ? owner.display_name || owner.username : <ChartNullValue />;
      },
    },
    { key: "reopened", header: "Reopened", render: (s) => (s.reopened ? "Yes" : <ChartNullValue />) },
  ];
  const hasReopened = data.samples.some((s) => s.reopened);
  return (
    <ChartPanel
      view={view}
      onViewChange={onViewChange}
      title="Cycle time"
      summary={cycleTimeSummary(data)}
      definition={`Cycle time: ${data.definition}`}
      notes={compact([
        data.sample_size > 0 ? `${data.sample_size} ${data.sample_size === 1 ? "card" : "cards"}.` : null,
        data.sample_size > 0 ? sparseNote(data.percentiles) : null,
        excludedNote(data.excluded_incomplete_history),
        hasReopened ? "Hollow points were reopened after finishing." : null,
      ])}
      testId="flow-cycle-time"
      table={<ChartTable label="Cycle time per card" columns={columns} rows={data.samples} rowKey={(s) => s.card_uid} />}
    >
      {(labelledBy) => <CycleTimeChart data={data} cards={cards} days={days} labelledBy={labelledBy} onSelect={onSelect} />}
    </ChartPanel>
  );
}

export function ThroughputPanel({
  data, onSelect, view, onViewChange,
}: PanelViewProps & { data: FlowThroughput; onSelect: (s: FlowThroughputSample) => void }) {
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
  ];
  return (
    <ChartPanel
      view={view}
      onViewChange={onViewChange}
      title="Throughput"
      summary={throughputSummary(data)}
      definition={`Throughput: ${data.definition}`}
      notes={compact([data.median === null && data.samples.length > 0 ? "Too few whole weeks to draw a median." : null])}
      testId="flow-throughput"
      table={<ChartTable label="Cards finished per week" columns={columns} rows={data.samples} rowKey={(s) => s.start} />}
    >
      {(labelledBy) => <ThroughputChart data={data} labelledBy={labelledBy} onSelect={onSelect} />}
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
  data, cards, onSelect, view, onViewChange,
}: PanelViewProps & { data: FlowWipAge; cards: Map<string, FlowCard>; onSelect: (s: FlowAgeSample) => void }) {
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
  ];
  const hasBlocked = data.samples.some((s) => s.is_blocked);
  const hasRinged = zones.p85 !== null && data.samples.some((s) => s.value_days > (zones.p85 as number));
  return (
    <ChartPanel
      view={view}
      onViewChange={onViewChange}
      title="WIP aging"
      summary={wipAgeSummary(data)}
      definition={`Age: ${data.definition}`}
      notes={compact([
        data.sample_size > 0 ? sparseNote(zones) : null,
        excludedNote(data.excluded_incomplete_history),
        hasBlocked ? "Squares are blocked cards." : null,
        hasRinged ? "Ringed cards are past the 85th percentile." : null,
      ])}
      testId="flow-wip-age"
      table={<ChartTable label="Age per in-progress card" columns={columns} rows={data.samples} rowKey={(s) => s.card_uid} emptyText="No cards are in progress." />}
    >
      {(labelledBy) => <WipAgeChart data={data} cards={cards} labelledBy={labelledBy} onSelect={onSelect} />}
    </ChartPanel>
  );
}


/**
 * A region's frame while it has no data to draw: the skeleton on first load,
 * or what failed. Sized like the panel it stands in for, so the page does not
 * jump when the data arrives.
 */
export function PanelPlaceholder({ title, failed, height = "h-56" }: { title: string; failed: boolean; height?: string }) {
  return (
    <div className="bg-surface border border-line rounded-lg p-4 flex flex-col gap-3 min-w-0">
      <h2 className="text-sm font-semibold text-fg">{title}</h2>
      {failed ? (
        <p className="text-sm text-fg-tertiary">Could not load this panel.</p>
      ) : (
        <div aria-hidden="true" className="flex flex-col gap-3">
          <div className="h-3 w-2/3 rounded bg-surface-hover animate-pulse motion-reduce:animate-none" />
          <div className={`${height} rounded bg-surface-hover animate-pulse motion-reduce:animate-none`} />
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
