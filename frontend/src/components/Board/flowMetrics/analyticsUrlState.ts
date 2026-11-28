import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { FlowFilters } from "../../../api/flowMetrics";
import { SORT_OPTIONS } from "./swimlanesFormat";
import type { SwimlaneSort } from "./swimlanesFormat";

/**
 * The Analytics tab's shareable state lives in the URL beside `?view=analytics`
 * (#2318): Period, Swimlane, Label, Break down by and the Overview/Swimlanes
 * choice; the Swimlanes view adds Group lanes by and Sort (#2546). Every parameter is optional and a default is never written, so an
 * existing `?view=analytics` link is unchanged and means exactly what it did.
 */
export const ANALYTICS_PARAM = {
  days: "a_days",
  swimlane: "a_swimlane",
  label: "a_label",
  by: "a_by",
  tab: "a_tab",
  group: "a_group",
  sort: "a_sort",
} as const;

export const ANALYTICS_PARAM_NAMES: readonly string[] = Object.values(ANALYTICS_PARAM);

/** The periods the filter bar offers; anything else in `a_days` is ignored. */
export const ANALYTICS_DAY_OPTIONS = [30, 90, 180, 365] as const;
export const ANALYTICS_DEFAULT_DAYS = 90;

export type AnalyticsTab = "overview" | "swimlanes";

type SetSearchParams = (
  next: URLSearchParams | ((prev: URLSearchParams) => URLSearchParams),
  options?: { replace?: boolean },
) => void;

/** Where the params live: the router's search params, passed down by the board. */
export interface AnalyticsUrlSource {
  searchParams: URLSearchParams;
  setSearchParams: SetSearchParams;
}

export interface AnalyticsUrlParams {
  params: URLSearchParams;
  /** Edits a copy of the current params. Replaces the history entry: a filter change is not a page. */
  update: (edit: (next: URLSearchParams) => void) => void;
}

/** A positive integer id, or null for anything else (negative, fractional, "abc", "1e3"). */
function parseId(raw: string | null): number | null {
  if (raw === null || !/^[1-9]\d{0,9}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * The filters in `params`. An unknown value falls back to its default, never an error:
 * a stale or hand-edited link still opens the page.
 */
export function parseAnalyticsFilters(params: URLSearchParams): FlowFilters {
  const days = Number(params.get(ANALYTICS_PARAM.days));
  return {
    days: (ANALYTICS_DAY_OPTIONS as readonly number[]).includes(days) ? days : ANALYTICS_DEFAULT_DAYS,
    swimlaneId: parseId(params.get(ANALYTICS_PARAM.swimlane)),
    labelId: parseId(params.get(ANALYTICS_PARAM.label)),
  };
}

/** Writes `filters` into `next`, leaving a parameter out when it holds its default. */
export function writeAnalyticsFilters(next: URLSearchParams, filters: FlowFilters): void {
  if (filters.days === ANALYTICS_DEFAULT_DAYS) next.delete(ANALYTICS_PARAM.days);
  else next.set(ANALYTICS_PARAM.days, String(filters.days));
  if (filters.swimlaneId === null) next.delete(ANALYTICS_PARAM.swimlane);
  else next.set(ANALYTICS_PARAM.swimlane, String(filters.swimlaneId));
  if (filters.labelId === null) next.delete(ANALYTICS_PARAM.label);
  else next.set(ANALYTICS_PARAM.label, String(filters.labelId));
}

export function parseAnalyticsTab(params: URLSearchParams): AnalyticsTab {
  return params.get(ANALYTICS_PARAM.tab) === "swimlanes" ? "swimlanes" : "overview";
}

export function writeAnalyticsTab(next: URLSearchParams, tab: AnalyticsTab): void {
  if (tab === "overview") next.delete(ANALYTICS_PARAM.tab);
  else next.set(ANALYTICS_PARAM.tab, tab);
}

export const SWIMLANE_SORT_DEFAULT: SwimlaneSort = "slowest";

/** The sort in `a_sort`; an unknown value is the default, never an error. */
export function parseSwimlaneSort(params: URLSearchParams): SwimlaneSort {
  const raw = params.get(ANALYTICS_PARAM.sort);
  return SORT_OPTIONS.find((o) => o.value === raw)?.value ?? SWIMLANE_SORT_DEFAULT;
}

export function writeSwimlaneSort(next: URLSearchParams, sort: SwimlaneSort): void {
  if (sort === SWIMLANE_SORT_DEFAULT) next.delete(ANALYTICS_PARAM.sort);
  else next.set(ANALYTICS_PARAM.sort, sort);
}

/** The swimlane custom field id in `a_group`, or null (none, malformed, or a field the board lacks). */
export function parseSwimlaneGroup(params: URLSearchParams, fields: readonly { id: number }[]): number | null {
  const id = parseId(params.get(ANALYTICS_PARAM.group));
  return id !== null && fields.some((f) => f.id === id) ? id : null;
}

export function writeSwimlaneGroup(next: URLSearchParams, groupId: number | null): void {
  if (groupId === null) next.delete(ANALYTICS_PARAM.group);
  else next.set(ANALYTICS_PARAM.group, String(groupId));
}

/** Drops every Analytics parameter, for when the user leaves the tab. */
export function clearAnalyticsParams(next: URLSearchParams): void {
  for (const name of ANALYTICS_PARAM_NAMES) next.delete(name);
}

/**
 * Reads and edits the Analytics params. With a `source` (the board inside the router) they
 * are the URL's; without one (a unit test, a mount outside a route) the same API runs on
 * local state, so the tab never needs a router to render.
 */
export function useAnalyticsUrlParams(source?: AnalyticsUrlSource): AnalyticsUrlParams {
  const [local, setLocal]: [URLSearchParams, Dispatch<SetStateAction<URLSearchParams>>] = useState(() => new URLSearchParams());
  const setSource = source?.setSearchParams;
  const update = useCallback((edit: (next: URLSearchParams) => void) => {
    const apply = (prev: URLSearchParams) => { const next = new URLSearchParams(prev); edit(next); return next; };
    if (setSource) setSource(apply, { replace: true });
    else setLocal(apply);
  }, [setSource]);
  return { params: source ? source.searchParams : local, update };
}
