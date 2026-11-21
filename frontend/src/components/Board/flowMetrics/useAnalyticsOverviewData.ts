import { useEffect, useState } from "react";
import { getBoardAnalytics } from "../../../api/boards";
import { getFlowOverview } from "../../../api/flowMetrics";
import type { FlowFilters, FlowGroupingParams } from "../../../api/flowMetrics";
import type {
  FlowAttention, FlowBlocked, FlowCumulativeFlow, FlowCycleTime, FlowDwell, FlowOverview, FlowThroughput, FlowWipAge,
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
 * Every request the Overview makes, once per filter change (#2261): the seven
 * flow charts in one `metrics/overview` request, which loads the board's history
 * once rather than once per chart (#2426), and the heatmap's `analytics`.
 * The charts therefore load or fail together; the heatmap fails on its own.
 *
 * The answers are swapped in together once all have settled, and the previous
 * answers stay on screen meanwhile: a chart that lost its data would unmount
 * and remount, and a keyboard user would lose their place. `results` is null
 * only before the first answer, which is the only time panels show skeletons.
 */
export function useAnalyticsOverviewData(boardId: number, filters: FlowFilters, attempt: number, grouping?: FlowGroupingParams) {
  // The filters travel with the answers they fetched, swapped in together, so period-labelled copy
  // never names a period the numbers on screen were not computed for.
  const [settled, setSettled] = useState<{ results: OverviewResults; filters: FlowFilters } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // A newer filter or retry supersedes this request: drop its late answer.
    let current = true;
    setLoading(true);
    // With no breakdown the call is exactly as before (no third argument).
    const extra: [FlowGroupingParams?] = grouping ? [grouping] : [];
    // allSettled never rejects and the `current` flag guards late answers, so fire-and-forget is safe.
    void Promise.allSettled([
      getFlowOverview(boardId, filters, ...extra),
      getBoardAnalytics(boardId, filters.days, undefined, { swimlaneId: filters.swimlaneId, labelId: filters.labelId }),
    ]).then(([overview, analytics]) => {
      if (!current) return;
      // One failed request fails every chart it carried, each in its own frame.
      const section = <K extends keyof FlowOverview>(key: K): Result<FlowOverview[K]> =>
        overview.status === "fulfilled" ? { data: overview.value[key] } : { error: overview.reason };
      setSettled({ filters, results: {
        cycle: section("cycle_time"),
        throughput: section("throughput"),
        cumulative: section("cumulative_flow"),
        wipAge: section("wip_age"),
        dwell: section("dwell"),
        blocked: section("blocked"),
        attention: section("attention"),
        analytics: settle(analytics as PromiseSettledResult<AnalyticsData | null>),
      } });
      setLoading(false);
    });
    return () => { current = false; };
  }, [boardId, filters, attempt, grouping]);

  const results = settled?.results ?? null;
  const fetchedFilters = settled?.filters ?? null;
  const failed = results !== null && Object.values(results).some((result) => result.error !== undefined);
  return { results, fetchedFilters, loading, failed };
}
