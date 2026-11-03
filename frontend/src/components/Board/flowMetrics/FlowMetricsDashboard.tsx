import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getFlowCumulativeDay, getFlowCumulativeFlow, getFlowCycleTime, getFlowThroughput, getFlowWipAge,
} from "../../../api/flowMetrics";
import type { FlowFilters } from "../../../api/flowMetrics";
import type {
  FlowAgeSample, FlowCard, FlowCumulativeFlow, FlowCycleTime, FlowCycleTimeSample, FlowThroughput, FlowThroughputSample, FlowWipAge,
} from "../../../types";
import { ChartNullValue, ChartPanel, ChartTable } from "../../Common/Chart";
import type { ChartTableColumn } from "../../Common/Chart";
import SingleSelectDropdown from "../../Common/SingleSelectDropdown";
import CumulativeFlowChart from "./CumulativeFlowChart";
import CycleTimeChart from "./CycleTimeChart";
import FlowDrillDrawer from "./FlowDrillDrawer";
import type { DrillSelection } from "./FlowDrillDrawer";
import {
  ageMarkLabel, bandKey, bandName, cumulativeFlowSummary, cycleTimeSummary, excludedNote, formatDate, formatDays,
  sparseNote, throughputSummary, wipAgeSummary,
} from "./flowFormat";
import ThroughputChart from "./ThroughputChart";
import WipAgeChart from "./WipAgeChart";

const RANGES = [
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
  { value: 180, label: "Last 180 days" },
  { value: 365, label: "Last 365 days" },
];
// Whole ISO weeks and enough completions for P85/P95 on a small team (ADR #1532).
const DEFAULT_DAYS = 90;

interface FlowData {
  cycle: FlowCycleTime;
  throughput: FlowThroughput;
  cumulative: FlowCumulativeFlow;
  age: FlowWipAge;
}

interface Props {
  boardId: number;
  swimlanes: { id: number; name: string }[];
  labels: { id: number; name: string }[];
  onOpenCard?: (cardId: number) => void;
  onGoToBoard?: () => void;
}

function isEmpty({ cycle, throughput, cumulative, age }: FlowData) {
  return (
    cycle.sample_size === 0
    && throughput.total === 0
    && age.sample_size === 0
    && cumulative.days.every((day) => Object.values(day.counts).every((count) => count === 0))
  );
}

