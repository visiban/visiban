import { useCallback, useMemo } from "react";
import type { FlowFilters } from "../../../api/flowMetrics";
import {
  ANALYTICS_DEFAULT_DAYS, parseAnalyticsFilters, useAnalyticsUrlParams, writeAnalyticsFilters,
} from "./analyticsUrlState";
import type { AnalyticsUrlParams } from "./analyticsUrlState";

export const RANGES = [
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
  { value: 180, label: "Last 180 days" },
  { value: 365, label: "Last 365 days" },
];
// Whole ISO weeks and enough completions for P85/P95 on a small team (ADR #1532).
export const DEFAULT_DAYS = ANALYTICS_DEFAULT_DAYS;

/**
 * The Analytics tab's one filter selection (#2261): Period, Swimlane and Label
 * drive every panel on the page, and the Swimlanes view reads the same Period
 * and Label. The selection lives in the URL (#2318), so a reload or a copied
 * link restores it; `url` is the page's one `useAnalyticsUrlParams`, shared
 * with the view choice and the breakdown.
 */
export function useAnalyticsFilters(url?: AnalyticsUrlParams) {
  const own = useAnalyticsUrlParams();
  const { params, update } = url ?? own;
  const paramString = params.toString();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- paramString is the params' identity; the object is rebuilt on every router render
  const filters = useMemo<FlowFilters>(() => parseAnalyticsFilters(params), [paramString]);
  // A function form, like a state setter's, reads the filters as they are in the URL right now.
  const setFilters = useCallback(
    (next: FlowFilters | ((current: FlowFilters) => FlowFilters)) =>
      update((p) => writeAnalyticsFilters(p, typeof next === "function" ? next(parseAnalyticsFilters(p)) : next)),
    [update],
  );
  const setDays = useCallback((days: number) => update((p) => writeAnalyticsFilters(p, { ...parseAnalyticsFilters(p), days })), [update]);
  const setSwimlaneId = useCallback((swimlaneId: number | null) => update((p) => writeAnalyticsFilters(p, { ...parseAnalyticsFilters(p), swimlaneId })), [update]);
  const setLabelId = useCallback((labelId: number | null) => update((p) => writeAnalyticsFilters(p, { ...parseAnalyticsFilters(p), labelId })), [update]);
  const clear = useCallback(() => update((p) => writeAnalyticsFilters(p, { days: DEFAULT_DAYS, swimlaneId: null, labelId: null })), [update]);
  return useMemo(
    () => ({ filters, setFilters, setDays, setSwimlaneId, setLabelId, clear }),
    [filters, setFilters, setDays, setSwimlaneId, setLabelId, clear],
  );
}
