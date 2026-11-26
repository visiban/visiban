import { useEffect, useMemo, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { FlowFilters } from "../../../api/flowMetrics";
import type { Column, CustomFieldDefinition, FlowCumulativeFlow, FlowCycleTime, FlowThroughput, FlowWipAge } from "../../../types";
import type { ChartPanelView } from "../../Common/Chart";
import AnalyticsFilterBar from "./AnalyticsFilterBar";
import { NO_BREAKDOWN, breakdownFields, breakdownKey, breakdownNote, breakdownNoun, breakdownParams } from "./breakdown";
import type { Breakdown } from "./breakdown";
import GroupLegend from "./GroupLegend";
import AttentionSection from "./AttentionSection";
import BlockedSection from "./BlockedSection";
import BottleneckPanel from "./BottleneckPanel";
import { buildColumnSelection } from "./columnDrill";
import {
  CumulativeFlowPanel, CycleTimePanel, PanelPlaceholder, RegionSlot, ThroughputPanel, WipAgePanel,
} from "./FlowChartPanels";
import { NoHistoryState, NoMatchState, isNarrowed } from "./FlowEmptyStates";
import FlowDrillDrawer from "./FlowDrillDrawer";
import FlowSection from "./FlowSection";
import { resolveZone } from "./flowFormat";
import { exportCsv, loadViewMode, saveViewMode } from "./heatmap";
import type { ViewMode } from "./heatmap";
import HeadlineTiles from "./HeadlineTiles";
import { useAnalyticsOverviewData } from "./useAnalyticsOverviewData";
import { analyticsErrorMessage, analyticsErrorRetryable } from "../../../api/analyticsErrors";
import { useFlowDrill } from "./useFlowDrill";

interface Props {
  boardId: number;
  filters: FlowFilters;
  onFiltersChange: (filters: FlowFilters) => void;
  swimlanes: { id: number; name: string }[];
  labels: { id: number; name: string }[];
  /** The board's columns, for WIP limits (matched on `uid`). */
  columns?: (Pick<Column, "uid" | "wip_limit"> & { name?: string })[];
  currentUserRole?: string | null;
  onOpenCard?: (cardId: number) => void;
  onGoToBoard?: () => void;
  /** Where focus goes when Retry is pressed, so it does not drop to <body>. */
  headingRef?: RefObject<HTMLElement | null>;
  /**
   * The board's card custom fields (#2268). Dropdown and checkbox ones become "Break down by"
   * entries. Card fields carry no admin-only flag, so every role sees the same list.
   */
  customFields?: Pick<CustomFieldDefinition, "id" | "name" | "field_type" | "position">[];
  /**
   * The "Break down by" choice, when the page keeps it in the URL (#2318). Omitted, the Overview
   * keeps its own, as before.
   */
  breakdown?: Breakdown;
  onBreakdownChange?: (breakdown: Breakdown) => void;
  /** Reports the filters the numbers on screen were fetched for, so the page's title row names that period. */
  onFetchedFilters?: (filters: FlowFilters | null) => void;
  /** #2051 — the board's zone; a change refetches because every bucket moves. */
  timeZone?: string | null;
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
 * One of the Overview's four questions (#2457): what is happening, how fast,
 * where work is stuck, why it is stuck. A heading and a line of context over
 * the panels that answer it; no panel is added or hidden by the grouping.
 */
function AnalyticsQuestion({ id, title, hint, children }: { id: string; title: string; hint: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`analytics-q-${id}`} className="flex flex-col gap-3 min-w-0" data-testid={`analytics-q-${id}`}>
      <div>
        <h2 id={`analytics-q-${id}`} className="text-base font-semibold text-fg">{title}</h2>
        <p className="text-xs text-fg-tertiary">{hint}</p>
      </div>
      {children}
    </section>
  );
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
  onOpenCard, onGoToBoard, headingRef, onFetchedFilters, customFields = [], breakdown: breakdownProp, onBreakdownChange, timeZone,
}: Props) {
  const [ownBreakdown, setOwnBreakdown] = useState<Breakdown>(NO_BREAKDOWN);
  const breakdown = breakdownProp ?? ownBreakdown;
  // Which group is isolated (its index in the response's groups); changing the breakdown clears it.
  const [isolated, setIsolated] = useState<number | null>(null);
  const setBreakdown = (next: Breakdown) => {
    setIsolated(null);
    if (onBreakdownChange) onBreakdownChange(next); else setOwnBreakdown(next);
  };
  const fields = useMemo(() => breakdownFields(customFields), [customFields]);
  const bKey = breakdownKey(breakdown);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bKey is the breakdown's identity; the object is rebuilt only when it changes
  const grouping = useMemo(() => breakdownParams(breakdown), [bKey]);
  const [attempt, setAttempt] = useState(0);
  // Here, not in the panels, so a panel's Chart | Table choice outlives a refetch.
  const [views, setViews] = useState<Record<string, ChartPanelView>>({});
  const [mode, setModeState] = useState<ViewMode>(() => loadViewMode(boardId));
  const { results, fetchedFilters, loading, failed, failedKind } = useAnalyticsOverviewData(boardId, filters, attempt, grouping, timeZone);

  useEffect(() => { onFetchedFilters?.(fetchedFilters); }, [fetchedFilters, onFetchedFilters]);

  const cycle = results?.cycle.data;
  const throughput = results?.throughput.data;
  const cumulative = results?.cumulative.data;
  const wipAge = results?.wipAge.data;
  const dwell = results?.dwell.data;
  const attention = results?.attention.data;
  const analytics = results?.analytics.data;

  const {
    drill, setDrill, cards, closeDrill, selectCycleSample, selectThroughputSample, selectAgeSample, selectDay,
  } = useFlowDrill(boardId, filters, { cycle, throughput, cumulative, wipAge, attention }, timeZone);
  // Instants (a completion, a transition, an axis tick) read in the board zone; bucket days stay UTC labels (#2051).
  const zone = resolveZone(timeZone ?? "UTC");

  const setMode = (next: ViewMode) => {
    saveViewMode(boardId, next);
    setModeState(next);
  };

  const panelView = (panel: string) => ({
    view: views[panel] ?? ("chart" as ChartPanelView),
    onViewChange: (view: ChartPanelView) => setViews((current) => ({ ...current, [panel]: view })),
  });

  const openColumn = (uid: string) => setDrill(buildColumnSelection(uid, { cumulative, dwell, wipAge, columns }, filtered));

  // Period-labelled copy names the period the numbers on screen were fetched for, not the live selection.
  const shownDays = (fetchedFilters ?? filters).days;
  const busy = loading && results !== null;
  const settled = results !== null;
  // The empty block follows the data on screen, so its chips and copy follow the filters that data was fetched
  // for, not the live selection: otherwise a pending refetch would show the wrong state.
  const shownFilters = fetchedFilters ?? filters;
  // Board-wide WIP-limit wording follows the same fetched filters: the dimmed data on screen was not narrowed by the live selection.
  const filtered = shownFilters.swimlaneId !== null || shownFilters.labelId !== null;
  const narrowed = isNarrowed(shownFilters);
  const empty = cycle && throughput && cumulative && wipAge ? isEmpty(cycle, throughput, cumulative, wipAge) : false;
  // The legend and colors follow the grouping on screen (the data's), not the live selection, like every other fetched-state label.
  const legendGrouping = (cycle?.grouping ?? throughput?.grouping ?? wipAge?.grouping ?? dwell?.grouping) ?? null;
  const legendGroups = legendGrouping && legendGrouping.groups.length > 0 ? legendGrouping.groups : null;
  const noun = legendGrouping ? breakdownNoun(legendGrouping, customFields.find((f) => f.id === legendGrouping.field_id)?.name) : undefined;
  // Isolation is an index into the groups on screen: drop it when the groups themselves change (a filter can reorder them).
  const groupSignature = legendGroups?.map((g) => g.key ?? "other").join("|") ?? "";
  useEffect(() => { setIsolated(null); }, [groupSignature]);
  const canExport = currentUserRole === "admin" || currentUserRole === "site_admin";
  const exportable = analytics?.swimlanes ? analytics : null;

  return (
    <div className="flex flex-col gap-4 min-w-0" data-testid="flow-metrics">
      <AnalyticsFilterBar
        filters={filters}
        onFiltersChange={onFiltersChange}
        swimlanes={swimlanes}
        labels={labels}
        breakdown={breakdown}
        onBreakdownChange={setBreakdown}
        breakdownFields={fields}
        actions={canExport && exportable ? (
          <button
            type="button"
            onClick={() => exportCsv(exportable, mode)}
            className="text-sm px-3 py-1.5 rounded border border-line-strong bg-surface text-fg-secondary hover:bg-surface-hover hover:text-fg transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Export CSV
          </button>
        ) : undefined}
      />
      {legendGroups && legendGrouping && !empty && (
        <GroupLegend
          groups={legendGroups}
          noun={noun ?? "group"}
          note={breakdownNote(legendGrouping.by === "custom_field" ? "custom_field" : legendGrouping.by)}
          isolated={isolated}
          onIsolate={setIsolated}
        />
      )}
      {legendGrouping && !legendGroups && !empty && (
        // A breakdown with no groups would otherwise draw exactly like None, with nothing to say why.
        <p role="status" className="text-sm text-fg-tertiary" data-testid="group-legend-empty">
          No cards in this view have a {noun ?? "group"} to break down by.
        </p>
      )}
      <p role="status" className="sr-only">
        {loading ? (results === null ? "Loading flow metrics" : "Updating") : (empty ? (narrowed ? "No cards match these filters" : "Nothing has moved yet") : "")}
      </p>
      {failed && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-danger-on-tint" role="alert">{analyticsErrorMessage(failedKind) ?? "Some panels failed to load."}</p>
          {/* Too much history is not retried: the same request would be refused again (#2428). */}
          {analyticsErrorRetryable(failedKind) && (
            <button
              type="button"
              onClick={() => {
                // The button unmounts once the panels load, which would drop focus to <body>.
                headingRef?.current?.focus();
                setAttempt((n) => n + 1);
              }}
              className="px-3 py-1.5 text-sm rounded border border-line-strong bg-surface text-fg-secondary hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Retry
            </button>
          )}
        </div>
      )}
      {empty ? (
        // Nothing to draw: one block in place of regions 5 to 9. Going from here to data remounts
        // the charts, which is safe because it follows the data itself, not a sibling's state.
        <div aria-busy={busy} className={`min-w-0 transition-opacity motion-reduce:transition-none ${busy ? "opacity-60" : ""}`}>
          {narrowed
            ? <NoMatchState filters={shownFilters} swimlanes={swimlanes} labels={labels} onFiltersChange={onFiltersChange} onBeforeChange={() => headingRef?.current?.focus()} />
            : <NoHistoryState onGoToBoard={onGoToBoard} />}
        </div>
      ) : (
        <>
          <AnalyticsQuestion id="happening" title="What is happening?" hint="Where the bottleneck is, and the headline numbers.">
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
          </AnalyticsQuestion>
          <AnalyticsQuestion id="fast" title="How fast does work move?" hint="How long finished work took and how much finishes each week.">
            <ChartRow>
              <RegionSlot busy={busy}>
                {throughput
                  ? <ThroughputPanel {...panelView("throughput")} data={throughput} onSelect={selectThroughputSample} noun={noun} isolated={isolated} />
                  : <PanelPlaceholder title="Throughput" failed={settled} />}
              </RegionSlot>
              <RegionSlot busy={busy}>
                {cycle
                  ? <CycleTimePanel {...panelView("cycle")} data={cycle} cards={cards} days={shownDays} onSelect={selectCycleSample} noun={noun} isolated={isolated} timeZone={zone} />
                  : <PanelPlaceholder title="Cycle time" failed={settled} />}
              </RegionSlot>
            </ChartRow>
          </AnalyticsQuestion>
          <AnalyticsQuestion id="stuck" title="Where is work stuck?" hint="Which columns queue, and which in-progress cards are getting old.">
            <RegionSlot busy={busy}>
              <FlowSection
                analytics={results?.analytics}
                cumulative={cumulative}
                dwell={dwell}
                wipAge={wipAge}
                throughput={throughput}
                columns={columns}
                mode={mode}
                onModeChange={setMode}
                {...panelView("flow")}
                filters={shownFilters}
                filtered={filtered}
                settled={settled}
                onOpenColumn={openColumn}
                isolated={isolated}
                breakdownNoun={noun}
              />
            </RegionSlot>
            <ChartRow>
              <RegionSlot busy={busy}>
                {cumulative
                  ? <CumulativeFlowPanel {...panelView("cumulative")} data={cumulative} onSelectDay={selectDay} />
                  : <PanelPlaceholder title="Cumulative flow" failed={settled} loadingNote={!settled} />}
              </RegionSlot>
              <RegionSlot busy={busy}>
                {wipAge
                  ? <WipAgePanel {...panelView("age")} data={wipAge} cards={cards} onSelect={selectAgeSample} noun={noun} isolated={isolated} />
                  : <PanelPlaceholder title="WIP age" failed={settled} />}
              </RegionSlot>
            </ChartRow>
          </AnalyticsQuestion>
          <AnalyticsQuestion id="why" title="Why is it stuck?" hint="Block reasons, and the cards that need attention now.">
            <ChartRow>
              <RegionSlot busy={busy}>
                <BlockedSection blocked={results?.blocked} days={shownDays} />
              </RegionSlot>
              <RegionSlot busy={busy}>
                <AttentionSection attention={results?.attention} swimlanes={swimlanes} columns={columns} onOpenCard={onOpenCard} />
              </RegionSlot>
            </ChartRow>
          </AnalyticsQuestion>
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
          timeZone={zone}
        />
      )}
    </div>
  );
}

