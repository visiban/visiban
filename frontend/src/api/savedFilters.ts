import client from "./client";
import type { SavedFilter } from "../types";

// Current schema version written by this frontend into SavedFilter.state_json.
// Bump when the FilterState shape changes in a non-additive way and add a
// corresponding migrator in hydrateFilter (see useSavedFilters.ts). Additive
// changes do not require a bump — the serializer's validate_state_json will
// need an entry in its key allow-list though (#698).
export const CURRENT_SAVED_FILTER_SCHEMA_VERSION = 1;

export const listSavedFilters = (boardId: number) =>
  client.get<SavedFilter[]>(`/api/v1/boards/${boardId}/saved-filters/`).then((r) => r.data);

export const createSavedFilter = (
  boardId: number,
  data: { name: string; state_json: Record<string, unknown>; state_version?: number },
) =>
  client
    .post<SavedFilter>(`/api/v1/boards/${boardId}/saved-filters/`, {
      state_version: CURRENT_SAVED_FILTER_SCHEMA_VERSION,
      ...data,
    })
    .then((r) => r.data);

export const deleteSavedFilter = (boardId: number, filterId: number) =>
  client.delete(`/api/v1/boards/${boardId}/saved-filters/${filterId}/`);
