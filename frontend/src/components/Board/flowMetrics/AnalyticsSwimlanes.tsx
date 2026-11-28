import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getFlowSwimlanes } from "../../../api/flowMetrics";
import { analyticsErrorKind, analyticsErrorMessage, analyticsErrorRetryable, cancelableWait, withAnalyticsBusyRetry } from "../../../api/analyticsErrors";
import type { FlowFilters } from "../../../api/flowMetrics";
import type { FlowSwimlaneComparison, FlowSwimlaneRow } from "../../../types";
import { CHART_COLORS, CHART_HUE } from "../../../utils/chartScale";
import SingleSelectDropdown from "../../Common/SingleSelectDropdown";
import AnalyticsFilterBar from "./AnalyticsFilterBar";
import {
  MEDIAN_APPEARS_AT, SORT_OPTIONS, barScale, blockedText, cycleText, dayText, findingText, sortRows, statusText, trendText,
} from "./swimlanesFormat";
import type { SwimlaneSort } from "./swimlanesFormat";

interface Props {
  boardId: number;
  filters: FlowFilters;
  onFiltersChange: (filters: FlowFilters) => void;
  labels: { id: number; name: string }[];
  /** Swimlane custom fields for "Group lanes by". */
  swimlaneFields?: { id: number; name: string }[];
  /** Sort and Group lanes by live in the URL (#2546), so the page owns them. */
  sort: SwimlaneSort;
  onSortChange: (sort: SwimlaneSort) => void;
  groupId: number | null;
  onGroupChange: (groupId: number | null) => void;
  /** A swimlane name opens the Overview filtered to that swimlane. */
  onOpenSwimlane: (swimlaneId: number) => void;
  /** Reports the filters the numbers on screen were fetched for (the title row's period). */
  onFetchedFilters?: (filters: FlowFilters | null) => void;
  /** #2051 — the board's zone; a change refetches because every bucket moves. */
  timeZone?: string | null;
}

const pct = (value: number, scale: number) => `${Math.min(100, Math.max(0, (value / scale) * 100))}%`;

function CycleBar({ row, scale, boardMedian }: { row: FlowSwimlaneRow; scale: number; boardMedian: number | null }) {
  const color = row.status === "slower" ? CHART_COLORS.warning : CHART_HUE;
  return (
    <div className="relative h-3 rounded bg-surface-hover" aria-hidden="true" data-testid="cycle-bar">
      {row.median_days !== null && (
        <div className="absolute inset-y-0 left-0 rounded" style={{ width: pct(row.median_days, scale), background: color }} />
      )}
      {row.median_days !== null && row.p85_days !== null && (
        <div
          className="absolute top-1/2 h-0.5 -translate-y-1/2"
          data-testid="p85-line"
          style={{ left: pct(row.median_days, scale), width: pct(Math.max(0, row.p85_days - row.median_days), scale), background: color }}
        />
      )}
      {boardMedian !== null && (
        <div className="absolute -top-1 -bottom-1 w-0.5 bg-fg" data-testid="board-tick" style={{ left: pct(boardMedian, scale) }} />
      )}
    </div>
  );
}

function TrendBars({ row }: { row: FlowSwimlaneRow }) {
  const values = row.rolling_median.map((p) => p.median_days);
  const max = Math.max(0, ...values.filter((v): v is number => v !== null));
  const color = row.status === "slower" || row.trend?.direction === "slower" ? CHART_COLORS.warning : CHART_HUE;
  if (!row.trend || max === 0) return <div className="h-6" aria-hidden="true" />;
  return (
    <div className="flex items-end gap-0.5 h-6" aria-hidden="true" data-testid="trend-bars">
      {values.map((v, i) => (
        <div key={i} className="flex-1 rounded-sm" style={{ height: v === null ? "2px" : `${Math.max(8, (v / max) * 100)}%`, background: v === null ? CHART_COLORS.neutral : color }} />
      ))}
    </div>
  );
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 flex flex-col gap-1">
      <span className="text-xs text-fg-tertiary">{label}</span>
      {children}
    </div>
  );
}

