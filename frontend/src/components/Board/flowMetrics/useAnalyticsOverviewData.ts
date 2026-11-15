import { useEffect, useState } from "react";
import { getBoardAnalytics } from "../../../api/boards";
import {
  getFlowAttention, getFlowBlocked, getFlowCumulativeFlow, getFlowCycleTime, getFlowDwell, getFlowThroughput, getFlowWipAge,
} from "../../../api/flowMetrics";
import type { FlowFilters } from "../../../api/flowMetrics";
import type {
  FlowAttention, FlowBlocked, FlowCumulativeFlow, FlowCycleTime, FlowDwell, FlowThroughput, FlowWipAge,
} from "../../../types";
import type { AnalyticsData } from "./heatmap";

/** One endpoint's answer: a failure of one does not blank the others. */
export interface Result<T> {
  data?: T;
  error?: unknown;
}

export interface OverviewResults {
  cycle: Result<FlowCycleTime>;
  throughput: Result<FlowThroughput>;
  cumulative: Result<FlowCumulativeFlow>;
  wipAge: Result<FlowWipAge>;
  dwell: Result<FlowDwell>;
  blocked: Result<FlowBlocked>;
  attention: Result<FlowAttention>;
  /** The heatmap and its CSV export (FlowSection). */
  analytics: Result<AnalyticsData | null>;
}

function settle<T>(outcome: PromiseSettledResult<T>): Result<T> {
  return outcome.status === "fulfilled" ? { data: outcome.value } : { error: outcome.reason };
}

/**
 * Every request the Overview makes, once per filter change (#2261).
 *
 * The answers are swapped in together once all have settled, and the previous
 * answers stay on screen meanwhile: a chart that lost its data would unmount
 * and remount, and a keyboard user would lose their place. `results` is null
 * only before the first answer, which is the only time panels show skeletons.
 */
export function useAnalyticsOverviewData(boardId: number, filters: FlowFilters, attempt: number) {
  // The filters travel with the answers they fetched, swapped in together, so period-labelled copy
  // never names a period the numbers on screen were not computed for.
  const [settled, setSettled] = useState<{ results: OverviewResults; filters: FlowFilters } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // A newer filter or retry supersedes this request: drop its late answer.
    let current = true;
    setLoading(true);
    Promise.allSettled([
      getFlowCycleTime(boardId, filters),
      getFlowThroughput(boardId, filters),
      getFlowCumulativeFlow(boardId, filters),
      getFlowWipAge(boardId, filters),
      getFlowDwell(boardId, filters),
      getFlowBlocked(boardId, filters),
      getFlowAttention(boardId, filters),
      getBoardAnalytics(boardId, filters.days, undefined, { swimlaneId: filters.swimlaneId, labelId: filters.labelId }),
    ]).then(([cycle, throughput, cumulative, wipAge, dwell, blocked, attention, analytics]) => {
      if (!current) return;
      setSettled({ filters, results: {
        cycle: settle(cycle),
        throughput: settle(throughput),
        cumulative: settle(cumulative),
        wipAge: settle(wipAge),
        dwell: settle(dwell),
        blocked: settle(blocked),
        attention: settle(attention),
        analytics: settle(analytics as PromiseSettledResult<AnalyticsData | null>),
      } });
      setLoading(false);
    });
    return () => { current = false; };
  }, [boardId, filters, attempt]);

  const results = settled?.results ?? null;
  const fetchedFilters = settled?.filters ?? null;
  const failed = results !== null && Object.values(results).some((result) => result.error !== undefined);
  return { results, fetchedFilters, loading, failed };
}
