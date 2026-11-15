import { useEffect, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { FlowFilters } from "../../../api/flowMetrics";
import type { Column, FlowCumulativeFlow, FlowCycleTime, FlowThroughput, FlowWipAge } from "../../../types";
import type { ChartPanelView } from "../../Common/Chart";
import AnalyticsFilterBar from "./AnalyticsFilterBar";
import AttentionSection from "./AttentionSection";
import BlockedSection from "./BlockedSection";
import BottleneckPanel from "./BottleneckPanel";
import {
  CumulativeFlowPanel, CycleTimePanel, PanelPlaceholder, RegionSlot, ThroughputPanel, WipAgePanel,
} from "./FlowChartPanels";
import FlowDrillDrawer from "./FlowDrillDrawer";
import FlowSection from "./FlowSection";
import { exportCsv, loadViewMode, saveViewMode } from "./heatmap";
import type { ViewMode } from "./heatmap";
import HeadlineTiles from "./HeadlineTiles";
import { useAnalyticsOverviewData } from "./useAnalyticsOverviewData";
import { useFlowDrill } from "./useFlowDrill";

interface Props {
  boardId: number;
  filters: FlowFilters;
  onFiltersChange: (filters: FlowFilters) => void;
  swimlanes: { id: number; name: string }[];
  labels: { id: number; name: string }[];
  /** The board's columns, for WIP limits (matched on `uid`). */
  columns?: Pick<Column, "uid" | "wip_limit">[];
  currentUserRole?: string | null;
  onOpenCard?: (cardId: number) => void;
  onGoToBoard?: () => void;
  /** Where focus goes when Retry is pressed, so it does not drop to <body>. */
  headingRef?: RefObject<HTMLElement | null>;
  /** Reports the filters the numbers on screen were fetched for, so the page's title row names that period. */
  onFetchedFilters?: (filters: FlowFilters | null) => void;
}

function isEmpty(cycle: FlowCycleTime, throughput: FlowThroughput, cumulative: FlowCumulativeFlow, age: FlowWipAge) {
  return (
    cycle.sample_size === 0
    && throughput.total === 0
    && age.sample_size === 0
    && cumulative.days.every((day) => Object.values(day.counts).every((count) => count === 0))
  );
}

/** Two equal columns from `lg`, one below; every child may shrink (no sideways page scroll). */
function ChartRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 min-w-0">{children}</div>;
}

/**
 * The Analytics tab's Overview (#448, #2261): the filter bar, then one region
 * per slot of the build spec (`docs/development/analytics-redesign.md`).
 *
 * One tree with fixed positions: every region is always rendered and shows its
 * own skeleton, failure or data inside its own frame, so a chart never changes
 * position when a sibling changes state (React would remount it). A refetch
 * keeps the previous answers on screen, dimmed, until the new ones are in.
 */