function LaneRow({ row, scale, boardMedian, onOpen }: {
  row: FlowSwimlaneRow; scale: number; boardMedian: number | null; onOpen: (id: number) => void;
}) {
  const status = statusText(row);
  const statusClass = row.status === "slower" ? "text-warning" : row.status === "faster" ? "text-success" : "text-fg-tertiary";
  const trendClass = row.trend?.direction === "slower" ? "text-warning" : row.trend?.direction === "faster" ? "text-success" : "text-fg-secondary";
  return (
    <li
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,3fr)_minmax(0,2fr)_minmax(0,1.6fr)_minmax(0,1fr)] gap-x-6 gap-y-3 py-4 border-b border-line last:border-b-0 items-start"
      data-testid="swimlane-row"
    >
      <div className="min-w-0 flex flex-col gap-1 sm:col-span-2 lg:col-span-1">
        <button
          type="button"
          onClick={() => onOpen(row.id)}
          className="self-start max-w-full text-left text-base font-semibold text-fg hover:underline underline-offset-2 truncate min-h-6 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          title={row.name}
          aria-label={`${row.name}, open in Overview`}
        >
          {row.name}
        </button>
        {status && <span className={`text-xs font-medium ${statusClass}`}>{status}</span>}
      </div>
      <Cell label="Cycle time">
        <CycleBar row={row} scale={scale} boardMedian={boardMedian} />
        <span className="text-xs text-fg-secondary">{cycleText(row)}</span>
      </Cell>
      <Cell label="Trend in period">
        <TrendBars row={row} />
        <span className={`text-xs font-medium ${trendClass}`}>{trendText(row)}</span>
      </Cell>
      <Cell label="Blocked time">
        <div className="h-2 rounded bg-surface-hover mt-0.5" aria-hidden="true">
          <div className="h-2 rounded" style={{ width: pct(row.blocked_share ?? 0, 1), background: CHART_COLORS.danger }} />
        </div>
        <span className="text-xs text-fg-secondary">{blockedText(row)}</span>
      </Cell>
      <div className="min-w-0 text-xs text-fg-secondary flex flex-col gap-0.5">
        <span>{row.in_progress} in progress</span>
        <span className="font-semibold text-fg">{row.finished} finished</span>
      </div>
    </li>
  );
}

/**
 * The Swimlanes view (#2267): one row per swimlane, ranked by how long work
 * takes. Status, trend and percentiles come from the server; this draws them.
 */
