import { useState, useEffect, useCallback } from "react";
import type { SavedFilter } from "../types";
import type { FilterState } from "../components/Board/FilterBar";
import { EMPTY_FILTER } from "../components/Board/FilterBar";
import {
  listSavedFilters,
  createSavedFilter,
  deleteSavedFilter,
} from "../api/savedFilters";

/**
 * Manages the list of saved filter presets for a board.
 *
 * Filters are loaded from the backend on mount so they persist across devices.
 * The list is kept in local state and updated optimistically on create/delete
 * to avoid an extra round-trip for the common happy-path case.
 */
export function useSavedFilters(boardId: number) {
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    listSavedFilters(boardId)
      .then((filters) => setSavedFilters(filters))
      .catch(() => setError("Failed to load saved filters."))
      .finally(() => setLoading(false));
  }, [boardId]);

  const saveFilter = useCallback(
    async (name: string, filters: FilterState): Promise<{ error?: string }> => {
      try {
        const created = await createSavedFilter(boardId, {
          name,
          state_json: filters as unknown as Record<string, unknown>,
        });
        setSavedFilters((prev) =>
          [...prev, created].sort((a, b) => a.name.localeCompare(b.name)),
        );
        return {};
      } catch (err: unknown) {
        const detail =
          (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
          "Failed to save filter.";
        return { error: detail };
      }
    },
    [boardId],
  );

  const removeFilter = useCallback(
    async (filterId: number): Promise<void> => {
      // Optimistic removal — revert on network failure is not implemented;
      // the user can reload to restore the list. This keeps the UX snappy
      // for the typical success case.
      setSavedFilters((prev) => prev.filter((f) => f.id !== filterId));
      try {
        await deleteSavedFilter(boardId, filterId);
      } catch {
        // Revert the optimistic removal on failure.
        listSavedFilters(boardId)
          .then((filters) => setSavedFilters(filters))
          .catch(() => {/* best-effort revert; ignore secondary error */});
      }
    },
    [boardId],
  );

  /**
   * Convert a saved filter's state_json back into a FilterState, dispatching
   * on state_version so a v2+ payload can be migrated forward when the shape
   * changes non-additively. Today only v1 exists; older rows that predate the
   * state_version column backfill to 1 via the column default, and rows from
   * a newer client (higher version) fall through to the defensive v1 reader
   * so fields they share still load rather than silently reset.
   */
  const hydrateFilter = useCallback((saved: SavedFilter): FilterState => {
    const s = saved.state_json;
    // v1 reader — tolerant of missing/wrong-typed fields so state saved before
    // a filter shape change still loads without throwing.
    return {
      search: typeof s["search"] === "string" ? s["search"] : EMPTY_FILTER.search,
      assigneeIds: Array.isArray(s["assigneeIds"])
        ? (s["assigneeIds"] as number[])
        : EMPTY_FILTER.assigneeIds,
      labelIds: Array.isArray(s["labelIds"])
        ? (s["labelIds"] as number[])
        : EMPTY_FILTER.labelIds,
      priorities: Array.isArray(s["priorities"])
        ? (s["priorities"] as FilterState["priorities"])
        : EMPTY_FILTER.priorities,
      dueDate:
        s["dueDate"] === "overdue" ||
        s["dueDate"] === "today" ||
        s["dueDate"] === "this_week" ||
        s["dueDate"] === "none"
          ? s["dueDate"]
          : EMPTY_FILTER.dueDate,
    };
  }, []);

  // Refetch the full filter list from the server. Used by the socket handler for
  // saved_filter.created — the broadcast no longer includes the full filter payload
  // (it was trimmed to {filter_id, user_id} to avoid broadcasting state_json to all
  // board members), so other sessions must refetch rather than inject directly.
  const refreshFilters = useCallback(() => {
    listSavedFilters(boardId)
      .then((filters) => setSavedFilters(filters))
      .catch(() => {/* best-effort refresh; ignore error */});
  }, [boardId]);

  const onSavedFilterEvicted = useCallback((filterId: number) => {
    setSavedFilters((prev) => prev.filter((f) => f.id !== filterId));
  }, []);

  return { savedFilters, loading, error, saveFilter, removeFilter, hydrateFilter, refreshFilters, onSavedFilterEvicted };
}