function CardButton({ label, title, onClick }: { label?: string; title: string; onClick: () => void }) {
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

function LoadingPanels() {
  return (
    <div aria-busy="true" data-testid="flow-loading">
      <p role="status" className="sr-only">Loading flow metrics</p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" aria-hidden="true">
        {[0, 1, 2, 3].map((panel) => (
          <div key={panel} className="bg-surface border border-line rounded-lg p-4 flex flex-col gap-3">
            <div className="h-4 w-32 rounded bg-surface-hover animate-pulse motion-reduce:animate-none" />
            <div className="h-3 w-2/3 rounded bg-surface-hover animate-pulse motion-reduce:animate-none" />
            <div className="h-56 rounded bg-surface-hover animate-pulse motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Four charts over the movement log: the Analytics tab's flow section (#448). */
export default function FlowMetricsDashboard({ boardId, swimlanes, labels, onOpenCard, onGoToBoard }: Props) {
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [swimlaneId, setSwimlaneId] = useState<number | null>(null);
  const [labelId, setLabelId] = useState<number | null>(null);
  const [data, setData] = useState<FlowData | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [drill, setDrill] = useState<DrillSelection | null>(null);
  const [dayCards, setDayCards] = useState<FlowCard[]>([]);
  // A filter changed while the day's list was loading: drop that late answer.
  const drillRequest = useRef(0);

  const filters: FlowFilters = useMemo(() => ({ days, swimlaneId, labelId }), [days, swimlaneId, labelId]);

  useEffect(() => {
    let current = true;
    setData(null);
    setFailed(false);
    Promise.all([
      getFlowCycleTime(boardId, filters),
      getFlowThroughput(boardId, filters),
      getFlowCumulativeFlow(boardId, filters),
      getFlowWipAge(boardId, filters),
    ])
      .then(([cycle, throughput, cumulative, age]) => {
        if (current) setData({ cycle, throughput, cumulative, age });
      })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [boardId, filters, attempt]);

  const cards = useMemo(() => {
    const directory = new Map<string, FlowCard>();
    for (const card of [
      ...(data?.cycle.cards ?? []),
      ...(data?.throughput.cards ?? []),
      ...(data?.age.cards ?? []),
      ...dayCards,
    ]) {
      directory.set(card.uid, card);
    }
    return directory;
  }, [data, dayCards]);

  const closeDrill = useCallback(() => {
    drillRequest.current += 1;
    setDrill(null);
  }, []);

  const selectCycleSample = (sample: FlowCycleTimeSample) =>
    setDrill({
      kind: "card",
      uid: sample.card_uid,
      facts: [
        { label: "Cycle time", value: formatDays(sample.value_days) },
        { label: "Started", value: formatDate(sample.start) },
        { label: "Finished", value: formatDate(sample.end) },
        ...(sample.reopened ? [{ label: "Reopened", value: "Yes, after finishing" }] : []),
      ],
    });

  const selectThroughputSample = (sample: FlowThroughputSample) =>
    setDrill({
      kind: "cards",
      title: `Finished the week of ${formatDate(sample.start)}`,
      groups: [{ label: null, uids: sample.card_uids }],
    });

  const selectAgeSample = (sample: FlowAgeSample) => {
    const names = new Map(data?.age.columns.map((c) => [c.column_uid, c.column_name]));
    const p85 = data?.age.cycle_time_percentiles.p85 ?? null;
    setDrill({
      kind: "card",
      uid: sample.card_uid,
      facts: [
        { label: "Days in progress", value: formatDays(sample.value_days) },
        { label: "85th percentile", value: p85 !== null ? formatDays(p85) : "—" },
        { label: "Blocked time", value: formatDays(sample.blocked_days) },
        ...(sample.is_blocked ? [{ label: "Now", value: "Blocked" }] : []),
      ],
      dwell: sample.dwell_by_column.map((entry) => ({
        name: (entry.column_uid && names.get(entry.column_uid)) || "Deleted column",
        days: entry.value_days,
      })),
    });
  };

  const selectDay = useCallback((date: string) => {
    drillRequest.current += 1;
    const request = drillRequest.current;
    const title = `Cards on ${formatDate(date)}`;
    const load = () => {
      setDrill({ kind: "cards", title, groups: null });
      getFlowCumulativeDay(boardId, filters, date)
        .then((day) => {
          if (request !== drillRequest.current) return;
          setDayCards(day.cards);
          const columnNames = new Map(data?.cumulative.columns.map((c) => [c.column_uid, bandName(c)]));
          setDrill({
            kind: "cards",
            title,
            groups: day.columns.map((column) => ({
              label: columnNames.get(column.column_uid) ?? "Deleted columns",
              uids: column.card_uids,
            })),
          });
        })
        .catch(() => {
          if (request === drillRequest.current) setDrill({ kind: "cards", title, groups: null, failed: true, onRetry: load });
        });
    };
    load();
  }, [boardId, filters, data]);

  return (
    <section aria-labelledby="flow-metrics-heading" className="flex flex-col gap-4 px-4 py-4" data-testid="flow-metrics">
      <div className="flex flex-col gap-2">
        <h2 id="flow-metrics-heading" className="text-xl font-semibold text-fg">Flow metrics</h2>
        <div className="flex flex-wrap items-center gap-2">
          {/* The default is not an active filter: it keeps the neutral trigger. */}
          <SingleSelectDropdown
            label="Last 90 days"
            ariaLabel="Date range"
            options={RANGES}
            selected={days === DEFAULT_DAYS ? null : days}
            onChange={(value) => setDays(value ?? DEFAULT_DAYS)}
            portalMenu
          />
          <SingleSelectDropdown
            label="All swimlanes"
            ariaLabel="Swimlane"
            options={swimlanes.map((s) => ({ value: s.id, label: s.name }))}
            selected={swimlaneId}
            onChange={setSwimlaneId}
            portalMenu
          />
          <SingleSelectDropdown
            label="All labels"
            ariaLabel="Label"
            options={labels.map((l) => ({ value: l.id, label: l.name }))}
            selected={labelId}
            onChange={setLabelId}
            portalMenu
          />
        </div>
        <p className="text-xs text-fg-tertiary">
          Calendar days in UTC, from each card&apos;s movement history. Filters use each card&apos;s current swimlane and labels.
        </p>
      </div>

      {failed && (
        <div className="flex items-center gap-2 py-6">
          <p className="text-sm text-danger" role="alert">Failed to load flow metrics.</p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="px-3 py-1.5 text-sm rounded text-fg-secondary hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Retry
          </button>
        </div>
      )}
      {!failed && !data && <LoadingPanels />}
      {data && isEmpty(data) && (
        <div className="flex flex-col items-center justify-center gap-2 py-8" data-testid="flow-empty">
          <svg className="w-10 h-10 text-fg-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 19V5m0 14h16M8 15l3-4 3 2 4-6" />
          </svg>
          {swimlaneId !== null || labelId !== null ? (
            <p className="text-sm font-medium text-fg-tertiary">No cards match these filters.</p>
          ) : (
            <>
              <p className="text-sm font-medium text-fg-tertiary">No flow history yet</p>
              {onGoToBoard && (
                <button
                  type="button"
                  onClick={onGoToBoard}
                  className="px-3 py-1.5 text-sm rounded bg-button-primary hover:bg-button-primary-hover text-on-primary focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  Go to board
                </button>
              )}
            </>
          )}
        </div>
      )}
      {data && !isEmpty(data) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <CycleTimePanel data={data.cycle} cards={cards} days={days} onSelect={selectCycleSample} />
          <ThroughputPanel data={data.throughput} onSelect={selectThroughputSample} />
          <CumulativeFlowPanel data={data.cumulative} onSelectDay={selectDay} />
          <WipAgePanel data={data.age} cards={cards} onSelect={selectAgeSample} />
        </div>
      )}
      {drill && (
        <FlowDrillDrawer
          boardId={boardId}
          selection={drill}
          cards={cards}
          onChange={setDrill}
          onClose={closeDrill}
          onOpenCard={onOpenCard}
        />
      )}
    </section>
  );
}

const compact = (notes: (string | null)[]) => notes.filter((note): note is string => note !== null);

function CycleTimePanel({
  data, cards, days, onSelect,
}: { data: FlowCycleTime; cards: Map<string, FlowCard>; days: number; onSelect: (s: FlowCycleTimeSample) => void }) {
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

function ThroughputPanel({ data, onSelect }: { data: FlowThroughput; onSelect: (s: FlowThroughputSample) => void }) {
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

function CumulativeFlowPanel({ data, onSelectDay }: { data: FlowCumulativeFlow; onSelectDay: (date: string) => void }) {
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

function WipAgePanel({
  data, cards, onSelect,
}: { data: FlowWipAge; cards: Map<string, FlowCard>; onSelect: (s: FlowAgeSample) => void }) {
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
