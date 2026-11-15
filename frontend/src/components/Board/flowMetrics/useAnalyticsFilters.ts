import { useCallback, useMemo, useState } from "react";
import type { FlowFilters } from "../../../api/flowMetrics";

export const RANGES = [
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
  { value: 180, label: "Last 180 days" },
  { value: 365, label: "Last 365 days" },
];
// Whole ISO weeks and enough completions for P85/P95 on a small team (ADR #1532).
export const DEFAULT_DAYS = 90;

const DEFAULT_FILTERS: FlowFilters = { days: DEFAULT_DAYS, swimlaneId: null, labelId: null };

/**
 * The Analytics tab's one filter selection (#2261): Period, Swimlane and Label
 * drive every panel on the page. It lives in `AnalyticsView`, above the views,
 * so a later Swimlanes view (#2267) can read the same Period and Label. Not in
 * the URL and not in a context: one owner, passed down.
 */
export function useAnalyticsFilters() {
  const [filters, setFilters] = useState<FlowFilters>(DEFAULT_FILTERS);
  const setDays = useCallback((days: number) => setFilters((f) => ({ ...f, days })), []);
  const setSwimlaneId = useCallback((swimlaneId: number | null) => setFilters((f) => ({ ...f, swimlaneId })), []);
  const setLabelId = useCallback((labelId: number | null) => setFilters((f) => ({ ...f, labelId })), []);
  const clear = useCallback(() => setFilters(DEFAULT_FILTERS), []);
  return useMemo(
    () => ({ filters, setFilters, setDays, setSwimlaneId, setLabelId, clear }),
    [filters, setDays, setSwimlaneId, setLabelId, clear],
  );
}
