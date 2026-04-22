import client from "./client";
import type { Board, BoardFull, BoardMembership, BoardTemplate, BoardPublic, CardMovement, Column, Swimlane, Label } from "../types";

export type BoardRole = "admin" | "member" | "collaborator" | "viewer";

export const setBoardMember = (boardId: number, userId: number, role: BoardRole, is_moderator?: boolean) =>
  client.post<BoardMembership>(`/api/v1/boards/${boardId}/members/`, { user_id: userId, role, ...(is_moderator !== undefined && { is_moderator }) }).then((r) => r.data);

export const removeBoardMember = (boardId: number, userId: number) =>
  client.delete(`/api/v1/boards/${boardId}/members/${userId}/`);

export const listBoards = () =>
  client.get<{ results: Board[] }>("/api/v1/boards/").then((r) => r.data.results);

export const listBoardTemplates = () =>
  client.get<BoardTemplate[]>("/api/v1/boards/templates/").then((r) => r.data);

export const createBoard = (data: { name: string; description?: string; template?: string; swimlane_name?: string }) =>
  client.post<Board>("/api/v1/boards/", data).then((r) => r.data);

export const getBoard = (id: number) =>
  client.get<Board>(`/api/v1/boards/${id}/`).then((r) => r.data);

export const getBoardFull = (id: number) =>
  client.get<BoardFull>(`/api/v1/boards/${id}/full/`).then((r) => r.data);

export const updateBoard = (id: number, data: Partial<Board>) =>
  client.put<Board>(`/api/v1/boards/${id}/`, data).then((r) => r.data);

export const patchBoard = (id: number, data: Record<string, unknown>) =>
  client.patch<Board>(`/api/v1/boards/${id}/`, data).then((r) => r.data);

export const deleteBoard = (id: number) =>
  client.delete(`/api/v1/boards/${id}/`);

export const moveBoardToGroup = (boardId: number, groupId: number | null) =>
  client.post<Board>(`/api/v1/boards/${boardId}/move-group/`, { group_id: groupId }).then((r) => r.data);

export const starBoard = (id: number) =>
  client.post<Board>(`/api/v1/boards/${id}/star/`).then((r) => r.data);

export const unstarBoard = (id: number) =>
  client.delete<Board>(`/api/v1/boards/${id}/star/`).then((r) => r.data);

export const listStarredBoards = () =>
  client.get<{ results: Board[] }>("/api/v1/boards/", { params: { starred: "true" } }).then((r) => r.data.results);

// Columns
export const createColumn = (boardId: number, data: { name: string; color?: string; wip_limit?: number; weight_limit?: number }) =>
  client.post<Column>(`/api/v1/boards/${boardId}/columns/`, data).then((r) => r.data);

export const updateColumn = (boardId: number, colId: number, data: Partial<Column>) =>
  client.put<Column>(`/api/v1/boards/${boardId}/columns/${colId}/`, data).then((r) => r.data);

export const deleteColumn = (boardId: number, colId: number) =>
  client.delete(`/api/v1/boards/${boardId}/columns/${colId}/`);

export const reorderColumns = (boardId: number, order: number[]) =>
  client.post<Column[]>(`/api/v1/boards/${boardId}/columns/reorder/`, { order }).then((r) => r.data);

// Swimlanes
export const createSwimlane = (boardId: number, data: { name: string; contact_email?: string; color?: string }) =>
  client.post<Swimlane>(`/api/v1/boards/${boardId}/swimlanes/`, data).then((r) => r.data);

export const updateSwimlane = (boardId: number, swimlaneId: number, data: Partial<Swimlane>) =>
  client.put<Swimlane>(`/api/v1/boards/${boardId}/swimlanes/${swimlaneId}/`, data).then((r) => r.data);

export const deleteSwimlane = (boardId: number, swimlaneId: number) =>
  client.delete(`/api/v1/boards/${boardId}/swimlanes/${swimlaneId}/`);

export const reorderSwimlanes = (boardId: number, order: number[]) =>
  client.post<Swimlane[]>(`/api/v1/boards/${boardId}/swimlanes/reorder/`, { order }).then((r) => r.data);

// Analytics
export const getBoardSummary = (id: number) =>
  client.get(`/api/v1/boards/${id}/summary/`).then((r) => r.data);

export const getBoardAnalytics = (id: number, days = 30, stalledDays?: number) =>
  client
    .get(`/api/v1/boards/${id}/analytics/`, {
      params: { days, ...(stalledDays !== undefined && { stalled_days: stalledDays }) },
    })
    .then((r) => r.data);

export const getBoardMovements = (boardId: number, params: Record<string, string> = {}) =>
  client.get<{ results: CardMovement[]; count: number; offset: number; page_size: number }>(`/api/v1/boards/${boardId}/movements/`, { params }).then((r) => r.data);

// Export
export const exportBoardCsv = (boardId: number) => {
  window.open(`${client.defaults.baseURL}/api/v1/boards/${boardId}/export/`, '_blank');
};

export const exportBoardJson = (boardId: number) => {
  window.open(`${client.defaults.baseURL}/api/v1/boards/${boardId}/export/?format=json`, '_blank');
};

// Labels
export const listLabels = (boardId: number) =>
  client.get<Label[]>(`/api/v1/boards/${boardId}/labels/`).then((r) => r.data);

export const createLabel = (boardId: number, data: { name: string; color?: string }) =>
  client.post<Label>(`/api/v1/boards/${boardId}/labels/`, data).then((r) => r.data);

export const importBoard = (file: File, name?: string, groupId?: number) => {
  const formData = new FormData();
  formData.append('file', file);
  if (name) formData.append('name', name);
  if (groupId) formData.append('group_id', String(groupId));
  return client.post<Board>('/api/v1/boards/import/', formData).then((r) => r.data);
};

// Share link
export const getPublicBoard = (token: string) =>
  client.get<BoardPublic>(`/api/share/${token}/`).then((r) => r.data);

// expiresInDays = null → never expires; allowed values: 7, 30, 90.
// The backend rejects anything else with 400 — keep this list in sync.
export type ShareTtlDays = 7 | 30 | 90 | null;

export const enableBoardSharing = (boardId: number, expiresInDays: ShareTtlDays = null) =>
  client
    .post<{ share_token: string; share_url: string; share_token_expires_at: string | null }>(
      `/api/v1/boards/${boardId}/share/`,
      { expires_in_days: expiresInDays },
    )
    .then((r) => r.data);

export const disableBoardSharing = (boardId: number) =>
  client.delete(`/api/v1/boards/${boardId}/share/`);
