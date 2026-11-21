import client from "./client";
import type {
  FlowAttention,
  FlowBlocked,
  FlowCumulativeDayCards,
  FlowCumulativeFlow,
  FlowCycleTime,
  FlowDwell,
  FlowGroupBy,
  FlowOverview,
  FlowSwimlaneComparison,
  FlowThroughput,
  FlowWipAge,
} from "../types";

/** The filters every `metrics/*` endpoint accepts (#448). */
export interface FlowFilters {
  days: number;
  swimlaneId: number | null;
  labelId: number | null;
}

function flowParams({ days, swimlaneId, labelId }: FlowFilters) {
  return {
    days,
    ...(swimlaneId !== null && { swimlane_id: swimlaneId }),
    ...(labelId !== null && { label_id: labelId }),
  };
}

/**
 * A breakdown (#2265). Only cycle-time, throughput, wip-age and dwell take it,
 * so it is a separate argument rather than part of the shared filters.
 * `fieldId` is required with `by: "custom_field"` and refused otherwise.
 */
export interface FlowGroupingParams {
  by: FlowGroupBy;
  fieldId?: number;
}

function groupedParams(filters: FlowFilters, grouping?: FlowGroupingParams) {
  if (!grouping) return flowParams(filters);
  return {
    ...flowParams(filters),
    group_by: grouping.by,
    ...(grouping.fieldId !== undefined && { group_by_field_id: grouping.fieldId }),
  };
}

export const getFlowCycleTime = (boardId: number, filters: FlowFilters, grouping?: FlowGroupingParams) =>
  client
    .get<FlowCycleTime>(`/api/v1/boards/${boardId}/metrics/cycle-time/`, {
      params: groupedParams(filters, grouping),
    })
    .then((r) => r.data);

export const getFlowThroughput = (boardId: number, filters: FlowFilters, grouping?: FlowGroupingParams) =>
  client
    .get<FlowThroughput>(`/api/v1/boards/${boardId}/metrics/throughput/`, {
      params: groupedParams(filters, grouping),
    })
    .then((r) => r.data);

export const getFlowCumulativeFlow = (boardId: number, filters: FlowFilters) =>
  client
    .get<FlowCumulativeFlow>(`/api/v1/boards/${boardId}/metrics/cumulative-flow/`, { params: flowParams(filters) })
    .then((r) => r.data);

export const getFlowCumulativeDay = (boardId: number, filters: FlowFilters, date: string) =>
  client
    .get<FlowCumulativeDayCards>(`/api/v1/boards/${boardId}/metrics/cumulative-flow/`, {
      params: { ...flowParams(filters), date },
    })
    .then((r) => r.data);

export const getFlowWipAge = (boardId: number, filters: FlowFilters, grouping?: FlowGroupingParams) =>
  client
    .get<FlowWipAge>(`/api/v1/boards/${boardId}/metrics/wip-age/`, { params: groupedParams(filters, grouping) })
    .then((r) => r.data);

export const getFlowDwell = (boardId: number, filters: FlowFilters, grouping?: FlowGroupingParams) =>
  client
    .get<FlowDwell>(`/api/v1/boards/${boardId}/metrics/dwell/`, { params: groupedParams(filters, grouping) })
    .then((r) => r.data);

export const getFlowBlocked = (boardId: number, filters: FlowFilters) =>
  client
    .get<FlowBlocked>(`/api/v1/boards/${boardId}/metrics/blocked/`, { params: flowParams(filters) })
    .then((r) => r.data);

export const getFlowAttention = (boardId: number, filters: FlowFilters) =>
  client
    .get<FlowAttention>(`/api/v1/boards/${boardId}/metrics/attention/`, { params: flowParams(filters) })
    .then((r) => r.data);

/**
 * Every Overview chart from one request (#2426). The server loads the board's
 * history once for all seven sections; asking for them separately loads it
 * once per chart. `grouping` breaks down cycle time, throughput, WIP age and dwell.
 */
export const getFlowOverview = (boardId: number, filters: FlowFilters, grouping?: FlowGroupingParams) =>
  client
    .get<FlowOverview>(`/api/v1/boards/${boardId}/metrics/overview/`, { params: groupedParams(filters, grouping) })
    .then((r) => r.data);

/**
 * Swimlanes tab (#2266). Takes no swimlane filter; `groupByFieldId` is a swimlane
 * custom field ("Group lanes by").
 */
export const getFlowSwimlanes = (
  boardId: number,
  filters: Omit<FlowFilters, 'swimlaneId'>,
  groupByFieldId?: number,
) =>
  client
    .get<FlowSwimlaneComparison>(`/api/v1/boards/${boardId}/metrics/swimlanes/`, {
      params: {
        days: filters.days,
        ...(filters.labelId !== null && { label_id: filters.labelId }),
        ...(groupByFieldId !== undefined && { group_by_field_id: groupByFieldId }),
      },
    })
    .then((r) => r.data)
