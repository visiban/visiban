import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getFlowCumulativeDay } from "../../../api/flowMetrics";
import { analyticsErrorKind, analyticsErrorMessage, analyticsErrorRetryable, withAnalyticsBusyRetry } from "../../../api/analyticsErrors";
import type { FlowFilters } from "../../../api/flowMetrics";
import type {
  FlowAgeSample, FlowAttention, FlowCard, FlowCumulativeFlow, FlowCycleTime, FlowCycleTimeSample, FlowThroughput,
  FlowThroughputSample, FlowWipAge,
} from "../../../types";
import type { DrillSelection } from "./FlowDrillDrawer";
import { bandName, formatDate, formatDays } from "./flowFormat";

interface DrillData {
  cycle?: FlowCycleTime;
  throughput?: FlowThroughput;
  cumulative?: FlowCumulativeFlow;
  wipAge?: FlowWipAge;
  attention?: FlowAttention;
}

/**
 * The drill-down drawer's state for the Analytics Overview (#448, #2261): what
 * is open, and the card directory every response contributes to. A filter
 * change closes the drawer, because what it lists no longer matches the page.
 */
export function useFlowDrill(boardId: number, filters: FlowFilters, data: DrillData) {
  const [drill, setDrill] = useState<DrillSelection | null>(null);
  const [dayCards, setDayCards] = useState<FlowCard[]>([]);
  // A filter changed while the day's list was loading: drop that late answer.
  const drillRequest = useRef(0);
  const { cycle, throughput, cumulative, wipAge, attention } = data;

  const cards = useMemo(() => {
    const directory = new Map<string, FlowCard>();
    for (const card of [
      ...(cycle?.cards ?? []),
      ...(throughput?.cards ?? []),
      ...(wipAge?.cards ?? []),
      ...(attention?.cards ?? []),
      ...dayCards,
    ]) {
      directory.set(card.uid, card);
    }
    return directory;
  }, [cycle, throughput, wipAge, attention, dayCards]);

  const closeDrill = useCallback(() => {
    drillRequest.current += 1;
    setDrill(null);
  }, []);

  useEffect(() => { closeDrill(); }, [filters, closeDrill]);

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

  const openCards = (title: string, uids: string[], more = 0) =>
    setDrill({ kind: "cards", title, groups: [{ label: null, uids }], ...(more > 0 && { more }) });

  // A capped response (#2429) keeps each period's whole count but lists only the first cards.
  const selectThroughputSample = (sample: FlowThroughputSample) =>
    openCards(`Finished the week of ${formatDate(sample.start)}`, sample.card_uids, sample.count - sample.card_uids.length);

  const selectAgeSample = (sample: FlowAgeSample) => {
    const names = new Map(wipAge?.columns.map((c) => [c.column_uid, c.column_name]));
    const p85 = wipAge?.cycle_time_percentiles.p85 ?? null;
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
      // A day's cards read the whole history, so an old board can be too large here (#2428).
      withAnalyticsBusyRetry(() => getFlowCumulativeDay(boardId, filters, date))
        .then((day) => {
          if (request !== drillRequest.current) return;
          setDayCards(day.cards);
          const columnNames = new Map(cumulative?.columns.map((c) => [c.column_uid, bandName(c)]));
          setDrill({
            kind: "cards",
            title,
            groups: day.columns.map((column) => ({
              label: columnNames.get(column.column_uid) ?? "Deleted columns",
              uids: column.card_uids,
            })),
          });
        })
        .catch((error: unknown) => {
          if (request !== drillRequest.current) return;
          const kind = analyticsErrorKind(error);
          setDrill({
            kind: "cards", title, groups: null, failed: true,
            failedMessage: analyticsErrorMessage(kind) ?? undefined,
            onRetry: analyticsErrorRetryable(kind) ? load : undefined,
          });
        });
    };
    load();
  }, [boardId, filters, cumulative]);

  return {
    drill, setDrill, cards, closeDrill, openCards, selectCycleSample, selectThroughputSample, selectAgeSample, selectDay,
  };
}