export default function AnalyticsSwimlanes({
  boardId, filters, onFiltersChange, labels, swimlaneFields = [], sort, onSortChange, groupId, onGroupChange, onOpenSwimlane, onFetchedFilters, timeZone,
}: Props) {
  const [data, setData] = useState<FlowSwimlaneComparison | null>(null);
  const [fetched, setFetched] = useState<FlowFilters | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // Why the last load failed (#2428): busy and too much history have their own copy.
  const [failedKind, setFailedKind] = useState<ReturnType<typeof analyticsErrorKind>>("other");
  const [attempt, setAttempt] = useState(0);
  const { days, labelId } = filters;
  // Both Retry buttons unmount when the reload starts. The root stays mounted through
  // loading, refusal and loaded, so Retry focuses it and focus never drops to <body> (#2428).
  const rootRef = useRef<HTMLDivElement>(null);
  const retry = () => { rootRef.current?.focus(); setAttempt((n) => n + 1); };

  useEffect(() => {
    let current = true;
    // Cancels a pending busy retry when this load is superseded or the table unmounts (#2428).
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    withAnalyticsBusyRetry(() => getFlowSwimlanes(boardId, { days, labelId }, groupId ?? undefined), cancelableWait, controller.signal)
      .then((result) => {
        if (!current) return;
        setData(result);
        setFetched({ days, labelId, swimlaneId: null });
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (current) { setFailedKind(analyticsErrorKind(error)); setFailed(true); setLoading(false); }
      });
    return () => { current = false; controller.abort(); };
    // timeZone is a refetch key only (#2051).
}, [boardId, days, labelId, groupId, attempt, timeZone]);

  useEffect(() => { onFetchedFilters?.(fetched); }, [fetched, onFetchedFilters]);

  const scale = useMemo(() => (data ? barScale(data) : 1), [data]);
  const finding = data ? findingText(data) : null;
  const sections = useMemo(() => {
    if (!data) return [];
    const rows = sortRows(data.swimlanes, sort);
    if (!data.grouping) return [{ key: "all", title: null as string | null, rows }];
    const named = data.grouping.groups.map((g) => ({
      key: g.key, title: g.name ?? g.key, rows: rows.filter((r) => r.group === g.key),
    }));
    const rest = rows.filter((r) => !data.grouping!.groups.some((g) => g.key === r.group));
    return [...named, ...(rest.length ? [{ key: "none", title: `No ${data.grouping.field_name}`, rows: rest }] : [])]
      .filter((s) => s.rows.length > 0);
  }, [data, sort]);

  const groupOptions = [{ value: 0, label: "None" }, ...swimlaneFields.map((f) => ({ value: f.id, label: f.name }))];
  const groupName = swimlaneFields.find((f) => f.id === groupId)?.name;

  return (
    <div ref={rootRef} tabIndex={-1} className="flex flex-col gap-4 min-w-0 focus:outline-none" data-testid="analytics-swimlanes">
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <AnalyticsFilterBar filters={filters} onFiltersChange={onFiltersChange} swimlanes={[]} labels={labels} showSwimlane={false} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {swimlaneFields.length > 0 && (
            <SingleSelectDropdown
              label={groupName ?? "None"}
              triggerPrefix="Group lanes by:"
              ariaLabel="Group lanes by"
              options={groupOptions}
              selected={groupId ?? 0}
              onChange={(value) => onGroupChange(value ? value : null)}
              portalMenu
            />
          )}
          <SingleSelectDropdown
            label={SORT_OPTIONS.find((o) => o.value === sort)?.label ?? "Slowest first"}
            triggerPrefix="Sort:"
            ariaLabel="Sort"
            options={SORT_OPTIONS}
            selected={sort}
            onChange={(value) => onSortChange(value ?? "slowest")}
            portalMenu
          />
        </div>
      </div>
      <div role="status" className="sr-only">{loading && data ? "Updating" : ""}</div>
      {failed && !data ? (
        <div role="alert" className="bg-surface border border-line rounded-lg p-4 flex flex-col gap-2 items-start">
          <p className="text-sm text-fg-secondary">{analyticsErrorMessage(failedKind) ?? "Could not load swimlanes."}</p>
          {analyticsErrorRetryable(failedKind) && <button type="button" onClick={retry} className="min-h-6 px-3 text-sm rounded border border-line-strong text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
            Retry
          </button>}
        </div>
      ) : !data || !finding ? (
        <div className="bg-surface border border-line rounded-lg p-4 h-64 animate-pulse motion-reduce:animate-none" data-testid="panel-skeleton" aria-busy="true">
          <span className="sr-only">Loading swimlanes…</span>
        </div>
      ) : (
        <div className={`flex flex-col gap-4 min-w-0 ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
          {failed && (
            <div role="alert" className="text-sm text-fg-secondary flex flex-wrap items-center gap-3">
              {analyticsErrorMessage(failedKind) ?? "Could not refresh swimlanes."} The numbers below are from the last load.
              {analyticsErrorRetryable(failedKind) && <button type="button" onClick={retry} className="min-h-6 px-3 text-sm rounded border border-line-strong text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
                Retry
              </button>}
            </div>
          )}
          <section
            className={`bg-surface border rounded-lg p-4 ${data.swimlanes.some((s) => s.status === "slower") ? "border-warning" : "border-line"}`}
            data-testid="swimlanes-finding"
          >
            <h2 className="text-base font-semibold text-fg">{finding.heading}</h2>
            <p className="text-sm text-fg-secondary mt-1 max-w-3xl">{finding.sentence}</p>
          </section>
          <section className="bg-surface border border-line rounded-lg px-4 min-w-0">
            <h2 className="sr-only">Swimlanes</h2>
            {data.swimlanes.length === 0 && <p className="text-sm text-fg-secondary py-4">This board has no swimlanes.</p>}
            {sections.map((section) => (
              <div key={section.key}>
                {section.title && <h3 className="text-sm font-semibold text-fg pt-4">{section.title}</h3>}
                <ul>
                  {section.rows.map((row) => (
                    <LaneRow key={row.id} row={row} scale={scale} boardMedian={data.board.median_days} onOpen={onOpenSwimlane} />
                  ))}
                </ul>
              </div>
            ))}
            {data.swimlanes.length > 0 && <p className="text-xs text-fg-tertiary py-3 border-t border-line flex flex-wrap gap-x-6 gap-y-1" data-testid="swimlanes-legend">
              <span>
                <span aria-hidden="true" className="inline-block w-0.5 h-3 bg-fg align-middle mr-1.5" />
                Board median{data.board.median_days !== null ? `, ${dayText(data.board.median_days)} days` : ""}
              </span>
              <span>Solid bar: median. Thin line: reaches the 85% mark.</span>
              <span>Trend compares rolling medians inside the selected period.</span>
              <span>Swimlanes with fewer than {MEDIAN_APPEARS_AT} finished cards show no median.</span>
            </p>}
          </section>
        </div>
      )}
    </div>
  );
}