export default function AnalyticsOverview({
  boardId, filters, onFiltersChange, swimlanes, labels, columns = [], currentUserRole = null,
  onOpenCard, onGoToBoard, headingRef, onFetchedFilters,
}: Props) {
  const [attempt, setAttempt] = useState(0);
  // Here, not in the panels, so a panel's Chart | Table choice outlives a refetch.
  const [views, setViews] = useState<Record<string, ChartPanelView>>({});
  const [mode, setModeState] = useState<ViewMode>(() => loadViewMode(boardId));
  const { results, fetchedFilters, loading, failed } = useAnalyticsOverviewData(boardId, filters, attempt);

  useEffect(() => { onFetchedFilters?.(fetchedFilters); }, [fetchedFilters, onFetchedFilters]);

  const cycle = results?.cycle.data;
  const throughput = results?.throughput.data;
  const cumulative = results?.cumulative.data;
  const wipAge = results?.wipAge.data;
  const dwell = results?.dwell.data;
  const attention = results?.attention.data;
  const analytics = results?.analytics.data;

  const {
    drill, setDrill, cards, closeDrill, openCards, selectCycleSample, selectThroughputSample, selectAgeSample, selectDay,
  } = useFlowDrill(boardId, filters, { cycle, throughput, cumulative, wipAge, attention });

  const setMode = (next: ViewMode) => {
    saveViewMode(boardId, next);
    setModeState(next);
  };

  const panelView = (panel: string) => ({
    view: views[panel] ?? ("chart" as ChartPanelView),
    onViewChange: (view: ChartPanelView) => setViews((current) => ({ ...current, [panel]: view })),
  });

  const openColumn = (uid: string) => {
    const name = cumulative?.columns.find((c) => c.column_uid === uid)?.column_name ?? "this column";
    const oldestFirst = [...(wipAge?.samples ?? [])]
      .filter((s) => s.column_uid === uid)
      .sort((a, b) => b.value_days - a.value_days)
      .map((s) => s.card_uid);
    openCards(`Cards in ${name} now`, oldestFirst);
  };

  // Period-labelled copy names the period the numbers on screen were fetched for, not the live selection.
  const shownDays = (fetchedFilters ?? filters).days;
  const busy = loading && results !== null;
  const settled = results !== null;
  const filtered = filters.swimlaneId !== null || filters.labelId !== null;
  const empty = cycle && throughput && cumulative && wipAge ? isEmpty(cycle, throughput, cumulative, wipAge) : false;
  const canExport = currentUserRole === "admin" || currentUserRole === "site_admin";
  const exportable = analytics?.swimlanes ? analytics : null;

  return (
    <div className="flex flex-col gap-4 min-w-0" data-testid="flow-metrics">
      <AnalyticsFilterBar
        filters={filters}
        onFiltersChange={onFiltersChange}
        swimlanes={swimlanes}
        labels={labels}
        actions={canExport && exportable ? (
          <button
            type="button"
            onClick={() => exportCsv(exportable, mode)}
            className="text-sm px-3 py-1.5 rounded border border-line-strong text-fg-secondary hover:bg-surface-hover hover:text-fg transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Export CSV
          </button>
        ) : undefined}
      />
      <p role="status" className="sr-only">
        {loading ? (results === null ? "Loading flow metrics" : "Updating") : ""}
      </p>
      {failed && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-danger" role="alert">Some panels failed to load.</p>
          <button
            type="button"
            onClick={() => {
              // The button unmounts once the panels load, which would drop focus to <body>.
              headingRef?.current?.focus();
              setAttempt((n) => n + 1);
            }}
            className="px-3 py-1.5 text-sm rounded border border-line-strong text-fg-secondary hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Retry
          </button>
        </div>
      )}
      {empty ? (
        // The whole board has nothing to show: one block in place of regions 5 to 9 (#2264 redesigns it).
        <div className="flex flex-col items-center justify-center gap-2 py-8" data-testid="flow-empty">
          <svg className="w-10 h-10 text-fg-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 19V5m0 14h16M8 15l3-4 3 2 4-6" />
          </svg>
          {filtered ? (
            <p className="text-sm font-medium text-fg-tertiary">No cards match these filters.</p>
          ) : (
            <>
              <p className="text-sm font-medium text-fg-tertiary">No flow history yet</p>
              {onGoToBoard && (
                <button
                  type="button"
                  onClick={onGoToBoard}
                  className="px-3 py-1.5 text-sm font-medium rounded bg-button-primary hover:bg-button-primary-hover text-on-primary focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  Go to board
                </button>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 min-w-0">
            <RegionSlot busy={busy} className="lg:col-span-2">
              <BottleneckPanel
                cumulative={cumulative}
                dwell={dwell}
                cycle={cycle}
                wipAge={wipAge}
                columns={columns}
                filtered={filtered}
                failed={settled && !cumulative}
                onOpenColumn={openColumn}
                onGoToBoard={onGoToBoard}
              />
            </RegionSlot>
            <RegionSlot busy={busy} className="lg:col-span-3">
              <HeadlineTiles
                cycle={cycle}
                throughput={throughput}
                wipAge={wipAge}
                blocked={results?.blocked.data}
                columns={columns}
                filtered={filtered}
                settled={settled}
              />
            </RegionSlot>
          </div>
          <RegionSlot busy={busy}>
            <FlowSection analytics={results?.analytics} mode={mode} onModeChange={setMode} filters={{ ...filters, days: shownDays }} />
          </RegionSlot>
          <ChartRow>
            <RegionSlot busy={busy}>
              {cumulative
                ? <CumulativeFlowPanel {...panelView("cumulative")} data={cumulative} onSelectDay={selectDay} />
                : <PanelPlaceholder title="Cumulative flow" failed={settled} />}
            </RegionSlot>
            <RegionSlot busy={busy}>
              {throughput
                ? <ThroughputPanel {...panelView("throughput")} data={throughput} onSelect={selectThroughputSample} />
                : <PanelPlaceholder title="Throughput" failed={settled} />}
            </RegionSlot>
          </ChartRow>
          <ChartRow>
            <RegionSlot busy={busy}>
              {wipAge
                ? <WipAgePanel {...panelView("age")} data={wipAge} cards={cards} onSelect={selectAgeSample} />
                : <PanelPlaceholder title="WIP aging" failed={settled} />}
            </RegionSlot>
            <RegionSlot busy={busy}>
              <AttentionSection attention={results?.attention} swimlanes={swimlanes} onOpenCard={onOpenCard} />
            </RegionSlot>
          </ChartRow>
          <ChartRow>
            <RegionSlot busy={busy}>
              {cycle
                ? <CycleTimePanel {...panelView("cycle")} data={cycle} cards={cards} days={shownDays} onSelect={selectCycleSample} />
                : <PanelPlaceholder title="Cycle time" failed={settled} />}
            </RegionSlot>
            <RegionSlot busy={busy}>
              <BlockedSection blocked={results?.blocked} days={shownDays} />
            </RegionSlot>
          </ChartRow>
        </>
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
    </div>
  );
}

