import client from "./client";
import type { SavedFilter } from "../types";

export const listSavedFilters = (boardId: number) =>
  client.get<SavedFilter[]>(`/api/v1/boards/${boardId}/saved-filters/`).then((r) => r.data);

export const createSavedFilter = (
  boardId: number,
  data: { name: string; state_json: Record<string, unknown> },
) =>
  client
    .post<SavedFilter>(`/api/v1/boards/${boardId}/saved-filters/`, data)
    .then((r) => r.data);

export const deleteSavedFilter = (boardId: number, filterId: number) =>
  client.delete(`/api/v1/boards/${boardId}/saved-filters/${filterId}/`);
