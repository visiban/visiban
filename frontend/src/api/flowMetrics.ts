import client from "./client";
import type {
  FlowCumulativeDayCards,
  FlowCumulativeFlow,
  FlowCycleTime,
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

export const getFlowCycleTime = (boardId: number, filters: FlowFilters) =>
  client
    .get<FlowCycleTime>(`/api/v1/boards/${boardId}/metrics/cycle-time/`, { params: flowParams(filters) })
    .then((r) => r.data);

export const getFlowThroughput = (boardId: number, filters: FlowFilters) =>
  client
    .get<FlowThroughput>(`/api/v1/boards/${boardId}/metrics/throughput/`, { params: flowParams(filters) })
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

export const getFlowWipAge = (boardId: number, filters: FlowFilters) =>
  client
    .get<FlowWipAge>(`/api/v1/boards/${boardId}/metrics/wip-age/`, { params: flowParams(filters) })
    .then((r) => r.data);
