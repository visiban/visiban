import client from "./client";
import type { Board, BoardFull, BoardMembership, Column, Swimlane, Label } from "../types";

export type BoardRole = "admin" | "member" | "collaborator" | "viewer";

export const setBoardMember = (boardId: number, userId: number, role: BoardRole) =>
  client.post<BoardMembership>(`/api/boards/${boardId}/members/`, { user_id: userId, role }).then((r) => r.data);

export const removeBoardMember = (boardId: number, userId: number) =>
  client.delete(`/api/boards/${boardId}/members/${userId}/`);

export const listBoards = () =>
  client.get<Board[]>("/api/boards/").then((r) => r.data);

export const createBoard = (data: { name: string; description?: string; template?: string }) =>
  client.post<Board>("/api/boards/", data).then((r) => r.data);

export const getBoard = (id: number) =>
  client.get<Board>(`/api/boards/${id}/`).then((r) => r.data);

export const getBoardFull = (id: number) =>
  client.get<BoardFull>(`/api/boards/${id}/full/`).then((r) => r.data);

export const updateBoard = (id: number, data: Partial<Board>) =>
  client.put<Board>(`/api/boards/${id}/`, data).then((r) => r.data);

export const deleteBoard = (id: number) =>
  client.delete(`/api/boards/${id}/`);

export const moveBoardToGroup = (boardId: number, groupId: number | null) =>
  client.post<Board>(`/api/boards/${boardId}/move-group/`, { group_id: groupId }).then((r) => r.data);

// Columns
export const createColumn = (boardId: number, data: { name: string; color?: string; wip_limit?: number; weight_limit?: number }) =>
  client.post<Column>(`/api/boards/${boardId}/columns/`, data).then((r) => r.data);

export const updateColumn = (boardId: number, colId: number, data: Partial<Column>) =>
  client.put<Column>(`/api/boards/${boardId}/columns/${colId}/`, data).then((r) => r.data);

export const deleteColumn = (boardId: number, colId: number) =>
  client.delete(`/api/boards/${boardId}/columns/${colId}/`);

export const reorderColumns = (boardId: number, order: number[]) =>
  client.post<Column[]>(`/api/boards/${boardId}/columns/reorder/`, { order }).then((r) => r.data);

// Swimlanes
export const createSwimlane = (boardId: number, data: { name: string; contact_email?: string; color?: string }) =>
  client.post<Swimlane>(`/api/boards/${boardId}/swimlanes/`, data).then((r) => r.data);

export const updateSwimlane = (boardId: number, swimlaneId: number, data: Partial<Swimlane>) =>
  client.put<Swimlane>(`/api/boards/${boardId}/swimlanes/${swimlaneId}/`, data).then((r) => r.data);

export const deleteSwimlane = (boardId: number, swimlaneId: number) =>
  client.delete(`/api/boards/${boardId}/swimlanes/${swimlaneId}/`);

export const reorderSwimlanes = (boardId: number, order: number[]) =>
  client.post<Swimlane[]>(`/api/boards/${boardId}/swimlanes/reorder/`, { order }).then((r) => r.data);

// Analytics
export const getBoardSummary = (id: number) =>
  client.get(`/api/boards/${id}/summary/`).then((r) => r.data);

export const getBoardAnalytics = (id: number, days = 30, stalledDays = 7) =>
  client
    .get(`/api/boards/${id}/analytics/`, { params: { days, stalled_days: stalledDays } })
    .then((r) => r.data);

// Export
export const exportBoardCsv = (boardId: number) => {
  window.open(`${client.defaults.baseURL}/api/boards/${boardId}/export/`, '_blank');
};

export const exportBoardJson = (boardId: number) => {
  window.open(`${client.defaults.baseURL}/api/boards/${boardId}/export/?format=json`, '_blank');
};

// Labels
export const listLabels = (boardId: number) =>
  client.get<Label[]>(`/api/boards/${boardId}/labels/`).then((r) => r.data);

export const createLabel = (boardId: number, data: { name: string; color?: string }) =>
  client.post<Label>(`/api/boards/${boardId}/labels/`, data).then((r) => r.data);

export const importBoard = (file: File, name?: string) => {
  const formData = new FormData();
  formData.append('file', file);
  if (name) formData.append('name', name);
  return client.post<Board>('/api/boards/import/', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then((r) => r.data);
};
